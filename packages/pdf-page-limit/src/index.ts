// @tripmate/pdf-page-limit -- shared page-count gate for client
// preflight and the Worker authoritative upload gate. The package stays
// pdf.js-runtime agnostic: callers provide their already-configured
// pdfjs module because browser and Cloudflare Worker need different
// worker/shim setup.

export const MAX_PDF_PAGES = 10
export const PDF_PAGE_PARSE_TIMEOUT_MS = 8_000
export const BOOKING_PDF_TEXT_MAX_CHARS = 24_000
export const BOOKING_PDF_LINE_MAX_CHARS = 500
export const BOOKING_PDF_LINE_MAX_COUNT = 600
export const PDF_PAGE_LIMIT_EXCEEDED = 'PDF_PAGE_LIMIT_EXCEEDED'
export const PDF_UNREADABLE = 'PDF_UNREADABLE'

export const PDF_PARSE_OPTIONS = {
  useWorkerFetch: false,
  useWasm: false,
  isEvalSupported: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  disableFontFace: true,
  stopAtErrors: true,
} as const

export type PdfPageLimitCode =
  | typeof PDF_PAGE_LIMIT_EXCEEDED
  | typeof PDF_UNREADABLE

export class PdfPageLimitError extends Error {
  readonly code: PdfPageLimitCode
  readonly pageCount?: number

  constructor(
    code: PdfPageLimitCode,
    opts: { message?: string; pageCount?: number; maxPages?: number; cause?: unknown } = {},
  ) {
    const maxPages = opts.maxPages ?? MAX_PDF_PAGES
    const message = opts.message ?? (
      code === PDF_PAGE_LIMIT_EXCEEDED
        ? `PDF page count ${opts.pageCount ?? 'unknown'} exceeds max ${maxPages}`
        : 'PDF could not be parsed'
    )
    super(message, { cause: opts.cause })
    this.name = 'PdfPageLimitError'
    this.code = code
    this.pageCount = opts.pageCount
  }
}

export function pdfPageLimitStatus(code: PdfPageLimitCode): 400 | 413 {
  return code === PDF_PAGE_LIMIT_EXCEEDED ? 413 : 400
}

export function pdfPageLimitMessageJa(
  code: PdfPageLimitCode,
  maxPages: number = MAX_PDF_PAGES,
): string {
  return code === PDF_PAGE_LIMIT_EXCEEDED
    ? `PDFは${maxPages}ページ以下のファイルを選択してください。`
    : 'PDFを検証できませんでした。別のPDFを選択してください。'
}

interface PdfDocument {
  readonly numPages: number
  destroy(): Promise<void> | void
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>
  destroy(): Promise<void> | void
}

declare function setTimeout(callback: () => void, ms: number): unknown
declare function clearTimeout(timeoutId: unknown): void

export interface PdfJsLike {
  readonly VerbosityLevel: {
    readonly ERRORS: number
  }
  getDocument(options: {
    data: Uint8Array
    verbosity: number
  } & Record<string, unknown>): PdfLoadingTask
}

async function destroyQuietly(resource: { destroy(): Promise<void> | void }): Promise<void> {
  try {
    await resource.destroy()
  } catch {
    // Cleanup is best-effort; the original parse/limit error is more useful.
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: unknown
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`PDF page-count parse timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  })
}

export async function assertPdfPageLimitWithPdfJs(
  pdfjs: PdfJsLike,
  data: Uint8Array,
  maxPages: number = MAX_PDF_PAGES,
  timeoutMs: number = PDF_PAGE_PARSE_TIMEOUT_MS,
): Promise<number> {
  const loadingTask = pdfjs.getDocument({
    data,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    ...PDF_PARSE_OPTIONS,
  })

  try {
    const pdf = await withTimeout(loadingTask.promise, timeoutMs)
    try {
      const pageCount = pdf.numPages
      if (!Number.isInteger(pageCount) || pageCount < 1) {
        throw new Error('invalid PDF page count')
      }
      if (pageCount > maxPages) {
        throw new PdfPageLimitError(PDF_PAGE_LIMIT_EXCEEDED, { pageCount, maxPages })
      }
      return pageCount
    } finally {
      await destroyQuietly(pdf)
    }
  } catch (e) {
    await destroyQuietly(loadingTask)
    if (e instanceof PdfPageLimitError) throw e
    throw new PdfPageLimitError(PDF_UNREADABLE, { cause: e })
  }
}
