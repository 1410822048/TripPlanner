// src/features/wish/components/WishPage.tsx
// List of wish items for the current trip — server-sorted by votes
// then createdAt. Heart-tap toggles the caller's vote optimistically;
// tapping the row body opens a read-first detail sheet; edit/delete live in
// the overflow/menu surfaces.
//
// Two-tab layout (景點 / 餐廳) replaces the earlier flat list. Each
// tab filters by `category`; new wishes default to whichever tab is
// currently active so the user's intent is reflected without an extra
// dropdown click.
import { Fragment, useEffect, useState } from 'react'
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
  wishUpdateMutationKey,
} from '../hooks/useWishes'
import { usePendingMutationIds } from '@/hooks/usePendingMutationIds'
import { MOCK_WISHES } from '../mocks'
import { useMembers } from '@/features/members/hooks/useMembers'
import { membersToTripMembers } from '@/features/members/utils'
import type { Wish, WishCategory } from '@/types'
import type { TripMember } from '@/features/trips/types'
import WishFormModal, { type WishFormResult } from './WishFormModal'
import WishCard from './WishCard'
import WishDetailSheet from './WishDetailSheet'
import WishVotingDeadlineBar from './WishVotingDeadlineBar'
import WishDeadlineSheet from './WishDeadlineSheet'
import { rankWishes, toConsensus } from '../utils'
import { WISH_CATEGORIES } from '../categories'
import { useSetWishVotingDeadline } from '@/features/trips/hooks/useTrips'

