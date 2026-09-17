// §5: reads the two efficiency-injection modules from resources/prompt-modules/ and builds
// the combined system-prompt string for a request. Kept out of the provider layer per the
// spec — every provider gets this uniformly, none of them know it exists.

import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelOverrides } from '@shared/models'

// app.getAppPath() resolves relative to however the entry script was launched, not
// reliably the project root — in a packaged build resources/ ships via extraResources
// under process.resourcesPath; in dev, __dirname is <project>/out/main, so the project
// root is two levels up.
const RESOURCES_DIR = app.isPackaged ? join(process.resourcesPath, 'resources') : join(__dirname, '../../resources')

function readModule(filename: string): string {
  return readFileSync(join(RESOURCES_DIR, 'prompt-modules', filename), 'utf8').trim()
}

/** Combines the user's custom system prompt with any active efficiency modules, in that order. */
export function buildSystemPrompt(overrides: ModelOverrides | null | undefined): string | null {
  const parts: string[] = []
  if (overrides?.systemPrompt?.trim()) parts.push(overrides.systemPrompt.trim())
  if (overrides?.leanCoding) parts.push(readModule('lean-coding.md'))
  if (overrides?.fastReasoning) parts.push(readModule('fast-reasoning.md'))
  return parts.length > 0 ? parts.join('\n\n') : null
}
