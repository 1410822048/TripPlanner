// src/features/attachments/components/AttachmentPreviewModal.tsx
// Full-screen viewer for an attachment (booking / expense receipt). Lets the
// user inspect the actual contents (list/form thumbnails are too small to
// read e.g. a flight QR code or hotel room number).
//
// path-only: the caller resolves the full-size blob objectURL via
// `useAttachmentUrl(fullPath, { kind: 'full' })` and passes it as `url`.
// While that getBlob is in flight `url` is null → we show a spinner (the
// modal is opened path-driven by the caller, not gated on the URL). The
// objectURL's lifetime is owned by the caller's hook (revoked on close).
//
// PDFs: rendered inline on every platform by the lazy-loaded PdfPreview
// (pdf.js via react-pdf). The old <iframe> couldn't render a blob: PDF on
// iOS WebKit, so iOS used to fall back to a new tab — which kicks a
// standalone PWA out to Safari. pdf.js renders in-app uniformly instead.
// The top-bar "別タブで開く" anchor stays as an escape hatch (and PdfPreview
// shows the same anchor if pdf.js fails to parse the bytes).
import { lazy, Suspense, useEffect } from 'react'
import { X, ExternalLink, FileText, Loader2 } from 'lucide-react'

const PdfPreview = lazy(() => import('./PdfPreview'))

interface Props {
  /** Resolved blob objectURL, or null while the bytes are being fetched. */
  url:      string | null
  fileType: string | undefined
  fileName: string
  onClose:  () => void
}

export default function AttachmentPreviewModal({ url, fileType, fileName, onClose }: Props) {
  // Escape closes. Lock body scroll while open so the page underneath
  // doesn't drift on iOS rubberband.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const main = document.querySelector<HTMLElement>('main')
    const prevOverflow = main?.style.overflow
    if (main) main.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      if (main && prevOverflow !== undefined) main.style.overflow = prevOverflow
    }
  }, [onClose])

  const isImage = (fileType ?? '').startsWith('image/')
  const isPdf   = fileType === 'application/pdf'

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[300] bg-black/85 flex flex-col"
      style={{ touchAction: isPdf ? 'auto' : 'none' }}
    >
      {/* Top bar — kept in normal flex flow (was previously `absolute`,
          which let the image body render behind it and visually drown the
          close button on busy / light images). `shrink-0` plus `z-10`
          guarantees the buttons sit above the body in every layout case. */}
      <div
        onClick={e => e.stopPropagation()}
        className="shrink-0 relative z-10 flex items-center justify-between px-4 pb-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
      >
        <div className="text-white/90 text-[12px] font-medium truncate max-w-[60vw]">
          {fileName}
        </div>
        <div className="flex items-center gap-2">
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="在新分頁開啟"
              className="w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center text-white transition-colors"
            >
              <ExternalLink size={16} strokeWidth={2} />
            </a>
          )}
          <button
            onClick={onClose}
            aria-label="關閉"
            className="w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center text-white border-none cursor-pointer transition-colors"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Body. While the blob is loading (url === null) show a spinner. */}
      {url === null ? (
        <div className="flex-1 min-h-0 flex items-center justify-center" onClick={e => e.stopPropagation()}>
          <Loader2 size={28} strokeWidth={2} className="text-white/70 animate-spin" />
        </div>
      ) : isImage ? (
        <div
          className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          <img
            src={url}
            alt={fileName}
            className="max-w-full max-h-full object-contain select-none"
            style={{ touchAction: 'auto' }}
            draggable={false}
          />
        </div>
      ) : isPdf ? (
        <div
          className="flex-1 min-h-0 flex flex-col"
          onClick={e => e.stopPropagation()}
        >
          <Suspense
            fallback={
              <div className="flex-1 min-h-0 flex items-center justify-center">
                <Loader2 size={28} strokeWidth={2} className="text-white/70 animate-spin" />
              </div>
            }
          >
            <PdfPreview key={url} url={url} />
          </Suspense>
        </div>
      ) : (
        // Unpreviewable type: open the (already-resolved) blob URL in a new
        // tab. Gesture-synchronous anchor → no popup-block race.
        <div
          className="flex-1 min-h-0 flex flex-col items-center justify-center p-6 gap-4 text-center"
          onClick={e => e.stopPropagation()}
        >
          <div className="w-20 h-20 rounded-2xl bg-white/10 flex items-center justify-center text-white/80">
            <FileText size={36} strokeWidth={1.4} />
          </div>
          <div className="text-white/90 text-[14px] font-semibold">
            {fileName}
          </div>
          <p className="text-white/60 text-[12px] leading-[1.6] max-w-[260px]">
            無法預覽此檔案。請在新分頁開啟以查看內容。
          </p>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 rounded-chip bg-white text-ink text-[13px] font-bold no-underline transition-colors hover:bg-white/90"
          >
            <ExternalLink size={14} strokeWidth={2.2} />
            在新分頁開啟
          </a>
        </div>
      )}
    </div>
  )
}
