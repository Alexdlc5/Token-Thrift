// §5: reads the two efficiency-injection modules from resources/prompt-modules/ and builds
// the combined system-prompt string for a request. Kept out of the provider layer per the
// spec — every provider gets this uniformly, none of them know it exists.

import assert from 'node:assert'
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelOverrides, SessionDocument } from '@shared/models'
import type { WorkingDirectorySnapshot, WriteFilesRequest } from './agent-files'

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

// A loaded image/PDF is never editable (DocumentPanel forces document-edit mode off the
// moment a binary file is loaded), so it never went through buildDocumentInstruction above —
// the model got no mention of it at all, and free models tend to fall back to a flat "I'm a
// text-based AI, I can't see images" denial instead of using whatever description they were
// actually given elsewhere in the conversation (the [Image loaded: ...] system message from
// handleFileSideEffects in main/index.ts). This runs whenever a file is loaded, independent
// of edit mode, so that denial has no reason to happen.
function buildReferenceFileInstruction(doc: SessionDocument): string {
  const name = doc.fileName?.trim() || 'a file'
  const kind = doc.mimeType?.startsWith('image/') ? 'image' : doc.mimeType === 'application/pdf' ? 'PDF' : 'file'
  return [
    `The user has loaded a reference ${kind} into the document panel above, named "${name}".`,
    'An earlier system message in this conversation already read it in detail — layout by ' +
      'region, colors, exact counts of people/animals/objects, any text found — and that ' +
      `description is your only source of truth for it. When asked about the ${kind} ` +
      '(what\'s in a corner, what color something is, how many of something there are, etc.), ' +
      "answer directly and confidently from that description, the way you would if you'd " +
      'looked at it yourself — do not hedge with phrases like "based on the description" or ' +
      '"I was told", and do not say you are unable to see images. Only fall back to saying ' +
      "you can't see it if that earlier message itself says the read failed."
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
    'You cannot generate images directly, but this app can — when the user asks you to ' +
      'CREATE, DRAW, or GENERATE a new image, do not say you are unable to. Instead, write ' +
      'a single detailed, vivid image-generation prompt describing exactly what to create, ' +
      'wrapped like this:',
    `<${IMAGE_TAG}>a detailed description of the image to generate</${IMAGE_TAG}>`,
    'Only use this when a brand-new image is actually being requested — never for unrelated ' +
      'replies, and never when the user is instead asking you to describe, analyze, read, or ' +
      'answer a question about an image or file they already loaded into the document panel. ' +
      'For that, answer from whatever description of it you were already given above — if ' +
      'none was given or it says the read failed, say plainly that you cannot see the file, ' +
      'rather than generating an unrelated image as a substitute.'
  ].join('\n\n')
}

/** Pulls the last `<generate_image>...</generate_image>` block out of a response, if present. */
export function extractImageGenerationRequest(
  responseText: string
): { prompt: string; remainder: string } | null {
  const result = extractTaggedBlock(responseText, IMAGE_TAG)
  return result ? { prompt: result.inner, remainder: result.remainder } : null
}

// Agent-level file access: same response-convention pattern as document editing and image
// generation, not a native tool-calling integration — this app has to work across ten
// free-tier providers, several of which don't support (or don't reliably support) function
// calling, so every "capability" here is plain text the model emits and main/index.ts parses.
// Plain "### FILE: path" markers instead of a JSON body: asking a weak free model to emit
// properly-escaped JSON containing verbatim multi-file source code is exactly the kind of
// thing that reliably breaks (unescaped quotes/newlines) — raw text with a delimiter line has
// nothing to escape. See main/agent-files.ts for where these paths actually get written
// (including the path-traversal guard) and db/repository.ts's findLibraryLinkByName for how a
// same-named project resumes into its existing folder across turns instead of duplicating.
const WRITE_FILES_TAG = 'write_files'

/** `snapshot` is the working directory's current contents (see agent-files.ts) — folded into
 * the instruction so the model can write INTO an existing project accurately (real paths, real
 * existing code to extend) instead of only ever scaffolding blind from nothing. */
