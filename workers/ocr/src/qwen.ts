// Qwen receipt OCR client. Used by the configured primary / fallback routes.
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
import type { ZodType } from 'zod'

const RECEIPT_MAX_TOKENS = 4096
const QWEN_MAX_ATTEMPT_TIMEOUT_MS = 45_000
const QWEN_VALIDATION_TOTAL_TIMEOUT_MS = 55_000
const RECEIPT_SCHEMA_REPAIR_PROMPT = [
  '',
  'Correction after validation failure:',
  '- The previous response was valid JSON but did not match the required schema.',
  '- Re-read the same receipt image and return one new complete JSON object with every required field and correct nested type.',
].join('\n')

export interface QwenConfig {
  /** Provider API key. For Alibaba Model Studio this is the DashScope key. */
  apiKey:  string
  /** Base URL without /chat/completions, e.g. .../compatible-mode/v1. */
  baseUrl: string
  /** Provider model id, e.g. qwen3-vl-flash or qwen3.7-flash. */
  model:   string
}

interface OpenAiContentPart {
  type: string
  text?: string
  image_url?: {
    url: string
  }
}

interface OpenAiChoice {
  finish_reason?: string
  message?: {
    content?: string | OpenAiContentPart[]
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

interface QwenStructuredJsonArgs {
  cfg:          QwenConfig
  logPrefix:    string
  maxTokens:    number
  timeoutMs?:   number
  system:       string
  content:      string | OpenAiContentPart[]
  schemaName:   string
  schema:       object
  requestLog:   string
}

interface QwenValidatedJsonArgs<T> extends Omit<QwenStructuredJsonArgs, 'content' | 'requestLog' | 'timeoutMs'> {
  contentForAttempt:    (attempt: 1 | 2) => string | OpenAiContentPart[]
  requestLogForAttempt: (attempt: 1 | 2) => string
  validationSchema:     ZodType<T>
  normalize?:           (json: unknown) => unknown
  maxAttemptTimeoutMs?: number
  totalTimeoutMs?:      number
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

export async function requestQwenStructuredJson(args: QwenStructuredJsonArgs): Promise<unknown> {
  if (!args.cfg.apiKey || !args.cfg.baseUrl || !args.cfg.model) {
    throw new OcrError('Qwen is not configured', 502)
  }

  const modelStudio = isModelStudioEndpoint(args.cfg.baseUrl)
  const timeoutMs = args.timeoutMs ?? 45_000
  const system = modelStudio
    ? `${args.system}\n\nRequired JSON Schema:\n${JSON.stringify(args.schema)}`
    : args.system

  const body = {
    model: args.cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: args.content },
    ],
    // Model Studio documents JSON mode (json_object), not OpenAI strict
    // json_schema. It also recommends omitting max_tokens so a response is
    // not cut off mid-JSON. Generic compatible gateways retain their native
    // json_schema contract and explicit output cap.
    ...(!modelStudio ? { max_tokens: args.maxTokens } : {}),
    temperature: 0,
    // Disable Qwen3 hybrid thinking mode on Model Studio: thinking mode (1)
    // doesn't support structured output and (2) its reasoning trace blows
    // latency past our 45s ceiling. Generic OpenAI-compatible gateways do not
    // receive this DashScope-only extension.
    ...(modelStudio ? { enable_thinking: false } : {}),
    response_format: modelStudio
      ? { type: 'json_object' }
      : {
          type: 'json_schema',
          json_schema: {
            name: args.schemaName,
            strict: true,
            schema: args.schema,
          },
        },
  }

  const endpoint = `${normalizeBaseUrl(args.cfg.baseUrl)}/chat/completions`
  const t0 = Date.now()
  console.log(`[${args.logPrefix}] request: model=${args.cfg.model} ${args.requestLog}`)

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${args.cfg.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError') {
      console.error(`[${args.logPrefix}] timeout after ${timeoutMs}ms`)
      throw new OcrError(`Qwen upstream timeout after ${timeoutMs}ms`, 504)
    }
    console.error(`[${args.logPrefix}] network error: ${err.message}`)
    throw new OcrError(`Qwen upstream network error: ${err.message}`, 502)
  }

