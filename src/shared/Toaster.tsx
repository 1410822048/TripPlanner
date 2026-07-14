// src/shared/Toaster.tsx
// Fixed-position viewport rendering active toasts. Mounted once at app root.
import { useToastStore, type ToastKind } from './toast'

const KIND_STYLE: Record<ToastKind, { bg: string; fg: string; ring: string; icon: string }> = {
  success: { bg: '#E8F2EC', fg: '#2A6A4F', ring: 'rgba(61,139,122,0.25)', icon: '✓' },
  error:   { bg: '#FBE8E5', fg: '#8C3A2E', ring: 'rgba(160,64,64,0.22)',  icon: '!' },
  info:    { bg: '#EEF1F6', fg: '#3A4B66', ring: 'rgba(74,111,160,0.22)', icon: 'ⓘ' },
}

export default function Toaster() {
  const items   = useToastStore(s => s.items)
  const dismiss = useToastStore(s => s.dismiss)
  if (items.length === 0) return null

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="fixed left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-2 pointer-events-none"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 14px)', maxWidth: '92vw' }}
    >
      {/* Outer is <div>, not <button>; the message area is its own inner
          button so tapping it still dismisses. */}
      {items.map(t => {
        const s = KIND_STYLE[t.kind]
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl text-[13px] font-semibold"
            style={{
              background:   s.bg,
              color:        s.fg,
              boxShadow:    `0 6px 20px ${s.ring}, 0 1px 3px rgba(0,0,0,0.06)`,
              animation:    'toastIn 0.24s cubic-bezier(0.32,0.72,0,1)',
              minWidth:     '240px',
              maxWidth:     '480px',
            }}
          >
            <span
              className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-black"
              style={{ background: s.fg, color: s.bg }}
            >
              {s.icon}
            </span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="關閉"
              className="flex-1 text-left border-none bg-transparent p-0 cursor-pointer font-semibold"
              style={{ color: s.fg }}
            >
              {t.message}
            </button>
          </div>
        )
      })}
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(-8px) scale(0.96); }
          to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }
      `}</style>
    </div>
  )
}