export default function WishPage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, isOwner, modal, signIn } =
    useFeatureListPage<Wish>()
  const [activeTab, setActiveTab] = useState<WishCategory>('place')
  const [detailWishId, setDetailWishId] = useState<string | null>(null)
  const [deadlineSheetOpen, setDeadlineSheetOpen] = useState(false)

  // Reactive clock for the Wish deadline. Render stays pure; the effect below
  // advances this only when the cutoff is reached.
  const [now, setNow] = useState(() => Date.now())

  // Shared Wish voting deadline (demo has no deadline concept — always open).
  const deadlineAt   = ctx.status === 'cloud' ? ctx.trip.wishVotingDeadlineAt : null
  const notifiedAt   = ctx.status === 'cloud' ? ctx.trip.wishVotingDeadlineNotifiedAt : null
  const deadlineMs   = deadlineAt?.toMillis() ?? null
  const deadlineLocked = !isDemo && notifiedAt != null
  const votingClosed = !isDemo && (deadlineLocked || (deadlineMs != null && deadlineMs <= now))
  const setDeadlineMut = useSetWishVotingDeadline(uid)

  useEffect(() => {
    if (isDemo || deadlineMs == null || deadlineLocked || deadlineMs <= now) return
    const currentMs = Date.now()
    const delayMs = Math.max(0, Math.min(deadlineMs - currentMs, 2_147_483_647))
    const timerId = window.setTimeout(() => setNow(Date.now()), delayMs)
    return () => window.clearTimeout(timerId)
  }, [deadlineLocked, deadlineMs, isDemo, now])

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
  // members query は wishes より遅れて解決し得る(cloud は wishes が先)。確定
  // 前は consensus の分母を出さないための ready フラグ。demo は同期的に揃う。
  const membersReady = ctx.status === 'demo' || fbMembers !== undefined

  let placeCount = 0, foodCount = 0
  for (const w of wishes) {
    if (w.category === 'place') placeCount++
    else if (w.category === 'food') foodCount++
  }
  const counts = { place: placeCount, food: foodCount }
  const hasAnyWishes = wishes.length > 0
  const showBoardChrome = (isLoading && !isDemo) || hasAnyWishes

  // ─ Wish board の派生データを 1 か所で生成 ───────────────────────────
  // 順位(rank)/ 提案者(proposer)/ 投票者(voters)/ 賛成度の表示状態(consensus)を
  // ここで確定し、WishCard は整形済み props を描画するだけにする(順位も分母も
  // card 側で推導しない)。rankWishes は demo の MOCK もソートする。投票直後も
  // 同じ rankWishes を通ったキャッシュなので、ここは並べ替え済みを map するだけ。
  const boardRows = rankWishes(wishes.filter(w => w.category === activeTab))
    .map((wish, index) => ({
      wish,
      rank:      index + 1,
      proposer:  memberById.get(wish.proposedBy),
      // votes[] 順(= arrayUnion 追加順)で uid → TripMember 解決。退会者など
      // 未知の uid は落とす(+N は totalVotes=votes.length が担保)。
      voters:    wish.votes.flatMap(uid => {
        const m = memberById.get(uid)
        return m ? [m] : []
      }),
      consensus: toConsensus(wish.votes.length, members.length, membersReady),
    }))
  const detailRow = detailWishId
    ? boardRows.find(row => row.wish.id === detailWishId) ?? null
    : null
  // ラベルは WISH_CATEGORIES を single source に(分類追加/改名時の二重管理を避ける)。
  const activeTabLabel = WISH_CATEGORIES.find(t => t.value === activeTab)?.label ?? ''

  // Optimistic close — modal closes immediately on save; failures route
  // to the global toast via MutationCache.onError + the hook rollback.
  const createMut = useCreateWish(mutationTripId)
  const updateMut = useUpdateWish(mutationTripId)
  const deleteMut = useDeleteWish(mutationTripId)
  const voteMut   = useToggleWishVote(mutationTripId)
  // Set of wish ids whose UPDATE is in-flight — drives the 保存中… pill
  // on edited cards. CREATE pending is handled inside WishCard via the
  // temp- id prefix; UPDATE preserves the real id so we need this signal.
  const pendingUpdateIds = usePendingMutationIds<{ wishId: string }>(
    wishUpdateMutationKey,
    'wishId',
  )

  if (ctx.status === 'loading') return <WishPageSkeleton />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={Heart} reason="為心願投票" />

  const title = ctx.trip.title

  function handleSave({ input, attachment }: WishFormResult) {
    if (votingClosed) { modal.close(); toast.error('投票已截止'); return }
    if (isDemo) { modal.close(); signIn.open(); return }
    if (!uid) { toast.error('正在準備登入，請稍候'); return }

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
    if (votingClosed) { modal.close(); toast.error('投票已截止'); return }
    if (isDemo) { modal.close(); signIn.open(); return }
    const target = modal.editTarget
    modal.close()
    deleteMut.mutate({ wishId: target.id, image: target.image })
  }

  function handleToggleVote(w: Wish) {
    if (votingClosed) { toast.error('投票已截止'); return }
    if (isDemo) { signIn.open(); return }
    if (!uid)   { toast.error('正在準備登入，請稍候'); return }
    voteMut.mutate({
      wishId:   w.id,
      uid,
      isVoting: !w.votes.includes(uid),
    })
  }

  /** Whether the current viewer can delete a given wish. Mirrors the
   *  firestore.rules predicate (proposer === uid OR trip owner), plus the
   *  wishVotingOpen(tripId) gate — once closed, nobody (incl. owner) can
   *  delete. Drives the ⋮ menu's 削除 item visibility. */
  function canDelete(w: Wish): boolean {
    if (votingClosed || isDemo || !uid) return false
    return w.proposedBy === uid || isOwner
  }

  /** Whether the current viewer can open the edit modal. Mirrors the
   *  proposer-only update path — owner can DELETE but NOT edit text.
   *  Demo mode opens the modal so the save-time signIn prompt is
   *  reachable (consistent with other features). */
  function canEdit(w: Wish): boolean {
    if (votingClosed) return false
    if (isDemo) return true
    return uid != null && w.proposedBy === uid
  }

  function handleDeleteFromMenu(w: Wish) {
    if (votingClosed) { toast.error('投票已截止'); return }
    if (isDemo) { signIn.open(); return }
    deleteMut.mutate({ wishId: w.id, image: w.image })
  }

  function handleSaveDeadline(deadlineAtInput: Date | null) {
    if (!cloudTripId) return
    if (votingClosed) {
      setDeadlineSheetOpen(false)
      toast.error('投票已截止')
      return
    }
    setDeadlineMut.mutate({ tripId: cloudTripId, deadlineAt: deadlineAtInput })
    setDeadlineSheetOpen(false)
  }

  function handleEditFromDetail(w: Wish) {
    setDetailWishId(null)
    modal.openEdit(w)
  }

  return (
    <div className="bg-app h-full flex flex-col overflow-hidden">
      {isDemo && <DemoBanner reason="儲存投票" onSignIn={signIn.open} />}

      <div className="shrink-0 px-5 pt-4 pb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 mb-1 text-[10.5px] font-semibold text-muted tracking-[0.12em] uppercase">
            心願
          </p>
          <h1 className="m-0 text-[22px] font-black text-ink -tracking-[0.5px] truncate">
            {title}
          </h1>
        </div>

        {/* 右側クラスタ:投票中の人数ピル。追加入口は分類タブ直下に固定し、
            header の丸 + と一覧内 CTA の二重導線を解消する。 */}
        <div className="flex items-center gap-2 shrink-0">
          {members.length > 0 && (
            <span className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-3 rounded-full text-[11.5px] font-semibold text-teal bg-teal-pale">
              <span className="w-1.5 h-1.5 rounded-full bg-teal" />
              {members.length}人投票
            </span>
          )}
        </div>
      </div>

      {!isDemo && (
        <WishVotingDeadlineBar
          deadlineAt={deadlineAt}
          now={now}
          votingClosed={votingClosed}
          deadlineLocked={deadlineLocked}
          isOwner={isOwner}
          isSaving={setDeadlineMut.isPending}
          onOpenSheet={() => setDeadlineSheetOpen(true)}
        />
      )}

      {showBoardChrome && (
        <>
          {/* 固定上方フレーム ── 分類タブ。追加 CTA は次の固定ブロックに置く。 */}
          <div className="shrink-0 px-4 pt-1 pb-2">
            <div className="flex gap-1 p-1 rounded-card bg-app border border-border">
              {WISH_CATEGORIES.map(t => {
                const active = activeTab === t.value
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setActiveTab(t.value)}
                    className={[
                      // 内側 pill の角丸は外枠(rounded-card=20px)− p-1(4px)= 16px に
                      // 合わせ、白い active 背景が外枠と同心になるようにする(角が四角く
                      // 見える違和感を解消)。
                      'flex-1 h-9 rounded-[16px] text-[12.5px] font-semibold cursor-pointer transition-all flex items-center justify-center gap-1.5',
                      active ? 'bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.08)]' : 'bg-transparent text-muted',
                    ].join(' ')}
                  >
                    <t.icon size={14} strokeWidth={2} />
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
          </div>

          {/* 分類に紐づく追加入口。固定フレーム内に置くことで、リストの Y 軸は
              このボタンの下から始まる。空タブでも高さが変わらずジャンプしない。
              投票締切後は非表示(wishVotingOpen(tripId) が create を拒否する)。 */}
          {!votingClosed && (
            <div className="shrink-0 px-4 pb-2">
              <button
                type="button"
                onClick={modal.openAdd}
                aria-label={`新增${activeTabLabel}候選項目`}
                className="w-full h-11 rounded-[16px] border border-teal/20 bg-teal-pale text-teal text-[12.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors hover:bg-teal/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <Plus size={15} strokeWidth={2.5} />
                新增{activeTabLabel}候選項目
              </button>
            </div>
          )}
        </>
      )}

      {/* 選項リスト ── 唯一スクロールする領域(独自 Y 軸)。relative ラッパーに
          上下のフェード overlay を重ね、固定フレームとの境界の「鋭い切れ」を
          和らげる。
          ⚠ 以前は scroll 要素に mask-image を掛けていたが、mask は position:fixed
          子孫の containing block を作るため、カードの ⋮ から開く BottomSheet
          (fixed)が scroll 領域内にクリップされ「削除が押せない」不具合になった。
          overlay 方式は fixed を閉じ込めないので解消する(relative は fixed の
          containing block を作らない)。 */}
      <div className="relative flex-1 min-h-0">
        {/* overscroll-contain ── 端まで滑っても外側 main へスクロールチェーンを
            伝播させない(整頁が連られて動く iOS の挙動を断つ)。 */}
        <div className="h-full overflow-y-auto overscroll-contain px-4 pt-2 pb-6">
        {isLoading && !isDemo ? (
          <WishListSkeleton />
        ) : boardRows.length === 0 ? (
          <div className="text-center px-6 py-12 bg-surface rounded-card border-[1.5px] border-dashed border-border">
            <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
              <Heart size={24} strokeWidth={1.6} />
            </div>
            {hasAnyWishes ? (
              <>
                <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
                  尚未有{activeTabLabel}
                </p>
                <p className="m-0 text-[11.5px] text-muted tracking-[0.04em]">
                  {activeTab === 'place'
                    ? '和大家分享想去的地方吧'
                    : '和大家分享想吃的店家吧'}
                </p>
              </>
            ) : (
              <>
                <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
                  尚未建立候選項目
                </p>
                <p className="m-0 mb-4 text-[11.5px] text-muted tracking-[0.04em] leading-[1.5]">
                  一起蒐集想去的地方與<br />
                  想吃的店家吧
                </p>
                {!votingClosed && (
                <button
                  type="button"
                  onClick={modal.openAdd}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
                >
                  <Plus size={14} strokeWidth={2.5} />
                  新增候選項目
                </button>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {boardRows.map(({ wish: w, rank, proposer, consensus }) => (
              <Fragment key={w.id}>
                {/* 上位3件 = 行程候補。3 位と 4 位の間に候補ラインを引いて
                    「ここまでが採用候補」を明示する(4 件以上ある時だけ)。 */}
                {rank === 4 && (
                  <div className="flex items-center gap-3 px-1 pt-1" aria-hidden>
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-[10.5px] font-semibold text-muted tracking-[0.06em]">
                      以上為前 3 名
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                )}
                <WishCard
                  wish={w}
                  isVoted={!!uid && w.votes.includes(uid)}
                  proposer={proposer}
                  isPreviewOnly={isDemo}
                  canEdit={canEdit(w)}
                  canDelete={canDelete(w)}
                  onEdit={() => modal.openEdit(w)}
                  onDelete={() => handleDeleteFromMenu(w)}
                  onOpenDetails={() => setDetailWishId(w.id)}
                  onToggleVote={() => handleToggleVote(w)}
                  // 単一カラムの順位リスト → 先頭(rank 1, 本命 lead)が LCP 候補。
                  eager={rank === 1}
                  isUpdating={pendingUpdateIds.has(w.id)}
                  rank={rank}
                  consensus={consensus}
                />
              </Fragment>
            ))}
          </div>
        )}
        </div>
        {/* 上下フェード ── scroll を遮らない overlay(pointer-events-none)。
            mask と違い fixed 子孫を閉じ込めないので ⋮ メニューは正常に開く。 */}
        {showBoardChrome && (
          <>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-app to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-app to-transparent" />
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

      {detailRow && (
        <WishDetailSheet
          isOpen
          wish={detailRow.wish}
          rank={detailRow.rank}
          voters={detailRow.voters}
          proposer={detailRow.proposer}
          consensus={detailRow.consensus}
          isVoted={!!uid && detailRow.wish.votes.includes(uid)}
          isPreviewOnly={isDemo}
          canEdit={canEdit(detailRow.wish)}
          isUpdating={pendingUpdateIds.has(detailRow.wish.id)}
          onClose={() => setDetailWishId(null)}
          onEdit={() => handleEditFromDetail(detailRow.wish)}
          onToggleVote={() => handleToggleVote(detailRow.wish)}
        />
      )}

      <SignInPromptModal
        isOpen={signIn.isOpen}
        onClose={signIn.close}
        reason="若要為心願投票，"
      />

      {deadlineSheetOpen && (
        <WishDeadlineSheet
          isOpen
          currentDeadlineAt={deadlineAt}
          isSaving={setDeadlineMut.isPending}
          onClose={() => setDeadlineSheetOpen(false)}
          onSave={handleSaveDeadline}
        />
      )}
    </div>
  )
}
