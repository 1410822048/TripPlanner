// src/features/wish/components/WishPage.tsx
// List of wish items for the current trip — server-sorted by votes
// then createdAt. Heart-tap toggles the caller's vote optimistically;
// tapping the row body opens edit (proposer) or read (others).
//
// Two-tab layout (景點 / 餐廳) replaces the earlier flat list. Each
// tab filters by `category`; new wishes default to whichever tab is
// currently active so the user's intent is reflected without an extra
// dropdown click.
import { useMemo, useState } from 'react'
import { Plus, Heart } from 'lucide-react'
import { useFeatureListPage } from '@/hooks/useFeatureListPage'
import { toast } from '@/shared/toast'
import LoadingText from '@/components/ui/LoadingText'
import TripLoading from '@/components/ui/TripLoading'
import NoTripEmptyState from '@/components/ui/NoTripEmptyState'
import DemoBanner from '@/components/ui/DemoBanner'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import {
  useWishes, useCreateWish, useUpdateWish, useDeleteWish, useToggleWishVote,
} from '../hooks/useWishes'
import { MOCK_WISHES } from '../mocks'
import type { Wish, WishCategory } from '@/types'
import WishFormModal, { type WishFormResult } from './WishFormModal'
import WishCard from './WishCard'

const TABS: { value: WishCategory; emoji: string; label: string }[] = [
  { value: 'place', emoji: '🗺️', label: '景點' },
  { value: 'food',  emoji: '🍜', label: '餐廳' },
]

