// §5: reads the two efficiency-injection modules from resources/prompt-modules/ and builds
// the combined system-prompt string for a request. Kept out of the provider layer per the
// spec — every provider gets this uniformly, none of them know it exists.

import assert from 'node:assert'
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelOverrides, SessionDocument } from '@shared/models'

// Resolved lazily inside readModule(), not at module load, so this file stays importable
// (for extractDocumentUpdate's self-check below) outside a real Electron runtime — matching
// every other main-process module here. app.getAppPath() resolves relative to however the
// entry script was launched, not reliably the project root — in a packaged build resources/
// ships via extraResources under process.resourcesPath; in dev, __dirname is
// <project>/out/main, so the project root is two levels up.
function resourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources') : join(__dirname, '../../resources')
}

function readModule(filename: string): string {
  return readFileSync(join(resourcesDir(), 'prompt-modules', filename), 'utf8').trim()
}

// Document editing (the "working file" panel) is a plain response convention, not a
// provider feature — works identically across all eight providers since it's just text the
// model is asked to emit, no function-calling/tool-use API required.
const DOCUMENT_TAG = 'document'
const DOCUMENT_BLOCK_RE = /<document>([\s\S]*?)<\/document>/

function buildDocumentInstruction(doc: SessionDocument | null): string {
  const title = doc?.fileName?.trim() || 'Untitled document'
  const current = doc?.kind === 'text' ? doc.content : ''
  return [
    `You are collaboratively editing a document with the user, currently titled "${title}".`,
    current
      ? `Its current full content is:\n\n---\n${current}\n---`
      : 'It is currently empty — you are starting it from scratch.',
    `When your response should update the document, output the ENTIRE new version of it wrapped exactly like this, with nothing else inside the tags:\n<${DOCUMENT_TAG}>\n...full updated content...\n</${DOCUMENT_TAG}>`,
    'Only include that block when you are actually revising the document. For questions, explanations, or anything that is not a document edit, respond normally without it.'
  ].join('\n\n')
}

/** Pulls the last `<document>...</document>` block out of a response, if present. */
export function extractDocumentUpdate(
  responseText: string
): { content: string; remainder: string } | null {
  const match = responseText.match(DOCUMENT_BLOCK_RE)
  if (!match || match.index === undefined) return null
  const content = match[1].trim()
  const stitched = responseText.slice(0, match.index) + responseText.slice(match.index + match[0].length)
  // Removing the block leaves a gap where it sat — collapse runs of 3+ newlines (i.e. more
  // than one blank line) down to a single paragraph break instead of showing it.
  const remainder = stitched.replace(/\n{3,}/g, '\n\n').trim()
  return { content, remainder }
}

interface DocumentContext {
  document: SessionDocument | null
  modeEnabled: boolean
}

/** Combines the user's custom system prompt, any active efficiency modules, and the
 * document-editing instruction (when document mode is on), in that order. */
export function buildSystemPrompt(
  overrides: ModelOverrides | null | undefined,
  documentContext?: DocumentContext
): string | null {
  const parts: string[] = []
  if (overrides?.systemPrompt?.trim()) parts.push(overrides.systemPrompt.trim())
  if (overrides?.leanCoding) parts.push(readModule('lean-coding.md'))
  if (overrides?.fastReasoning) parts.push(readModule('fast-reasoning.md'))
  if (documentContext?.modeEnabled) parts.push(buildDocumentInstruction(documentContext.document))
  return parts.length > 0 ? parts.join('\n\n') : null
}

// --- self-check ---------------------------------------------------------------------
// Only extractDocumentUpdate — the rest of this file needs a real Electron app to read the
// resource files. No network/API key needed here either way.
if (require.main === module) {
  assert.strictEqual(extractDocumentUpdate('just a plain reply, no document block'), null)

  const onlyBlock = extractDocumentUpdate('<document>\nfull resume text\n</document>')
  assert.deepStrictEqual(onlyBlock, { content: 'full resume text', remainder: '' })

  const withCommentary = extractDocumentUpdate(
    "Sure, I tightened the bullet points.\n\n<document>\nJane Doe\nSoftware Engineer\n</document>\n\nLet me know if you want another pass."
  )
  assert.strictEqual(withCommentary?.content, 'Jane Doe\nSoftware Engineer')
  assert.strictEqual(
    withCommentary?.remainder,
    'Sure, I tightened the bullet points.\n\nLet me know if you want another pass.'
  )

  console.log('prompt-modules self-check passed')
}
