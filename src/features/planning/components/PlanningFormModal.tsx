// src/features/planning/components/PlanningFormModal.tsx
// Add / edit a planning checklist item. Three text fields; useFormReducer
// keeps the state shape one-line-add when fields evolve.
import { useRef, useState } from 'react'
import type { PlanItem, PlanCategory, CreatePlanItemInput } from '@/types'
import FormModalShell from '@/components/ui/FormModalShell'
import FormField from '@/components/ui/FormField'
import DeleteConfirm from '@/components/ui/DeleteConfirm'
import { inputClass } from '@/components/ui/inputStyle'
import CategoryChipRow from '@/components/ui/CategoryChipRow'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'
import { useAwaitedSave, describeSaveFailure } from '@/hooks/useAwaitedSave'
import { PLAN_CATEGORY_ICON } from '../categories'

const CATEGORIES: { value: PlanCategory; label: string }[] = [
  { value: 'essentials', label: '必備'   },
  { value: 'documents',  label: '訂單確認' },
  { value: 'packing',    label: '行李'   },
  { value: 'todo',       label: '行前'   },
  { value: 'other',      label: '其他' },
]

// `type` (not `interface`): TS won't widen interfaces to satisfy
// `Record<string, unknown>` since interfaces are open for declaration
// merging. Type aliases are closed and pass useFormReducer's constraint.
type FormState = {
  category: PlanCategory
  title:    string
  note:     string
}

function initFromTarget(t: PlanItem | null, defaultCategory: PlanCategory): FormState {
  return {
    category: t?.category ?? defaultCategory,
    title:    t?.title ?? '',
    note:     t?.note ?? '',
  }
}

interface Props {
  editTarget:      PlanItem | null
  defaultCategory: PlanCategory
  isOpen:          boolean
  /** Banner for a refusal the page decides synchronously (scope / epoch).
   *  A failed write is this form's own banner (useAwaitedSave). */
  saveError?:      string | null
  onClose:         () => void
  /** Returns the write's promise when one is issued; this form tracks it —
   *  busy state, banner and closing belong to this open, not the page.
   *  `reportInForm` goes into the mutation variables. */
  onSave:          (data: CreatePlanItemInput, reportInForm: () => boolean) => void | Promise<unknown>
  /** Visible only in edit mode. */
  onDelete?:       () => void | Promise<unknown>
}

export default function PlanningFormModal({
  editTarget, defaultCategory, isOpen, saveError, onClose, onSave, onDelete,
}: Props) {
  const awaited = useAwaitedSave(onClose)
  const { state, setField } = useFormReducer<FormState>(
    () => initFromTarget(editTarget, defaultCategory),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  const titleRef = useRef<HTMLInputElement>(null)
  useAutoFocus(titleRef, isOpen)

  function handleSave() {
    const e: Record<string, string> = {}
    if (!state.title.trim()) e.title = '請輸入標題'
    setErrors(e)
    if (Object.keys(e).length > 0) return
    const data: CreatePlanItemInput = {
      category: state.category,
      title:    state.title.trim(),
      note:     state.note.trim() || undefined,
    }
    awaited.submit(() => onSave(data, awaited.stillOpen), describeSaveFailure)
  }

  // Delete failures are toasted globally; this form only closes itself, and
  // only if it is still the open one.
  function handleDelete() {
    awaited.submit(() => onDelete?.())
  }

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={awaited.saving}
      title={editTarget ? '編輯項目' : '新增項目'}
      saveLabel={editTarget ? '儲存變更' : '新增'}
      saveError={awaited.error ?? saveError}
      onClose={onClose}
      onSave={handleSave}
    >
      <FormField label="分類">
        <CategoryChipRow
          categories={CATEGORIES}
          icons={PLAN_CATEGORY_ICON}
          active={state.category}
          onSelect={v => setField('category', v)}
        />
      </FormField>

      <FormField label="標題" error={errors.title} required>
        <input
          ref={titleRef}
          value={state.title}
          maxLength={100}
          onChange={e => setField('title', e.target.value)}
          placeholder="例如：護照、充電器、換匯"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="備註">
        <textarea
          value={state.note}
          maxLength={500}
          onChange={e => setField('note', e.target.value)}
          placeholder="數量、尺寸或補充說明"
          rows={3}
          className={`${inputClass(false)} resize-none leading-[1.6] py-2.5 h-auto`}
        />
      </FormField>

      {editTarget && onDelete && <DeleteConfirm noun="項目" onDelete={handleDelete} disabled={awaited.saving} />}
    </FormModalShell>
  )
}
