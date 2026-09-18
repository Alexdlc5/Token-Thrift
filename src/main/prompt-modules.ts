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

/**
 * Pulls a `<tag>...</tag>` block out of a response. Also handles the tag being opened but
 * never closed — a weaker free model cut off mid-generation, or one that just doesn't
 * follow the closing-tag convention precisely, would otherwise leave the raw `<tag>...`
 * text sitting in the visible chat message forever. Treating "opened, never closed" as
 * "everything after the opening tag is the content" is strictly better than that.
 */
function extractTaggedBlock(text: string, tag: string): { inner: string; remainder: string } | null {
  const closedMatch = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  if (closedMatch && closedMatch.index !== undefined) {
    const inner = closedMatch[1].trim()
    const stitched = text.slice(0, closedMatch.index) + text.slice(closedMatch.index + closedMatch[0].length)
    // Removing the block leaves a gap where it sat — collapse runs of 3+ newlines (i.e.
    // more than one blank line) down to a single paragraph break instead of showing it.
    return { inner, remainder: stitched.replace(/\n{3,}/g, '\n\n').trim() }
  }

  const openMatch = text.match(new RegExp(`<${tag}>([\\s\\S]*)$`))
  if (openMatch && openMatch.index !== undefined) {
    const inner = openMatch[1].trim()
    if (!inner) return null
    return { inner, remainder: text.slice(0, openMatch.index).trim() }
  }

  return null
}

// Document editing (the "working file" panel) is a plain response convention, not a
// provider feature — works identically across all eight providers since it's just text the
// model is asked to emit, no function-calling/tool-use API required.
const DOCUMENT_TAG = 'document'

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
  const result = extractTaggedBlock(responseText, DOCUMENT_TAG)
  return result ? { content: result.inner, remainder: result.remainder } : null
}

// Image generation: same convention pattern as the document block. No chat provider here
// can generate images itself, so the model is told to hand off a prompt instead of just
// apologizing — main/index.ts catches the tag and calls image-providers/cloudflare-image.ts.
const IMAGE_TAG = 'generate_image'

function buildImageGenerationInstruction(): string {
  return [
    'You cannot generate images directly, but this app can — when the user asks for an ' +
      'image (or something that clearly calls for one), do not say you are unable to. ' +
      'Instead, write a single detailed, vivid image-generation prompt describing exactly ' +
      'what to create, wrapped like this:',
    `<${IMAGE_TAG}>a detailed description of the image to generate</${IMAGE_TAG}>`,
    'Only use this when an image is actually being requested — never for unrelated replies.'
  ].join('\n\n')
}

/** Pulls the last `<generate_image>...</generate_image>` block out of a response, if present. */
export function extractImageGenerationRequest(
  responseText: string
): { prompt: string; remainder: string } | null {
  const result = extractTaggedBlock(responseText, IMAGE_TAG)
  return result ? { prompt: result.inner, remainder: result.remainder } : null
}

// Some free/weaker models are fine-tuned on agentic tool-calling data and emit their own
// trained tool-call syntax (e.g. Hermes-style <|tool_call_start|>[fn(...)]<|tool_call_end|>)
// even though this app never sends a `tools` schema — seen in the wild triggered by the
// document-editing instruction above. This app doesn't execute those calls (out of scope),
// but raw control tokens and call syntax should never be shown to the user as if they were
// a real reply.
const TOOL_CALL_BLOCK_RE = /<\|tool_call_start\|>[\s\S]*?<\|tool_call_end\|>/gi
const STRAY_SPECIAL_TOKEN_RE = /<\|[a-z_]+\|>/gi

export function sanitizeAssistantText(text: string): string {
  return text
    .replace(TOOL_CALL_BLOCK_RE, '_(model attempted an unsupported tool call — ignored)_')
    .replace(STRAY_SPECIAL_TOKEN_RE, '')
    .trim()
}

interface DocumentContext {
  document: SessionDocument | null
  modeEnabled: boolean
}

/** Combines the user's custom system prompt, any active efficiency modules, and the
 * document-editing/image-generation instructions (when each is on), in that order. */
export function buildSystemPrompt(
  overrides: ModelOverrides | null | undefined,
  documentContext?: DocumentContext
): string | null {
  const parts: string[] = []
  if (overrides?.systemPrompt?.trim()) parts.push(overrides.systemPrompt.trim())
  if (overrides?.leanCoding) parts.push(readModule('lean-coding.md'))
  if (overrides?.fastReasoning) parts.push(readModule('fast-reasoning.md'))
  if (documentContext?.modeEnabled) parts.push(buildDocumentInstruction(documentContext.document))
  if (overrides?.imageGeneration) parts.push(buildImageGenerationInstruction())
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

  assert.strictEqual(extractImageGenerationRequest('just chatting, no image here'), null)
  const imageOnly = extractImageGenerationRequest(
    '<generate_image>a red apple on a wooden table, soft lighting</generate_image>'
  )
  assert.deepStrictEqual(imageOnly, {
    prompt: 'a red apple on a wooden table, soft lighting',
    remainder: ''
  })
  const imageWithCommentary = extractImageGenerationRequest(
    "Sure, here you go!\n\n<generate_image>a cyberpunk cat</generate_image>\n\nLet me know what you think."
  )
  assert.strictEqual(imageWithCommentary?.prompt, 'a cyberpunk cat')
  assert.strictEqual(imageWithCommentary?.remainder, 'Sure, here you go!\n\nLet me know what you think.')

  // The model opened the tag but the response ended before closing it (cut off, or the
  // model just never learned to close it) — must not leave the raw tag visible.
  const unclosedImage = extractImageGenerationRequest(
    '<generate_image>A crisp, glossy red apple on a dark wooden table, soft daylight'
  )
  assert.deepStrictEqual(unclosedImage, {
    prompt: 'A crisp, glossy red apple on a dark wooden table, soft daylight',
    remainder: ''
  })
  const unclosedDocument = extractDocumentUpdate('Here is the draft:\n\n<document>\nJane Doe\nEngineer')
  assert.strictEqual(unclosedDocument?.content, 'Jane Doe\nEngineer')
  assert.strictEqual(unclosedDocument?.remainder, 'Here is the draft:')
  // An opening tag with literally nothing after it isn't a real request — don't treat an
  // empty string as content.
  assert.strictEqual(extractImageGenerationRequest('thinking about it... <generate_image>'), null)

  assert.strictEqual(sanitizeAssistantText('a perfectly normal reply'), 'a perfectly normal reply')
  assert.strictEqual(
    sanitizeAssistantText("<|tool_call_start|>[write(content='hi', path='f.txt')]<|tool_call_end|>"),
    '_(model attempted an unsupported tool call — ignored)_'
  )
  assert.strictEqual(
    sanitizeAssistantText('Sure thing!<|im_end|> Here is the answer.'),
    'Sure thing! Here is the answer.'
  )

  console.log('prompt-modules self-check passed')
}
