// FLUX.1 [schnell] on Cloudflare Workers AI — confirmed free-tier (same account/Neuron
// budget as the text models in providers/cloudflare-workers-ai.ts; see that file's header
// for the free-tier details). Reuses the exact same stored "accountId:apiToken" key, so
// there's nothing new to configure in Settings if that's already set up.
//
// Endpoint (confirmed against developers.cloudflare.com/workers-ai/models/flux-1-schnell,
// 2026-09-17): POST .../ai/run/@cf/black-forest-labs/flux-1-schnell, body {prompt, steps},
// response wrapped as {result: {image: "<base64 JPEG, no data: prefix>"}} — Cloudflare's
// generic /ai/run/ envelope is just {result: ...}, not the fuller {success,errors,...}
// envelope some of their other APIs use.

import assert from 'node:assert'
import { parseStoredKey } from '../providers/cloudflare-workers-ai'
import { getApiKey } from '../secure-store'
import type { ImageGenResult, ImageProvider } from './ImageProvider'

const MODEL_URL_SUFFIX = '/ai/run/@cf/black-forest-labs/flux-1-schnell'

interface RunResponse {
  result?: { image?: string }
  errors?: { message?: string }[]
}

/** Pure so it's testable without a live call — the only real branching in this file. */
export function parseRunResponse(ok: boolean, status: string, body: RunResponse): ImageGenResult {
  if (!ok || !body.result?.image) {
    const message = body.errors?.[0]?.message ?? status
    throw new Error(`Cloudflare image generation failed: ${message}`)
  }
  return { dataUrl: `data:image/jpeg;base64,${body.result.image}`, mimeType: 'image/jpeg' }
}

class CloudflareImageProvider implements ImageProvider {
  readonly id = 'cloudflare-image' as const

  async generate(prompt: string): Promise<ImageGenResult> {
    const { accountId, apiToken } = parseStoredKey(getApiKey('cloudflare-workers-ai'))

    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${MODEL_URL_SUFFIX}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt, steps: 4 })
    })

    const body = (await res.json().catch(() => ({}))) as RunResponse
    return parseRunResponse(res.ok, `${res.status} ${res.statusText}`, body)
  }
}

export const cloudflareImageProvider = new CloudflareImageProvider()

// --- self-check ---------------------------------------------------------------------
if (require.main === module) {
  const success = parseRunResponse(true, '200 OK', { result: { image: 'QUJD' } })
  assert.strictEqual(success.dataUrl, 'data:image/jpeg;base64,QUJD')
  assert.strictEqual(success.mimeType, 'image/jpeg')

  assert.throws(
    () => parseRunResponse(false, '500 Internal Server Error', { errors: [{ message: 'model overloaded' }] }),
    /model overloaded/,
    'error message from the response envelope surfaces'
  )
  assert.throws(
    () => parseRunResponse(false, '429 Too Many Requests', {}),
    /429 Too Many Requests/,
    'falls back to the HTTP status when the response carries no error message'
  )
  assert.throws(
    () => parseRunResponse(true, '200 OK', {}),
    /200 OK/,
    'a 200 with no image in the body is still treated as a failure'
  )

  console.log('cloudflare-image self-check passed')
}
