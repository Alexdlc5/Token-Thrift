// API keys never touch the renderer and never sit on disk as plaintext. Electron's
// safeStorage is backed by the OS keychain (DPAPI on Windows) with no native module to
// compile, unlike keytar — the ciphertext it produces is the only thing persisted, in a
// plain JSON file (a full settings library is unwarranted for two flat maps).

import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderId } from '@shared/models'

interface SettingsSchema {
  apiKeys: Record<string, string>
  allowPaid: Record<string, boolean>
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'token-thrift-settings.json')
}

function readSettings(): SettingsSchema {
  const path = settingsPath()
  if (!existsSync(path)) return { apiKeys: {}, allowPaid: {} }
  return JSON.parse(readFileSync(path, 'utf8')) as SettingsSchema
}

function writeSettings(settings: SettingsSchema): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is unavailable on this machine')
  }
}

export function setApiKey(providerId: ProviderId, apiKey: string): void {
  assertEncryptionAvailable()
  const settings = readSettings()
  settings.apiKeys[providerId] = safeStorage.encryptString(apiKey).toString('base64')
  writeSettings(settings)
}

export function getApiKey(providerId: ProviderId): string | null {
  const encrypted = readSettings().apiKeys[providerId]
  if (!encrypted) return null
  assertEncryptionAvailable()
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

export function hasApiKey(providerId: ProviderId): boolean {
  return Boolean(readSettings().apiKeys[providerId])
}

export function setAllowPaid(providerId: ProviderId, allow: boolean): void {
  const settings = readSettings()
  settings.allowPaid[providerId] = allow
  writeSettings(settings)
}

export function getAllowPaid(providerId: ProviderId): boolean {
  return readSettings().allowPaid[providerId] ?? false
}
