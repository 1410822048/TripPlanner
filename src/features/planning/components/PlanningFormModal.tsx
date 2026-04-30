// src/features/planning/components/PlanningFormModal.tsx
// Add / edit a planning checklist item. Three text fields; useFormReducer
// keeps the state shape one-line-add when fields evolve.
import { useRef, useState } from 'react'
import type { PlanItem, PlanCategory, CreatePlanItemInput } from '@/types'
import FormModalShell from '@/components/ui/FormModalShell'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'

const CATEGORIES: { value: PlanCategory; emoji: string; label: string }[] = [
  { value: 'essentials', emoji: '🎒', label: '必備'   },
  { value: 'documents',  emoji: '📄', label: '予約'   },
  { value: 'packing',    emoji: '👕', label: '荷物'   },
  { value: 'todo',       emoji: '✅', label: '行前'   },
  { value: 'other',      emoji: '📌', label: 'その他' },
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
  onClose:         () => void
  onSave:          (data: CreatePlanItemInput) => void
  /** Visible only in edit mode. */
  onDelete?:       () => void
}

export default function PlanningFormModal({
  editTarget, defaultCategory, isOpen, isSaving, onClose, onSave, onDelete,
}: Props) {
  const { state, setField } = useFormReducer<FormState>(
    () => initFromTarget(editTarget, defaultCategory),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirmDelete, setConfirmDelete] = useState(false)

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
      onClose={onClose}
      onSave={handleSave}
    >
      <FormField label="カテゴリ">
        <div className="flex gap-[7px] flex-wrap">
          {CATEGORIES.map(c => {
            const active = state.category === c.value
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setField('category', c.value)}
                className={[
                  'flex items-center gap-[5px] px-3 py-1.5 rounded-card text-[12px] cursor-pointer transition-all border-[1.5px]',
                  active
                    ? 'border-accent bg-accent text-white font-semibold'
                    : 'border-border bg-transparent text-muted font-normal hover:border-muted',
                ].join(' ')}
              >
                <span>{c.emoji}</span>{c.label}
              </button>
            )
          })}
        </div>
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

      {editTarget && onDelete && (
        confirmDelete ? (
          <div className="flex gap-2 p-3 rounded-xl bg-danger-pale border border-danger-soft">
            <span className="flex-1 text-[12px] text-danger self-center leading-[1.5]">
              この項目を削除しますか？
            </span>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1.5 rounded-lg border border-border bg-transparent text-muted text-[12px] font-medium cursor-pointer whitespace-nowrap hover:bg-app transition-colors"
            >
              キャンセル
            </button>
            <button
              onClick={onDelete}
              className="px-3 py-1.5 rounded-lg border border-danger-soft bg-transparent text-danger text-[12px] font-medium cursor-pointer whitespace-nowrap hover:bg-danger-pale transition-colors"
            >
              削除
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="w-full p-[11px] rounded-xl border border-danger-soft bg-transparent text-danger text-[13px] font-medium cursor-pointer tracking-[0.04em] hover:bg-danger-pale transition-colors"
          >
            この項目を削除
          </button>
        )
      )}
    </FormModalShell>
  )
}
