// src/features/wish/components/WishListSkeleton.tsx
// Placeholder cards mirroring WishCard's Pinterest layout(16:9 hero +
// title + description + action row).
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

function Card() {
  return (
    <div className="bg-surface border border-border rounded-[18px] overflow-hidden">
      <div className="w-full aspect-[16/9] bg-tile" />
      <div className="px-3.5 pt-2.5 pb-1 space-y-1.5">
        <SkeletonBar className="h-[14px] w-[70%]" />
        <SkeletonBar className="h-[11px] w-[45%]" />
      </div>
      <div className="px-3 pb-2.5 pt-1.5 flex items-center">
        <SkeletonBar className="h-[20px] w-[60px] rounded-full" />
        <div className="ml-auto h-8 w-14 rounded-full bg-tile" />
      </div>
    </div>
  )
}

export default function WishListSkeleton({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <SkeletonContainer embedded={embedded}>
      <div className="flex flex-col gap-3">
        {[0, 1].map(i => <Card key={i} />)}
      </div>
    </SkeletonContainer>
  )
}