  const elapsed = Date.now() - t0
  console.log(`[${args.logPrefix}] response: status=${res.status} elapsed=${elapsed}ms`)

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error(`[${args.logPrefix}] error body (truncated): ${detail.slice(0, 500)}`)
    throw new OcrError(
      `Qwen ${res.status}: ${detail.slice(0, 200)}`,
      upstreamStatusForClient(res.status),
    )
  }

  const envelope = await res.json() as OpenAiChatCompletion
  const choice = envelope.choices?.[0]
  const finish = choice?.finish_reason
  const text = extractMessageText(choice?.message)
  console.log(`[${args.logPrefix}] finish_reason=${finish ?? '?'} textLen=${text?.length ?? 0}`)

  if (finish === 'length') {
    throw new OcrError('Qwen output truncated', 422)
  }
  if (typeof text !== 'string') {
    console.error(`[${args.logPrefix}] no text content in response`, JSON.stringify(envelope).slice(0, 500))
    throw new OcrError('Qwen returned no text content', 422)
  }

  try {
    return parseModelJson(text)
  } catch {
    throw new OcrError('Qwen returned non-JSON content', 422)
  }
}

/**
 * Retry exactly one Zod shape mismatch. Upstream/network errors, invalid JSON,
 * truncation, and timeouts are definitive for this request and fail fast.
 * Keeping this decision here prevents receipt and booking OCR from drifting.
 */
export async function requestQwenValidatedJson<T>(args: QwenValidatedJsonArgs<T>): Promise<T> {
  const deadline = Date.now() + (args.totalTimeoutMs ?? QWEN_VALIDATION_TOTAL_TIMEOUT_MS)
  const maxAttemptTimeoutMs = args.maxAttemptTimeoutMs ?? QWEN_MAX_ATTEMPT_TIMEOUT_MS

  const runAttempt = async (attempt: 1 | 2) => {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new OcrError('Qwen schema repair exceeded its total time budget', 504)
    }
    const json = await requestQwenStructuredJson({
      cfg:        args.cfg,
      logPrefix:  args.logPrefix,
      maxTokens:  args.maxTokens,
      timeoutMs:  Math.min(maxAttemptTimeoutMs, remainingMs),
      system:     args.system,
      content:    args.contentForAttempt(attempt),
      schemaName: args.schemaName,
      schema:     args.schema,
      requestLog: args.requestLogForAttempt(attempt),
    })
    return args.validationSchema.safeParse(args.normalize ? args.normalize(json) : json)
  }

  const first = await runAttempt(1)
  if (first.success) return first.data
  console.warn(`[${args.logPrefix}] schema mismatch; retrying once: ${first.error.message.slice(0, 300)}`)

  const second = await runAttempt(2)
  if (second.success) return second.data
  console.error(`[${args.logPrefix}] schema mismatch after retry: ${second.error.message.slice(0, 300)}`)
  throw new OcrError(`Schema mismatch: ${second.error.message.slice(0, 200)}`, 422)
}

export async function extractReceiptItemsQwen(
  imageBase64: string,
  mimeType:    string,
  currency:    string | undefined,
  cfg:         QwenConfig,
): Promise<OcrResponse> {
  const result = await requestQwenValidatedJson({
    cfg,
    logPrefix:  'qwen',
    maxTokens:  RECEIPT_MAX_TOKENS,
    system:     SYSTEM_PROMPT,
    contentForAttempt: attempt => [
      {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${imageBase64}`,
        },
      },
      {
        type: 'text',
        text: `${buildPrompt(currency)}${attempt === 2 ? RECEIPT_SCHEMA_REPAIR_PROMPT : ''}`,
      },
    ],
    schemaName: 'receipt_ocr',
    schema:     OCR_RESPONSE_JSON_SCHEMA,
    validationSchema: OcrResponseSchema,
    requestLogForAttempt: attempt =>
      `attempt=${attempt} mime=${mimeType} imgBytes~${Math.round(imageBase64.length * 0.75)}`,
  })

  if (result.items.length === 0) {
    console.warn('[qwen] unreadable: items=[]')
    throw new OcrError('Receipt unreadable (model returned empty items)', 422)
  }

  console.log(`[qwen] success: items=${result.items.length} adjustments=${result.adjustments.length} ignored=${result.ignoredLines.length}`)
  return result
}
