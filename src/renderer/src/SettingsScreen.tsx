import type { ModelOverrides, ProviderId, SessionSummary } from '@shared/models'
import { PROVIDER_LABELS } from './mockData'

export interface ProviderSetting {
  apiKey: string
  allowPaid: boolean
}

interface SettingsScreenProps {
  providerSettings: Record<ProviderId, ProviderSetting>
  onUpdateProviderSetting: (providerId: ProviderId, patch: Partial<ProviderSetting>) => void
  activeSession: SessionSummary | null
  overrides: ModelOverrides
  onUpdateOverrides: (patch: Partial<ModelOverrides>) => void
}

const ALL_PROVIDERS = Object.keys(PROVIDER_LABELS) as ProviderId[]

export default function SettingsScreen({
  providerSettings,
  onUpdateProviderSetting,
  activeSession,
  overrides,
  onUpdateOverrides
}: SettingsScreenProps): React.JSX.Element {
  return (
    <div style={{ padding: 24, overflowY: 'auto', height: '100%' }}>
      <h2>Provider settings</h2>
      {ALL_PROVIDERS.map((providerId) => {
        const setting = providerSettings[providerId]
        return (
          <div key={providerId} style={{ marginBottom: 16, border: '1px solid #333', borderRadius: 6, padding: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{PROVIDER_LABELS[providerId]}</div>
            <label style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
              API key
              <input
                type="password"
                value={setting.apiKey}
                onChange={(e) => onUpdateProviderSetting(providerId, { apiKey: e.target.value })}
                placeholder="sk-..."
                style={{ display: 'block', width: 320, marginTop: 4, padding: 6 }}
              />
            </label>
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={setting.allowPaid}
                onChange={(e) => onUpdateProviderSetting(providerId, { allowPaid: e.target.checked })}
              />
              Allow paid models
            </label>
          </div>
        )
      })}

      <h2>Model overrides</h2>
      {!activeSession ? (
        <p style={{ opacity: 0.7 }}>Select a session to edit its model overrides.</p>
      ) : (
        <div style={{ border: '1px solid #333', borderRadius: 6, padding: 12, maxWidth: 420 }}>
          <p style={{ marginTop: 0, fontSize: 13, opacity: 0.75 }}>
            Editing overrides for <strong>{activeSession.modelId}</strong> ({PROVIDER_LABELS[activeSession.providerId]})
          </p>
          <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
            Temperature
            <input
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={overrides.temperature ?? ''}
              onChange={(e) => onUpdateOverrides({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })}
              style={{ display: 'block', width: 120, marginTop: 4, padding: 6 }}
            />
          </label>
          <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
            Top P
            <input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={overrides.topP ?? ''}
              onChange={(e) => onUpdateOverrides({ topP: e.target.value === '' ? undefined : Number(e.target.value) })}
              style={{ display: 'block', width: 120, marginTop: 4, padding: 6 }}
            />
          </label>
          <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
            Max tokens
            <input
              type="number"
              step={1}
              min={1}
              value={overrides.maxTokens ?? ''}
              onChange={(e) => onUpdateOverrides({ maxTokens: e.target.value === '' ? undefined : Number(e.target.value) })}
              style={{ display: 'block', width: 120, marginTop: 4, padding: 6 }}
            />
          </label>
          <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
            System prompt
            <textarea
              value={overrides.systemPrompt ?? ''}
              onChange={(e) => onUpdateOverrides({ systemPrompt: e.target.value })}
              rows={3}
              style={{ display: 'block', width: '100%', marginTop: 4, padding: 6 }}
            />
          </label>
          <label style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
            Reasoning effort
            <select
              value={overrides.reasoningEffort ?? 'medium'}
              onChange={(e) => onUpdateOverrides({ reasoningEffort: e.target.value as ModelOverrides['reasoningEffort'] })}
              style={{ display: 'block', width: 160, marginTop: 4, padding: 6 }}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={overrides.leanCoding ?? false}
              onChange={(e) => onUpdateOverrides({ leanCoding: e.target.checked })}
            />
            Lean coding mode
          </label>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={overrides.fastReasoning ?? false}
              onChange={(e) => onUpdateOverrides({ fastReasoning: e.target.checked })}
            />
            Fast reasoning mode
          </label>
        </div>
      )}
    </div>
  )
}
