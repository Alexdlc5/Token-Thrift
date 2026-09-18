import type { ModelInfo, ProviderId } from '@shared/models'
import { PROVIDER_LABELS } from './mockData'
import Spinner from './Spinner'

interface NewSessionPickerProps {
  models: ModelInfo[]
  /** True until the initial listModels() call resolves — an empty list before then reads as "no free models", not "still loading". */
  loading: boolean
  /** True while a pick is in flight (session create/switch IPC round trip) — disables further picks so a slow response can't be double-clicked into two sessions. */
  creating: boolean
  onPick: (model: ModelInfo) => void
  onCancel: () => void
}

export default function NewSessionPicker({
  models,
  loading,
  creating,
  onPick,
  onCancel
}: NewSessionPickerProps): React.JSX.Element {
  const freeModels = models.filter((m) => m.isFree)
  const providerIds = Array.from(new Set(freeModels.map((m) => m.providerId))) as ProviderId[]

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#1e1e28',
          border: '1px solid #444',
          borderRadius: 8,
          padding: 20,
          width: 480,
          maxHeight: '70vh',
          overflowY: 'auto',
          position: 'relative'
        }}
      >
        <h2 style={{ marginTop: 0 }}>Start a new session</h2>
        <p style={{ fontSize: 13, opacity: 0.75 }}>Pick a free model from any provider.</p>

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0', fontSize: 13, opacity: 0.7 }}>
            <Spinner /> Loading available models…
          </div>
        ) : providerIds.length === 0 ? (
          <p style={{ fontSize: 13, opacity: 0.6 }}>
            No free models found yet — add a provider API key in Settings, or try refreshing.
          </p>
        ) : (
          providerIds.map((providerId) => (
            <div key={providerId} style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{PROVIDER_LABELS[providerId]}</div>
              {freeModels
                .filter((m) => m.providerId === providerId)
                .map((model) => (
                  <button
                    key={`${model.providerId}:${model.modelId}`}
                    onClick={() => onPick(model)}
                    disabled={creating}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      marginBottom: 4,
                      cursor: creating ? 'default' : 'pointer',
                      opacity: creating ? 0.5 : 1
                    }}
                  >
                    {model.label}
                    {model.supportsReasoningTrace ? ' (reasoning)' : ''}
                  </button>
                ))}
            </div>
          ))
        )}

        {creating && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(30,30,40,0.75)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontSize: 13
            }}
          >
            <Spinner /> Working…
          </div>
        )}

        <button onClick={onCancel} disabled={creating} style={{ marginTop: 8 }}>
          Cancel
        </button>
      </div>
    </div>
  )
}
