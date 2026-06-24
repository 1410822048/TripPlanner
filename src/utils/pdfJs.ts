// The worker comes from top-level `pdfjs-dist`, but the runtime pdf.js comes
// from react-pdf's bundled copy. pdf.js throws "API version does not match
// Worker version" if they differ, so BOTH `pdfjs-dist` and `react-pdf` are
// pinned EXACT in package.json (5.4.296 / 10.4.1) as a locked pair — they
// dedupe to one install. Bump them together; never re-add a caret to either.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// VerbosityLevel.ERRORS is 0 in pdf.js. Keeping this numeric avoids a
// top-level react-pdf import from upload service modules in Node/Vitest.
export const PDF_DOCUMENT_OPTIONS = { verbosity: 0 }

export function configurePdfJsWorker(pdfjs: { GlobalWorkerOptions: { workerSrc: string } }): void {
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
}
