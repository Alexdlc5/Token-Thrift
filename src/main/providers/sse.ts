// Shared SSE-stream reader for every OpenAI-compatible-shaped provider adapter (and Google AI
// Studio, whose `alt=sse` stream buffers the same way even though its payload shape differs).
// Each provider still owns its own `parseEvent` — only the byte-buffering/`\n\n`-block-
// splitting loop around it was identical across all ten adapters.

import type { ChatStreamPart } from './LLMProvider'

/** Minimal shape of the reader each adapter needs, so this can be fed either a real
 * `response.body.getReader()` or a fixture reader in a self-check. */
export interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}

/** One `data: {...}` block parsed into zero or more stream parts, plus whether the stream is
 * done (a provider's own sentinel, e.g. `data: [DONE]` — google-ai-studio.ts has none and
 * always returns done: false, relying on the HTTP stream closing instead). */
export interface ParsedSseEvent {
  done: boolean
  parts: ChatStreamPart[]
}

export async function* parseSseStream(
  reader: ByteReader,
  parseEvent: (eventBlock: string) => ParsedSseEvent
): AsyncGenerator<ChatStreamPart> {
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const { done: isDone, parts } = parseEvent(block)
      for (const part of parts) yield part
      if (isDone) return
    }
  }
}
