// src/features/schedule/components/EmptyTrips.tsx
// Onboarding hero shown when a signed-in user has zero trips. Tapping
// the CTA opens CreateTripModal — wired from SchedulePage.
import { Plus } from 'lucide-react'

export default function EmptyTrips({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="bg-app min-h-full flex flex-col items-center justify-center px-6 py-10">
      <div className="text-[52px] leading-none mb-4">🗺️</div>
      <h2 className="m-0 mb-1.5 text-[20px] font-black text-ink -tracking-[0.3px]">
        最初の旅を始めましょう
      </h2>
      <p className="m-0 mb-7 text-[12.5px] text-muted text-center max-w-[280px] leading-[1.7] tracking-[0.02em]">
        行程・費用・日記を一つのアプリで。<br />
        まずは旅程を作成してください。
      </p>
      <button
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 px-6 py-3 rounded-chip border-none bg-teal text-white text-[13.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
        style={{ boxShadow: '0 6px 20px rgba(61,139,122,0.28)' }}
      >
        <Plus size={15} strokeWidth={2.5} />
        新しい旅を作成
      </button>
    </div>
  )
}
