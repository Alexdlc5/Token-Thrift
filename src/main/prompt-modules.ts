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
    `Editing a document titled "${title}" with the user.`,
    current ? `Current content:\n\n---\n${current}\n---` : 'Currently empty.',
    `To update it, output its ENTIRE new content wrapped in <${DOCUMENT_TAG}>...</${DOCUMENT_TAG}> — nothing else inside the tags.`,
    'Only include this block when actually revising the document; otherwise respond normally.'
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
    `A reference ${kind} named "${name}" is loaded above.`,
    'An earlier system message already described it in detail (layout, colors, counts, any ' +
      "text) — that's your only source of truth. Answer questions about it directly and " +
      'confidently, as if you\'d seen it yourself — no hedging ("based on the description"), ' +
      "no claiming you can't view images. Only say you can't see it if that earlier message " +
      'says the read failed.'
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
    "This app can generate images for you — when asked to CREATE/DRAW/GENERATE a new image, " +
      "don't say you can't. Write a vivid image prompt wrapped like this:",
    `<${IMAGE_TAG}>a detailed description of the image to generate</${IMAGE_TAG}>`,
    'Only for genuinely new images — never when the user is asking about a file already ' +
      'loaded above (answer from its description instead, or say the read failed; ' +
      "don't generate a substitute)."
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
    "You can write real files to disk — when asked to build/scaffold/modify an app/script/" +
      "project, don't just print code blocks to copy by hand; write the actual files in " +
      'this format:',
    `<${WRITE_FILES_TAG}>\n### PROJECT: <short-project-name>\n### FILE: <relative/path/one.ext>\n<full file contents>\n### FILE: <relative/path/two.ext>\n<full file contents>\n</${WRITE_FILES_TAG}>`,
    'Rules: FULL file contents only, never a diff or "...rest unchanged" — each FILE section ' +
      'fully replaces that file. Relative paths only (never absolute or "../"). Keep the ' +
      'PROJECT name identical across a conversation about the same project so later edits ' +
      'land in the same place. Only for actual file creation/changes — not for a single ' +
      'snippet or explanation. Do NOT wrap a FILE section in a markdown code fence (no ``` ' +
      "lines) — the content between FILE markers is written to disk exactly as-is, so a " +
      'fence line becomes a broken first/last line of the real file.'
  ]

  if (snapshot && snapshot.paths.length > 0) {
    const fileList = snapshot.paths.map((p) => `- ${p}`).join('\n')
    const excerptText = snapshot.excerpts
      .map((e) => `### ${e.path}\n${e.content}`)
      .join('\n\n')
    parts.push(
      [
        'Working directory contents (existing project, not blank):',
        fileList,
        excerptText ? "Smaller text files' current contents (others listed above, not shown):\n\n" + excerptText : null,
        "Reuse existing paths/PROJECT name when editing — don't guess new ones."
      ]
        .filter((section): section is string => Boolean(section))
        .join('\n\n')
    )
  }

  return parts.join('\n\n')
}

/** Weaker models wrap a FILE's content in a markdown code fence out of habit, even though the
 * instruction above asks for raw content — left in, the fence lines get written into the
 * actual file and break it (e.g. a .py file whose first real line is a literal "```python").
 * Strips a leading fence unconditionally; the trailing one only if present, since a response
 * cut off mid-generation won't have gotten around to closing it. */
