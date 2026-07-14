// src/features/planning/components/PlanningPage.tsx
// Pre-trip checklist grouped by category. Rows are inline tap-to-edit;
// the leading control toggles the current member's completion without
// opening the modal. Empty categories render an inline "+ 追加" prompt
// inside their section so the user can add directly into context.
import { useState } from 'react'
import { Plus, ListChecks } from 'lucide-react'
import { useFeatureListPage } from '@/hooks/useFeatureListPage'
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import { toast } from '@/shared/toast'
import { simulateFailureMaybe } from '@/utils/devFailures'
import PlanningListSkeleton from './PlanningListSkeleton'
import PlanningPageSkeleton from './PlanningPageSkeleton'
import NoTripEmptyState from '@/components/ui/NoTripEmptyState'
import DemoBanner from '@/components/ui/DemoBanner'
import MemberAvatar from '@/components/ui/MemberAvatar'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import {
  usePlanning, useCreatePlanItem, useUpdatePlanItem,
  useTogglePlanItem, useDeletePlanItem,
} from '../hooks/usePlanning'
import { useMembers } from '@/features/members/hooks/useMembers'
import { memberToTripMember } from '@/features/members/utils'
import { MOCK_PLAN_ITEMS } from '../mocks'
import type { PlanItem, PlanCategory, CreatePlanItemInput } from '@/types'
import type { TripMember } from '@/features/trips/types'
import PlanningFormModal from './PlanningFormModal'
import PlanningRow from './PlanningRow'

type PlanningMember = TripMember & { name: string }

// Section order — matches PlanCategory enum semantically. UI fixed even
// when sections are empty so the page layout doesn't reshuffle as items
// get added (less disorienting than dynamic section visibility).
const SECTIONS: { category: PlanCategory; label: string }[] = [
  { category: 'essentials', label: '必備'   },
  { category: 'documents',  label: '訂單確認' },
  { category: 'packing',    label: '荷物'   },
  { category: 'todo',       label: '行前 todo' },
  { category: 'other',      label: '其他' },
]

function isCompletedBy(item: PlanItem, uid: string | undefined): boolean {
  return !!uid && Boolean(item.completedBy[uid])
}

function completedCount(items: PlanItem[], uid: string | undefined): number {
  return uid ? items.filter(item => isCompletedBy(item, uid)).length : 0
}

