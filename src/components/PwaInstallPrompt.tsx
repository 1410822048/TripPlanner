// src/components/PwaInstallPrompt.tsx
// Encourages users to install the app to their home screen, so they get
// the standalone-window experience (no Safari/Chrome chrome, app-icon
// launch, full-screen on iOS) instead of running it as a tab.
//
// Two paths:
//   - Android / desktop Chrome: the browser fires `beforeinstallprompt`,
//     we capture it, and the user's tap calls `prompt()`. The browser
//     handles the rest (its own confirm sheet, install UX).
//   - iOS Safari: there is no install API at all — the user must tap
//     Share → Add to Home Screen by hand. So we show a small instructions
//     modal that walks them through it.
//
// The banner is hidden when:
//   - already running in standalone mode (display-mode: standalone, or
//     iOS legacy navigator.standalone),
//   - the user dismissed it within the last 14 days,
//   - the browser hasn't fired beforeinstallprompt and we're not on iOS
//     Safari (e.g. desktop Firefox — no install support at all).
import { useEffect, useRef, useState } from 'react'
import { Download, Share, Plus, X } from 'lucide-react'

const DISMISSED_KEY = 'tripmate-install-dismissed-at'
const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000  // 14 days
// Delay the first appearance so the banner doesn't compete with the
// splash screen (1600ms) and the user has a moment to orient. Long
// enough to feel non-intrusive; short enough that engaged users see it.
const APPEAR_DELAY_MS = 3000

// Chrome's install event fires on `window` but isn't in lib.dom yet for
// all TS configurations. Minimal local typing — we only need prompt()
// and userChoice for our flow.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type Mode = 'hidden' | 'native' | 'ios'

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  // Android / desktop / iOS-PWA all support display-mode media query.
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  // iOS Safari pre-iOS 17 only exposes the legacy property.
  const navStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone
  return !!navStandalone
}

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // iPad on iOS 13+ reports as Mac — fall back to touch + platform check.
  const iPadDesktop = navigator.platform === 'MacIntel'
    && typeof navigator.maxTouchPoints === 'number'
    && navigator.maxTouchPoints > 1
  const isIos = /iPad|iPhone|iPod/.test(ua) || iPadDesktop
  if (!isIos) return false
  // Exclude in-app browsers (FB / Line) and other non-Safari shells —
  // those can't add to home screen, so showing instructions wastes pixels.
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
  return isSafari
}

function recentlyDismissed(): boolean {
  try {
    const v = localStorage.getItem(DISMISSED_KEY)
    if (!v) return false
    const at = Number(v)
    if (!Number.isFinite(at)) return false
    return Date.now() - at < DISMISS_TTL_MS
  } catch { return false }
}

function markDismissed() {
  try { localStorage.setItem(DISMISSED_KEY, String(Date.now())) }
  catch { /* private mode / quota — banner just re-appears next session */ }
}