function stripCodeFence(content: string): string {
  const lines = content.split('\n')
  if (lines.length > 0 && /^```\S*$/.test(lines[0].trim())) {
    lines.shift()
    if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop()
    return lines.join('\n').trim()
  }
  return content
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
    if (path) files.push({ path, content: stripCodeFence((parts[i + 1] ?? '').trim()) })
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

// "Test and improve code" — a real command run in the agent's working directory (see
// main/code-execution.ts), separate from and gated behind its own override so a user who
// only wants file writing never pays for this instruction. One command at a time, not a
// shell script: keeps the ask simple for a weak model and keeps the denylist/timeout
// reasoning in code-execution.ts meaningful (one clear thing to sandbox, not an arbitrary
// multi-line script).
const RUN_COMMAND_TAG = 'run_command'

function buildCodeExecutionInstruction(): string {
  return [
    'You can also run a real command in the working directory to test what you wrote — ' +
      'wrap ONE shell command like this:',
    `<${RUN_COMMAND_TAG}>the exact command, e.g. npm test</${RUN_COMMAND_TAG}>`,
    "You'll see its real output (or the task monitor will) and can fix problems on your " +
      'next turn. Only when you actually want to run something — not for every response.'
  ].join('\n\n')
}

/** Pulls the last `<run_command>...</run_command>` block out of a response, if present. */
export function extractRunCommandRequest(
  responseText: string
): { command: string; remainder: string } | null {
  const result = extractTaggedBlock(responseText, RUN_COMMAND_TAG)
  return result ? { command: result.inner, remainder: result.remainder } : null
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
  const indices = [`<${DOCUMENT_TAG}>`, `<${IMAGE_TAG}>`, `<${WRITE_FILES_TAG}>`, `<${RUN_COMMAND_TAG}>`]
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
  if (overrides?.agentCodeExecution) parts.push(buildCodeExecutionInstruction())
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

  // A weak model wrapped a FILE's content in a markdown fence anyway — must not end up as a
  // literal "```python" line in the actual file written to disk.
  const fencedFile = extractWriteFilesRequest(
    '<write_files>\n### PROJECT: oregon-trail\n### FILE: game.py\n```python\nprint("hi")\n```\n</write_files>'
  )
  assert.deepStrictEqual(fencedFile?.request.files, [{ path: 'game.py', content: 'print("hi")' }])

  // Same, but cut off mid-generation before the fence ever closed — strip the leading fence
  // regardless (this is exactly the Oregon Trail bug report: fence present, closer never sent).
  const fencedUnclosedFile = extractWriteFilesRequest(
    '<write_files>\n### PROJECT: oregon-trail\n### FILE: game.py\n```python\nprint("hi")'
  )
  assert.deepStrictEqual(fencedUnclosedFile?.request.files, [{ path: 'game.py', content: 'print("hi")' }])

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
  assert.ok(!noSnapshotPrompt?.includes('Working directory contents'), 'no existing-project section with no snapshot')

  const withSnapshotPrompt = buildSystemPrompt({ agentFileAccess: true }, undefined, {
    paths: ['index.js', 'assets/logo.png'],
    excerpts: [{ path: 'index.js', content: "console.log('hi')" }]
  })
  assert.ok(withSnapshotPrompt?.includes('- index.js'), 'full file listing is included')
  assert.ok(withSnapshotPrompt?.includes('- assets/logo.png'), 'files without an excerpt are still listed')
  assert.ok(withSnapshotPrompt?.includes("console.log('hi')"), 'small text file content is included verbatim')

  const emptySnapshotPrompt = buildSystemPrompt({ agentFileAccess: true }, undefined, { paths: [], excerpts: [] })
  assert.ok(
    !emptySnapshotPrompt?.includes('Working directory contents'),
    'an empty working directory is treated the same as no snapshot at all'
  )

  assert.strictEqual(extractRunCommandRequest('just chatting, nothing to run'), null)

  const runClosed = extractRunCommandRequest(
    "Let's verify it works.\n\n<run_command>npm test</run_command>\n\nI'll check the output."
  )
  assert.strictEqual(runClosed?.command, 'npm test')
  assert.strictEqual(runClosed?.remainder, "Let's verify it works.\n\nI'll check the output.")

  // Opened but never closed — same unclosed-tag fallback as the other tags.
  const runUnclosed = extractRunCommandRequest('<run_command>node index.js')
  assert.strictEqual(runUnclosed?.command, 'node index.js')
  assert.strictEqual(runUnclosed?.remainder, '')

  // An opening tag with nothing after it isn't a real request.
  assert.strictEqual(extractRunCommandRequest('sure, one sec <run_command>'), null)

  const runPrompt = buildSystemPrompt({ agentCodeExecution: true })
  assert.ok(runPrompt?.includes('<run_command>'), 'code execution instruction is included when the override is on')
  assert.ok(!buildSystemPrompt({})?.includes('<run_command>'), 'omitted entirely when the override is off')

  console.log('prompt-modules self-check passed')
}
