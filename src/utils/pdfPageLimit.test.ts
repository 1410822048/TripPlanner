import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PDF_UNREADABLE,
  PdfPageLimitError,
  pdfPageLimitMessageJa,
} from '@tripmate/pdf-page-limit'
import { validatePdfPageLimit } from './pdfPageLimit'

const mocks = vi.hoisted(() => ({
  assertPdfPageLimitWithPdfJs: vi.fn(),
  configurePdfJsWorker:       vi.fn(),
  pdfjs: {
    GlobalWorkerOptions: { workerSrc: '' },
    VerbosityLevel:      { ERRORS: 0 },
  },
}))

vi.mock('@tripmate/pdf-page-limit', async () => {
  const actual = await vi.importActual<typeof import('@tripmate/pdf-page-limit')>('@tripmate/pdf-page-limit')
  return {
    ...actual,
    assertPdfPageLimitWithPdfJs: (...args: unknown[]) => mocks.assertPdfPageLimitWithPdfJs(...args),
  }
})

vi.mock('react-pdf', () => ({
  pdfjs: mocks.pdfjs,
}))

vi.mock('@/utils/pdfJs', () => ({
  configurePdfJsWorker: mocks.configurePdfJsWorker,
}))

describe('validatePdfPageLimit', () => {
  beforeEach(() => {
    mocks.assertPdfPageLimitWithPdfJs.mockReset()
    mocks.configurePdfJsWorker.mockClear()
  })

  it('wraps non-PdfPageLimitError failures as localized PDF_UNREADABLE', async () => {
    const cause = new Error('pdf.js exploded')
    mocks.assertPdfPageLimitWithPdfJs.mockRejectedValueOnce(cause)

    await expect(
      validatePdfPageLimit(new Blob(['%PDF'], { type: 'application/pdf' })),
    ).rejects.toMatchObject({
      name:    'PdfPageLimitError',
      code:    PDF_UNREADABLE,
      message: pdfPageLimitMessageJa(PDF_UNREADABLE),
    } satisfies Partial<PdfPageLimitError>)

    expect(mocks.configurePdfJsWorker).toHaveBeenCalledWith(mocks.pdfjs)
  })
})
