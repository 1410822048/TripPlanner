import { describe, expect, it } from 'vitest'
import { assertPdfPageLimitBytes } from '../src/pdf-page-limit'
import {
	MAX_PDF_PAGES,
	PDF_PAGE_LIMIT_EXCEEDED,
	PDF_UNREADABLE,
	PdfPageLimitError,
	pdfPageLimitStatus,
} from '@tripmate/pdf-page-limit'

function minimalPdfBytes(pageCount: number): ArrayBuffer {
	const objects: string[] = [
		'1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
		`2 0 obj\n<< /Type /Pages /Kids [${Array.from(
			{ length: pageCount },
			(_, i) => `${i + 3} 0 R`,
		).join(' ')}] /Count ${pageCount} >>\nendobj\n`,
	]
	for (let i = 0; i < pageCount; i++) {
		objects.push(`${i + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>\nendobj\n`)
	}

	let body = '%PDF-1.4\n'
	const offsets = [0]
	for (const obj of objects) {
		offsets.push(body.length)
		body += obj
	}
	const xrefOffset = body.length
	body += `xref\n0 ${objects.length + 1}\n`
	body += '0000000000 65535 f \n'
	for (const offset of offsets.slice(1)) {
		body += `${String(offset).padStart(10, '0')} 00000 n \n`
	}
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
	body += `startxref\n${xrefOffset}\n%%EOF\n`
	return new TextEncoder().encode(body).buffer
}

describe('assertPdfPageLimitBytes', () => {
	it('accepts PDFs at the 10-page limit', async () => {
		await expect(assertPdfPageLimitBytes(minimalPdfBytes(MAX_PDF_PAGES))).resolves.toBe(MAX_PDF_PAGES)
	})

	it('rejects PDFs above the 10-page limit', async () => {
		await expect(assertPdfPageLimitBytes(minimalPdfBytes(MAX_PDF_PAGES + 1)))
			.rejects.toMatchObject({ name: 'PdfPageLimitError', code: 'PDF_PAGE_LIMIT_EXCEEDED', pageCount: MAX_PDF_PAGES + 1 })
	})

	it('rejects unreadable PDFs fail-closed', async () => {
		await expect(assertPdfPageLimitBytes(new TextEncoder().encode('not a pdf').buffer))
			.rejects.toBeInstanceOf(PdfPageLimitError)
	})

	it('derives HTTP status from the stable error code', () => {
		expect(pdfPageLimitStatus(PDF_PAGE_LIMIT_EXCEEDED)).toBe(413)
		expect(pdfPageLimitStatus(PDF_UNREADABLE)).toBe(400)
	})
})
