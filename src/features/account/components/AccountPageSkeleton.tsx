// src/features/account/components/AccountPageSkeleton.tsx
// Placeholder shown during the brief auth-bootstrapping window. Mirrors the
// layout of the signed-in AccountPage so the transition to real content
// doesn't shift anything — the user perceives "loading a page" rather than
// "page type changing". `animate-pulse` is Tailwind's built-in opacity
// shimmer (cheap, GPU-accelerated, no custom CSS needed).
//
// Only used for the 'loading' auth state. When auth resolves to signed-out,
// callers show the full sign-in CTA instead (it's an obvious hero content
// change, not a placeholder). When it resolves to signed-in, the real
// profile renders.

/** Grey rounded block; width + height passed via Tailwind classes. */
function Bar({ className = '' }: { className?: string }) {
  return <div className={`bg-tile rounded-md ${className}`} />
}

export default function AccountPageSkeleton() {
  return (
    <div className="bg-app min-h-full pb-10 animate-pulse">
      {/* Header */}
      <div className="px-5 pt-6 pb-5">
        <Bar className="h-[26px] w-[120px]" />
      </div>

      {/* Profile card */}
      <div className="mx-4">
        <div className="bg-surface border border-border rounded-[22px] px-5 pt-6 pb-5 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          {/* Avatar — round 88px */}
          <div className="flex justify-center">
            <div className="w-[88px] h-[88px] rounded-full bg-tile" />
          </div>
          {/* Name + email (centered) */}
          <div className="mt-3 flex flex-col items-center gap-1.5">
            <Bar className="h-[18px] w-[120px]" />
            <Bar className="h-[12px] w-[160px]" />
          </div>
          {/* Stats row */}
          <div className="mt-5 pt-4 border-t border-border flex divide-x divide-border">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex-1 flex flex-col items-center justify-center gap-1.5 px-2">
                <Bar className="h-[20px] w-[44px]" />
                <Bar className="h-[10px] w-[32px]" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 2-column feature grid */}
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
              <Bar className="h-[13px] w-[80px]" />
              <Bar className="h-[10px] w-[56px]" />
            </div>
          </div>
        ))}
      </div>

      {/* Planner promo card */}
      <div className="mx-4 mt-3">
        <div className="w-full bg-surface border border-border rounded-[22px] px-5 py-4 flex items-center gap-4 shadow-[0_2px_12px_rgba(0,0,0,0.05)]">
          <div className="w-[72px] h-[72px] rounded-2xl bg-tile shrink-0" />
          <div className="flex-1 space-y-2">
            <Bar className="h-[15px] w-[140px]" />
            <Bar className="h-[11px] w-full max-w-[220px]" />
          </div>
        </div>
      </div>

      {/* Action */}
      <div className="mx-4 mt-5">
        <div className="w-full h-12 rounded-xl bg-surface border border-border" />
      </div>

      {/* Version footer */}
      <div className="mt-8 flex justify-center">
        <Bar className="h-[10px] w-[140px]" />
      </div>
    </div>
  )
}
