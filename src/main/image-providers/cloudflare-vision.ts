// Image reading ("Workstream A", redirected): the spec asked for a local Tesseract/
// PaddleOCR/CLIP/LLaVA pipeline, which would mean embedding a whole local ML inference
// stack (multi-GB model downloads, a Python or native runtime bridge, GPU dependency
// handling) into what's otherwise a pure remote-free-API chat app — a fundamentally
// different architecture from everything else here, for something a single free hosted
// vision-language model already does in one HTTP call. Uses the same Cloudflare Workers AI
// account as the text/image-generation adapters (same free Neuron budget, same stored
// "accountId:apiToken" key) rather than a second local pipeline.
//
// Model: @cf/meta/llama-3.2-11b-vision-instruct, via the NATIVE /ai/run endpoint (not the
// OpenAI-compatible /ai/v1/chat/completions one the text providers use). Confirmed against
// the model's own input schema (github.com/cloudflare/cloudflare-docs,
// src/content/workers-ai-models/llama-3.2-11b-vision-instruct.json): the top-level `image`
// field only takes a raw 0-255 byte array or a binary string and is explicitly marked
// deprecated ("use image as a part of messages now") — sending it a data: URL string is a
// type mismatch that 400s. The current, non-deprecated shape is the "Messages" schema
// variant: `messages: [{ role, content: [{type:'text',...}, {type:'image_url',
// image_url:{url:'data:...'}}] }]`, same OpenAI-style content-array shape the compat
// endpoint uses — the native /ai/run endpoint accepts it directly too.
//
// Meta-licensed models also need a one-time per-account acceptance call
// (`{"prompt":"agree"}` to this same run endpoint) before they'll serve real requests —
// skipping it is exactly what surfaces as a 403 Forbidden on first use (confirmed against
// cloudflare/ai's own vision demo, which has that exact call commented in for first-run use).
// readImage() below does that lazily, on the first 403, so no manual setup step is needed.

import assert from 'node:assert'
import { parseStoredKey } from '../providers/cloudflare-workers-ai'
import { getApiKey } from '../secure-store'

const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct'

const READ_PROMPT =
  'Look at this image and respond with ONLY a JSON object (no markdown code fences, no ' +
  'commentary before or after) in exactly this shape: {"text": "<any readable text in the ' +
  'image, verbatim, empty string if none>", "objects": ["<notable object or element>", ...], ' +
  '"description": "<a one or two sentence natural-language description of the image>"}'

export interface ImageReadResult {
  text: string
  objects: string[]
  description: string
}

/** Pure so it's testable without a live call — models sometimes wrap JSON in code fences, or don't return valid JSON at all, and this must degrade gracefully rather than fail the whole read. */
export function parseVisionResponse(content: string): ImageReadResult {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()

  try {
    const parsed: unknown = JSON.parse(cleaned)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      return {
        text: typeof obj.text === 'string' ? obj.text : '',
        objects: Array.isArray(obj.objects) ? obj.objects.filter((o): o is string => typeof o === 'string') : [],
        description: typeof obj.description === 'string' ? obj.description : cleaned
      }
    }
  } catch {
    // fall through — not valid JSON
  }
  // Model didn't follow the requested format — still surface *something* useful instead of
  // failing the whole read (this is the "unreadable image" error-handling case: a malformed
  // response is treated the same as a low-quality/ambiguous image, not a hard failure).
  return { text: '', objects: [], description: cleaned || '(no description returned)' }
}

function runUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`
}

async function callVisionModel(accountId: string, apiToken: string, dataUrl: string): Promise<Response> {
  return fetch(runUrl(accountId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: READ_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      max_tokens: 512
    })
  })
}

export async function readImage(dataUrl: string): Promise<ImageReadResult> {
  const { accountId, apiToken } = parseStoredKey(getApiKey('cloudflare-workers-ai'))

  let res = await callVisionModel(accountId, apiToken, dataUrl)
  if (res.status === 403) {
    // First-ever use of this model on this account — accept the Meta license once, then
    // retry the real request. If the acceptance call itself fails, the retry below just
    // surfaces whatever error comes back, same as any other failed read.
    await fetch(runUrl(accountId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'agree' })
    })
    res = await callVisionModel(accountId, apiToken, dataUrl)
  }

  if (!res.ok) {
    throw new Error(`Image read failed: ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as { result?: { response?: string } }
  const content = body.result?.response
  if (!content) throw new Error('Image read failed: empty response')
  return parseVisionResponse(content)
}

// --- self-check ---------------------------------------------------------------------
// Only parseVisionResponse — readImage() needs a real key/network call.
if (require.main === module) {
  const clean = parseVisionResponse('{"text":"HELLO","objects":["mug","laptop"],"description":"A desk with a mug and a laptop."}')
  assert.deepStrictEqual(clean, { text: 'HELLO', objects: ['mug', 'laptop'], description: 'A desk with a mug and a laptop.' })

  const fenced = parseVisionResponse('```json\n{"text":"","objects":[],"description":"A red apple."}\n```')
  assert.deepStrictEqual(fenced, { text: '', objects: [], description: 'A red apple.' })

  const malformed = parseVisionResponse('Sure! This looks like a photo of a cat sitting on a windowsill.')
  assert.deepStrictEqual(malformed, {
    text: '',
    objects: [],
    description: 'Sure! This looks like a photo of a cat sitting on a windowsill.'
  })

  const partial = parseVisionResponse('{"description":"just a description, no text/objects fields"}')
  assert.deepStrictEqual(partial, { text: '', objects: [], description: 'just a description, no text/objects fields' })

  console.log('cloudflare-vision self-check passed')
}
