import {
	MAX_PDF_PAGES,
	assertPdfPageLimitWithPdfJs,
} from '@tripmate/pdf-page-limit'

type PdfJsModule = typeof import('pdfjs-dist/build/pdf.mjs')
type PdfJsWorkerModule = typeof import('pdfjs-dist/build/pdf.worker.mjs')

let pdfjsPromise: Promise<PdfJsModule> | undefined

class MinimalDOMMatrix {
	multiplySelf() { return this }
	preMultiplySelf() { return this }
	translate() { return this }
	scale() { return this }
	invertSelf() { return this }
}

function installPdfJsImportShims(): void {
	const g = globalThis as typeof globalThis & Record<string, unknown>
	g.DOMMatrix ??= MinimalDOMMatrix
	g.ImageData ??= class ImageData {}
	g.Path2D ??= class Path2D {
		addPath() {}
	}
}

async function loadPdfJs(): Promise<PdfJsModule> {
	pdfjsPromise ??= (async () => {
		installPdfJsImportShims()
		const [pdfjs, pdfjsWorker] = await Promise.all([
			import('pdfjs-dist/build/pdf.mjs'),
			import('pdfjs-dist/build/pdf.worker.mjs') as Promise<PdfJsWorkerModule>,
		])
		const g = globalThis as typeof globalThis & { pdfjsWorker?: PdfJsWorkerModule }
		g.pdfjsWorker ??= pdfjsWorker
		if (!g.pdfjsWorker) {
			throw new Error('pdf.js worker module was not installed on globalThis')
		}
		return pdfjs
	})()
	return pdfjsPromise
}

export async function assertPdfPageLimitBytes(
	bytes: ArrayBuffer,
	maxPages: number = MAX_PDF_PAGES,
): Promise<number> {
	const pdfjs = await loadPdfJs()
	return assertPdfPageLimitWithPdfJs(pdfjs, new Uint8Array(bytes), maxPages)
}
