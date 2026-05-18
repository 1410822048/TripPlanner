// src/components/ui/skeleton.tsx
// Shared primitives for skeleton placeholders. Two pieces:
//   - SkeletonBar   : a single grey block(bg-tile + rounded-md)
//   - SkeletonContainer : the wrapper(animate-pulse + role=status +
//     sr-only fallback for screen readers)
//
// Earlier, every skeleton file declared its own inline `function Bar(...)`
// and duplicated the aria wrapper. Centralising here keeps the screen-reader
// label consistent and lets us tweak the pulse rhythm in one spot.
import type { ReactNode } from 'react'

export function SkeletonBar({ className = '' }: { className?: string }) {
  return <div className={`bg-tile rounded-md ${className}`} />
}

interface ContainerProps {
  className?: string
  children:   ReactNode
  /** When true, render a plain layout div without pulse / role / sr-only.
   *  Set on list skeletons used inside a page skeleton so the outer
   *  PageSkeletonShell owns the single animate-pulse + aria-live region;
   *  avoids opacity multiplication and double screen-reader announcements. */
  embedded?: boolean
}

export function SkeletonContainer({ className = '', children, embedded = false }: ContainerProps) {
  if (embedded) return <div className={className}>{children}</div>
  return (
    <div role="status" aria-label="読み込み中" className={`animate-pulse ${className}`}>
      {children}
      <span className="sr-only">読み込み中</span>
    </div>
  )
}

/** Top-level wrapper for full-page skeletons. Bundles the page-shell
 *  classes(bg-app min-h-full pb-8)with the standard
 *  SkeletonContainer chrome so the 5 page skeletons collapse to one
 *  wrapper line each + future shell tweaks (safe-area-bottom, etc.)
 *  happen in one place. */
export function PageSkeletonShell({ children }: { children: ReactNode }) {
  return (
    <SkeletonContainer className="bg-app min-h-full pb-8">
      {children}
    </SkeletonContainer>
  )
}

/** Page header placeholder — small uppercase label + big title bar.
 *  Mirrors the px-5/pt-4/pb-2 + 10.5px label + 22px title pattern used
 *  by Expense / Wish / Bookings / Planning page headers. `right` slot
 *  for pages like Planning that show a done/total counter on the right. */
export function PageHeaderSkeleton({ right }: { right?: ReactNode }) {
  return (
    <div className="px-5 pt-4 pb-2 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <SkeletonBar className="h-[10.5px] w-[72px] mb-1" />
        <SkeletonBar className="h-[22px] w-[58%]" />
      </div>
      {right}
    </div>
  )
}
