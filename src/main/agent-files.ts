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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { sanitizeFileName } from './library'

export interface WriteFilesRequest {
  project: string
  files: { path: string; content: string }[]
}

export interface WriteFilesResult {
  projectPath: string
  totalBytes: number
}

/** The default shared root when the user hasn't picked a specific working directory —
 * exported so main/index.ts can snapshot the right folder even when agentWorkingDir is unset. */
export function projectsRoot(): string {
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

/** Writes every file straight into `dir` (creating it, and any nested parent directories,
 * as needed) and reports its new total size. The one place that actually touches disk. */
function writeFilesDirectlyInto(dir: string, request: WriteFilesRequest): WriteFilesResult {
  mkdirSync(dir, { recursive: true })
  for (const file of request.files) {
    const fullPath = safeJoin(dir, file.path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, file.content, 'utf8')
  }
  return { projectPath: dir, totalBytes: folderSizeBytes(dir) }
}

/** Resolves which directory a project belongs in, then writes it — taking the projects root
 * as a parameter instead of resolving it from app.getPath('documents') itself, keeping this
 * self-checkable without a real Electron app, same reasoning as every other main-process
 * module's pure/impure split. `existingPath` is reused only if it still exists (the linked
 * folder may have been deleted externally since); otherwise a fresh, non-colliding folder is
 * picked under `root`. */
export function writeProjectFilesInto(
  root: string,
  request: WriteFilesRequest,
  existingPath: string | null
): WriteFilesResult {
  const name = sanitizeFileName(request.project)
  const projectDir = existingPath && existsSync(existingPath) ? existingPath : resolveNewProjectDir(root, name)
  return writeFilesDirectlyInto(projectDir, request)
}

/**
 * `existingPath` is the current link's path when resuming a project across turns (see
 * findLibraryLinkByName in db/repository.ts) — null creates a fresh one under the shared
 * default root. `customWorkingDir` (from ModelOverrides.agentWorkingDir) changes this: when
 * set, that exact folder is always the target (created if it doesn't exist yet), never a
 * subfolder nested inside it — picking a specific folder is normally "work inside my
 * project", not "start a new one nested inside it".
 */
export function writeProjectFiles(
  request: WriteFilesRequest,
  existingPath: string | null,
  customWorkingDir?: string | null
): WriteFilesResult {
  const trimmedCustomDir = customWorkingDir?.trim()
  if (trimmedCustomDir) return writeFilesDirectlyInto(trimmedCustomDir, request)
  return writeProjectFilesInto(projectsRoot(), request, existingPath)
}

// "Expand the access" — the model previously only ever wrote blind, with no idea what (if
// anything) already existed in its working directory. There's no native tool-calling to let
// it ask for a file's contents mid-response (same constraint as everywhere else in this app),
// so instead the working directory's current state is folded into the system prompt up front:
// every relative path, plus the full contents of small text files. Noisy/generated
// directories are skipped, and both the per-file and total content budgets are capped so a
// large existing project doesn't blow out the request's token budget.
const SNAPSHOT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'target',
  'venv',
  '.venv',
  '__pycache__'
])
const SNAPSHOT_TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt', '.html', '.css', '.py', '.java',
  '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.php', '.yml', '.yaml', '.toml', '.sh', '.bat'
])
// Halved from the original 4000/8000: this gets resent in full on every single message while
// agentFileAccess is on, even a message that has nothing to do with the working directory —
// worth staying conservative here specifically since, unlike a one-off read, this is a
// recurring per-message cost for as long as the toggle stays on.
const SNAPSHOT_MAX_FILE_CHARS = 2000
const SNAPSHOT_MAX_TOTAL_CHARS = 4000

export interface WorkingDirectorySnapshot {
  /** Every file's path relative to the working directory, so the model can reference real
   * paths even for files whose content wasn't small enough to include below. */
  paths: string[]
  excerpts: { path: string; content: string }[]
}

// Hard stop for the walk itself, independent of the (lower) warn threshold below — a
// pathological pick (a whole drive, the user's home directory) must not hang the main
// process on a synchronous multi-million-entry walk; past this point "too many" is already
// established regardless of the exact count.
const WALK_HARD_CAP = 2000

function safeReadDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // permission-denied or similar on an arbitrary user-picked path — skip, don't crash
  }
}

function walkForSnapshot(dir: string, root: string, paths: string[]): void {
  if (paths.length >= WALK_HARD_CAP) return
  for (const entry of safeReadDir(dir)) {
    if (paths.length >= WALK_HARD_CAP) return
    if (entry.isDirectory()) {
      if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue
      walkForSnapshot(join(dir, entry.name), root, paths)
    } else {
      paths.push(relative(root, join(dir, entry.name)))
    }
  }
}

/** null when `root` doesn't exist yet (a brand-new working directory, or the default project
 * folder before the agent has ever written anything into it) — nothing to snapshot. */
export function snapshotWorkingDirectory(root: string): WorkingDirectorySnapshot | null {
  if (!existsSync(root)) return null
  const paths: string[] = []
  walkForSnapshot(root, root, paths)

  let budget = SNAPSHOT_MAX_TOTAL_CHARS
  const excerpts: { path: string; content: string }[] = []
  for (const path of paths) {
    if (budget <= 0) break
    if (!SNAPSHOT_TEXT_EXTENSIONS.has(extname(path))) continue
    const content = readFileSync(join(root, path), 'utf8')
    if (content.length > SNAPSHOT_MAX_FILE_CHARS) continue
    excerpts.push({ path, content: content.slice(0, budget) })
    budget -= content.length
  }
  return { paths, excerpts }
}

