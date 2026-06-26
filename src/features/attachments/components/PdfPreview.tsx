// src/features/attachments/components/PdfPreview.tsx
// In-app PDF viewer (pdf.js via react-pdf). Lazy-loaded ONLY when the
// attachment preview opens on a PDF, so pdfjs + its worker (~hundreds of KB)
// stay out of the main bundle. Replaces the old per-platform split (desktop
// <iframe> / iOS "別タブで開く"); iOS PWA users no longer get kicked out to
// Safari to read a booking document.
//
// Renders up to the product PDF page limit in a vertical scroll. New uploads
// are Worker-gated to the same limit; the render cap is a legacy-data guard.
import { useEffect, useState } from 'react'
import { MAX_PDF_PAGES } from '@tripmate/pdf-page-limit'
import { Loader2, FileText } from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import { configurePdfJsWorker, PDF_DOCUMENT_OPTIONS } from '@/utils/pdfJs'
import PdfZoomViewport from './PdfZoomViewport'

configurePdfJsWorker(pdfjs)

const ESTIMATED_PAGE_RATIO = 1.414
const MAX_CANVAS_PIXELS = 12_000_000
const MAX_DEVICE_PIXEL_RATIO = 2.5

const spinner = (
  <div className="flex items-center justify-center py-16">
    <Loader2 size={28} strokeWidth={2} className="text-white/70 animate-spin" />
  </div>
)

function pdfDevicePixelRatio(renderWidth: number) {
  const nativeRatio = window.devicePixelRatio || 1
  const targetRatio = Math.min(nativeRatio * 1.5, MAX_DEVICE_PIXEL_RATIO)
  const estimatedPixels = renderWidth * renderWidth * ESTIMATED_PAGE_RATIO
  const cappedRatio = Math.sqrt(MAX_CANVAS_PIXELS / estimatedPixels)
  return Math.max(1, Math.min(targetRatio, cappedRatio))
}

function ScaledPdfPage({
  pageNumber,
  width,
  scale,
}: {
  pageNumber: number
  width: number
  scale: number
}) {
  const [pageRatio, setPageRatio] = useState(ESTIMATED_PAGE_RATIO)
  const displayWidth = width * scale
  const displayHeight = width * pageRatio * scale

  return (
    <div
      data-pdf-page-frame={pageNumber}
      className="relative shrink-0"
      style={{ width: `${displayWidth}px`, height: `${displayHeight}px` }}
    >
      <div
        className="absolute left-1/2 top-0"
        style={{
          transform: `translateX(-50%) scale(${scale})`,
          transformOrigin: 'top center',
          width: `${width}px`,
        }}
      >
        <Page
          pageNumber={pageNumber}
          width={width}
          devicePixelRatio={pdfDevicePixelRatio(width)}
          renderAnnotationLayer={false}
          renderTextLayer={false}
          className="shadow-lg"
          onRenderSuccess={page => {
            setPageRatio(current => {
              const next = page.height / width
              return current === next ? current : next
            })
          }}
        />
      </div>
    </div>
  )
}

export default function PdfPreview({ url }: { url: string }) {
  const [numPages, setNumPages] = useState(0)
  const [failed, setFailed]     = useState(false)
  const visiblePages = Math.min(numPages, MAX_PDF_PAGES)
  const hiddenPages  = Math.max(0, numPages - visiblePages)

  // pdf.js fetching a blob: URL directly can fail with "Unexpected server
  // response (0)" (its range-request / worker-context handling of object
  // URLs). Read the resolved URL into a Blob once and hand that to <Document>;
  // pdf.js then reads it via arrayBuffer(). In production this is usually a
  // cross-origin GCS signed URL, so preview depends on bucket CORS allowing the
  // Pages origin. In getBlob/dev mode it is a blob: URL owned by useAttachmentUrl
  // for the modal lifetime.
  const [file, setFile] = useState<Blob>()
  useEffect(() => {
    const controller = new AbortController()

    fetch(url, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`PDF fetch failed: ${r.status}`)
        return r.blob()
      })
      .then(b => {
        if (!controller.signal.aborted) setFile(b)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })

    return () => controller.abort()
  }, [url])

  if (failed) {
    // pdf.js couldn't parse / fetch the bytes. Keep the new-tab escape hatch
    // (the resolved blob/signed URL still opens in the browser's own viewer).
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <FileText size={36} strokeWidth={1.4} className="text-white/80" />
        <p className="text-white/70 text-[13px]">PDF を表示できませんでした</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/90 underline text-[13px]"
        >
          別タブで開く
        </a>
      </div>
    )
  }

  return file ? (
    <PdfZoomViewport>
      {({ pageWidth, scale }) => (
        <Document
          file={file}
          options={PDF_DOCUMENT_OPTIONS}
          loading={spinner}
          onLoadSuccess={({ numPages }) => setNumPages(numPages)}
          onLoadError={() => setFailed(true)}
          onSourceError={() => setFailed(true)}
          className="flex w-max min-w-full flex-col items-center gap-3"
        >
          {pageWidth !== undefined &&
            Array.from({ length: visiblePages }, (_, i) => (
              <ScaledPdfPage
                key={i}
                pageNumber={i + 1}
                width={pageWidth}
                scale={scale}
              />
            ))}
          {hiddenPages > 0 && (
            <div className="w-full max-w-[900px] px-4 py-3 text-center text-white/70 text-[12px] leading-[1.6]">
              残り{hiddenPages}ページは非表示です。
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/90 underline underline-offset-2"
              >
                別タブで開く
              </a>
              から確認してください。
            </div>
          )}
        </Document>
      )}
    </PdfZoomViewport>
  ) : (
    <div className="flex-1 min-h-0 overflow-auto overscroll-contain py-3">
      {spinner}
    </div>
  )
}
