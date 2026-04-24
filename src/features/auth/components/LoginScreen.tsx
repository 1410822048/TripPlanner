// src/features/auth/components/LoginScreen.tsx
import { useState } from 'react'
import { CalendarDays, Receipt, Users } from 'lucide-react'
import GoogleIcon from '@/components/icons/GoogleIcon'
import { toast } from '@/shared/toast'

interface Props {
  onSignIn: () => Promise<void>
}

const FEATURES = [
  { Icon: CalendarDays, label: '行程を組み立てる',  sub: '日程・交通・宿泊を一つに' },
  { Icon: Receipt,      label: '費用を分かち合う',  sub: '自動で精算額を計算' },
  { Icon: Users,        label: '仲間と一緒に',      sub: 'リアルタイムで共有' },
] as const

export default function LoginScreen({ onSignIn }: Props) {
  const [loading, setLoading] = useState(false)

  async function handle() {
    if (loading) return
    setLoading(true)
    try {
      await onSignIn()
    } catch (e) {
      const code = (e as { code?: string })?.code
      const msg  = code === 'auth/popup-closed-by-user'
        ? 'サインインがキャンセルされました'
        : e instanceof Error ? e.message : 'ログインに失敗しました'
      toast.error(msg)
      setLoading(false)
    }
    // On success the auth listener unmounts this screen; on redirect the
    // page navigates away. Either way, no need to reset loading.
  }

  return (
    <div className="fixed inset-0 max-w-[430px] mx-auto bg-app overflow-y-auto">
      <div className="min-h-full flex flex-col px-6 pt-14 pb-10">

        <div className="flex flex-col items-center">
          <div className="w-[72px] h-[72px] rounded-[22px] bg-teal flex items-center justify-center text-[40px] shadow-[0_8px_24px_rgba(61,139,122,0.28)] mb-5">
            ✈️
          </div>
          <h1 className="m-0 mb-1.5 text-[28px] font-black text-teal -tracking-[0.5px]">
            TripMate
          </h1>
          <p className="m-0 text-[12.5px] text-muted tracking-[0.04em] text-center">
            旅行を、仲間と一緒に記録しよう
          </p>
        </div>

        <div className="mt-10 flex flex-col gap-3">
          {FEATURES.map(({ Icon, label, sub }) => (
            <div
              key={label}
              className="flex items-center gap-3 px-4 py-3 bg-surface border border-border rounded-2xl shadow-[0_1px_6px_rgba(0,0,0,0.04)]"
            >
              <div className="w-10 h-10 shrink-0 rounded-xl bg-accent-pale flex items-center justify-center text-accent">
                <Icon size={18} strokeWidth={1.8} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-semibold text-ink -tracking-[0.2px]">
                  {label}
                </div>
                <div className="text-[11px] text-muted mt-0.5 tracking-[0.02em]">
                  {sub}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-auto pt-10 flex flex-col items-center">
          <button
            onClick={handle}
            disabled={loading}
            aria-busy={loading}
            className="w-full max-w-[320px] h-12 rounded-chip border border-border bg-surface text-ink text-[14px] font-semibold flex items-center justify-center gap-2.5 cursor-pointer transition-all hover:-translate-y-px disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
          >
            <GoogleIcon size={18} />
            {loading ? 'サインイン中…' : 'Google でサインイン'}
          </button>

          <p className="mt-5 text-[10.5px] text-muted text-center max-w-[300px] leading-[1.7] tracking-[0.02em]">
            サインインすることで、旅行データをクラウドに保存し、
            仲間とリアルタイムで共有できるようになります。
          </p>
        </div>
      </div>
    </div>
  )
}

