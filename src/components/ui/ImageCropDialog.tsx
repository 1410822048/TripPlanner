// src/components/ui/ImageCropDialog.tsx
// Full-screen crop UI shown after a user picks an image and before the
// file enters the upload pipeline. Wraps react-easy-crop (which handles
// pinch / drag / zoom natively across touch + mouse) inside the app's
// modal language: dark backdrop, surface-coloured footer with cancel +
// confirm.
//
// Flow:
//   pick file → ImageCropDialog opens with the file's blob URL
//   → user drags / zooms to position
//   → onConfirm fires with the pixel rectangle the user chose
//   → caller pipes that into cropImage() to produce a new File
//
// Aspect ratio is fixed to 16:9 (the WishCard hero) — matches the
// primary display target. The smaller 1:1 thumbnails downstream
// (Account / PastLodging) still apply CSS center-crop on top, but
// since the user has now centred their subject inside the 16:9, the
// 1:1 inner crop also lands on it.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Cropper, { type Area } from 'react-easy-crop'
import { Check, X as XIcon } from 'lucide-react'
import type { PixelCrop } from '@/utils/image'

interface Props {
  /** Blob URL of the user's picked file. Caller owns the URL lifecycle
   *  (URL.createObjectURL + revokeObjectURL) — this component just reads. */
  src:       string
  onCancel:  () => void
  onConfirm: (area: PixelCrop) => void
  /** Override the 16:9 default if a different target ratio is ever
   *  needed (e.g. square avatar crop). Number is width / height. */
  aspect?:   number
}

export default function ImageCropDialog({ src, onCancel, onConfirm, aspect = 16 / 9 }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [area, setArea] = useState<Area | null>(null)

  // Esc / hardware back closes. onCancel is read via a ref so callers
  // can pass inline arrows (`onCancel={() => setOpen(false)}`) without
  // re-subscribing the listener on every parent render — same pattern
  // as BottomSheet's onCloseRef.
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onCancelRef.current = onCancel })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancelRef.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Portal so the dialog sits above any parent BottomSheet without
  // being clipped by its overflow-hidden / rounded corners.
  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="画像をトリミング"
      style={{ background: 'rgba(15, 12, 10, 0.96)' }}
    >
      {/* Crop area fills available space above the footer. Cropper
          itself is absolutely positioned by the lib, so we just give
          it a relatively-positioned parent with a fixed rect. */}
      <div className="relative flex-1 min-h-0">
        <Cropper
          image={src}
          crop={crop}
          zoom={zoom}
          aspect={aspect}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={(_, pixels) => setArea(pixels)}
          objectFit="contain"
          showGrid
        />
      </div>

      {/* Zoom slider — visible affordance on top of the universal
          pinch-to-zoom gesture, for desktop users without touch. */}
      <div className="px-5 pb-3 pt-2 bg-transparent">
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={e => setZoom(Number(e.target.value))}
          aria-label="ズーム"
          className="w-full accent-[#3D8B7A]"
        />
      </div>

      {/* Footer: cancel + confirm, mirrors FormModalShell layout so
          the two buttons feel like the standard form bottom bar. */}
      <div
        className="flex gap-2.5 px-4 py-3 bg-surface border-t border-border"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
      >
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 h-11 rounded-chip border border-border bg-transparent text-ink text-[14px] font-semibold cursor-pointer flex items-center justify-center gap-1.5 transition-colors hover:bg-app"
        >
          <XIcon size={15} strokeWidth={2.2} />
          キャンセル
        </button>
        <button
          type="button"
          onClick={() => area && onConfirm(area)}
          disabled={!area}
          className="flex-1 h-11 rounded-chip border-none bg-teal text-white text-[14px] font-bold cursor-pointer flex items-center justify-center gap-1.5 transition-all hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
        >
          <Check size={15} strokeWidth={2.4} />
          切り抜く
        </button>
      </div>
    </div>,
    document.body,
  )
}
