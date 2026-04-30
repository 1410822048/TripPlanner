// src/components/PwaUpdatePrompt.tsx
// Surfaces a subtle banner when the service worker has a new version waiting.
// Clicking "更新" triggers updateServiceWorker(), which activates the new SW
// and reloads the page. The banner is dismissible so users mid-task can
// defer until they're ready.
//
// Integrates with vite-plugin-pwa's `registerType: 'prompt'` mode — without
// that mode the SW auto-updates silently and this prompt never fires.
import { RefreshCw, X } from 'lucide-react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { captureError } from '@/services/sentry'

export default function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // Non-fatal: if SW registration fails (first visit without SW support,
      // dev mode quirks), the app still works — we just lose PWA features.
      // Forward to Sentry so unexpected SW failures (e.g. CSP regressions
      // breaking Workbox) surface in monitoring instead of silent loss
      // of the offline experience.
      captureError(error, { source: 'pwa-sw-register' })
    },
  })

  if (!needRefresh) return null

  return (
    <div
      role="status"
      className="fixed left-1/2 -translate-x-1/2 bottom-[76px] z-[300] w-[min(94vw,400px)] bg-surface border border-border rounded-[18px] px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.15)] flex items-center gap-3"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
    >
      <div className="w-9 h-9 rounded-full bg-accent-pale shrink-0 flex items-center justify-center text-accent">
        <RefreshCw size={16} strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-bold text-ink tracking-[0.02em]">
          新しいバージョンがあります
        </div>
        <div className="text-[10.5px] text-muted mt-0.5">
          再読み込みでアップデートします
        </div>
      </div>
      <button
        onClick={() => setNeedRefresh(false)}
        aria-label="あとで"
        className="w-8 h-8 rounded-full text-muted hover:bg-app transition-colors flex items-center justify-center cursor-pointer shrink-0"
      >
        <X size={14} strokeWidth={2} />
      </button>
      <button
        onClick={() => { void updateServiceWorker() }}
        className="shrink-0 h-8 px-3 rounded-full bg-accent text-white text-[11.5px] font-bold tracking-[0.04em] border-none cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all"
        style={{ boxShadow: '0 2px 6px rgba(61,139,122,0.25)' }}
      >
        更新
      </button>
    </div>
  )
}
