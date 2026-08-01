import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOKING_PDF_LINE_MAX_CHARS,
  PDF_UNREADABLE,
} from '@tripmate/pdf-page-limit'
import { extractBookingPdfText } from './bookingPdfText'

const mocks = vi.hoisted(() => ({
  getPdfJs: vi.fn(),
}))

vi.mock('@/utils/pdfJs', () => ({
  getPdfJs: mocks.getPdfJs,
}))

function pdfFile(): File {
  return {
    type: 'application/pdf',
    name: 'booking.pdf',
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  } as unknown as File
}

describe('extractBookingPdfText', () => {
  beforeEach(() => {
    mocks.getPdfJs.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does not start pdf.js when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(extractBookingPdfText(pdfFile(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(mocks.getPdfJs).not.toHaveBeenCalled()
  })

  it('times out a stuck pdf.js loading task and destroys it', async () => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => {
      const controller = new AbortController()
      setTimeout(() => {
        controller.abort(new DOMException(`PDF text extraction timed out after ${timeoutMs}ms`, 'TimeoutError'))
      }, timeoutMs)
      return controller.signal
    })
    const destroy = vi.fn()
    const getDocument = vi.fn(() => ({
      promise: new Promise<never>(() => undefined),
      destroy,
    }))
    mocks.getPdfJs.mockResolvedValue({
      VerbosityLevel: { ERRORS: 0 },
      getDocument,
    })

    const promise = extractBookingPdfText(pdfFile())
    await vi.waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1))

    const rejection = expect(promise).rejects.toMatchObject({ code: PDF_UNREADABLE })
    await vi.advanceTimersByTimeAsync(15_000)

    await rejection
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('caps each emitted line to the worker request schema limit', async () => {
    const pdfDestroy = vi.fn()
    const getPage = vi.fn(async () => ({
      getTextContent: vi.fn(async () => ({
        items: [{
          str:       'A'.repeat(BOOKING_PDF_LINE_MAX_CHARS + 123),
          transform: [1, 0, 0, 1, 10, 700],
        }],
      })),
    }))
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage,
        destroy: pdfDestroy,
      }),
      destroy: vi.fn(),
    }))
    mocks.getPdfJs.mockResolvedValue({
      VerbosityLevel: { ERRORS: 0 },
      getDocument,
    })

    const digest = await extractBookingPdfText(pdfFile())

    expect(digest.lines.map(line => line.text)).toEqual([
      'A'.repeat(BOOKING_PDF_LINE_MAX_CHARS),
    ])
    expect(digest.text).toHaveLength(BOOKING_PDF_LINE_MAX_CHARS)
    expect(pdfDestroy).toHaveBeenCalledTimes(1)
  })

  it('normalizes compatibility glyphs, removes overprint copies, and preserves column boundaries', async () => {
    const pdfDestroy = vi.fn()
    const overprint = (str: string, x: number, y: number, width: number) => [
      { str, width, transform: [1, 0, 0, 1, x, y] },
      { str, width, transform: [1, 0, 0, 1, x, y + 1.5] },
      { str, width, transform: [1, 0, 0, 1, x + 0.75, y + 0.75] },
      { str, width, transform: [1, 0, 0, 1, x + 1.5, y] },
      { str, width, transform: [1, 0, 0, 1, x + 1.5, y + 1.5] },
    ]
    const getPage = vi.fn(async () => ({
      getTextContent: vi.fn(async () => ({
        items: [
          ...overprint('⼊', 64, 700, 12),
          { str: '住', width: 12, transform: [1, 0, 0, 1, 76, 700] },
          { str: '退', width: 12, transform: [1, 0, 0, 1, 508, 700] },
          { str: '房', width: 12, transform: [1, 0, 0, 1, 520, 700] },
          ...overprint('2026', 64, 680, 24),
          { str: '年', width: 12, transform: [1, 0, 0, 1, 88, 680] },
          { str: '9', width: 7, transform: [1, 0, 0, 1, 100, 680] },
          { str: '⽉', width: 12, transform: [1, 0, 0, 1, 107, 680] },
          { str: '18', width: 12, transform: [1, 0, 0, 1, 119, 680] },
          { str: '⽇', width: 12, transform: [1, 0, 0, 1, 131, 680] },
          { str: '⾄', width: 12, transform: [1, 0, 0, 1, 143, 680] },
          { str: '26', width: 12, transform: [1, 0, 0, 1, 155, 680] },
          { str: '⽇', width: 12, transform: [1, 0, 0, 1, 167, 680] },
          { str: 'A', width: 6, transform: [1, 0, 0, 1, 64, 660] },
          { str: 'A', width: 6, transform: [1, 0, 0, 1, 65.5, 661.5] },
          { str: '1', width: 6, transform: [1, 0, 0, 1, 64, 640] },
          { str: '1', width: 6, transform: [1, 0, 0, 1, 70, 640] },
          { str: 'New ', width: 24, transform: [1, 0, 0, 1, 64, 620] },
          { str: 'York', width: 24, transform: [1, 0, 0, 1, 88, 620] },
        ],
      })),
    }))
    mocks.getPdfJs.mockResolvedValue({
      VerbosityLevel: { ERRORS: 0 },
      getDocument: vi.fn(() => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage,
          destroy: pdfDestroy,
        }),
        destroy: vi.fn(),
      })),
    })

    const digest = await extractBookingPdfText(pdfFile())

    expect(digest.lines.map(line => line.text)).toEqual([
      '入住 | 退房',
      '2026年9月18日至26日',
      'A',
      '11',
      'New York',
    ])
    expect(digest.lines).toHaveLength(5)
    expect(pdfDestroy).toHaveBeenCalledTimes(1)
  })
})
