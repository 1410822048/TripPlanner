// src/features/account/components/AccountPageSkeleton.tsx
// Placeholder shown during the brief auth-bootstrapping window. Mirrors
// the signed-in AccountPage layout so the transition doesn't shift
// content — only used for the 'loading' auth state. Signed-out users get
// a sign-in CTA instead(distinct hero, not a placeholder).
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

export default function AccountPageSkeleton() {
  return (
    <SkeletonContainer className="bg-app min-h-full pb-10">
      <div className="px-5 pt-6 pb-5">
        <SkeletonBar className="h-[26px] w-[120px]" />
      </div>

      <div className="mx-4">
        <div className="bg-surface border border-border rounded-[22px] px-5 pt-6 pb-5 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <div className="flex justify-center">
            <div className="w-[88px] h-[88px] rounded-full bg-tile" />
          </div>
          <div className="mt-3 flex flex-col items-center gap-1.5">
            <SkeletonBar className="h-[18px] w-[120px]" />
            <SkeletonBar className="h-[12px] w-[160px]" />
          </div>
          <div className="mt-5 pt-4 border-t border-border flex divide-x divide-border">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex-1 flex flex-col items-center justify-center gap-1.5 px-2">
                <SkeletonBar className="h-[20px] w-[44px]" />
                <SkeletonBar className="h-[10px] w-[32px]" />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-4 mt-3 grid grid-cols-2 gap-3">
        {[0, 1].map(i => (
          <div
            key={i}
            className="aspect-square bg-surface border border-border rounded-[22px] p-4 flex flex-col shadow-[0_2px_12px_rgba(0,0,0,0.05)]"
          >
            <div className="flex-1 flex items-center justify-center">
              <div className="w-14 h-14 rounded-2xl bg-tile" />
            </div>
            <div className="mt-2.5 space-y-1.5">
              <SkeletonBar className="h-[13px] w-[80px]" />
              <SkeletonBar className="h-[10px] w-[56px]" />
            </div>
          </div>
        ))}
      </div>

      <div className="mx-4 mt-3">
        <div className="w-full bg-surface border border-border rounded-[22px] px-5 py-4 flex items-center gap-4 shadow-[0_2px_12px_rgba(0,0,0,0.05)]">
          <div className="w-[72px] h-[72px] rounded-2xl bg-tile shrink-0" />
          <div className="flex-1 space-y-2">
            <SkeletonBar className="h-[15px] w-[140px]" />
            <SkeletonBar className="h-[11px] w-full max-w-[220px]" />
          </div>
        </div>
      </div>

      <div className="mx-4 mt-5">
        <div className="w-full h-12 rounded-xl bg-surface border border-border" />
      </div>

      <div className="mt-8 flex justify-center">
        <SkeletonBar className="h-[10px] w-[140px]" />
      </div>
    </SkeletonContainer>
  )
}
