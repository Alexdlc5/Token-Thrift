// Writes an uploaded/generated file to userData/library/<sessionId>/ and records it in
// library_items — this is additive to the single-slot document panel (sessions.document_*),
// not a replacement: every file that ever passes through a session accumulates here, so
// there's a real per-session file history, not just "whatever's showing right now."

import assert from 'node:assert'
import { app } from 'electron'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { addLibraryItem, getLibraryItemPath } from './db/repository'
import type { LibraryItem } from '@shared/models'

function libraryDir(sessionId: string): string {
  return join(app.getPath('userData'), 'library', sessionId)
}

/** Strips anything that isn't safe in a filename across Windows/macOS/Linux. */
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 120) || 'file'
}

function parseDataUrl(dataUrl: string): { buffer: Buffer; mimeTypeFromUrl: string | null } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s)
  if (!match) throw new Error('Expected a data: URL')
  return { buffer: Buffer.from(match[2], 'base64'), mimeTypeFromUrl: match[1] }
}

/** Decodes a data: URL and saves it into the session's library folder + DB row. */
export function saveToLibrary(
  sessionId: string,
  dataUrl: string,
  mimeType: string,
  fileName: string,
  description: string | null
): LibraryItem {
  const { buffer } = parseDataUrl(dataUrl)
  const dir = libraryDir(sessionId)
  mkdirSync(dir, { recursive: true })
  const diskName = `${randomUUID()}-${sanitizeFileName(fileName)}`
  const filePath = join(dir, diskName)
  writeFileSync(filePath, buffer)

  return addLibraryItem({
    sessionId,
    fileName,
    filePath,
    mimeType,
    sizeBytes: buffer.byteLength,
    description
  })
}

export { getLibraryItemPath }

/** Removes a session's whole library folder from disk — pair with repository.deleteSession(),
 * which only removes the DB rows. Safe to call even if the session never saved a file. */
export function deleteLibraryDir(sessionId: string): void {
  rmSync(libraryDir(sessionId), { recursive: true, force: true })
}

// --- self-check ---------------------------------------------------------------------
// Only the pure parsing/sanitizing helpers — saveToLibrary() itself needs a real Electron
// app + database.
if (require.main === module) {
  assert.strictEqual(sanitizeFileName('resume.pdf'), 'resume.pdf')
  assert.strictEqual(sanitizeFileName('../../etc/passwd'), '.._.._etc_passwd', 'path separators stripped')
  assert.strictEqual(sanitizeFileName('a"b*c?d'), 'a_b_c_d', 'reserved characters stripped')
  assert.strictEqual(sanitizeFileName(''), 'file', 'empty name falls back to a default')
  assert.strictEqual(sanitizeFileName('x'.repeat(200)).length, 120, 'long names are capped')

  const { buffer, mimeTypeFromUrl } = parseDataUrl('data:image/png;base64,aGVsbG8=')
  assert.strictEqual(buffer.toString('utf8'), 'hello')
  assert.strictEqual(mimeTypeFromUrl, 'image/png')

  assert.throws(() => parseDataUrl('not-a-data-url'), /data: URL/)

  console.log('library self-check passed')
}
