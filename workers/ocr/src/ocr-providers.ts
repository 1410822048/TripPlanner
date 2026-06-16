import {
  extractReceiptItems,
  OcrError,
  type ClaudeConfig,
} from './claude'
import {
  extractReceiptItemsQwen,
  type QwenConfig,
} from './qwen'
import type { OcrResponse } from './schema'

export type OcrProvider = 'claude' | 'qwen'
export type OptionalOcrProvider = OcrProvider | 'none'

export interface OcrProviderConfig {
  claude: ClaudeConfig
  qwen:   QwenConfig
}

export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      throw new OcrError(`Invalid boolean env value: ${value}`, 502)
  }
}

export function parseOcrProvider(
  value: string | undefined,
  envName: string,
  fallback: OcrProvider,
): OcrProvider {
  if (value === undefined || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'claude' || normalized === 'qwen') return normalized
  throw new OcrError(`${envName} must be "qwen" or "claude"`, 502)
}

export function parseOptionalOcrProvider(
  value: string | undefined,
  envName: string,
  fallback: OptionalOcrProvider,
): OptionalOcrProvider {
  if (value === undefined || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'none' || normalized === 'claude' || normalized === 'qwen') return normalized
  throw new OcrError(`${envName} must be "qwen", "claude", or "none"`, 502)
}

export function runOcrProvider(
  provider: OcrProvider,
  imageBase64: string,
  mimeType:    string,
  currency:    string | undefined,
  cfg:         OcrProviderConfig,
): Promise<OcrResponse> {
  if (provider === 'qwen') {
    return extractReceiptItemsQwen(imageBase64, mimeType, currency, cfg.qwen)
  }
  return extractReceiptItems(imageBase64, mimeType, currency, cfg.claude)
}
