import type { ModelInfo, ProviderId } from '@shared/models'
import { PROVIDER_LABELS } from './mockData'

interface NewSessionPickerProps {
  models: ModelInfo[]
  onPick: (model: ModelInfo) => void
  onCancel: () => void
}

export default function NewSessionPicker({ models, onPick, onCancel }: NewSessionPickerProps): React.JSX.Element {
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
          overflowY: 'auto'
        }}
      >
        <h2 style={{ marginTop: 0 }}>Start a new session</h2>
        <p style={{ fontSize: 13, opacity: 0.75 }}>Pick a free model from any provider.</p>
        {providerIds.map((providerId) => (
          <div key={providerId} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{PROVIDER_LABELS[providerId]}</div>
            {freeModels
              .filter((m) => m.providerId === providerId)
              .map((model) => (
                <button
                  key={`${model.providerId}:${model.modelId}`}
                  onClick={() => onPick(model)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    marginBottom: 4,
                    cursor: 'pointer'
                  }}
                >
                  {model.label}
                  {model.supportsReasoningTrace ? ' (reasoning)' : ''}
                </button>
              ))}
          </div>
        ))}
        <button onClick={onCancel} style={{ marginTop: 8 }}>
          Cancel
        </button>
      </div>
    </div>
  )
}
