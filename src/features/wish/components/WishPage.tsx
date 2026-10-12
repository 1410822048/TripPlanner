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
import PageHeader from '@/components/ui/PageHeader'
import ListEmptyCard from '@/components/ui/ListEmptyCard'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import {
  useWishes, useCreateWish, useUpdateWish, useDeleteWish, useToggleWishVote,
  wishKeys, wishOverlay,
} from '../hooks/useWishes'
import { useOverlayPendingRowIds } from '@/hooks/listOverlay'
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
import { getClientWriteBlockReason } from '@/services/clientCompatibility'
import { FORM_SCOPE_CHANGED_MESSAGE } from '@/hooks/useFormModal'

export default function WishPage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, isOwner, canOwnerWrite, writeCompatible, modal, signIn } =
    useFeatureListPage<Wish>()
  const [activeTab, setActiveTab] = useState<WishCategory>('place')
  const [detailWishId, setDetailWishId] = useState<string | null>(null)
  // Non-null while the deadline sheet is open; carries the {tripId, uid} it
  // was opened under so a background trip switch can't write A's date into B.
  const [deadlineSheet, setDeadlineSheet] = useState<
    { tripId: string | undefined; uid: string | undefined } | null
  >(null)

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
  // members query 可能比 wishes 晚解析(cloud 是 wishes 先到)。這是確定前
  // 不顯示 consensus 分母用的 ready 旗標。demo 會同步備齊。
  const membersReady = ctx.status === 'demo' || fbMembers !== undefined

  let placeCount = 0, foodCount = 0
  for (const w of wishes) {
    if (w.category === 'place') placeCount++
    else if (w.category === 'food') foodCount++
  }
  const counts = { place: placeCount, food: foodCount }
  const hasAnyWishes = wishes.length > 0
  const showBoardChrome = (isLoading && !isDemo) || hasAnyWishes

  // ─ 在同一處產生 Wish board 的衍生資料 ───────────────────────────
  // 名次(rank)/ 提案者(proposer)/ 投票者(voters)/ 贊成度顯示狀態(consensus)
  // 都在這裡決定,WishCard 只負責渲染整理好的 props(名次與分母都
  // 不在 card 端推導)。rankWishes 也會排序 demo 的 MOCK。投票後也是
  // 經過同一個 rankWishes 的快取,所以這裡只需 map 已排序的結果。
  const boardRows = rankWishes(wishes.filter(w => w.category === activeTab))
    .map((wish, index) => ({
      wish,
      rank:      index + 1,
      proposer:  memberById.get(wish.proposedBy),
      // 依 votes[] 順序(= arrayUnion 加入順序)把 uid 解析成 TripMember。已退出者等
      // 未知 uid 直接略過(+N 由 totalVotes=votes.length 保證)。
      voters:    wish.votes.flatMap(uid => {
        const m = memberById.get(uid)
        return m ? [m] : []
      }),
      consensus: toConsensus(wish.votes.length, members.length, membersReady),
    }))
  const detailRow = detailWishId
    ? boardRows.find(row => row.wish.id === detailWishId) ?? null
    : null
  // 標籤以 WISH_CATEGORIES 為 single source(避免新增/改名分類時雙重維護)。
  const activeTabLabel = WISH_CATEGORIES.find(t => t.value === activeTab)?.label ?? ''

  // Optimistic close — modal closes immediately on save; a failure drops
  // the overlay operation and MutationCache.onError raises the toast.
  const createMut = useCreateWish(mutationTripId)
  const updateMut = useUpdateWish(mutationTripId)
  const deleteMut = useDeleteWish(mutationTripId)
  const voteMut   = useToggleWishVote(mutationTripId)
  // Ids whose write is still in flight — drives the 保存中… pill and locks
  // the card. Covers create and update alike now that both are overlay ops
  // carrying the real id, so there is no id-shape check left to do.
  const pendingUpdateIds = useOverlayPendingRowIds(wishOverlay, wishKeys.all(mutationTripId, uid))

  if (ctx.status === 'loading') return <WishPageSkeleton />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={Heart} reason="為心願投票" />

  const title = ctx.trip.title

  function handleSave({ input, attachment }: WishFormResult) {
    // Scope BEFORE demo / votingClosed: both close the form. The deadline
    // belongs to the LIVE trip, so a form dragged onto an already-closed trip
    // B (or a cloud form signed out into demo) would otherwise lose its draft
    // instead of being refused with the draft kept.
    if (modal.scopeChanged) { modal.setError(FORM_SCOPE_CHANGED_MESSAGE); return }
    if (isDemo) { modal.close(); signIn.open(); return }
    if (votingClosed) { modal.close(); toast.error('投票已截止'); return }
    if (!uid) { toast.error('正在準備登入，請稍候'); return }

    // Optimistic close (mirrors ExpensePage). Modal closes immediately;
    // the hook's onMutate adds an overlay operation so the card shows at
    // once, the real write runs in the background, and a failure drops
    // that operation while MutationCache.onError raises the toast.
    const editing = modal.editTarget
    const file = attachment instanceof File ? attachment : null
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) {
      modal.setError(writeBlockReason)
      return
    }
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
      createMut.mutate({ wishId: crypto.randomUUID(), input, file, proposedBy: uid })
    }
  }

  function handleDelete() {
    if (!modal.editTarget) return
    if (isDemo) { modal.close(); signIn.open(); return }
    // Same ordering as handleSave: scope before the live trip's deadline.
    if (modal.scopeChanged) { modal.setError(FORM_SCOPE_CHANGED_MESSAGE); return }
    if (votingClosed) { modal.close(); toast.error('投票已截止'); return }
    const target = modal.editTarget
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) {
      modal.setError(writeBlockReason)
      return
    }
    modal.close()
    deleteMut.mutate({ wishId: target.id })
  }

  function handleToggleVote(w: Wish) {
    if (votingClosed) { toast.error('投票已截止'); return }
    if (isDemo) { signIn.open(); return }
    if (!uid)   { toast.error('正在準備登入，請稍候'); return }
    // Votes are isMember-gated, so no role check hides this button; without a
    // toast the tap would silently do nothing on a blocked client.
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) { toast.error(writeBlockReason); return }
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
    // Proposers reach this without any owner gate, so compatibility has to be
    // checked here rather than riding in on `canOwnerWrite`.
    if (!writeCompatible) return false
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
    // Hiding the menu item only affects renders after the flip; a menu already
    // on screen can still submit.
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) { toast.error(writeBlockReason); return }
    deleteMut.mutate({ wishId: w.id })
  }

  function handleSaveDeadline(deadlineAtInput: Date | null) {
    // The mutation targets the LIVE trip — a sheet opened on trip A must not
    // write A's date into trip B after a background reselect. A vanished live
    // trip/uid (cloud → demo / no-trip) is the same fail-closed branch, not a
    // silent early-return. Sheet stays open so the owner closes it
    // deliberately.
    if (
      !deadlineSheet || !cloudTripId || !uid ||
      deadlineSheet.tripId !== cloudTripId || deadlineSheet.uid !== uid
    ) {
      toast.error(FORM_SCOPE_CHANGED_MESSAGE)
      return
    }
    if (votingClosed) {
      setDeadlineSheet(null)
      toast.error('投票已截止')
      return
    }
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) { toast.error(writeBlockReason); return }
    setDeadlineMut.mutate({ tripId: cloudTripId, deadlineAt: deadlineAtInput })
    setDeadlineSheet(null)
  }

  function handleEditFromDetail(w: Wish) {
    setDetailWishId(null)
    modal.openEdit(w)
  }

  return (
    <div className="bg-app h-full flex flex-col overflow-hidden">
      {isDemo && <DemoBanner reason="儲存投票" onSignIn={signIn.open} />}

      {/* 右側群組:投票中人數 pill。新增入口固定在分類 tab 正下方,
          header 的圓形加號與列表 CTA 不再重複。 */}
      <PageHeader
        eyebrow="心願"
        title={title}
        align="center"
        className="shrink-0"
        truncateTitle
        right={(
          <div className="flex items-center gap-2 shrink-0">
            {members.length > 0 && (
              <span className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-3 rounded-full text-[11.5px] font-semibold text-teal bg-teal-pale">
                <span className="w-1.5 h-1.5 rounded-full bg-teal" />
                {members.length}人投票
              </span>
            )}
          </div>
        )}
      />

      {!isDemo && (
        <WishVotingDeadlineBar
          deadlineAt={deadlineAt}
          now={now}
          votingClosed={votingClosed}
          deadlineLocked={deadlineLocked}
          canSetDeadline={canOwnerWrite}
          isSaving={setDeadlineMut.isPending}
          onOpenSheet={() => setDeadlineSheet({ tripId: cloudTripId, uid })}
        />
      )}

      {showBoardChrome && (
        <>
          {/* 固定上方框架 ── 分類 tab。新增 CTA 放在下一個固定區塊。 */}
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
                      // 內側 pill 的圓角對齊 外框(rounded-card=20px)− p-1(4px)= 16px,
                      // 讓白色 active 背景與外框同心(消除角看起來
                      // 太方的違和感)。
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

          {/* 綁定分類的新增入口。放在固定框架內,列表的 Y 軸
              就從這顆按鈕下方開始。空 tab 時高度也不變、不會跳動。
              投票截止後隱藏(wishVotingOpen(tripId) 會拒絕 create)。 */}
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

      {/* 選項列表 ── 唯一會捲動的區域(獨立 Y 軸)。在 relative 外層上
          疊上下淡出 overlay,緩和與固定框架交界處的「生硬切邊」。
          ⚠ 以前是在 scroll 元素上套 mask-image,但 mask 會為 position:fixed
          子孫建立 containing block,導致從卡片 ⋮ 開啟的 BottomSheet
          (fixed)被裁切在 scroll 區域內,出現「刪除按不到」的 bug。
          overlay 方式不會困住 fixed,因此解決(relative 不會為 fixed
          建立 containing block)。 */}
      <div className="relative flex-1 min-h-0">
        {/* overscroll-contain ── 滑到底也不把捲動鏈傳到外層 main
            (阻斷 iOS 整頁被連帶拖動的行為)。 */}
        <div className="h-full overflow-y-auto overscroll-contain px-4 pt-2 pb-6">
        {isLoading && !isDemo ? (
          <WishListSkeleton />
        ) : boardRows.length === 0 ? (
          <ListEmptyCard
            className="py-12"
            icon={(
              <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
                <Heart size={24} strokeWidth={1.6} />
              </div>
            )}
            title={hasAnyWishes ? `尚未有${activeTabLabel}` : '尚未建立候選項目'}
            description={hasAnyWishes
              ? activeTab === 'place'
                ? '和大家分享想去的地方吧'
                : '和大家分享想吃的店家吧'
              : (
                <span className="leading-[1.5]">
                  一起蒐集想去的地方與<br />
                  想吃的店家吧
                </span>
              )}
            actions={!hasAnyWishes && !votingClosed ? (
                <button
                  type="button"
                  onClick={modal.openAdd}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
                >
                  <Plus size={14} strokeWidth={2.5} />
                  新增候選項目
                </button>
            ) : undefined}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {boardRows.map(({ wish: w, rank, proposer, consensus }) => (
              <Fragment key={w.id}>
                {/* 前 3 名 = 行程候選。在第 3 名與第 4 名之間畫候選分隔線,
                    明示「到這裡為止是採用候選」(只在 4 筆以上時)。 */}
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
                  // 單欄名次列表 → 第一筆(rank 1, 第一名 lead)是 LCP 候選。
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
        {/* 上下淡出 ── 不擋 scroll 的 overlay(pointer-events-none)。
            與 mask 不同,不會困住 fixed 子孫,所以 ⋮ 選單能正常開啟。 */}
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

      {deadlineSheet && (
        <WishDeadlineSheet
          isOpen
          currentDeadlineAt={deadlineAt}
          isSaving={setDeadlineMut.isPending}
          onClose={() => setDeadlineSheet(null)}
          onSave={handleSaveDeadline}
        />
      )}
    </div>
  )
}
