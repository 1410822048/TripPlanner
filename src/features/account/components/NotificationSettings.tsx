// src/features/account/components/NotificationSettings.tsx
// Browser push settings entry. The compact banner opens the detailed sheet;
// the header bell is reserved for the in-app notification inbox.
import { useState } from 'react'
import { AlertCircle, Bell, BellOff, Check, Info, Loader2 } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import { usePushNotifications } from '../hooks/usePushNotifications'

export default function NotificationSettings({ uid }: { uid: string }) {
  const { support, state, error, enable, disable } = usePushNotifications(uid)
  const [open, setOpen] = useState(false)

  const checking    = support === 'checking'
  const on          = state === 'enabled'
  const busy        = state === 'enabling' || state === 'disabling'
  const unavailable = support === 'unsupported'
    || support === 'ios-not-installed'
    || state === 'blocked'

  const status =
    checking                        ? '通知の状態を確認しています'
    : state === 'enabling'          ? '通知を有効にしています'
    : state === 'disabling'         ? '通知をオフにしています'
    : support === 'unsupported'     ? 'この環境では通知を利用できません'
    : support === 'ios-not-installed' ? 'ホーム画面に追加すると通知を利用できます'
    : state === 'blocked'           ? 'ブラウザ設定で通知がブロックされています'
    : state === 'error'             ? (error ?? '通知の設定に失敗しました')
    : on                            ? '重要な更新を通知します'
    : '通知はオフです'

  const StatusIcon = checking ? Loader2 : unavailable ? AlertCircle : on ? Bell : BellOff
  const bannerIconClass = checking
    ? 'animate-spin text-muted'
    : unavailable || state === 'error'
      ? 'text-warn'
      : on
        ? 'text-accent'
        : 'text-warn'
  const bannerClass = on
    ? 'border-accent/25 bg-accent-pale text-accent'
    : 'border-warn/45 bg-surface text-warn'

  function onToggle() {
    if (busy || unavailable || checking) return
    if (on) void disable()
    else void enable()
  }

  return (
    <>
      <div className="mx-4 mb-4">
        <div className={[
          'min-h-11 rounded-[18px] border-[1.5px] shadow-[0_2px_10px_rgba(0,0,0,0.04)]',
          'flex items-stretch overflow-hidden',
          bannerClass,
        ].join(' ')}
        >
          <button
            type="button"
            aria-label="通知設定"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="min-w-0 flex-1 px-3.5 py-2.5 text-left flex items-center gap-2.5 cursor-pointer"
          >
            <span className="w-6 h-6 rounded-full bg-current/10 flex items-center justify-center shrink-0">
              <StatusIcon
                size={14}
                strokeWidth={2.2}
                aria-hidden
                className={bannerIconClass}
              />
            </span>
            <span className="min-w-0 text-[11.5px] font-bold leading-[1.45] tracking-[0.02em]">
              {status}
            </span>
          </button>
        </div>
      </div>

      <BottomSheet isOpen={open} onClose={() => setOpen(false)} title="通知設定">
        <div className="flex items-start gap-3 rounded-card bg-app border border-border px-4 py-3.5">
          <div className="w-10 h-10 rounded-full bg-surface flex items-center justify-center shrink-0">
            <StatusIcon
              size={18}
              strokeWidth={2}
              aria-hidden
              className={checking ? 'animate-spin text-muted' : unavailable || !on ? 'text-muted' : 'text-accent'}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-black text-ink -tracking-[0.1px]">通知</div>
            <div className="mt-1 text-[12px] leading-[1.6] text-muted">
              {status}
            </div>
          </div>
        </div>

        {support === 'ios-not-installed' ? (
          <div className="rounded-card border border-accent/15 bg-accent-pale px-4 py-3.5">
            <div className="flex items-center gap-2 text-[13px] font-bold text-accent">
              <Info size={15} strokeWidth={2} aria-hidden />
              ホーム画面から利用できます
            </div>
            <div className="mt-2 text-[12px] leading-[1.7] text-accent/85">
              Safari の共有メニューからホーム画面に追加し、追加した TripMate から開いてください。
            </div>
          </div>
        ) : null}

        {support === 'supported' && state !== 'blocked' ? (
          <div className="rounded-card border border-border bg-surface px-4 py-3.5 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-bold text-ink">プッシュ通知</div>
              <div className="mt-1 text-[11.5px] leading-[1.55] text-muted">
                費用、予約、精算、メンバー参加を通知します
              </div>
            </div>
            {busy ? (
              <Loader2 size={20} className="animate-spin text-muted shrink-0" aria-hidden />
            ) : (
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label="プッシュ通知"
                onClick={onToggle}
                className={[
                  'relative w-11 h-6 rounded-full transition-colors shrink-0 cursor-pointer',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  on ? 'bg-accent' : 'bg-border',
                ].join(' ')}
              >
                <span
                  className={[
                    'absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white shadow transition-all',
                    on ? 'left-[22px]' : 'left-0.5',
                  ].join(' ')}
                />
              </button>
            )}
          </div>
        ) : null}

        {on ? (
          <div className="flex items-center gap-2 text-[11.5px] text-accent px-1">
            <Check size={14} strokeWidth={2.2} aria-hidden />
            この端末で通知を受け取れます
          </div>
        ) : null}
      </BottomSheet>
    </>
  )
}
