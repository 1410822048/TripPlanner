// src/features/wish/components/WishPage.tsx
// List of wish items for the current trip — server-sorted by votes
// then createdAt. Heart-tap toggles the caller's vote optimistically;
// tapping the row body opens edit (proposer) or read (others).
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
import type { Wish } from '@/types'
import WishFormModal, { type WishFormResult } from './WishFormModal'
import WishCard from './WishCard'

export default function WishPage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, modal, signIn } =
    useFeatureListPage<Wish>()

  const { data: cloudWishes, isLoading } = useWishes(cloudTripId)
  const demoWishes = ctx.status === 'demo' && ctx.trip.id === 'demo' ? MOCK_WISHES : []
  const wishes = ctx.status === 'demo' ? demoWishes : (cloudWishes ?? [])

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

      <div className="mt-4 px-4">
        {isLoading && !isDemo ? (
          <div className="text-center py-12 text-dot text-[13px]">
            <LoadingText />
          </div>
        ) : wishes.length === 0 ? (
          <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
            <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
              <Heart size={24} strokeWidth={1.6} />
            </div>
            <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
              まだウィッシュがありません
            </p>
            <p className="m-0 mb-[18px] text-[11.5px] text-muted tracking-[0.04em]">
              行きたい所、食べたい物、やりたい事を共有しましょう
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
              {wishes.map(w => (
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
