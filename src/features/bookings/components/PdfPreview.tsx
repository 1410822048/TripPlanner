// src/features/bookings/components/PdfPreview.tsx
// In-app PDF viewer (pdf.js via react-pdf). Lazy-loaded ONLY when the
// attachment preview opens on a PDF, so pdfjs + its worker (~hundreds of KB)
// stay out of the main bundle. Replaces the old per-platform split (desktop
// <iframe> / iOS "別タブで開く"); iOS PWA users no longer get kicked out to
// Safari to read a booking document.
//
// Renders up to the product PDF page limit in a vertical scroll. New uploads
// are Worker-gated to the same limit; the render cap is a legacy-data guard.
import { useEffect, useRef, useState } from 'react'
import { MAX_PDF_PAGES } from '@tripmate/pdf-page-limit'
import { Loader2, FileText } from 'lucide-react'
import { Document, Page, pdfjs } from 'react-pdf'
import { configurePdfJsWorker, PDF_DOCUMENT_OPTIONS } from '@/utils/pdfJs'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

configurePdfJsWorker(pdfjs)

const spinner = (
  <div className="flex items-center justify-center py-16">
    <Loader2 size={28} strokeWidth={2} className="text-white/70 animate-spin" />
  </div>
)

export default function PdfPreview({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth]       = useState<number>()
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

  // Fit each page to the container width (capped so desktop doesn't render a
  // giant page). ResizeObserver = external-resource subscription, the one
  // place useEffect is correct here (cf. useBlobUrl / useAttachmentUrl).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setWidth(Math.min(el.clientWidth - 24, 900))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-3"
      style={{ touchAction: 'auto' }}
    >
      {file ? (
        <Document
          file={file}
          options={PDF_DOCUMENT_OPTIONS}
          loading={spinner}
          onLoadSuccess={({ numPages }) => setNumPages(numPages)}
          onLoadError={() => setFailed(true)}
          onSourceError={() => setFailed(true)}
          className="flex flex-col items-center gap-3"
        >
          {width !== undefined &&
            Array.from({ length: visiblePages }, (_, i) => (
              <Page key={i} pageNumber={i + 1} width={width} className="shadow-lg" />
            ))}
          {hiddenPages > 0 && (
            <div className="w-full max-w-[900px] px-4 py-3 text-center text-white/70 text-[12px] leading-[1.6]">
              残り{hiddenPages}ページは
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
      ) : spinner}
    </div>
  )
}