export default function PwaInstallPrompt() {
  const [mode, setMode] = useState<Mode>('hidden')
  const [showSteps, setShowSteps] = useState(false)
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    if (isStandalone()) return
    if (recentlyDismissed()) return

    let appearTimer: number | undefined
    function scheduleAppear(next: Mode) {
      appearTimer = window.setTimeout(() => setMode(next), APPEAR_DELAY_MS)
    }

    if (isIosSafari()) {
      scheduleAppear('ios')
      return () => { if (appearTimer) window.clearTimeout(appearTimer) }
    }

    function onBeforeInstallPrompt(e: Event) {
      // Stop the browser's own mini-infobar; we surface our own.
      e.preventDefault()
      deferredRef.current = e as BeforeInstallPromptEvent
      scheduleAppear('native')
    }
    function onInstalled() {
      // Browser confirmed install — banner job is done forever.
      deferredRef.current = null
      setMode('hidden')
      markDismissed()
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
      if (appearTimer) window.clearTimeout(appearTimer)
    }
  }, [])

  async function handleNativeInstall() {
    const dp = deferredRef.current
    if (!dp) return
    try {
      await dp.prompt()
      const choice = await dp.userChoice
      // Either way the prompt is consumed (Chrome only fires it once per
      // session). Hide the banner; remember dismissal only if the user
      // declined, so accepters won't see it on a future visit.
      deferredRef.current = null
      setMode('hidden')
      if (choice.outcome === 'dismissed') markDismissed()
    } catch {
      // Some browsers throw if prompt() is called twice — just hide.
      setMode('hidden')
    }
  }

  function handleDismiss() {
    markDismissed()
    setMode('hidden')
    setShowSteps(false)
  }

  if (mode === 'hidden') return null

  return (
    <>
      <div
        role="dialog"
        aria-label="加入主畫面"
        className="fixed left-1/2 -translate-x-1/2 z-[300] w-[min(94vw,400px)] bg-surface border border-border rounded-[18px] px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.15)] flex items-center gap-3"
        // Sit 12px above the nav's top edge. The nav already spans the
        // viewport's bottom var(--nav-h) — including the iOS home-
        // indicator safe area on standalone PWAs — so layering an extra
        // env(safe-area-inset-bottom) here would double-count that space
        // and push the banner ~34px higher than the user expects on iPhone.
        style={{ bottom: 'calc(var(--nav-h) + 12px)' }}
      >
        <div className="w-9 h-9 rounded-full bg-accent-pale shrink-0 flex items-center justify-center text-accent">
          <Download size={16} strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] font-bold text-ink tracking-[0.02em]">
            加入主畫面
          </div>
          <div className="text-[10.5px] text-muted mt-0.5 truncate">
            像 App 一樣直接開啟
          </div>
        </div>
        <button
          onClick={handleDismiss}
          aria-label="稍後再說"
          className="w-8 h-8 rounded-full text-muted hover:bg-app transition-colors flex items-center justify-center cursor-pointer shrink-0"
        >
          <X size={14} strokeWidth={2} />
        </button>
        <button
          onClick={mode === 'native' ? handleNativeInstall : () => setShowSteps(true)}
          className="shrink-0 h-8 px-3 rounded-full bg-accent text-white text-[11.5px] font-bold tracking-[0.04em] border-none cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all"
          style={{ boxShadow: '0 2px 6px rgba(61,139,122,0.25)' }}
        >
          {mode === 'native' ? '安裝' : '查看方法'}
        </button>
      </div>

      {mode === 'ios' && showSteps && (
        <IosInstructions onClose={() => setShowSteps(false)} onDismiss={handleDismiss} />
      )}
    </>
  )
}

function IosInstructions({ onClose, onDismiss }: { onClose: () => void; onDismiss: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="加入主畫面的方法"
      className="fixed inset-0 z-[400] bg-black/40 flex items-end justify-center"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-[440px] bg-surface rounded-t-[24px] px-5 pt-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="m-0 text-[15px] font-black text-ink -tracking-[0.3px]">
            加入主畫面
          </h2>
          <button
            onClick={onClose}
            aria-label="關閉"
            className="w-8 h-8 rounded-full text-muted hover:bg-app transition-colors flex items-center justify-center cursor-pointer border-none bg-transparent"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <ol className="m-0 p-0 list-none flex flex-col gap-3">
          <Step
            n={1}
            title="點選分享按鈕"
            note="Safari 底部的分享圖示"
            icon={<Share size={18} strokeWidth={1.8} className="text-accent" />}
          />
          <Step
            n={2}
            title="選擇「加入主畫面」"
            note="向下捲動選單"
            icon={<Plus size={18} strokeWidth={2} className="text-accent" />}
          />
          <Step
            n={3}
            title="點選「加入」"
            note="圖示會顯示在主畫面"
            icon={<Download size={18} strokeWidth={1.8} className="text-accent" />}
          />
        </ol>

        <button
          onClick={onDismiss}
          className="mt-4 w-full h-11 rounded-chip bg-app text-ink text-[13px] font-semibold border border-border cursor-pointer hover:bg-tile active:scale-[0.99] transition-all tracking-[0.04em]"
        >
          不再顯示
        </button>
      </div>
    </div>
  )
}

function Step({ n, title, note, icon }: {
  n: number
  title: string
  note: string
  icon: React.ReactNode
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 rounded-card bg-app border border-border">
      <div className="w-7 h-7 rounded-full bg-surface text-accent text-[12px] font-black flex items-center justify-center shrink-0">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-bold text-ink">{title}</div>
        <div className="text-[10.5px] text-muted mt-0.5">{note}</div>
      </div>
      <div className="w-8 h-8 rounded-full bg-accent-pale flex items-center justify-center shrink-0">
        {icon}
      </div>
    </li>
  )
}
