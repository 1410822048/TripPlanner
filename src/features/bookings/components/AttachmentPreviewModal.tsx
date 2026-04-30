// src/features/bookings/components/AttachmentPreviewModal.tsx
// Full-screen image viewer for booking attachments. Lets the user inspect
// the actual confirmation contents (the list/form thumbnails are too small
// to read e.g. a flight QR code or hotel room number).
//
// PDFs and other non-image types aren't rendered inline — we offer a
// "別タブで開く" button that opens the storage download URL in a new tab,
// which delegates to the OS / browser PDF viewer (every modern browser
// has one built in). Trying to embed PDFs inline runs into MIME / CSP /
// scrolling-in-modal issues that aren't worth the complexity for a feature
// that gets used a few times per trip.
import { useEffect } from 'react'
import { X, ExternalLink, FileText } from 'lucide-react'

interface Props {
  url:      string
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

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[300] bg-black/85 flex flex-col"
      style={{ touchAction: 'none' }}
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
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="別タブで開く"
            className="w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center text-white transition-colors"
          >
            <ExternalLink size={16} strokeWidth={2} />
          </a>
          <button
            onClick={onClose}
            aria-label="閉じる"
            className="w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center text-white border-none cursor-pointer transition-colors"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Body — single tap on the image area still bubbles to backdrop close,
          but we allow native pinch-zoom via touchAction:none on the wrapper
          and `auto` on the image. */}
      {isImage ? (
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
      ) : (
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
            このファイルはプレビューできません。別タブで開くと内容を確認できます。
          </p>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-2 px-5 py-2.5 rounded-chip bg-white text-ink text-[13px] font-bold no-underline transition-colors hover:bg-white/90"
          >
            <ExternalLink size={14} strokeWidth={2.2} />
            別タブで開く
          </a>
        </div>
      )}
    </div>
  )
}