function buildFileAgentInstruction(snapshot: WorkingDirectorySnapshot | null): string {
  const parts = [
    'You can write real files to disk for the user — when asked to build, scaffold, ' +
      'create, or modify an app/script/project (not just explain or show a snippet), do not ' +
      'just print code blocks for the user to copy by hand. Write the actual files using ' +
      'this exact format, with nothing else inside the tags:',
    `<${WRITE_FILES_TAG}>\n### PROJECT: <short-project-name>\n### FILE: <relative/path/one.ext>\n<full file contents>\n### FILE: <relative/path/two.ext>\n<full file contents>\n</${WRITE_FILES_TAG}>`,
    'Rules: give every file its FULL contents, never a diff or a "// ... rest unchanged" ' +
      'placeholder — each ### FILE section completely replaces that file, even one that ' +
      'already exists (see below) and you are only changing part of. Use relative paths ' +
      'only (e.g. "src/main.js" — never "/etc/...", "C:\\...", or anything starting with ' +
      '"../"). Keep the project name short and exactly the same across a conversation about ' +
      'the same project, so a later request ("now add X") lands in the same project instead ' +
      'of creating a duplicate. Only use this when real files are actually being created or ' +
      "changed — for questions, explanations, or a single snippet that isn't meant to be run " +
      'as-is, just answer normally without it.'
  ]

  if (snapshot && snapshot.paths.length > 0) {
    const fileList = snapshot.paths.map((p) => `- ${p}`).join('\n')
    const excerptText = snapshot.excerpts
      .map((e) => `### ${e.path}\n${e.content}`)
      .join('\n\n')
    parts.push(
      [
        'Your working directory already has files in it — this is an existing project, not a ' +
          'blank slate. Its full file listing:',
        fileList,
        excerptText
          ? 'Current contents of the smaller text files in it (larger or binary files are ' +
              'listed above but not shown):\n\n' + excerptText
          : null,
        'When the user asks you to change something that already exists, reuse its real path ' +
          'from the listing above and the same PROJECT name this project was created under — ' +
          "don't guess a new path or start a parallel copy."
      ]
        .filter((section): section is string => Boolean(section))
        .join('\n\n')
    )
  }

  return parts.join('\n\n')
}

/** Splits a `<write_files>` block's inner text on its `### PROJECT:`/`### FILE:` markers.
 * Plain text markers, not JSON — see the comment above buildFileAgentInstruction for why. */
