import { describe, expect, it, vi } from 'vitest'
import {
  PDF_PAGE_LIMIT_EXCEEDED,
  PDF_UNREADABLE,
  PdfPageLimitError,
  assertPdfPageLimitWithPdfJs,
  pdfPageLimitMessageJa,
  type PdfJsLike,
} from './index'

describe('assertPdfPageLimitWithPdfJs', () => {
  it('uses stopAtErrors because upload accepts only PDFs that pass strict pdf.js validation', async () => {
    const pdf = {
      numPages: 2,
      destroy: vi.fn(),
    }
    const loadingTask = {
      promise: Promise.resolve(pdf),
      destroy: vi.fn(),
    }
    const pdfjs: PdfJsLike = {
      VerbosityLevel: { ERRORS: 0 },
      getDocument: vi.fn(() => loadingTask),
    }

    await expect(assertPdfPageLimitWithPdfJs(pdfjs, new Uint8Array([1]))).resolves.toBe(2)

    expect(pdfjs.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ stopAtErrors: true }),
    )
    expect(pdf.destroy).toHaveBeenCalledOnce()
    expect(loadingTask.destroy).not.toHaveBeenCalled()
  })

  it('times out a stalled pdf.js loading task and destroys it', async () => {
    vi.useFakeTimers()
    try {
      const loadingTask = {
        promise: new Promise<never>(() => {}),
        destroy: vi.fn(),
      }
      const pdfjs: PdfJsLike = {
        VerbosityLevel: { ERRORS: 0 },
        getDocument: vi.fn(() => loadingTask),
      }

      const result = expect(
        assertPdfPageLimitWithPdfJs(pdfjs, new Uint8Array([1]), 10, 25),
      ).rejects.toMatchObject({
        name: 'PdfPageLimitError',
        code: PDF_UNREADABLE,
      } satisfies Partial<PdfPageLimitError>)

      await vi.advanceTimersByTimeAsync(25)

      await result
      expect(loadingTask.destroy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pdfPageLimitMessageJa', () => {
  it('keeps client and Worker PDF upload copy in one shared formatter', () => {
    expect(pdfPageLimitMessageJa(PDF_PAGE_LIMIT_EXCEEDED, 10))
      .toBe('PDFは10ページ以下のファイルを選択してください。')
    expect(pdfPageLimitMessageJa(PDF_UNREADABLE, 10))
      .toBe('PDFを検証できませんでした。別のPDFを選択してください。')
  })
})
