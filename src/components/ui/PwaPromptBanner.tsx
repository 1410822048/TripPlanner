import type { ReactNode } from 'react'
import { X } from 'lucide-react'

interface PwaPromptBannerProps {
  icon: ReactNode
  title: string
  description: string
  actionLabel: string
  onAction: () => void
  onDismiss?: () => void
  role: 'alert' | 'dialog' | 'status'
  ariaLabel?: string
  position?: 'above-nav' | 'top'
  actionDisabled?: boolean
}

export default function PwaPromptBanner({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  onDismiss,
  role,
  ariaLabel,
  position = 'above-nav',
  actionDisabled = false,
}: PwaPromptBannerProps) {
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className="fixed left-1/2 -translate-x-1/2 z-[300] w-[min(94vw,400px)] bg-surface border border-border rounded-[18px] px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.15)] flex items-center gap-3"
      style={position === 'top'
        ? { top: 'calc(env(safe-area-inset-top) + 12px)' }
        : { bottom: 'calc(var(--nav-h) + 12px)' }}
    >
      <div className="w-9 h-9 rounded-full bg-accent-pale shrink-0 flex items-center justify-center text-accent">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-bold text-ink tracking-[0.02em]">
          {title}
        </div>
        <div className="text-[10.5px] text-muted mt-0.5 truncate">
          {description}
        </div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="稍後再說"
          className="w-8 h-8 rounded-full text-muted hover:bg-app transition-colors flex items-center justify-center cursor-pointer shrink-0"
        >
          <X size={14} strokeWidth={2} />
        </button>
      )}
      <button
        type="button"
        onClick={onAction}
        disabled={actionDisabled}
        className="shrink-0 h-8 px-3 rounded-full bg-accent text-white text-[11.5px] font-bold tracking-[0.04em] border-none cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all disabled:opacity-60 disabled:cursor-wait"
        style={{ boxShadow: '0 2px 6px rgba(61,139,122,0.25)' }}
      >
        {actionLabel}
      </button>
    </div>
  )
}
