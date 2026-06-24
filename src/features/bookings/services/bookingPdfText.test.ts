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

    expect(digest.lines).toHaveLength(1)
    expect(digest.lines[0]!.text).toHaveLength(BOOKING_PDF_LINE_MAX_CHARS)
    expect(digest.text).toHaveLength(BOOKING_PDF_LINE_MAX_CHARS)
    expect(pdfDestroy).toHaveBeenCalledTimes(1)
  })
})
