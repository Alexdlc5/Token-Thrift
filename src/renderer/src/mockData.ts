// Static display data + defaults for the renderer. Session/model/message data now comes
// from window.api (Phase 2) — this file no longer holds seed data for those.
import type { ModelOverrides, ProviderId } from '@shared/models'

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  groq: 'Groq',
  'google-ai-studio': 'Google AI Studio',
  cerebras: 'Cerebras',
  'nvidia-nim': 'NVIDIA NIM',
  huggingface: 'Hugging Face',
  mistral: 'Mistral',
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  cohere: 'Cohere',
  zhipu: 'Z.ai (GLM)'
}

// The one place this list is derived — every provider-agnostic loop (Settings, App's
// per-provider status state) imports this instead of keeping its own copy, so adding a
// provider here is the only place that can be forgotten.
export const ALL_PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderId[]

export const DEFAULT_OVERRIDES: ModelOverrides = {
  temperature: 0.7,
  topP: 1,
  maxTokens: 2048,
  systemPrompt: '',
  reasoningEffort: 'medium',
  leanCoding: false,
  fastReasoning: false,
  // On by default — "automatically" hand off to real image generation instead of the model
  // just apologizing, per the user's ask. Needs a Cloudflare Workers AI key in Settings to
  // actually produce anything; otherwise it fails with a clear message, same as any other
  // unconfigured provider.
  imageGeneration: true,
  // Off by default, unlike imageGeneration — this writes real files under the user's
  // Documents folder rather than staying inside the app's own sandboxed library storage, so
  // it's an explicit opt-in per session rather than always-on.
  agentFileAccess: false,
  // Off by default, and meaningfully riskier than agentFileAccess alone — this actually
  // executes shell commands (see main/code-execution.ts).
  agentCodeExecution: false
}