function parseWriteFilesBlock(inner: string): WriteFilesRequest | null {
  const projectMatch = inner.match(/^### PROJECT:\s*(.+)$/m)
  if (!projectMatch || projectMatch.index === undefined) return null
  const project = projectMatch[1].trim()
  if (!project) return null

  const afterProject = inner.slice(projectMatch.index + projectMatch[0].length)
  const parts = afterProject.split(/^### FILE:\s*(.+)$/m)
  const files: { path: string; content: string }[] = []
  for (let i = 1; i < parts.length; i += 2) {
    const path = parts[i].trim()
    if (path) files.push({ path, content: (parts[i + 1] ?? '').trim() })
  }
  return files.length > 0 ? { project, files } : null
}

/** Pulls the last `<write_files>...</write_files>` block out of a response and parses its
 * project/file markers, if present and well-formed. */
export function extractWriteFilesRequest(
  responseText: string
): { request: WriteFilesRequest; remainder: string } | null {
  const result = extractTaggedBlock(responseText, WRITE_FILES_TAG)
  if (!result) return null
  const request = parseWriteFilesBlock(result.inner)
  return request ? { request, remainder: result.remainder } : null
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

/**
 * Index of the earliest document/image-generation opening tag in an in-progress streamed
 * response, or -1 if neither has started yet. Lets the caller stop forwarding raw chunks to
 * the renderer the moment a tag begins — otherwise the user watches the literal
 * "<generate_image>a crisp glossy red apple..." prompt text type itself out live, instead of
 * just seeing the thinking indicator until the real result (the generated image, or the
 * updated document) is ready.
 */
export function findEarliestTagStart(text: string): number {
  const indices = [`<${DOCUMENT_TAG}>`, `<${IMAGE_TAG}>`, `<${WRITE_FILES_TAG}>`]
    .map((tag) => text.indexOf(tag))
    .filter((i) => i !== -1)
  return indices.length > 0 ? Math.min(...indices) : -1
}

interface DocumentContext {
  document: SessionDocument | null
  modeEnabled: boolean
}

/** Combines the user's custom system prompt, any active efficiency modules, and the
 * document-editing/image-generation/agent-file instructions (when each is on), in that order.
 * `workingDirSnapshot` is only meaningful (and only computed by the caller) when
 * agentFileAccess is on — see agent-files.ts's snapshotWorkingDirectory. */
export function buildSystemPrompt(
  overrides: ModelOverrides | null | undefined,
  documentContext?: DocumentContext,
  workingDirSnapshot?: WorkingDirectorySnapshot | null
): string | null {
  const parts: string[] = []
  if (overrides?.systemPrompt?.trim()) parts.push(overrides.systemPrompt.trim())
  if (overrides?.leanCoding) parts.push(readModule('lean-coding.md'))
  if (overrides?.fastReasoning) parts.push(readModule('fast-reasoning.md'))
  if (documentContext?.modeEnabled) parts.push(buildDocumentInstruction(documentContext.document))
  if (documentContext?.document?.kind === 'file') parts.push(buildReferenceFileInstruction(documentContext.document))
  if (overrides?.imageGeneration) parts.push(buildImageGenerationInstruction())
  if (overrides?.agentFileAccess) parts.push(buildFileAgentInstruction(workingDirSnapshot ?? null))
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

  assert.strictEqual(findEarliestTagStart('just chatting'), -1)
  assert.strictEqual(findEarliestTagStart('Sure! <generate_image>a red apple'), 6)
  assert.strictEqual(findEarliestTagStart('Here: <document>\ncontent'), 6)
  assert.strictEqual(findEarliestTagStart('Sure! <write_files>\n### PROJECT: x'), 6)
  // Both tags present (shouldn't normally happen, but the earliest one wins either way).
  assert.strictEqual(findEarliestTagStart('a<document>b<generate_image>c'), 1)

  assert.strictEqual(extractWriteFilesRequest('just chatting, nothing to build'), null)

  const project = extractWriteFilesRequest(
    "Here's your Pong game!\n\n" +
      '<write_files>\n' +
      '### PROJECT: pong-game\n' +
      '### FILE: package.json\n' +
      '{\n  "name": "pong-game"\n}\n' +
      '### FILE: main.js\n' +
      "const { app } = require('electron')\n" +
      '</write_files>\n\n' +
      'Run npm install then npm start.'
  )
  assert.strictEqual(project?.request.project, 'pong-game')
  assert.deepStrictEqual(project?.request.files, [
    { path: 'package.json', content: '{\n  "name": "pong-game"\n}' },
    { path: 'main.js', content: "const { app } = require('electron')" }
  ])
  assert.strictEqual(project?.remainder, "Here's your Pong game!\n\nRun npm install then npm start.")

  // Opened but never closed (cut off mid-generation) — same unclosed-tag fallback as the
  // other tags, so raw block syntax never leaks into the visible reply.
  const unclosedFiles = extractWriteFilesRequest(
    '<write_files>\n### PROJECT: half-done\n### FILE: index.html\n<h1>hi</h1'
  )
  assert.strictEqual(unclosedFiles?.request.project, 'half-done')
  assert.deepStrictEqual(unclosedFiles?.request.files, [{ path: 'index.html', content: '<h1>hi</h1' }])

  // A block with no FILE markers at all isn't a real request — don't hand back an empty
  // project that would just create an empty folder.
  assert.strictEqual(extractWriteFilesRequest('<write_files>\n### PROJECT: nothing here\n</write_files>'), null)
  // No PROJECT marker at all — malformed, ignore it rather than guess a name.
  assert.strictEqual(
    extractWriteFilesRequest('<write_files>\n### FILE: a.txt\ncontent\n</write_files>'),
    null
  )

  // buildSystemPrompt with agentFileAccess doesn't touch readModule() (leanCoding/
  // fastReasoning both off here), so this is safe to exercise without a real Electron app.
  const noSnapshotPrompt = buildSystemPrompt({ agentFileAccess: true }, undefined, null)
  assert.ok(noSnapshotPrompt?.includes('<write_files>'), 'agent file instruction is included when the override is on')
  assert.ok(!noSnapshotPrompt?.includes('working directory already has files'), 'no existing-project section with no snapshot')

  const withSnapshotPrompt = buildSystemPrompt({ agentFileAccess: true }, undefined, {
    paths: ['index.js', 'assets/logo.png'],
    excerpts: [{ path: 'index.js', content: "console.log('hi')" }]
  })
  assert.ok(withSnapshotPrompt?.includes('- index.js'), 'full file listing is included')
  assert.ok(withSnapshotPrompt?.includes('- assets/logo.png'), 'files without an excerpt are still listed')
  assert.ok(withSnapshotPrompt?.includes("console.log('hi')"), 'small text file content is included verbatim')

  const emptySnapshotPrompt = buildSystemPrompt({ agentFileAccess: true }, undefined, { paths: [], excerpts: [] })
  assert.ok(
    !emptySnapshotPrompt?.includes('working directory already has files'),
    'an empty working directory is treated the same as no snapshot at all'
  )

  console.log('prompt-modules self-check passed')
}
