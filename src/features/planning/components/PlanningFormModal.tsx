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
import { PLAN_CATEGORY_ICON } from '../categories'

const CATEGORIES: { value: PlanCategory; label: string }[] = [
  { value: 'essentials', label: '必備'   },
  { value: 'documents',  label: '予約'   },
  { value: 'packing',    label: '荷物'   },
  { value: 'todo',       label: '行前'   },
  { value: 'other',      label: 'その他' },
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
  isSaving:        boolean
  saveError?:      string | null
  onClose:         () => void
  onSave:          (data: CreatePlanItemInput) => void
  /** Visible only in edit mode. */
  onDelete?:       () => void
}

export default function PlanningFormModal({
  editTarget, defaultCategory, isOpen, isSaving, saveError, onClose, onSave, onDelete,
}: Props) {
  const { state, setField } = useFormReducer<FormState>(
    () => initFromTarget(editTarget, defaultCategory),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  const titleRef = useRef<HTMLInputElement>(null)
  useAutoFocus(titleRef, isOpen)

  function handleSave() {
    const e: Record<string, string> = {}
    if (!state.title.trim()) e.title = 'タイトルを入力してください'
    setErrors(e)
    if (Object.keys(e).length > 0) return
    onSave({
      category: state.category,
      title:    state.title.trim(),
      note:     state.note.trim() || undefined,
    })
  }

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={isSaving}
      title={editTarget ? '項目を編集' : '項目を追加'}
      saveLabel={editTarget ? '変更を保存' : '追加'}
      saveError={saveError}
      onClose={onClose}
      onSave={handleSave}
    >
      <FormField label="カテゴリ">
        <CategoryChipRow
          categories={CATEGORIES}
          icons={PLAN_CATEGORY_ICON}
          active={state.category}
          onSelect={v => setField('category', v)}
        />
      </FormField>

      <FormField label="タイトル" error={errors.title} required>
        <input
          ref={titleRef}
          value={state.title}
          onChange={e => setField('title', e.target.value)}
          placeholder="例：パスポート、充電器、両替"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="メモ">
        <textarea
          value={state.note}
          onChange={e => setField('note', e.target.value)}
          placeholder="数量・サイズ・補足など"
          rows={3}
          className={`${inputClass(false)} resize-none leading-[1.6] py-2.5 h-auto`}
        />
      </FormField>

      {editTarget && onDelete && <DeleteConfirm noun="項目" onDelete={onDelete} />}
    </FormModalShell>
  )
}
