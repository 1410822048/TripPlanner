// src/features/planning/components/PlanningRow.tsx
// One row in the planning checklist. Swipe-left reveals a red delete
// button — same gesture + tap-to-confirm UX as SwipeableBookingItem /
// SwipeableTripItem. Body tap opens edit; leading control toggles the
// current member's completion.
//
// When the row is swiped open, taps on either the body or the checkbox
// are short-circuited to "close the row" so the user can dismiss the
// delete affordance without accidentally toggling state.
import { Check, Trash2 } from 'lucide-react'
import type { PlanItem } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { useSwipeRow, SWIPE_WIDTH, BG_TRANSITION, FG_TRANSITION } from '@/hooks/useSwipeRow'
import MemberAvatar from '@/components/ui/MemberAvatar'

interface Props {
  item:          PlanItem
  members:       TripMember[]
  currentUid:    string | undefined
  isDone:        boolean
  canEdit:       boolean
  /** True in demo mode — visually dim the row so users sense it's "not
   *  real yet", but the click still fires so the parent can surface the
   *  sign-in prompt. */
  isPreviewOnly: boolean
  isOpen:        boolean
  onToggleDone:  () => void
  onTap:         () => void
  onOpen:        () => void
  onClose:       () => void
  onDelete:      () => void
}

function PlanningRow({
  item, members, currentUid, isDone, canEdit, isPreviewOnly, isOpen,
  onToggleDone, onTap, onOpen, onClose, onDelete,
}: Props) {
  const {
    bindFg, bindBg, pointerProps, deleteProps, openX, confirming, wrapTap,
  } = useSwipeRow({ isOpen, onOpen, onClose, onDelete, enabled: canEdit })

  return (
    <div className="relative overflow-hidden bg-surface">
      <div
        ref={bindBg}
        {...deleteProps}
        className={[
          'absolute top-0 right-0 bottom-0 flex items-center justify-center cursor-pointer',
          confirming ? 'bg-[#A83A3A]' : 'bg-[#D85A5A]',
        ].join(' ')}
        style={{
          width: SWIPE_WIDTH,
          transform: `translate3d(${SWIPE_WIDTH + openX}px,0,0)`,
          transition: BG_TRANSITION,
          pointerEvents: openX < 0 ? 'auto' : 'none',
        }}
      >
        {confirming ? (
          <div className="text-white text-[11px] font-bold tracking-[0.04em] text-center leading-[1.3]">
            確認<br />削除
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5">
            <Trash2 size={18} color="white" strokeWidth={2.2} />
            <span className="text-white text-[10px] font-bold tracking-[0.04em]">
              削除
            </span>
          </div>
        )}
      </div>

      <div
        ref={bindFg}
        {...pointerProps}
        className="relative select-none bg-surface"
        style={{
          transform: `translate3d(${openX}px,0,0)`,
          transition: FG_TRANSITION,
          touchAction: 'pan-y',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <div className="flex items-start py-3">
          <button
            type="button"
            onClick={wrapTap(onToggleDone)}
            aria-pressed={isDone}
            aria-label={isDone ? '自分を未完了に戻す' : '自分を完了にする'}
            className={[
              'shrink-0 -my-3 flex h-11 w-14 items-center justify-center bg-transparent border-none cursor-pointer transition-colors hover:bg-app',
              isPreviewOnly ? 'opacity-70' : 'opacity-100',
            ].join(' ')}
          >
            <span className={[
              'flex h-6 w-6 items-center justify-center rounded-full transition-all',
              isDone
                ? 'bg-[#B29B89] text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.24),0_1px_3px_rgba(80,62,48,0.16)]'
                : 'border border-[#D8D4CF] bg-[#FCFBF9] text-transparent shadow-[inset_0_1px_2px_rgba(255,255,255,0.9),0_1px_3px_rgba(80,70,60,0.08)] hover:border-[#C9C3BC] hover:bg-white',
            ].join(' ')}>
              {isDone && <Check size={13} strokeWidth={3} />}
            </span>
          </button>

          <button
            type="button"
            onClick={canEdit ? wrapTap(onTap) : undefined}
            disabled={!canEdit}
            className={[
              'flex min-w-0 flex-1 items-start gap-3 pr-3 text-left bg-transparent border-none transition-colors',
              canEdit ? 'cursor-pointer hover:bg-app' : 'cursor-default',
              isDone ? 'opacity-60' : '',
            ].join(' ')}
          >
            <div className="min-w-0 flex-1">
              <div className={[
                'truncate text-[13.5px] font-extrabold leading-5',
                isDone ? 'text-muted' : 'text-ink',
              ].join(' ')}>
                {item.title}
              </div>
              {item.note && (
                <div className="mt-0.5 truncate text-[11px] font-medium text-muted">
                  {item.note}
                </div>
              )}
            </div>
            <div className="w-[72px] shrink-0 text-right">
              <div className={[
                'truncate text-[12px] font-extrabold leading-5',
                isDone ? 'text-muted' : 'text-ink',
              ].join(' ')}>
                {isDone ? '完了' : '未準備'}
              </div>
            </div>
          </button>
        </div>

        {members.length > 0 && (
          <div className="mx-3 mb-3 rounded-[14px] border border-border/70 bg-app/45 px-3 py-2.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-bold tracking-[0.04em] text-muted">
                メンバー準備
              </span>
            </div>
            <div className="flex items-center justify-end gap-2">
              {members.map(member => {
                const memberDone = Boolean(item.completedBy[member.id])
                const avatar = (
                  <MemberAvatar
                    member={member}
                    size={24}
                    className={memberDone
                      ? 'ring-2 ring-[#B29B89] ring-offset-2 ring-offset-surface'
                      : 'opacity-35 grayscale'}
                  />
                )
                return (
                  <span
                    key={member.id}
                    aria-label={memberDone ? '完了' : '未準備'}
                    aria-current={member.id === currentUid ? 'true' : undefined}
                  >
                    {avatar}
                  </span>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default PlanningRow
