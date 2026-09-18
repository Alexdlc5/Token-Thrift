import { useEffect, useRef, useState } from 'react'
import type { ModelOverrides, ProviderId, SessionSummary, StoredKeyInfo } from '@shared/models'
import { ALL_PROVIDERS, PROVIDER_LABELS } from './mockData'

const WORKING_DIR_CHECK_DEBOUNCE_MS = 400

/** The path field + Browse button + "this folder's too big" warning — split out since it
 * needs its own debounced size-check state, separate from the rest of the overrides form. */
function WorkingDirField({
  overrides,
  onUpdateOverrides
}: {
  overrides: ModelOverrides
  onUpdateOverrides: (patch: Partial<ModelOverrides>) => void
}): React.JSX.Element {
  const [warning, setWarning] = useState<string | null>(null)
  const checkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Re-checks whenever the path changes for any reason — typing, a Browse pick, or switching
  // to a session with a different saved working directory — debounced so free typing doesn't
  // fire an IPC call (a real directory walk) per keystroke.
  useEffect(() => {
    clearTimeout(checkTimer.current)
    const path = overrides.agentWorkingDir?.trim()
    if (!path) {
      setWarning(null)
      return
    }
    checkTimer.current = setTimeout(() => {
      window.api
        .checkWorkingDirSize(path)
        .then((result) => {
          setWarning(
            result?.tooMany
              ? `This folder has ${result.fileCount} files in it — the agent reads through all of them every message. Pick a smaller, more focused folder for it to work in.`
              : null
          )
        })
        .catch(console.error)
    }, WORKING_DIR_CHECK_DEBOUNCE_MS)
    return () => clearTimeout(checkTimer.current)
  }, [overrides.agentWorkingDir])

  function handleBrowse(): void {
    window.api
      .pickFolder()
      .then((path) => {
        if (path) onUpdateOverrides({ agentWorkingDir: path })
      })
      .catch(console.error)
  }

  return (
    <div style={{ marginTop: 8, marginLeft: 22 }}>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>
        Working directory — the model reads and writes only inside this folder. Leave blank to
        use a "Token Thrift Projects" folder under Documents, with one subfolder per project.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={overrides.agentWorkingDir ?? ''}
          onChange={(e) => onUpdateOverrides({ agentWorkingDir: e.target.value })}
          placeholder="Default: Documents/Token Thrift Projects"
          style={{ flex: 1, padding: 6, fontSize: 12 }}
        />
        <button onClick={handleBrowse} style={{ fontSize: 12 }}>
          Browse…
        </button>
      </div>
      {warning && <div style={{ fontSize: 11, color: '#e0a03f', marginTop: 4 }}>⚠ {warning}</div>}
    </div>
  )
}

interface SettingsScreenProps {
  apiKeysByProvider: Record<ProviderId, StoredKeyInfo[]>
  activeKeyByProvider: Record<ProviderId, string | null>
  allowPaidByProvider: Record<ProviderId, boolean>
  onAddApiKey: (providerId: ProviderId, label: string, apiKey: string) => void
  onRemoveApiKey: (providerId: ProviderId, keyId: string) => void
  onSetActiveApiKey: (providerId: ProviderId, keyId: string) => void
  onSetAllowPaid: (providerId: ProviderId, allow: boolean) => void
  activeSession: SessionSummary | null
  overrides: ModelOverrides
  onUpdateOverrides: (patch: Partial<ModelOverrides>) => void
  onSaveAsDefaultOverrides: (overrides: ModelOverrides) => void
}

