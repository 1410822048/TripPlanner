// src/features/wish/components/WishDetailSheet.tsx
// Read-first detail surface for a wish. The list card is for comparison; this
// sheet answers "what is this candidate and why would we go?" without turning
// the primary tap into edit.
import { ExternalLink, MapPin, Pencil } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import type { Wish } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { addressMapHref, isGoogleMapsUrl } from '@/utils/maps'
import { WISH_CATEGORIES, WISH_CATEGORY_ICON } from '../categories'
import type { Consensus } from '../utils'
import WishConsensusBar from './WishConsensusBar'
import WishVoteButton from './WishVoteButton'

interface Props {
  isOpen:        boolean
  wish:          Wish
  rank:          number
  voters:        TripMember[]
  proposer:      TripMember | undefined
  consensus:     Consensus
  isVoted:       boolean
  isPreviewOnly: boolean
  canEdit:       boolean
  isUpdating?:   boolean
  onClose:       () => void
  onEdit:        () => void
  onToggleVote:  () => void
}

export default function WishDetailSheet({
  isOpen, wish, rank, voters, proposer, consensus, isVoted, isPreviewOnly,
  canEdit, isUpdating, onClose, onEdit, onToggleVote,
}: Props) {
  const fullUrl = useAttachmentUrl(isOpen ? wish.image?.path : undefined, { kind: 'full' })
  const thumbUrl = useAttachmentUrl(isOpen && !fullUrl ? wish.image?.thumbPath : undefined, { kind: 'thumb' })
  const CategoryIcon = WISH_CATEGORY_ICON[wish.category]
  const category = WISH_CATEGORIES.find(c => c.value === wish.category)
  const linkIsMaps = !!wish.link && isGoogleMapsUrl(wish.link)
  const mapHref = addressMapHref(wish.address) ?? (linkIsMaps ? wish.link : null)
  const siteHref = wish.link && !linkIsMaps ? wish.link : null
  const isPending = wish.id.startsWith('temp-') || !!isUpdating

  const heroUrl = fullUrl ?? thumbUrl

  return (
    <BottomSheet
      isOpen={isOpen}
      title="候選項目詳情"
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="h-11 px-3 rounded-full border border-border bg-surface text-ink flex items-center justify-center gap-1.5 cursor-pointer active:scale-[0.97] transition-all"
            >
              <Pencil size={14} strokeWidth={2.2} />
              <span className="text-[12.5px] font-bold">編輯</span>
            </button>
          )}
          <WishVoteButton
            isVoted={isVoted}
            isPreviewOnly={isPreviewOnly || isPending}
            disabled={isPending}
            onToggleVote={onToggleVote}
            variant="wide"
          />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <figure className="m-0 relative rounded-[18px] overflow-hidden bg-tile min-h-[180px]">
          {heroUrl ? (
            <img
              src={heroUrl}
              alt=""
              decoding="async"
              draggable={false}
              className="block w-full h-[180px] object-cover"
            />
          ) : (
            <div className="h-[180px] flex items-center justify-center bg-teal-pale">
              <CategoryIcon size={46} strokeWidth={1.6} className="text-teal" />
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/55 to-transparent" />
          <div className="absolute left-3 top-3 inline-flex items-center h-7 px-2.5 rounded-full bg-surface/92 backdrop-blur-md text-[11px] font-black text-ink shadow-[0_1px_4px_rgba(0,0,0,0.10)]">
            #{rank}
          </div>
          <div className="absolute right-3 top-3 inline-flex items-center gap-1 h-7 px-2.5 rounded-full bg-surface/92 backdrop-blur-md text-[11px] font-bold text-teal shadow-[0_1px_4px_rgba(0,0,0,0.10)]">
            <CategoryIcon size={13} strokeWidth={2.1} />
            {category?.label ?? ''}
          </div>
        </figure>

        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[20px] leading-[1.25] font-black text-ink -tracking-[0.4px] break-words">
            {wish.title}
          </h2>
          <WishConsensusBar consensus={consensus} size="lg" />
        </section>

        <section className="rounded-[16px] bg-app px-3.5 py-3">
          <div className="text-[10.5px] font-bold text-muted tracking-[0.12em] uppercase mb-1.5">
            推薦原因
          </div>
          <p className="m-0 text-[13px] leading-[1.65] text-ink whitespace-pre-wrap break-words">
            {wish.description?.trim() || '尚未提供說明'}
          </p>
        </section>

        {(mapHref || siteHref) && (
          <div className="grid grid-cols-2 gap-2">
            {mapHref && (
              <a
                href={mapHref}
                target="_blank"
                rel="noopener noreferrer"
                className={[
                  'min-h-11 rounded-[14px] border border-teal/20 bg-teal-pale text-teal no-underline flex items-center justify-center gap-1.5 px-3',
                  siteHref ? '' : 'col-span-2',
                ].join(' ')}
              >
                <MapPin size={15} strokeWidth={2.2} />
                <span className="text-[12.5px] font-bold">地圖</span>
              </a>
            )}
            {siteHref && (
              <a
                href={siteHref}
                target="_blank"
                rel="noopener noreferrer"
                className={[
                  'min-h-11 rounded-[14px] border border-border bg-surface text-ink no-underline flex items-center justify-center gap-1.5 px-3',
                  mapHref ? '' : 'col-span-2',
                ].join(' ')}
              >
                <ExternalLink size={15} strokeWidth={2.1} />
                <span className="text-[12.5px] font-bold">網站</span>
              </a>
            )}
          </div>
        )}

        {wish.address && (
          <section className="rounded-[16px] border border-border bg-surface px-3.5 py-3">
            <div className="text-[10.5px] font-bold text-muted tracking-[0.12em] uppercase mb-1.5">
              地點
            </div>
            <p className="m-0 text-[13px] leading-[1.55] text-ink break-words">
              {wish.address}
            </p>
          </section>
        )}

        <section className="rounded-[16px] border border-border bg-surface px-3.5 py-3">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-[10.5px] font-bold text-muted tracking-[0.12em] uppercase">
                投票者
              </div>
              <div className="text-[12px] text-muted mt-0.5">
                {wish.votes.length} 票
              </div>
            </div>
            {proposer && (
              <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
                <span>提案者</span>
                <MemberAvatar member={proposer} size={22} />
              </div>
            )}
          </div>
          {voters.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {voters.map(voter => (
                <span
                  key={voter.id}
                  title={voter.label}
                  className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-app"
                >
                  <MemberAvatar member={voter} size={24} />
                </span>
              ))}
            </div>
          ) : (
            <p className="m-0 text-[12px] text-muted">尚未有投票</p>
          )}
        </section>
      </div>
    </BottomSheet>
  )
}
