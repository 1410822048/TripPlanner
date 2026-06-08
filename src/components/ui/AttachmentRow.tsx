// src/components/ui/AttachmentRow.tsx
// Shared "has attachment" row used by Expense / Booking / Wish form
// modals. Whole row triggers replace, optional thumbnail triggers
// preview, X icon removes.
//
// A11y/focus model: the full-row "replace" target is a SIBLING button
// positioned `absolute inset-0` underneath the visual layer — NOT a
// div role="button" wrapping nested buttons (that would dirty the
// focus tree and confuse screen readers). The filename column uses
// `pointer-events-none` so taps fall through to the overlay; thumbnail
// and X are real `relative z-10` buttons. Tab order is replace →
// preview → remove, three independent buttons in the a11y tree.
//
// Empty state ("add file" CTA) lives in each caller — this component
// only renders the populated state.

import { X as XIcon, FileText } from 'lucide-react'

interface BaseProps {
  fileName:         string
  previewUrl:       string | null
  isImage:          boolean
  onReplace:        () => void
  onClear:          () => void
  replaceAriaLabel: string
  clearAriaLabel:   string
  /** Muted hint shown beneath the filename. Defaults to a generic
   *  "tap to change" copy that fits any noun. */
  changeHint?:      string
}

/** Preview support is all-or-nothing — having `onPreview` without an
 *  aria-label would ship an unannounced thumbnail button, and supplying
 *  an aria-label without a handler is dead config. The `?: never` arm
 *  enforces "omit both" on callers like Wish that don't preview.
 *
 *  `canPreview` gates the button independently of `previewUrl`: under the
 *  path-only model a thumb-less attachment (PDF / pre-thumb image) has no
 *  thumbnail URL but IS still openable in the full preview (the full blob
 *  resolves on open), so enablement tracks "is there something to open"
 *  (fullPath / a freshly-picked file), not "do we have a thumbnail". */
type PreviewProps =
  | { onPreview:  () => void; previewAriaLabel: string; canPreview: boolean }
  | { onPreview?: never;       previewAriaLabel?: never; canPreview?: never }

type Props = BaseProps & PreviewProps

export default function AttachmentRow({
  fileName,
  previewUrl,
  isImage,
  onReplace,
  onClear,
  onPreview,
  canPreview,
  replaceAriaLabel,
  previewAriaLabel,
  clearAriaLabel,
  changeHint = 'タップして変更',
}: Props) {
  const thumbInner = isImage && previewUrl
    ? <img src={previewUrl} alt="" className="w-full h-full object-cover" draggable={false} />
    : <FileText size={20} strokeWidth={1.6} className="text-muted" />

  const thumbBase = 'w-12 h-12 rounded-md shrink-0 overflow-hidden bg-tile flex items-center justify-center'

  return (
    <div className="relative flex items-center gap-3 px-2.5 py-2 rounded-input bg-app border border-border transition-colors hover:border-muted">
      {/* Replace trigger. First in DOM = first Tab stop. Invisible but
          sized to the parent's content box via `absolute inset-0`, so
          the focus ring traces the row's outline. */}
      <button
        type="button"
        onClick={onReplace}
        aria-label={replaceAriaLabel}
        className="absolute inset-0 rounded-input cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      />

      {onPreview ? (
        <button
          type="button"
          onClick={onPreview}
          disabled={!canPreview}
          aria-label={previewAriaLabel}
          className={`relative z-10 ${thumbBase} border-none cursor-pointer hover:opacity-80 transition-opacity disabled:cursor-default disabled:opacity-100`}
        >
          {thumbInner}
        </button>
      ) : (
        // Decorative thumbnail. pointer-events-none lets taps fall
        // through to the replace overlay below.
        <div className={`relative z-10 pointer-events-none ${thumbBase}`}>
          {thumbInner}
        </div>
      )}

      {/* Text column — pointer-events-none so taps land on overlay. */}
      <div className="relative z-10 pointer-events-none flex-1 min-w-0">
        <div className="text-[12px] font-semibold text-ink truncate">{fileName}</div>
        <div className="text-[11px] text-muted font-medium">{changeHint}</div>
      </div>

      <button
        type="button"
        onClick={onClear}
        aria-label={clearAriaLabel}
        className="relative z-10 w-8 h-8 rounded-full flex items-center justify-center bg-app text-muted border-none cursor-pointer hover:bg-border transition-colors shrink-0"
      >
        <XIcon size={14} strokeWidth={2} />
      </button>
    </div>
  )
}
