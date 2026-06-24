declare module 'pdfjs-dist/build/pdf.mjs' {
	export * from 'pdfjs-dist/types/src/pdf'
}

declare module 'pdfjs-dist/build/pdf.worker.mjs' {
	export const WorkerMessageHandler: unknown
}
