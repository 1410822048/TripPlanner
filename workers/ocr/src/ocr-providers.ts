import {
  extractReceiptItems,
  type ClaudeConfig,
} from './claude'
import {
  extractReceiptItemsQwen,
  type QwenConfig,
} from './qwen'
import type { OcrResponse } from './schema'

export type OcrProvider = 'claude' | 'qwen'

/**
 * Product contract shared by all receipt OCR routes. The client presents
 * Qwen as the default model and Claude as the explicit high-accuracy retry;
 * keeping the roles fixed here prevents a Worker env override from silently
 * reversing those labels.
 */
export const RECEIPT_OCR_PROVIDERS = {
  primary:  'qwen',
  fallback: 'claude',
} as const satisfies Record<'primary' | 'fallback', OcrProvider>

export interface OcrProviderConfig {
  claude: ClaudeConfig
  qwen:   QwenConfig
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
