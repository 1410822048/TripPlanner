// src/features/wish/components/WishPage.tsx
// List of wish items for the current trip — server-sorted by votes
// then createdAt. Heart-tap toggles the caller's vote optimistically;
// tapping the row body opens edit (proposer) or read (others).
//
// Two-tab layout (景點 / 餐廳) replaces the earlier flat list. Each
// tab filters by `category`; new wishes default to whichever tab is
// currently active so the user's intent is reflected without an extra
// dropdown click.
import { useState } from 'react'
import { Plus, Heart } from 'lucide-react'
import { useFeatureListPage } from '@/hooks/useFeatureListPage'
import { toast } from '@/shared/toast'
import WishListSkeleton from './WishListSkeleton'
import WishPageSkeleton from './WishPageSkeleton'
import NoTripEmptyState from '@/components/ui/NoTripEmptyState'
import DemoBanner from '@/components/ui/DemoBanner'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import {
  useWishes, useCreateWish, useUpdateWish, useDeleteWish, useToggleWishVote,
} from '../hooks/useWishes'
import { MOCK_WISHES } from '../mocks'
import { useMembers } from '@/features/members/hooks/useMembers'
import { membersToTripMembers } from '@/features/members/utils'
import type { Wish, WishCategory } from '@/types'
import type { TripMember } from '@/features/trips/types'
import WishFormModal, { type WishFormResult } from './WishFormModal'
import WishCard from './WishCard'

const TABS: { value: WishCategory; emoji: string; label: string }[] = [
  { value: 'place', emoji: '🗺️', label: '景點' },
  { value: 'food',  emoji: '🍜', label: '餐廳' },
]

export default function WishPage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, isOwner, modal, signIn } =
    useFeatureListPage<Wish>()
  const [activeTab, setActiveTab] = useState<WishCategory>('place')

  const { data: cloudWishes, isLoading } = useWishes(cloudTripId)
  const { data: fbMembers } = useMembers(cloudTripId)
  // Compiler memoises these derivations. Per-tab counts reflect the
  // full data set, not the visible (filtered) subset, so badge numbers
  // stay accurate when switching tabs.
  const wishes = ctx.status === 'demo'
    ? (ctx.trip.id === 'demo' ? MOCK_WISHES : [])
    : (cloudWishes ?? [])

  // 跟 ExpensePage 同樣的三狀態邏輯。voters 需要從 uid → TripMember 解析,
  // 所以這裡先建好 memberById lookup。
  const members: TripMember[] =
    ctx.status === 'demo'  ? ctx.trip.members :
    ctx.status === 'cloud' ? membersToTripMembers(fbMembers ?? []) :
    []
  const memberById = new Map(members.map(m => [m.id, m]))

  let placeCount = 0, foodCount = 0
  for (const w of wishes) {
    if (w.category === 'place') placeCount++
    else if (w.category === 'food') foodCount++
  }
  const counts = { place: placeCount, food: foodCount }

  const filteredWishes = wishes.filter(w => w.category === activeTab)

  // Optimistic close — modal closes immediately on save; failures route
  // to the global toast via MutationCache.onError + the hook rollback.
  const createMut = useCreateWish(mutationTripId)
  const updateMut = useUpdateWish(mutationTripId)
  const deleteMut = useDeleteWish(mutationTripId)
  const voteMut   = useToggleWishVote(mutationTripId)

  if (ctx.status === 'loading') return <WishPageSkeleton />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={Heart} reason="ウィッシュを投票" />

  const title = ctx.trip.title

  function handleSave({ input, attachment }: WishFormResult) {
    if (isDemo) { modal.close(); signIn.open(); return }
    if (!uid) { toast.error('ログイン準備中です。少々お待ちください'); return }

    // Optimistic close (mirrors ExpensePage). Modal closes immediately;
    // the hook's onMutate inserts a temp row into the list cache, the
    // real write runs in the background, and onError rolls back + the
    // global MutationCache.onError toasts on failure.
    const editing = modal.editTarget
    const file = attachment instanceof File ? attachment : null
    modal.close()
    if (editing) {
      updateMut.mutate({
        wishId:        editing.id,
        updates:       input,
        uid,
        attachment,
        existingImage: editing.image,
      })
    } else {
      createMut.mutate({ input, file, proposedBy: uid })
    }
  }

  function handleDelete() {
    if (!modal.editTarget) return
    if (isDemo) { modal.close(); signIn.open(); return }
    const target = modal.editTarget
    modal.close()
    deleteMut.mutate({ wishId: target.id, image: target.image })
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

  /** Whether the current viewer can delete a given wish. Mirrors the
   *  firestore.rules predicate (proposer === uid OR trip owner). Drives
   *  the ⋮ menu's 削除 item visibility. */
  function canDelete(w: Wish): boolean {
    if (isDemo || !uid) return false
    return w.proposedBy === uid || isOwner
  }

  /** Whether the current viewer can open the edit modal. Mirrors the
   *  proposer-only update path — owner can DELETE but NOT edit text.
   *  Demo mode opens the modal so the save-time signIn prompt is
   *  reachable (consistent with other features). */
  function canEdit(w: Wish): boolean {
    if (isDemo) return true
    return uid != null && w.proposedBy === uid
  }

  function handleDeleteFromMenu(w: Wish) {
    if (isDemo) { signIn.open(); return }
    deleteMut.mutate({ wishId: w.id, image: w.image })
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
          <WishListSkeleton />
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
            <div className="flex flex-col gap-3">
              {filteredWishes.map((w, index) => {
                // Resolve uid → TripMember in `votes[]` order (= first-
                // voted first, since arrayUnion appends). Unknown uids
                // (kicked / former members) are silently dropped — the
                // card's totalVotes prop still feeds the heart count, so
                // they show up as "+N" rather than vanishing.
                const voters = w.votes.flatMap(uid => {
                  const m = memberById.get(uid)
                  return m ? [m] : []
                })
                return (
                  <WishCard
                    key={w.id}
                    wish={w}
                    isVoted={!!uid && w.votes.includes(uid)}
                    voters={voters}
                    isPreviewOnly={isDemo}
                    canEdit={canEdit(w)}
                    canDelete={canDelete(w)}
                    onEdit={() => modal.openEdit(w)}
                    onDelete={() => handleDeleteFromMenu(w)}
                    onToggleVote={() => handleToggleVote(w)}
                    // Layout is a single-column flex stack (above), so
                    // index 0 = literal top card = LCP target on /wish
                    // cold load. Eager loading skips the lazy round-trip
                    // for that one image only; everything below stays
                    // lazy so a long wish list doesn't fan-out network.
                    eager={index === 0}
                  />
                )
              })}
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
          isSaving={false}
          saveError={modal.saveError}
          onClose={modal.close}
          onSave={handleSave}
          onDelete={
            modal.editTarget && canDelete(modal.editTarget)
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
