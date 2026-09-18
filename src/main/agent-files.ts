// Writes real multi-file projects to disk, driven by the <write_files> response convention
// (see prompt-modules.ts) — the "agent-level file access" capability: a model can scaffold a
// whole runnable app in one response instead of dumping code blocks the user has to copy by
// hand. Deliberately NOT inside userData/ like the rest of library.ts's storage — the whole
// point is a real, findable project folder the user can open in their own editor/terminal, so
// it lives under the user's Documents folder instead.
//
// SECURITY: every path in a <write_files> block is model output — untrusted input, whether
// from a weak model hallucinating a bad path or a prompt-injected one deliberately trying to
// escape its project folder (e.g. "../../../../Windows/System32/..."). safeJoin() below is
// the one place that boundary is enforced; every write goes through it.

import assert from 'node:assert'
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { sanitizeFileName } from './library'

export interface WriteFilesRequest {
  project: string
  files: { path: string; content: string }[]
}

export interface WriteFilesResult {
  projectPath: string
  totalBytes: number
}

function projectsRoot(): string {
  return join(app.getPath('documents'), 'Token Thrift Projects')
}

/** Resolves a model-supplied relative file path against a trusted root, refusing to let it
 * leave — see the file header. Rejects absolute paths (both Unix and Windows drive-letter
 * forms) outright, then resolves and checks the result still sits under `root` (catches every
 * `..`-traversal shape, since path.resolve() collapses them before the prefix check runs). */
export function safeJoin(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').trim()
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Unsafe file path from model: "${relativePath}"`)
  }
  const resolved = resolve(root, normalized)
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Unsafe file path from model: "${relativePath}" (escapes its project folder)`)
  }
  return resolved
}

/** Also reused by main/index.ts's relink handler — a drag-and-dropped replacement folder
 * needs the same total-size computation a freshly written project gets. */
export function folderSizeBytes(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    total += entry.isDirectory() ? folderSizeBytes(full) : statSync(full).size
  }
  return total
}

/** Picks a fresh folder if `name` is already taken by something unrelated — never silently
 * overwrites a different project that happens to sanitize to the same name. */
function resolveNewProjectDir(root: string, name: string): string {
  const base = join(root, name)
  if (!existsSync(base)) return base
  for (let i = 2; ; i++) {
    const candidate = join(root, `${name}-${i}`)
    if (!existsSync(candidate)) return candidate
  }
}

/** The actual write logic, taking the projects root as a parameter instead of resolving it
 * from app.getPath('documents') itself — keeps this self-checkable without a real Electron
 * app, same reasoning as every other main-process module's pure/impure split. */
export function writeProjectFilesInto(
  root: string,
  request: WriteFilesRequest,
  existingPath: string | null
): WriteFilesResult {
  const name = sanitizeFileName(request.project)
  const projectDir = existingPath && existsSync(existingPath) ? existingPath : resolveNewProjectDir(root, name)

  mkdirSync(projectDir, { recursive: true })
  for (const file of request.files) {
    const fullPath = safeJoin(projectDir, file.path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, file.content, 'utf8')
  }

  return { projectPath: projectDir, totalBytes: folderSizeBytes(projectDir) }
}

/** `existingPath` is the current link's path when resuming a project across turns (see
 * findLibraryLinkByName in db/repository.ts) — null creates a fresh one. */
export function writeProjectFiles(request: WriteFilesRequest, existingPath: string | null): WriteFilesResult {
  return writeProjectFilesInto(projectsRoot(), request, existingPath)
}

// --- self-check ---------------------------------------------------------------------
// No Electron app needed — writeProjectFilesInto takes the root as a parameter, so this runs
// against a throwaway temp directory and cleans up after itself.
if (require.main === module) {
  const testRoot = join(tmpdir(), `tt-agent-files-selfcheck-${Date.now()}`)

  const inside = safeJoin(testRoot, 'src/index.js')
  assert.ok(inside.startsWith(testRoot), 'legit relative path resolves inside root')

  assert.throws(() => safeJoin(testRoot, '../../etc/passwd'), /Unsafe file path/, 'parent traversal rejected')
  assert.throws(() => safeJoin(testRoot, '..'), /Unsafe file path/, 'bare parent traversal rejected')
  assert.throws(() => safeJoin(testRoot, '/etc/passwd'), /Unsafe file path/, 'unix absolute path rejected')
  assert.throws(() => safeJoin(testRoot, 'C:\\Windows\\System32'), /Unsafe file path/, 'windows absolute path rejected')
  assert.throws(() => safeJoin(testRoot, ''), /Unsafe file path/, 'empty path rejected')

  const result = writeProjectFilesInto(
    testRoot,
    {
      project: 'Pong: Game?',
      files: [
        { path: 'package.json', content: '{}' },
        { path: 'src/main.js', content: 'x'.repeat(50) }
      ]
    },
    null
  )
  assert.ok(result.projectPath.startsWith(testRoot))
  assert.ok(result.projectPath.endsWith('Pong_ Game_'), 'reserved characters stripped from the project folder name')
  assert.strictEqual(result.totalBytes, 2 + 50, 'total size is the real sum of what was written')
  assert.ok(existsSync(join(result.projectPath, 'package.json')))
  assert.ok(existsSync(join(result.projectPath, 'src/main.js')), 'nested file paths create their parent directories')

  const collision = writeProjectFilesInto(testRoot, { project: 'Pong: Game?', files: [{ path: 'a.txt', content: 'a' }] }, null)
  assert.notStrictEqual(collision.projectPath, result.projectPath, 'name collision gets a distinct folder, not overwritten')

  const resumed = writeProjectFilesInto(
    testRoot,
    { project: 'ignored on resume', files: [{ path: 'extra.txt', content: 'more' }] },
    result.projectPath
  )
  assert.strictEqual(resumed.projectPath, result.projectPath, 'an existing project path is reused, not recreated')
  assert.ok(existsSync(join(result.projectPath, 'extra.txt')))

  assert.throws(
    () => writeProjectFilesInto(testRoot, { project: 'evil', files: [{ path: '../../escaped.txt', content: 'x' }] }, null),
    /Unsafe file path/,
    'a file path escaping its own project directory is refused, not written'
  )
  assert.ok(!existsSync(join(testRoot, '..', 'escaped.txt')), 'the escaping write never actually happened')

  rmSync(testRoot, { recursive: true, force: true })
  console.log('agent-files self-check passed')
}
