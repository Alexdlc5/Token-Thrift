// API keys never touch the renderer and never sit on disk as plaintext. Electron's
// safeStorage is backed by the OS keychain (DPAPI on Windows) with no native module to
// compile, unlike keytar — the ciphertext it produces is the only thing persisted, in a
// plain JSON file (a full settings library is unwarranted for what's still just two maps).
//
// Multiple named keys per provider (e.g. two OpenRouter accounts for genuinely separate
// purposes), one of which is "active" and resolved by getApiKey() — every existing caller
// (each provider adapter) keeps calling getApiKey(providerId) exactly as before and never
// needs to know multiple keys exist.

import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelOverrides, ProviderId, StoredKeyInfo } from '@shared/models'

interface StoredKeyRecord extends StoredKeyInfo {
  encryptedKey: string
}

interface SettingsSchema {
  version: 2
  keysByProvider: Record<string, StoredKeyRecord[]>
  activeKeyId: Record<string, string>
  allowPaid: Record<string, boolean>
  /** Seeds a brand-new session's overrides (see App.tsx) — separate from each session's own
   * saved overrides, and only changed when the user explicitly asks to save one as the
   * default, not on every per-session tweak. */
  defaultOverrides?: ModelOverrides
}

interface LegacySettingsSchema {
  apiKeys?: Record<string, string>
  allowPaid?: Record<string, boolean>
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'token-thrift-settings.json')
}

function migrateLegacy(legacy: LegacySettingsSchema): SettingsSchema {
  const keysByProvider: Record<string, StoredKeyRecord[]> = {}
  const activeKeyId: Record<string, string> = {}
  for (const [providerId, encryptedKey] of Object.entries(legacy.apiKeys ?? {})) {
    if (!encryptedKey) continue
    const record: StoredKeyRecord = { id: randomUUID(), label: 'Default', encryptedKey, createdAt: Date.now() }
    keysByProvider[providerId] = [record]
    activeKeyId[providerId] = record.id
  }
  return { version: 2, keysByProvider, activeKeyId, allowPaid: legacy.allowPaid ?? {} }
}

function readSettings(): SettingsSchema {
  const path = settingsPath()
  if (!existsSync(path)) return { version: 2, keysByProvider: {}, activeKeyId: {}, allowPaid: {} }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as SettingsSchema | LegacySettingsSchema
  if ('version' in parsed && parsed.version === 2) return parsed
  const migrated = migrateLegacy(parsed)
  writeSettings(migrated)
  return migrated
}

function writeSettings(settings: SettingsSchema): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is unavailable on this machine')
  }
}

/** Adds a new named key and makes it the active one. */
export function addApiKey(providerId: ProviderId, label: string, apiKey: string): StoredKeyInfo {
  assertEncryptionAvailable()
  const settings = readSettings()
  const record: StoredKeyRecord = {
    id: randomUUID(),
    label,
    encryptedKey: safeStorage.encryptString(apiKey).toString('base64'),
    createdAt: Date.now()
  }
  settings.keysByProvider[providerId] = [...(settings.keysByProvider[providerId] ?? []), record]
  settings.activeKeyId[providerId] = record.id
  writeSettings(settings)
  return { id: record.id, label: record.label, createdAt: record.createdAt }
}

export function listApiKeys(providerId: ProviderId): StoredKeyInfo[] {
  return (readSettings().keysByProvider[providerId] ?? []).map(({ id, label, createdAt }) => ({
    id,
    label,
    createdAt
  }))
}

export function removeApiKey(providerId: ProviderId, keyId: string): void {
  const settings = readSettings()
  settings.keysByProvider[providerId] = (settings.keysByProvider[providerId] ?? []).filter(
    (k) => k.id !== keyId
  )
  if (settings.activeKeyId[providerId] === keyId) {
    const remaining = settings.keysByProvider[providerId]
    if (remaining.length > 0) settings.activeKeyId[providerId] = remaining[0].id
    else delete settings.activeKeyId[providerId]
  }
  writeSettings(settings)
}

export function setActiveApiKey(providerId: ProviderId, keyId: string): void {
  const settings = readSettings()
  if (!settings.keysByProvider[providerId]?.some((k) => k.id === keyId)) {
    throw new Error(`No saved key "${keyId}" for provider "${providerId}"`)
  }
  settings.activeKeyId[providerId] = keyId
  writeSettings(settings)
}

/** Resolves the provider's active key — the only lookup every provider adapter uses. */
export function getApiKey(providerId: ProviderId): string | null {
  const settings = readSettings()
  const activeId = settings.activeKeyId[providerId]
  const record = settings.keysByProvider[providerId]?.find((k) => k.id === activeId)
  if (!record) return null
  assertEncryptionAvailable()
  return safeStorage.decryptString(Buffer.from(record.encryptedKey, 'base64'))
}

export function hasApiKey(providerId: ProviderId): boolean {
  return Boolean(readSettings().activeKeyId[providerId])
}

export function getActiveKeyId(providerId: ProviderId): string | null {
  return readSettings().activeKeyId[providerId] ?? null
}

export function setAllowPaid(providerId: ProviderId, allow: boolean): void {
  const settings = readSettings()
  settings.allowPaid[providerId] = allow
  writeSettings(settings)
}

export function getAllowPaid(providerId: ProviderId): boolean {
  return readSettings().allowPaid[providerId] ?? false
}

export function setDefaultOverrides(overrides: ModelOverrides): void {
  const settings = readSettings()
  settings.defaultOverrides = overrides
  writeSettings(settings)
}

export function getDefaultOverrides(): ModelOverrides | null {
  return readSettings().defaultOverrides ?? null
}