function ProviderKeysCard({
  providerId,
  keys,
  activeKeyId,
  allowPaid,
  onAdd,
  onRemove,
  onSetActive,
  onSetAllowPaid
}: {
  providerId: ProviderId
  keys: StoredKeyInfo[]
  activeKeyId: string | null
  allowPaid: boolean
  onAdd: (label: string, apiKey: string) => void
  onRemove: (keyId: string) => void
  onSetActive: (keyId: string) => void
  onSetAllowPaid: (allow: boolean) => void
}): React.JSX.Element {
  const [draftLabel, setDraftLabel] = useState('')
  const [draftKey, setDraftKey] = useState('')

  function commitAdd(): void {
    if (!draftKey.trim()) return
    onAdd(draftLabel.trim() || 'Untitled', draftKey.trim())
    setDraftLabel('')
    setDraftKey('')
  }

  return (
    <div style={{ marginBottom: 16, border: '1px solid #333', borderRadius: 6, padding: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{PROVIDER_LABELS[providerId]}</div>

      {keys.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {keys.map((key) => (
            <div
              key={key.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                padding: '4px 0',
                opacity: key.id === activeKeyId ? 1 : 0.6
              }}
            >
              <input
                type="radio"
                name={`${providerId}-active-key`}
                checked={key.id === activeKeyId}
                onChange={() => onSetActive(key.id)}
              />
              <span style={{ width: 90, flexShrink: 0 }}>
                {key.label}
                {key.id === activeKeyId ? ' (active)' : ''}
              </span>
              {/* Shows as a filled box so it's visually obvious a key IS saved here — this is
                  never the real secret, which never comes back to the renderer at all. */}
              <input
                type="password"
                value="••••••••••••"
                disabled
                style={{ flex: 1, padding: 6, fontSize: 12, opacity: 0.7 }}
              />
              <span style={{ opacity: 0.6 }}>{new Date(key.createdAt).toLocaleDateString()}</span>
              <button onClick={() => onRemove(key.id)} style={{ fontSize: 11 }}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {providerId === 'cloudflare-workers-ai' && (
        <p style={{ fontSize: 11, opacity: 0.6, marginTop: -4, marginBottom: 6 }}>
          Needs two values — paste as <code>accountId:apiToken</code>
        </p>
      )}
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>
        {keys.length > 0 ? 'Add another key' : 'Add a key'}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
          placeholder="Label (e.g. personal)"
          style={{ width: 140, padding: 6, fontSize: 12 }}
        />
        <input
          type="password"
          value={draftKey}
          onChange={(e) => setDraftKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commitAdd()}
          placeholder={providerId === 'cloudflare-workers-ai' ? 'accountId:apiToken' : 'API key'}
          style={{ flex: 1, padding: 6, fontSize: 12 }}
        />
        <button onClick={commitAdd}>Save key</button>
      </div>

      <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={allowPaid} onChange={(e) => onSetAllowPaid(e.target.checked)} />
        Allow paid models
      </label>
    </div>
  )
}

export default function SettingsScreen({
  apiKeysByProvider,
  activeKeyByProvider,
  allowPaidByProvider,
  onAddApiKey,
  onRemoveApiKey,
  onSetActiveApiKey,
  onSetAllowPaid,
  activeSession,
  overrides,
  onUpdateOverrides,
  onSaveAsDefaultOverrides
}: SettingsScreenProps): React.JSX.Element {
  return (
    <div style={{ padding: 24, overflowY: 'auto', height: '100%' }}>
      <h2>Provider settings</h2>
      <p style={{ fontSize: 12, opacity: 0.6, maxWidth: 480, marginTop: -8 }}>
        Multiple saved keys per provider are for genuinely separate accounts (personal vs.
        work, etc.) — switching between them doesn't raise or reset any single provider's
        rate limits.
      </p>
      {ALL_PROVIDERS.map((providerId) => (
        <ProviderKeysCard
          key={providerId}
          providerId={providerId}
          keys={apiKeysByProvider[providerId]}
          activeKeyId={activeKeyByProvider[providerId]}
          allowPaid={allowPaidByProvider[providerId]}
          onAdd={(label, apiKey) => onAddApiKey(providerId, label, apiKey)}
          onRemove={(keyId) => onRemoveApiKey(providerId, keyId)}
          onSetActive={(keyId) => onSetActiveApiKey(providerId, keyId)}
          onSetAllowPaid={(allow) => onSetAllowPaid(providerId, allow)}
        />
      ))}

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
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={overrides.fastReasoning ?? false}
              onChange={(e) => onUpdateOverrides({ fastReasoning: e.target.checked })}
            />
            Fast reasoning mode
          </label>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={overrides.imageGeneration ?? false}
              onChange={(e) => onUpdateOverrides({ imageGeneration: e.target.checked })}
            />
            Image generation (via Cloudflare Workers AI — needs a key above)
          </label>
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={overrides.agentFileAccess ?? false}
              onChange={(e) => onUpdateOverrides({ agentFileAccess: e.target.checked })}
            />
            Agent file access — let the model write (and read) real project files
          </label>
          {overrides.agentFileAccess && (
            <>
              <WorkingDirField overrides={overrides} onUpdateOverrides={onUpdateOverrides} />
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={overrides.agentCodeExecution ?? false}
                  onChange={(e) => onUpdateOverrides({ agentCodeExecution: e.target.checked })}
                />
                Allow code execution — let the model run real commands (tests, builds) to check its own work
              </label>
            </>
          )}

          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #333' }}>
            <button onClick={() => onSaveAsDefaultOverrides(overrides)} style={{ fontSize: 12 }}>
              Save as default for new sessions
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
