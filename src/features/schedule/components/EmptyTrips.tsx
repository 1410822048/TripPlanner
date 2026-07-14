// src/features/schedule/components/EmptyTrips.tsx
// Onboarding hero shown when a signed-in user has zero trips. Tapping
// the CTAs are wired from SchedulePage.
import { Plus, QrCode } from 'lucide-react'

export default function EmptyTrips({ onCreate, onScanInvite }: {
  onCreate:     () => void
  onScanInvite: () => void
}) {
  return (
    <div className="bg-app min-h-full flex flex-col items-center justify-center px-6 py-10">
      <div className="text-[52px] leading-none mb-4">🗺️</div>
      <h2 className="m-0 mb-1.5 text-[20px] font-black text-ink -tracking-[0.3px]">
        開始規劃第一趟旅程
      </h2>
      <p className="m-0 mb-7 text-[12.5px] text-muted text-center max-w-[280px] leading-[1.7] tracking-[0.02em]">
        在同一個 App 管理行程、費用與心願。<br />
        先建立一趟旅程吧。
      </p>
      <div className="flex flex-col items-center gap-2.5">
        <button
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 px-6 py-3 rounded-chip border-none bg-teal text-white text-[13.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
          style={{ boxShadow: '0 6px 20px rgba(61,139,122,0.28)' }}
        >
          <Plus size={15} strokeWidth={2.5} />
          建立新旅程
        </button>
        <button
          onClick={onScanInvite}
          className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-chip border border-border bg-surface text-pick text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:bg-pick-pale hover:border-pick"
        >
          <QrCode size={14} strokeWidth={2.4} />
          掃描 QR Code 加入
        </button>
      </div>
    </div>
  )
}
