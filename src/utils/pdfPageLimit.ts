import {
  assertPdfPageLimitWithPdfJs,
  MAX_PDF_PAGES,
  PDF_PAGE_LIMIT_EXCEEDED,
  PDF_UNREADABLE,
  PdfPageLimitError,
  type PdfPageLimitCode,
} from '@tripmate/pdf-page-limit'
import { configurePdfJsWorker } from '@/utils/pdfJs'

const PDF_MIME = 'application/pdf'

type ReactPdfModule = typeof import('react-pdf')
type PdfJsModule = ReactPdfModule['pdfjs']

let pdfjsPromise: Promise<PdfJsModule> | undefined

async function loadPdfJs(): Promise<PdfJsModule> {
  pdfjsPromise ??= (async () => {
    const { pdfjs } = await import('react-pdf')
    configurePdfJsWorker(pdfjs)
    return pdfjs
  })().catch(e => {
    pdfjsPromise = undefined
    throw e
  })
  return pdfjsPromise
}

function clientPdfPageLimitMessage(code: PdfPageLimitCode, maxPages: number): string {
  return code === PDF_PAGE_LIMIT_EXCEEDED
    ? `PDFは${maxPages}ページ以下のファイルを選択してください。`
    : 'PDFを読み込めませんでした。別のPDFを選択してください。'
}

export async function validatePdfPageLimit(
  file: Blob,
  maxPages: number = MAX_PDF_PAGES,
): Promise<void> {
  if (file.type !== PDF_MIME) return

  try {
    const data = new Uint8Array(await file.arrayBuffer())
    const pdfjs = await loadPdfJs()
    await assertPdfPageLimitWithPdfJs(pdfjs, data, maxPages)
  } catch (e) {
    const code = e instanceof PdfPageLimitError ? e.code : PDF_UNREADABLE
    throw new PdfPageLimitError(code, {
      message: clientPdfPageLimitMessage(code, maxPages),
      pageCount: e instanceof PdfPageLimitError ? e.pageCount : undefined,
      cause: e,
    })
  }
}
