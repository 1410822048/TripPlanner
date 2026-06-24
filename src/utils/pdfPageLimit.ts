import {
  assertPdfPageLimitWithPdfJs,
  MAX_PDF_PAGES,
  PDF_UNREADABLE,
  PdfPageLimitError,
  pdfPageLimitMessageJa,
} from '@tripmate/pdf-page-limit'
import { getPdfJs } from '@/utils/pdfJs'

const PDF_MIME = 'application/pdf'

export async function validatePdfPageLimit(
  file: Blob,
  maxPages: number = MAX_PDF_PAGES,
): Promise<void> {
  if (file.type !== PDF_MIME) return

  try {
    const data = new Uint8Array(await file.arrayBuffer())
    const pdfjs = await getPdfJs()
    await assertPdfPageLimitWithPdfJs(pdfjs, data, maxPages)
  } catch (e) {
    const code = e instanceof PdfPageLimitError ? e.code : PDF_UNREADABLE
    throw new PdfPageLimitError(code, {
      message: pdfPageLimitMessageJa(code, maxPages),
      pageCount: e instanceof PdfPageLimitError ? e.pageCount : undefined,
      cause: e,
    })
  }
}
