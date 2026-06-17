// Qwen receipt OCR client. Used by the configured primary / fallback /
// comparison OCR routes.
//
// Provider API: OpenAI-compatible Chat Completions. Keep baseUrl + model in
// env because Alibaba Model Studio regions, OpenRouter, and self-hosted
// OpenAI-compatible gateways all use slightly different model ids / hosts.
import {
  OCR_RESPONSE_JSON_SCHEMA,
  OcrResponseSchema,
  type OcrResponse,
} from './schema'
import { buildPrompt, OcrError, SYSTEM_PROMPT } from './claude'

const MAX_TOKENS = 4096

export interface QwenConfig {
  /** Provider API key. For Alibaba Model Studio this is the DashScope key. */
  apiKey:  string
  /** Base URL without /chat/completions, e.g. .../compatible-mode/v1. */
  baseUrl: string
  /** Provider model id, e.g. qwen3-vl-flash or qwen3.6-flash. */
  model:   string
}

interface OpenAiTextPart {
  type: string
  text?: string
}

interface OpenAiChoice {
  finish_reason?: string
  message?: {
    content?: string | OpenAiTextPart[]
  }
}

interface OpenAiChatCompletion {
  choices?: OpenAiChoice[]
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

function upstreamStatusForClient(status: number): number {
  if (status === 429) return 429
  if (status === 408 || status === 529) return 503
  return 502
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

// enable_thinking is a DashScope / Model Studio EXTENSION to the OpenAI Chat
// Completions body, NOT a standard field. This client's contract (see file
// header) allows pointing QWEN_BASE_URL at OpenRouter / self-hosted OpenAI-
// compatible gateways, and a strict gateway may reject unknown top-level
// fields with 400. So the field is sent ONLY to Model Studio hosts
// (*.aliyuncs.com); every other gateway gets a clean standard body.
function isModelStudioEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('.aliyuncs.com')
  } catch {
    return false
  }
}

function extractMessageText(message: OpenAiChoice['message']): string | undefined {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.find(part => part.type === 'text' && typeof part.text === 'string')?.text
  }
  return undefined
}

function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim())
    }
    const start = text.indexOf('{')
    const end   = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1))
    }
    throw new Error('no JSON object found')
  }
}

export async function extractReceiptItemsQwen(
  imageBase64: string,
  mimeType:    string,
  currency:    string | undefined,
  cfg:         QwenConfig,
): Promise<OcrResponse> {
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
    throw new OcrError('Qwen OCR is not configured', 502)
  }

  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`,
            },
          },
          { type: 'text', text: buildPrompt(currency) },
        ],
      },
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0,
    // Disable Qwen3 hybrid thinking mode on Model Studio: thinking mode (1)
    // doesn't support structured output and (2) its reasoning trace blows
    // latency past our 45s ceiling → 504. Gated to Model Studio hosts because
    // enable_thinking is a DashScope extension (see isModelStudioEndpoint) —
    // a generic OpenAI-compatible gateway would 400 on the unknown field.
    ...(isModelStudioEndpoint(cfg.baseUrl) ? { enable_thinking: false } : {}),
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'receipt_ocr',
        strict: true,
        schema: OCR_RESPONSE_JSON_SCHEMA,
      },
    },
  }

  const endpoint = `${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`
  const t0 = Date.now()
  console.log(`[qwen] request: model=${cfg.model} mime=${mimeType} imgBytes~${Math.round(imageBase64.length * 0.75)}`)

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError') {
      console.error('[qwen] timeout after 45s')
      throw new OcrError('Qwen upstream timeout after 45s', 504)
    }
    console.error(`[qwen] network error: ${err.message}`)
    throw new OcrError(`Qwen upstream network error: ${err.message}`, 502)
  }

  const elapsed = Date.now() - t0
  console.log(`[qwen] response: status=${res.status} elapsed=${elapsed}ms`)

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error(`[qwen] error body (truncated): ${detail.slice(0, 500)}`)
    throw new OcrError(
      `Qwen ${res.status}: ${detail.slice(0, 200)}`,
      upstreamStatusForClient(res.status),
    )
  }

  const envelope = await res.json() as OpenAiChatCompletion
  const choice = envelope.choices?.[0]
  const finish = choice?.finish_reason
  const text = extractMessageText(choice?.message)
  console.log(`[qwen] finish_reason=${finish ?? '?'} textLen=${text?.length ?? 0}`)

  if (finish === 'length') {
    throw new OcrError('Qwen output truncated', 422)
  }
  if (typeof text !== 'string') {
    console.error('[qwen] no text content in response', JSON.stringify(envelope).slice(0, 500))
    throw new OcrError('Qwen returned no text content', 422)
  }

  let json: unknown
  try {
    json = parseModelJson(text)
  } catch {
    throw new OcrError('Qwen returned non-JSON content', 422)
  }

  const parsed = OcrResponseSchema.safeParse(json)
  if (!parsed.success) {
    console.error(`[qwen] schema mismatch: ${parsed.error.message.slice(0, 300)}`)
    throw new OcrError(`Schema mismatch: ${parsed.error.message.slice(0, 200)}`, 422)
  }
  if (parsed.data.items.length === 0) {
    console.warn('[qwen] unreadable: items=[]')
    throw new OcrError('Receipt unreadable (model returned empty items)', 422)
  }

  console.log(`[qwen] success: items=${parsed.data.items.length} adjustments=${parsed.data.adjustments.length} ignored=${parsed.data.ignoredLines.length}`)
  return parsed.data
}
