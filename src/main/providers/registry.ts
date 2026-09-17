import type { ProviderId } from '@shared/models'
import type { LLMProvider } from './LLMProvider'

const registry = new Map<ProviderId, LLMProvider>()

export function registerProvider(provider: LLMProvider): void {
  registry.set(provider.id, provider)
}

export function getProvider(id: ProviderId): LLMProvider | undefined {
  return registry.get(id)
}

export function listProviders(): LLMProvider[] {
  return [...registry.values()]
}
