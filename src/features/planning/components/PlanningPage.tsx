// src/features/planning/components/PlanningPage.tsx
// Pre-trip checklist grouped by category. Rows are inline tap-to-edit;
// the checkbox to the left of each row toggles done state without
// opening the modal. Empty categories render an inline "+ 追加" prompt
// inside their section so the user can add directly into context.
import { useState, useMemo } from 'react'
import { Plus, ListChecks } from 'lucide-react'
import { useFeatureListPage } from '@/hooks/useFeatureListPage'
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import { toast } from '@/shared/toast'
import LoadingText from '@/components/ui/LoadingText'
import TripLoading from '@/components/ui/TripLoading'
import NoTripEmptyState from '@/components/ui/NoTripEmptyState'
import DemoBanner from '@/components/ui/DemoBanner'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import {
  usePlanning, useCreatePlanItem, useUpdatePlanItem,
  useTogglePlanItem, useDeletePlanItem,
} from '../hooks/usePlanning'
import { MOCK_PLAN_ITEMS } from '../mocks'
import type { PlanItem, PlanCategory, CreatePlanItemInput } from '@/types'
import PlanningFormModal from './PlanningFormModal'
import PlanningRow from './PlanningRow'

// Section order — matches PlanCategory enum semantically. UI fixed even
// when sections are empty so the page layout doesn't reshuffle as items
// get added (less disorienting than dynamic section visibility).
const SECTIONS: { category: PlanCategory; emoji: string; label: string }[] = [
  { category: 'essentials', emoji: '🎒', label: '必備'   },
  { category: 'documents',  emoji: '📄', label: '予約確認' },
  { category: 'packing',    emoji: '👕', label: '荷物'   },
  { category: 'todo',       emoji: '✅', label: '行前 todo' },
  { category: 'other',      emoji: '📌', label: 'その他' },
]

