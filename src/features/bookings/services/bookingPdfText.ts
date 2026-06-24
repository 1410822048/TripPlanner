import {
  BOOKING_PDF_LINE_MAX_COUNT,
  BOOKING_PDF_LINE_MAX_CHARS,
  BOOKING_PDF_TEXT_MAX_CHARS,
  MAX_PDF_PAGES,
  PDF_PARSE_OPTIONS,
  PDF_PAGE_LIMIT_EXCEEDED,
  PDF_UNREADABLE,
  PdfPageLimitError,
} from '@tripmate/pdf-page-limit'
import { getPdfJs } from '@/utils/pdfJs'

const PDF_MIME = 'application/pdf'
const PDF_TEXT_PARSE_TIMEOUT_MS = 15_000
const LINE_Y_TOLERANCE = 3

interface PdfTextItemLike {
  str:       string
  transform: number[]
  width?:    number
}

interface PositionedText {
  text: string
  x:    number
  y:    number
}

export interface BookingPdfTextLine {
  page: number
  text: string
  x:    number
  y:    number
}

export interface BookingPdfTextDigest {
  fileName?:  string
  pageCount:  number
  text:       string
  lines:      BookingPdfTextLine[]
}

function isPdfTextItem(item: unknown): item is PdfTextItemLike {
  if (!item || typeof item !== 'object') return false
  const candidate = item as { str?: unknown; transform?: unknown }
  return typeof candidate.str === 'string' && Array.isArray(candidate.transform)
}

export function isPdfFile(file: File): boolean {
  return file.type === PDF_MIME || file.name.toLowerCase().endsWith('.pdf')
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

function pdfTextParseSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PDF_TEXT_PARSE_TIMEOUT_MS)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abortHandler: (() => void) | undefined

  const abort = new Promise<never>((_, reject) => {
    abortHandler = () => reject(signal.reason)
    signal.addEventListener('abort', abortHandler, { once: true })
  })

  return Promise.race([promise, abort]).finally(() => {
    if (abortHandler) signal.removeEventListener('abort', abortHandler)
  }) as Promise<T>
}

async function destroyQuietly(resource: { destroy(): Promise<void> | void }): Promise<void> {
  try {
    await resource.destroy()
  } catch {
    // Best-effort cleanup; the parse error path is more useful to the caller.
  }
}

function groupItemsIntoLines(pageNumber: number, items: PositionedText[]): BookingPdfTextLine[] {
  const rows: Array<{ y: number; items: PositionedText[] }> = []
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x))

  for (const item of sorted) {
    const row = rows.find(r => Math.abs(r.y - item.y) <= LINE_Y_TOLERANCE)
    if (row) {
      row.items.push(item)
      row.y = (row.y + item.y) / 2
    } else {
      rows.push({ y: item.y, items: [item] })
    }
  }

  return rows
    .map(row => {
      const ordered = [...row.items].sort((a, b) => a.x - b.x)
      const text = ordered
        .map(item => item.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        page: pageNumber,
        text,
        x: Math.min(...ordered.map(item => item.x)),
        y: row.y,
      }
    })
    .filter(line => line.text.length > 0)
}

function buildDigest(lines: BookingPdfTextLine[], fileName: string | undefined, pageCount: number): BookingPdfTextDigest {
  const kept: BookingPdfTextLine[] = []
  const textParts: string[] = []
  let remainingChars = BOOKING_PDF_TEXT_MAX_CHARS

  for (const line of lines) {
    if (kept.length >= BOOKING_PDF_LINE_MAX_COUNT || remainingChars <= 0) break
    const text = line.text.slice(0, Math.min(remainingChars, BOOKING_PDF_LINE_MAX_CHARS))
    kept.push({ ...line, text })
    textParts.push(text)
    remainingChars -= text.length + 1
  }

  const text = textParts.join('\n').trim()
  if (!text) {
    throw new PdfPageLimitError(PDF_UNREADABLE)
  }
  return { fileName, pageCount, text, lines: kept }
}

export async function extractBookingPdfText(file: File, signal?: AbortSignal): Promise<BookingPdfTextDigest> {
  if (!isPdfFile(file)) {
    throw new PdfPageLimitError(PDF_UNREADABLE)
  }

  const parseSignal = pdfTextParseSignal(signal)
  let loadingTask: { destroy(): Promise<void> | void } | undefined

  try {
    parseSignal.throwIfAborted()
    const pdfjs = await getPdfJs()
    parseSignal.throwIfAborted()
    const data = new Uint8Array(await raceAbort(file.arrayBuffer(), parseSignal))

    const task = pdfjs.getDocument({
      data,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
      ...PDF_PARSE_OPTIONS,
    })
    loadingTask = task

    const pdf = await raceAbort(task.promise, parseSignal)
    try {
      const pageCount = pdf.numPages
      if (!Number.isInteger(pageCount) || pageCount < 1) {
        throw new PdfPageLimitError(PDF_UNREADABLE)
      }
      if (pageCount > MAX_PDF_PAGES) {
        throw new PdfPageLimitError(PDF_PAGE_LIMIT_EXCEEDED, { pageCount })
      }

      const lines: BookingPdfTextLine[] = []
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        parseSignal.throwIfAborted()
        const page = await raceAbort(pdf.getPage(pageNumber), parseSignal)
        const content = await raceAbort(page.getTextContent(), parseSignal)
        const positioned: PositionedText[] = []
        for (const item of content.items) {
          parseSignal.throwIfAborted()
          if (!isPdfTextItem(item)) continue
          const [, , , , xRaw, yRaw] = item.transform
          const text = item.str.trim()
          if (!text) continue
          positioned.push({
            text,
            x: Number.isFinite(xRaw) ? xRaw : 0,
            y: Number.isFinite(yRaw) ? yRaw : 0,
          })
        }
        lines.push(...groupItemsIntoLines(pageNumber, positioned))
      }

      return buildDigest(lines, file.name || undefined, pageCount)
    } finally {
      await destroyQuietly(pdf)
    }
  } catch (e) {
    if (loadingTask) await destroyQuietly(loadingTask)
    if (e instanceof PdfPageLimitError) throw e
    if (isAbortError(e)) throw e
    throw new PdfPageLimitError(PDF_UNREADABLE, { cause: e })
  }
}