export default function PlanningPage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, canWrite, modal, signIn } =
    useFeatureListPage<PlanItem>()
  /** Which category the "Add" tap should default to. Reset to first
   *  category when modal closes so a global add button still feels
   *  intentional (not "remembered last section"). */
  const [defaultCategory, setDefaultCategory] = useState<PlanCategory>('essentials')
  const swipe = useSwipeOpen()

  const { data: cloudItems, isLoading } = usePlanning(cloudTripId)
  const { data: cloudMembers } = useMembers(cloudTripId)

  // Compiler memoises both `items` and `grouped` based on inferred deps.
  const items: PlanItem[] =
    ctx.status === 'demo'  ? (ctx.trip.id === 'demo' ? MOCK_PLAN_ITEMS : []) :
    ctx.status === 'cloud' ? (cloudItems ?? []) :
    []
  const members: PlanningMember[] =
    ctx.status === 'demo'  ? ctx.trip.members.map(member => ({ ...member, name: member.label })) :
    ctx.status === 'cloud' ? (cloudMembers ?? []).map(member => ({ ...memberToTripMember(member), name: member.displayName })) :
    []
  const currentUid = uid ?? (isDemo ? members[0]?.id : undefined)

  const grouped: Record<PlanCategory, PlanItem[]> = {
    essentials: [], documents: [], packing: [], todo: [], other: [],
  }
  for (const i of items) grouped[i.category].push(i)

  const totalCount = items.length
  const doneCount  = completedCount(items, currentUid)

  // silent — modal surfaces errors via inline banner(useFormModal.saveError),
  // global toast would double-notify.
  const createMut = useCreatePlanItem(mutationTripId, { silent: true })
  const updateMut = useUpdatePlanItem(mutationTripId, { silent: true })
  const toggleMut = useTogglePlanItem(mutationTripId)
  const deleteMut = useDeletePlanItem(mutationTripId)
  const isSaving  = createMut.isPending || updateMut.isPending

  if (ctx.status === 'loading') return <PlanningPageSkeleton />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={ListChecks} reason="管理行前準備清單" />

  const title = ctx.trip.title

  function openAdd(category: PlanCategory = 'essentials') {
    setDefaultCategory(category)
    modal.openAdd()
  }

  async function handleSave(input: CreatePlanItemInput) {
    if (isDemo) { modal.close(); signIn.open(); return }
    if (!canWrite) { toast.error('你沒有編輯權限'); return }
    if (!uid) { toast.error('正在準備登入，請稍候'); return }
    modal.clearError()
    try {
      await simulateFailureMaybe()
      if (modal.editTarget) {
        await updateMut.mutateAsync({ itemId: modal.editTarget.id, updates: input, uid })
      } else {
        await createMut.mutateAsync({ input, createdBy: uid })
      }
      modal.close()
    } catch (err) {
      modal.setError(err instanceof Error ? err.message : '儲存失敗')
    }
  }

  async function handleDelete() {
    if (!modal.editTarget) return
    if (isDemo) { modal.close(); signIn.open(); return }
    if (!canWrite) { toast.error('你沒有刪除權限'); return }
    try {
      await deleteMut.mutateAsync(modal.editTarget.id)
      modal.close()
    } catch { /* hook onError already toasted */ }
  }

  function handleToggle(item: PlanItem) {
    if (isDemo) { signIn.open(); return }
    if (!uid)   { toast.error('正在準備登入，請稍候'); return }
    toggleMut.mutate({ itemId: item.id, uid, done: !isCompletedBy(item, uid) })
  }

  async function handleSwipeDelete(item: PlanItem) {
    swipe.closeAll()
    if (isDemo) { signIn.open(); return }
    if (!canWrite) { toast.error('你沒有刪除權限'); return }
    await deleteMut.mutateAsync(item.id).catch(() => {})
  }

  return (
    // Click anywhere on the page wrapper closes any open swipe — the row's
    // inner buttons stopPropagation, so this only fires for taps in the
    // gaps between rows, headers, and other non-row areas.
    <div className="bg-app min-h-full pb-8" onClick={swipe.closeAll}>
      {isDemo && <DemoBanner reason="儲存清單" onSignIn={signIn.open} />}

      <div className="px-5 pt-4 pb-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 mb-1 text-[10.5px] font-semibold text-muted tracking-[0.12em] uppercase">
            旅前計画
          </p>
          <h1 className="m-0 text-[22px] font-black text-ink -tracking-[0.5px] truncate">
            {title}
          </h1>
        </div>
        {totalCount > 0 && (
          <div className="shrink-0 text-right">
            <div className="text-[20px] font-black text-ink leading-none tabular-nums">
              {doneCount}<span className="text-[14px] text-muted font-bold"> / {totalCount}</span>
            </div>
            <div className="text-[10px] text-muted mt-0.5 tracking-[0.06em]">
              已完成
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 px-4">
        {members.length > 0 && totalCount > 0 && (
          <div className="mb-5">
            <p className="m-0 mb-2 px-1 text-[11px] font-extrabold tracking-[0.08em] text-muted">
              全員準備進度
            </p>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {members.map(member => {
                const memberDone = completedCount(items, member.id)
                const memberPercent = totalCount ? Math.round((memberDone / totalCount) * 100) : 0
                return (
                  <div
                    key={member.id}
                    className="min-w-[86px] rounded-[18px] border border-border bg-surface px-3 py-3 text-center shadow-[0_2px_10px_rgba(0,0,0,0.04)]"
                  >
                    <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full border-[2px] border-[#D8CEC3] bg-app">
                      <MemberAvatar member={member} size={30} />
                    </div>
                    <div className="truncate text-[11.5px] font-black text-ink">
                      {member.name}
                    </div>
                    <div className="mt-1 text-[10.5px] font-extrabold tabular-nums text-[#8A6B50]">
                      {memberDone} / {totalCount} 項
                    </div>
                    <div className="mt-2 h-1 rounded-full bg-border/70">
                      <div
                        className="h-full rounded-full bg-[#B29B89]"
                        style={{ width: `${memberPercent}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {isLoading && !isDemo ? (
          <PlanningListSkeleton />
        ) : totalCount === 0 ? (
          <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
            <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
              <ListChecks size={24} strokeWidth={1.6} />
            </div>
            <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
              清單還是空的
            </p>
            <p className="m-0 mb-[18px] text-[11.5px] text-muted tracking-[0.04em]">
              護照、充電器、出發前手續等，別忘了準備
            </p>
            {canWrite && (
              <button
                onClick={() => openAdd('essentials')}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
                style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
              >
                <Plus size={14} strokeWidth={2.5} />
                新增項目
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {SECTIONS.map(section => {
              const sectionItems = grouped[section.category]
              const sectionDone  = completedCount(sectionItems, currentUid)
              const sectionPercent = sectionItems.length
                ? Math.round((sectionDone / sectionItems.length) * 100)
                : 0
              return (
                <section
                  key={section.category}
                  className="relative overflow-hidden rounded-[24px] border border-border bg-surface shadow-[0_2px_14px_rgba(0,0,0,0.05)]"
                >
                  <div className="flex items-start justify-between gap-3 pb-2 pr-5">
                    <div className="flex h-[52px] min-w-[150px] items-center gap-3 rounded-br-[26px] bg-[#A78A72] pl-5 pr-6 text-white shadow-[0_4px_14px_rgba(120,88,62,0.18)]">
                      <span className="text-[15px] font-black tabular-nums leading-none">
                        {sectionPercent}%
                      </span>
                      <span className="h-4 w-px bg-white/35" aria-hidden />
                      <span className="text-[13px] font-extrabold tracking-[0.04em] whitespace-nowrap">
                        {section.label}
                      </span>
                    </div>

                    <div className="pt-4 text-right">
                      <div className="text-[10.5px] font-semibold tracking-[0.08em] text-muted">
                        進捗概要
                      </div>
                      <div className="mt-0.5 text-[17px] font-black leading-none tabular-nums text-[#8A6B50]">
                        {sectionDone} / {sectionItems.length}
                        <span className="ml-1 text-[13px] font-extrabold text-ink">項目</span>
                      </div>
                    </div>
                  </div>

                  <div className="px-5 pb-4 pt-1">
                    {sectionItems.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        {sectionItems.map(item => (
                          <PlanningRow
                            key={item.id}
                            item={item}
                            members={members}
                            currentUid={currentUid}
                            isDone={isCompletedBy(item, currentUid)}
                            canEdit={canWrite}
                            isPreviewOnly={isDemo}
                            {...swipe.bindRow(item.id)}
                            onToggleDone={() => { swipe.closeAll(); handleToggle(item) }}
                            onTap={() => { swipe.closeAll(); modal.openEdit(item) }}
                            onDelete={() => handleSwipeDelete(item)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="px-1 py-5 text-center text-[12px] font-semibold text-muted">
                        尚未有項目
                      </div>
                    )}
                    {canWrite && (
                      <button
                        onClick={() => openAdd(section.category)}
                        className="mt-2 h-9 w-full rounded-[14px] border-[1.5px] border-dashed border-border bg-transparent text-muted text-[11.5px] font-medium flex items-center justify-center gap-1 cursor-pointer tracking-[0.04em] transition-all hover:bg-teal-pale hover:border-teal hover:text-teal"
                      >
                        <Plus size={12} strokeWidth={2} />
                        新增
                      </button>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>

      {modal.isOpen && (
        <PlanningFormModal
          key={modal.key}
          isOpen
          editTarget={modal.editTarget}
          defaultCategory={defaultCategory}
          isSaving={isSaving}
          saveError={modal.saveError}
          onClose={modal.close}
          onSave={handleSave}
          onDelete={modal.editTarget && canWrite && !isDemo ? handleDelete : undefined}
        />
      )}

      <SignInPromptModal
        isOpen={signIn.isOpen}
        onClose={signIn.close}
        reason="若要儲存清單，"
      />
    </div>
  )
}