export default function PlanningPage() {
  const { ctx, uid, cloudTripId, mutationTripId, isDemo, modal, signIn } =
    useFeatureListPage<PlanItem>()
  /** Which category the "Add" tap should default to. Reset to first
   *  category when modal closes so a global add button still feels
   *  intentional (not "remembered last section"). */
  const [defaultCategory, setDefaultCategory] = useState<PlanCategory>('essentials')
  const swipe = useSwipeOpen()

  const { data: cloudItems, isLoading } = usePlanning(cloudTripId)

  // Memoise items so the grouped useMemo below doesn't re-bucket every
  // render (a fresh array literal would otherwise change identity each
  // pass). When ctx.status / cloudItems are the same, items is stable.
  const items: PlanItem[] = useMemo(() => {
    if (ctx.status === 'demo')  return ctx.trip.id === 'demo' ? MOCK_PLAN_ITEMS : []
    if (ctx.status === 'cloud') return cloudItems ?? []
    return []
  }, [ctx, cloudItems])

  // Group items by section. useMemo because every render of the list
  // would otherwise re-bucket O(N×5).
  const grouped = useMemo(() => {
    const out: Record<PlanCategory, PlanItem[]> = {
      essentials: [], documents: [], packing: [], todo: [], other: [],
    }
    for (const i of items) out[i.category].push(i)
    return out
  }, [items])

  const totalCount = items.length
  const doneCount  = items.filter(i => i.done).length

  const createMut = useCreatePlanItem(mutationTripId)
  const updateMut = useUpdatePlanItem(mutationTripId)
  const toggleMut = useTogglePlanItem(mutationTripId)
  const deleteMut = useDeletePlanItem(mutationTripId)
  const isSaving  = createMut.isPending || updateMut.isPending

  if (ctx.status === 'loading') return <TripLoading />
  if (ctx.status === 'no-trip') return <NoTripEmptyState icon={ListChecks} reason="旅前準備のリストを管理" />

  const title = ctx.trip.title

  function openAdd(category: PlanCategory = 'essentials') {
    setDefaultCategory(category)
    modal.openAdd()
  }

  async function handleSave(input: CreatePlanItemInput) {
    if (isDemo) { modal.close(); signIn.open(); return }
    if (!modal.editTarget && !uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
    try {
      if (modal.editTarget) {
        await updateMut.mutateAsync({ itemId: modal.editTarget.id, updates: input })
      } else {
        await createMut.mutateAsync({ input, createdBy: uid! })
      }
      modal.close()
    } catch { /* hook onError already toasted */ }
  }

  async function handleDelete() {
    if (!modal.editTarget) return
    if (isDemo) { modal.close(); signIn.open(); return }
    try {
      await deleteMut.mutateAsync(modal.editTarget.id)
      modal.close()
    } catch { /* hook onError already toasted */ }
  }

  function handleToggle(item: PlanItem) {
    if (isDemo) { signIn.open(); return }
    if (!uid)   { toast.error('ログイン準備中です。少々お待ちください'); return }
    toggleMut.mutate({ itemId: item.id, uid, done: !item.done })
  }

  async function handleSwipeDelete(item: PlanItem) {
    swipe.closeAll()
    if (isDemo) { signIn.open(); return }
    await deleteMut.mutateAsync(item.id).catch(() => {})
  }

  return (
    // Click anywhere on the page wrapper closes any open swipe — the row's
    // inner buttons stopPropagation, so this only fires for taps in the
    // gaps between rows, headers, and other non-row areas.
    <div className="bg-app min-h-full pb-8" onClick={swipe.closeAll}>
      {isDemo && <DemoBanner reason="チェックリストを保存" onSignIn={signIn.open} />}

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
              完了
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 px-4">
        {isLoading && !isDemo ? (
          <div className="text-center py-12 text-dot text-[13px]">
            <LoadingText />
          </div>
        ) : totalCount === 0 ? (
          <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
            <div className="w-14 h-14 rounded-full bg-app flex items-center justify-center mx-auto mb-3 text-muted">
              <ListChecks size={24} strokeWidth={1.6} />
            </div>
            <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
              リストはまだ空です
            </p>
            <p className="m-0 mb-[18px] text-[11.5px] text-muted tracking-[0.04em]">
              パスポート、充電器、行く前の手続きなど、忘れず準備
            </p>
            <button
              onClick={() => openAdd('essentials')}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
              style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
            >
              <Plus size={14} strokeWidth={2.5} />
              項目を追加
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {SECTIONS.map(section => {
              const sectionItems = grouped[section.category]
              const sectionDone  = sectionItems.filter(i => i.done).length
              return (
                <div key={section.category}>
                  <div className="flex items-center justify-between px-1 mb-2">
                    <span className="text-[12px] font-bold text-ink tracking-[0.02em]">
                      {section.emoji} {section.label}
                    </span>
                    {sectionItems.length > 0 && (
                      <span className="text-[11px] text-muted font-medium tabular-nums">
                        {sectionDone} / {sectionItems.length}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {sectionItems.map(item => (
                      <PlanningRow
                        key={item.id}
                        item={item}
                        isPreviewOnly={isDemo}
                        {...swipe.bindRow(item.id)}
                        onToggleDone={() => { swipe.closeAll(); handleToggle(item) }}
                        onTap={() => { swipe.closeAll(); modal.openEdit(item) }}
                        onDelete={() => handleSwipeDelete(item)}
                      />
                    ))}
                    <button
                      onClick={() => openAdd(section.category)}
                      className="h-9 rounded-[14px] border-[1.5px] border-dashed border-border bg-transparent text-muted text-[11.5px] font-medium flex items-center justify-center gap-1 cursor-pointer tracking-[0.04em] transition-all hover:bg-teal-pale hover:border-teal hover:text-teal"
                    >
                      <Plus size={12} strokeWidth={2} />
                      追加
                    </button>
                  </div>
                </div>
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
          onClose={modal.close}
          onSave={handleSave}
          onDelete={modal.editTarget && !isDemo ? handleDelete : undefined}
        />
      )}

      <SignInPromptModal
        isOpen={signIn.isOpen}
        onClose={signIn.close}
        reason="チェックリストを保存するには、"
      />
    </div>
  )
}