export default function WishPage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, modal, signIn } =
    useFeatureListPage<Wish>()
  const [activeTab, setActiveTab] = useState<WishCategory>('place')

  const { data: cloudWishes, isLoading } = useWishes(cloudTripId)
  // useMemo so an empty-state render doesn't produce a fresh [] each
  // pass — without this, downstream `counts` / `filteredWishes` memos
  // would invalidate on every parent re-render.
  const wishes = useMemo(() => {
    if (ctx.status === 'demo') return ctx.trip.id === 'demo' ? MOCK_WISHES : []
    return cloudWishes ?? []
  }, [ctx, cloudWishes])

  // Per-tab counts so the badge always reflects the full data set, not
  // the visible (filtered) subset. Memoised on `wishes` so unrelated
  // re-renders (modal toggles, vote ticks) don't re-iterate.
  const counts = useMemo(() => {
    let place = 0, food = 0
    for (const w of wishes) {
      if (w.category === 'place') place++
      else if (w.category === 'food') food++
    }
    return { place, food }
  }, [wishes])

  const filteredWishes = useMemo(
    () => wishes.filter(w => w.category === activeTab),
    [wishes, activeTab],
  )

  const createMut = useCreateWish(mutationTripId)
  const updateMut = useUpdateWish(mutationTripId)
  const deleteMut = useDeleteWish(mutationTripId)
  const voteMut   = useToggleWishVote(mutationTripId)
  const isSaving  = createMut.isPending || updateMut.isPending

  if (ctx.status === 'loading') return <TripLoading />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={Heart} reason="ウィッシュを投票" />

  const title = ctx.trip.title
  // Trip owner can delete any wish (moderation power); other members
  // can only delete their own. Demo trips have no real owner concept.
  const isTripOwner = ctx.status === 'cloud' && !!uid && ctx.trip.ownerId === uid

  async function handleSave({ input, attachment }: WishFormResult) {
    if (isDemo) { modal.close(); signIn.open(); return }
    if (!modal.editTarget && !uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
    try {
      if (modal.editTarget) {
        await updateMut.mutateAsync({
          wishId:        modal.editTarget.id,
          updates:       input,
          attachment,
          existingImage: modal.editTarget.image,
        })
      } else {
        await createMut.mutateAsync({
          input,
          file:       attachment instanceof File ? attachment : null,
          proposedBy: uid!,
        })
      }
      modal.close()
    } catch { /* hook onError already toasted */ }
  }

  async function handleDelete() {
    if (!modal.editTarget) return
    if (isDemo) { modal.close(); signIn.open(); return }
    try {
      await deleteMut.mutateAsync({
        wishId: modal.editTarget.id,
        image:  modal.editTarget.image,
      })
      modal.close()
    } catch { /* hook onError already toasted */ }
  }

  function handleToggleVote(w: Wish) {
    if (isDemo) { signIn.open(); return }
    if (!uid)   { toast.error('ログイン準備中です。少々お待ちください'); return }
    voteMut.mutate({
      wishId:   w.id,
      uid,
      isVoting: !w.votes.includes(uid),
    })
  }

  return (
    <div className="bg-app min-h-full pb-8">
      {isDemo && <DemoBanner reason="投票を保存" onSignIn={signIn.open} />}

      <div className="px-5 pt-4 pb-2">
        <p className="m-0 mb-1 text-[10.5px] font-semibold text-muted tracking-[0.12em] uppercase">
          ウィッシュ
        </p>
        <h1 className="m-0 text-[22px] font-black text-ink -tracking-[0.5px]">
          {title}
        </h1>
      </div>

      {/* Tab switcher: 景點 / 餐廳. The active tab drives both the list
          filter (filteredWishes) and the form's defaultCategory below,
          so adding from one tab pre-selects the matching category. */}
      <div className="mx-4 mt-3 flex gap-1 p-1 rounded-card bg-app border border-border">
        {TABS.map(t => {
          const active = activeTab === t.value
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setActiveTab(t.value)}
              className={[
                'flex-1 h-9 rounded-[8px] text-[12.5px] font-semibold cursor-pointer transition-all flex items-center justify-center gap-1.5',
                active ? 'bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.08)]' : 'bg-transparent text-muted',
              ].join(' ')}
            >
              <span>{t.emoji}</span>
              <span>{t.label}</span>
              <span className={[
                'text-[10.5px] font-medium tabular-nums',
                active ? 'text-muted' : 'text-muted opacity-70',
              ].join(' ')}>
                {counts[t.value]}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-4 px-4">
        {isLoading && !isDemo ? (
          <div className="text-center py-12 text-dot text-[13px]">
            <LoadingText />
          </div>
        ) : filteredWishes.length === 0 ? (
          <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
            <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
              <Heart size={24} strokeWidth={1.6} />
            </div>
            <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
              {activeTab === 'place' ? 'まだ景點がありません' : 'まだ餐廳がありません'}
            </p>
            <p className="m-0 mb-[18px] text-[11.5px] text-muted tracking-[0.04em]">
              {activeTab === 'place'
                ? '行きたい所をみんなで共有しましょう'
                : '食べたいお店をみんなで共有しましょう'}
            </p>
            <button
              onClick={modal.openAdd}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
              style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
            >
              <Plus size={14} strokeWidth={2.5} />
              ウィッシュを追加
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              {filteredWishes.map(w => (
                <WishCard
                  key={w.id}
                  wish={w}
                  isVoted={!!uid && w.votes.includes(uid)}
                  isPreviewOnly={isDemo}
                  onTap={() => modal.openEdit(w)}
                  onToggleVote={() => handleToggleVote(w)}
                />
              ))}
            </div>

            <button
              onClick={modal.openAdd}
              className="mt-4 w-full h-11 rounded-chip border-[1.5px] border-dashed border-border bg-transparent text-muted text-[13px] font-medium flex items-center justify-center gap-1.5 cursor-pointer tracking-[0.04em] transition-all hover:bg-teal-pale hover:border-teal hover:text-teal"
            >
              <Plus size={14} strokeWidth={2} />
              ウィッシュを追加
            </button>
          </>
        )}
      </div>

      {modal.isOpen && (
        <WishFormModal
          key={modal.key}
          isOpen
          editTarget={modal.editTarget}
          defaultCategory={activeTab}
          isSaving={isSaving}
          onClose={modal.close}
          onSave={handleSave}
          onDelete={
            modal.editTarget && !isDemo && (modal.editTarget.proposedBy === uid || isTripOwner)
              ? handleDelete
              : undefined
          }
        />
      )}

      <SignInPromptModal
        isOpen={signIn.isOpen}
        onClose={signIn.close}
        reason="ウィッシュに投票するには、"
      />
    </div>
  )
}
