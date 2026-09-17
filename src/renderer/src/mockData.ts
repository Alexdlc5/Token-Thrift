// Local mock seed data for the renderer UI shell. No IPC calls — Phase 1 is UI-only.
import type { ChatMessage, ModelInfo, ModelOverrides, ProviderId, SessionSummary } from '@shared/models'

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  groq: 'Groq',
  'google-ai-studio': 'Google AI Studio',
  cerebras: 'Cerebras',
  'nvidia-nim': 'NVIDIA NIM',
  huggingface: 'Hugging Face'
}

export const MOCK_MODELS: ModelInfo[] = [
  { providerId: 'openrouter', modelId: 'meta-llama/llama-3.1-8b-instruct:free', label: 'Llama 3.1 8B Instruct', isFree: true, supportsReasoningTrace: false, contextLength: 128000 },
  { providerId: 'openrouter', modelId: 'openai/gpt-4o', label: 'GPT-4o', isFree: false, supportsReasoningTrace: false, contextLength: 128000 },
  { providerId: 'groq', modelId: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', isFree: true, supportsReasoningTrace: false, contextLength: 131072 },
  { providerId: 'groq', modelId: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 Distill 70B', isFree: true, supportsReasoningTrace: true, contextLength: 131072 },
  { providerId: 'google-ai-studio', modelId: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', isFree: true, supportsReasoningTrace: false, contextLength: 1000000 },
  { providerId: 'google-ai-studio', modelId: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', isFree: false, supportsReasoningTrace: true, contextLength: 2000000 },
  { providerId: 'cerebras', modelId: 'llama3.1-8b', label: 'Llama 3.1 8B', isFree: true, supportsReasoningTrace: false, contextLength: 8192 },
  { providerId: 'nvidia-nim', modelId: 'nvidia/llama-3.1-nemotron-70b-instruct', label: 'Nemotron 70B Instruct', isFree: true, supportsReasoningTrace: false, contextLength: 128000 },
  { providerId: 'huggingface', modelId: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B Instruct', isFree: true, supportsReasoningTrace: false, contextLength: 32768 },
  { providerId: 'huggingface', modelId: 'meta-llama/Meta-Llama-3-70B-Instruct', label: 'Meta Llama 3 70B Instruct', isFree: false, supportsReasoningTrace: false, contextLength: 8192 }
]

export const MOCK_SESSIONS: SessionSummary[] = [
  { id: 's1', providerId: 'groq', modelId: 'llama-3.3-70b-versatile', title: 'Trip planning to Kyoto', createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2, archived: false },
  { id: 's2', providerId: 'google-ai-studio', modelId: 'gemini-2.0-flash', title: 'Debugging React hooks', createdAt: Date.now() - 1000 * 60 * 60 * 5, archived: false },
  { id: 's3', providerId: 'openrouter', modelId: 'meta-llama/llama-3.1-8b-instruct:free', title: 'Sourdough starter tips', createdAt: Date.now() - 1000 * 60 * 30, archived: true }
]

export const MOCK_MESSAGES: ChatMessage[] = [
  { id: 'm1', sessionId: 's1', role: 'user', content: 'Plan a 3-day itinerary for Kyoto in autumn.', createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2 },
  { id: 'm2', sessionId: 's1', role: 'assistant', content: 'Day 1: Fushimi Inari at sunrise, Gion in the evening. Day 2: Arashiyama bamboo grove...', createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2 + 1000 * 30 },
  { id: 'm3', sessionId: 's1', role: 'user', content: 'Any vegetarian food recommendations?', createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2 + 1000 * 90 },

  { id: 'm4', sessionId: 's2', role: 'user', content: 'Why does my useEffect run twice in development?', createdAt: Date.now() - 1000 * 60 * 60 * 5 },
  { id: 'm5', sessionId: 's2', role: 'assistant', content: "That's React 18 StrictMode intentionally double-invoking effects to surface cleanup bugs.", createdAt: Date.now() - 1000 * 60 * 60 * 5 + 1000 * 20 },

  { id: 'm6', sessionId: 's3', role: 'user', content: 'My starter smells like nail polish remover, is it dead?', createdAt: Date.now() - 1000 * 60 * 30 },
  { id: 'm7', sessionId: 's3', role: 'assistant', content: "No, that's overproduction of acetone from hunger — feed it and it should mellow out.", createdAt: Date.now() - 1000 * 60 * 30 + 1000 * 15 }
]

export const DEFAULT_OVERRIDES: ModelOverrides = {
  temperature: 0.7,
  topP: 1,
  maxTokens: 2048,
  systemPrompt: '',
  reasoningEffort: 'medium',
  leanCoding: false,
  fastReasoning: false
}
