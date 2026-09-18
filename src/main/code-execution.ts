// Runs a single command the model requested via <run_command> (see prompt-modules.ts) — the
// "test and improve code" loop: after writing files, the model can ask to run them, see the
// real output, and fix what's broken on its next turn. Node's built-in child_process.exec
// already runs through a shell (needed for things like "npm start") and has a built-in
// timeout that SIGTERMs a runaway process, so no extra dependency for any of this.
//
// SAFETY: this executes real commands on the user's machine. The actual safety boundary is
// the opt-in toggle (off by default, only offered alongside agentFileAccess), the fixed cwd
// (the agent's own working directory, never anywhere else), the timeout, and this being
// visible in the task monitor — not the denylist below, which is defense in depth only and
// can't be exhaustive against a hallucinated or prompt-injected command.

import assert from 'node:assert'
import { exec } from 'node:child_process'
import { tmpdir } from 'node:os'

export interface CommandResult {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 4000

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+[/~]/i,
  /rd\s+\/s/i,
  /format\s+[a-z]:/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // classic shell fork bomb
  /mkfs/i,
  />\s*\/dev\/sd/i,
  /\b(shutdown|reboot)\b/i
]

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + '\n... (truncated)' : text
}

export function runCommand(cwd: string, command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  if (isDangerousCommand(command)) {
    return Promise.resolve({
      command,
      exitCode: null,
      stdout: '',
      stderr: 'Refused: command matched a denylisted pattern (looked destructive).',
      timedOut: false
    })
  }

  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && 'killed' in err && err.killed && err.signal === 'SIGTERM')
      const exitCode = !err ? 0 : typeof err.code === 'number' ? err.code : null
      resolve({ command, exitCode, stdout: truncate(stdout), stderr: truncate(stderr), timedOut })
    })
  })
}

// --- self-check ---------------------------------------------------------------------
// Real process execution (via `node -e`, guaranteed available since this whole app runs on
// Node), so this is more of an integration check than a pure-function one — but no Electron
// app or API key needed either way.
if (require.main === module) {
  void (async () => {
    assert.strictEqual(isDangerousCommand('rm -rf /'), true)
    assert.strictEqual(isDangerousCommand('rm -rf ~'), true)
    assert.strictEqual(isDangerousCommand('npm test'), false, 'ordinary command must not be flagged')
    assert.strictEqual(isDangerousCommand('node index.js'), false)

    const cwd = tmpdir()

    const ok = await runCommand(cwd, 'node -e "console.log(1 + 1)"')
    assert.strictEqual(ok.exitCode, 0)
    assert.ok(ok.stdout.includes('2'))
    assert.strictEqual(ok.timedOut, false)

    const failed = await runCommand(cwd, 'node -e "process.exit(7)"')
    assert.strictEqual(failed.exitCode, 7)

    const blocked = await runCommand(cwd, 'rm -rf /')
    assert.strictEqual(blocked.exitCode, null)
    assert.ok(blocked.stderr.includes('Refused'), 'denylisted command never actually runs')

    const timedOut = await runCommand(cwd, 'node -e "setTimeout(() => {}, 5000)"', 200)
    assert.strictEqual(timedOut.timedOut, true)

    const longOutput = await runCommand(cwd, `node -e "console.log('x'.repeat(${MAX_OUTPUT_CHARS + 500}))"`)
    assert.ok(longOutput.stdout.length < MAX_OUTPUT_CHARS + 500, 'huge output gets truncated, not sent in full')
    assert.ok(longOutput.stdout.endsWith('(truncated)'))

    console.log('code-execution self-check passed')
  })().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