// A folder with far more files than this gets its ENTIRE listing dumped into the system
// prompt on every single turn (snapshotWorkingDirectory doesn't cap the listing itself, only
// the excerpt content) — worth warning about before the user picks it, not after they notice
// every message got slow/expensive.
export const WORKING_DIR_WARN_FILE_COUNT = 150

export interface WorkingDirSizeCheck {
  fileCount: number
  tooMany: boolean
}

/** Cheap pre-check for the folder picker in Settings — same walk/skip-list as the real
 * snapshot, so "too many files" means exactly what it will actually cost on every message
 * afterward. null when the path doesn't exist yet (a brand-new folder — nothing to warn
 * about). */
export function checkWorkingDirSize(root: string): WorkingDirSizeCheck | null {
  const snapshot = snapshotWorkingDirectory(root)
  if (!snapshot) return null
  return { fileCount: snapshot.paths.length, tooMany: snapshot.paths.length > WORKING_DIR_WARN_FILE_COUNT }
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

  // A custom working directory is written into directly — no per-project subfolder nesting,
  // even though the model still supplies (and this ignores) its own "project" name, and even
  // when the folder doesn't exist yet.
  const customDir = join(testRoot, 'my-existing-repo')
  const customResult = writeProjectFiles(
    { project: 'whatever the model called it', files: [{ path: 'index.js', content: 'console.log(1)' }] },
    null,
    customDir
  )
  assert.strictEqual(customResult.projectPath, customDir, 'writes straight into the configured folder, not a subfolder')
  assert.ok(existsSync(join(customDir, 'index.js')))

  // A second call with a different (ignored) project name still lands in the same folder and
  // adds to it, rather than creating a sibling.
  const customResult2 = writeProjectFiles(
    { project: 'a totally different name', files: [{ path: 'style.css', content: 'body{}' }] },
    null,
    customDir
  )
  assert.strictEqual(customResult2.projectPath, customDir)
  assert.ok(existsSync(join(customDir, 'index.js')), 'earlier file in the same folder survives')
  assert.ok(existsSync(join(customDir, 'style.css')))

  // --- snapshotWorkingDirectory ---

  assert.strictEqual(snapshotWorkingDirectory(join(testRoot, 'does-not-exist')), null)

  const snapshot = snapshotWorkingDirectory(customDir)
  assert.deepStrictEqual(snapshot?.paths.sort(), ['index.js', 'style.css'])
  const excerptPaths = snapshot?.excerpts.map((e) => e.path).sort()
  assert.deepStrictEqual(excerptPaths, ['index.js', 'style.css'], 'small text files get their content included')
  assert.strictEqual(snapshot?.excerpts.find((e) => e.path === 'index.js')?.content, 'console.log(1)')

  const skipDir = join(testRoot, 'skip-test')
  mkdirSync(join(skipDir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(skipDir, 'node_modules', 'dep', 'index.js'), 'ignored', 'utf8')
  writeFileSync(join(skipDir, 'real.js'), 'kept', 'utf8')
  const skipSnapshot = snapshotWorkingDirectory(skipDir)
  assert.deepStrictEqual(skipSnapshot?.paths, ['real.js'], 'noisy directories like node_modules are skipped entirely')

  const bigDir = join(testRoot, 'big-file-test')
  mkdirSync(bigDir, { recursive: true })
  writeFileSync(join(bigDir, 'huge.js'), 'x'.repeat(SNAPSHOT_MAX_FILE_CHARS + 1), 'utf8')
  writeFileSync(join(bigDir, 'binary.png'), 'not really png bytes', 'utf8')
  const bigSnapshot = snapshotWorkingDirectory(bigDir)
  assert.deepStrictEqual(bigSnapshot?.paths.sort(), ['binary.png', 'huge.js'], 'still listed even when skipped')
  assert.deepStrictEqual(bigSnapshot?.excerpts, [], 'oversized file and non-text extension both excluded from content')

  // --- checkWorkingDirSize / WORKING_DIR_WARN_FILE_COUNT ---

  assert.strictEqual(checkWorkingDirSize(join(testRoot, 'does-not-exist')), null)

  const smallDir = join(testRoot, 'small-dir')
  mkdirSync(smallDir, { recursive: true })
  writeFileSync(join(smallDir, 'a.txt'), 'x', 'utf8')
  assert.deepStrictEqual(checkWorkingDirSize(smallDir), { fileCount: 1, tooMany: false })

  const bigCountDir = join(testRoot, 'many-files')
  mkdirSync(bigCountDir, { recursive: true })
  for (let i = 0; i < WORKING_DIR_WARN_FILE_COUNT + 1; i++) {
    writeFileSync(join(bigCountDir, `f${i}.txt`), '', 'utf8')
  }
  const bigCountCheck = checkWorkingDirSize(bigCountDir)
  assert.strictEqual(bigCountCheck?.fileCount, WORKING_DIR_WARN_FILE_COUNT + 1)
  assert.strictEqual(bigCountCheck?.tooMany, true, 'crosses the warn threshold')

  rmSync(testRoot, { recursive: true, force: true })
  console.log('agent-files self-check passed')
}
