// @tripmate/pdf-page-limit -- shared page-count gate for client
// preflight and the Worker authoritative upload gate. The package stays
// pdf.js-runtime agnostic: callers provide their already-configured
// pdfjs module because browser and Cloudflare Worker need different
// worker/shim setup.

export const MAX_PDF_PAGES = 10
export const PDF_PAGE_LIMIT_EXCEEDED = 'PDF_PAGE_LIMIT_EXCEEDED'
export const PDF_UNREADABLE = 'PDF_UNREADABLE'

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

interface PdfDocument {
  readonly numPages: number
  destroy(): Promise<void> | void
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>
  destroy(): Promise<void> | void
}

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

export async function assertPdfPageLimitWithPdfJs(
  pdfjs: PdfJsLike,
  data: Uint8Array,
  maxPages: number = MAX_PDF_PAGES,
): Promise<number> {
  const loadingTask = pdfjs.getDocument({
    data,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    useWorkerFetch: false,
    useWasm: false,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    stopAtErrors: true,
  })

  try {
    const pdf = await loadingTask.promise
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
