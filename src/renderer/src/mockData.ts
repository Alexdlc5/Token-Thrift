// Static display data + defaults for the renderer. Session/model/message data now comes
// from window.api (Phase 2) — this file no longer holds seed data for those.
import type { ModelOverrides, ProviderId } from '@shared/models'

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  groq: 'Groq',
  'google-ai-studio': 'Google AI Studio',
  cerebras: 'Cerebras',
  'nvidia-nim': 'NVIDIA NIM',
  huggingface: 'Hugging Face'
}

export const DEFAULT_OVERRIDES: ModelOverrides = {
  temperature: 0.7,
  topP: 1,
  maxTokens: 2048,
  systemPrompt: '',
  reasoningEffort: 'medium',
  leanCoding: false,
  fastReasoning: false
}
