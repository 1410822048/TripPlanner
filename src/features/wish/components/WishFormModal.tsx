// src/features/wish/components/WishFormModal.tsx
// Add / edit a wish item. Single optional cover image (vs Journal's
// multi-image gallery — wish items are "is this the place" reference,
// not photo memories). Form state via useReducer; image via the same
// tri-state pattern as bookings.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X as XIcon, Trash2, FileText } from 'lucide-react'
import type { Wish, WishCategory, WishImage, CreateWishInput } from '@/types'
import FormModalShell from '@/components/ui/FormModalShell'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'
import ConfirmSheet from '@/components/ui/ConfirmSheet'

const ACCEPT_TYPES = 'image/*'
const MAX_FILE_BYTES = 5 * 1024 * 1024

const CATEGORIES: { value: WishCategory; emoji: string; label: string }[] = [
  { value: 'place',    emoji: '🗺️', label: '行く所' },
  { value: 'food',     emoji: '🍜', label: '食べる' },
  { value: 'activity', emoji: '🎯', label: 'やる事' },
  { value: 'other',    emoji: '📌', label: 'その他' },
]

// `type` (not `interface`): TS won't widen interfaces to satisfy
// `Record<string, unknown>` since interfaces are open for declaration
// merging. Type aliases are closed and pass useFormReducer's constraint.
type FormState = {
  category:    WishCategory
  title:       string
  description: string
  link:        string
}

function initFromTarget(t: Wish | null): FormState {
  return {
    category:    t?.category ?? 'place',
    title:       t?.title ?? '',
    description: t?.description ?? '',
    link:        t?.link ?? '',
  }
}

type AttachmentChange = File | null | undefined

export interface WishFormResult {
  input:      CreateWishInput
  attachment: AttachmentChange
}

interface Props {
  editTarget: Wish | null
  isOpen:     boolean
  isSaving:   boolean
  onClose:    () => void
  onSave:     (data: WishFormResult) => void
  /** Only present in edit mode for the proposer. Hidden otherwise. */
  onDelete?:  () => void
}

export default function WishFormModal({
  editTarget, isOpen, isSaving, onClose, onSave, onDelete,
}: Props) {
  const { state, setField } = useFormReducer<FormState>(() => initFromTarget(editTarget))

  // Image state — single optional. Mirror booking's tri-state contract.
  const [existing, setExisting] = useState<WishImage | null>(editTarget?.image ?? null)
  const [newFile,  setNewFile]  = useState<File | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)

  const newFileBlobUrl = useMemo(
    () => newFile ? URL.createObjectURL(newFile) : null,
    [newFile],
  )
  useEffect(() => {
    if (!newFileBlobUrl) return
    return () => URL.revokeObjectURL(newFileBlobUrl)
  }, [newFileBlobUrl])

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirmDelete, setConfirmDelete] = useState(false)

  const titleRef = useRef<HTMLInputElement>(null)
  const fileRef  = useRef<HTMLInputElement>(null)
  useAutoFocus(titleRef, isOpen)

  function pickFile() {
    fileRef.current?.click()
  }
  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (f.size > MAX_FILE_BYTES) {
      setImageError('画像サイズは 5MB 以下にしてください')
      return
    }
    setImageError(null)
    setNewFile(f)
  }
  function clearImage() {
    setNewFile(null)
    setExisting(null)
    setImageError(null)
  }

  function pickAttachmentChange(): AttachmentChange {
    if (newFile) return newFile
    if (editTarget?.image && !existing) return null
    return undefined
  }

  function validate(): WishFormResult | null {
    const e: Record<string, string> = {}
    if (!state.title.trim()) e.title = 'タイトルを入力してください'
    if (state.link.trim() && !/^https?:\/\//i.test(state.link.trim())) {
      e.link = 'http:// または https:// で始まる URL'
    }
    setErrors(e)
    if (Object.keys(e).length > 0) return null

    const input: CreateWishInput = {
      category:    state.category,
      title:       state.title.trim(),
      description: state.description.trim() || undefined,
      link:        state.link.trim() || undefined,
    }
    return { input, attachment: pickAttachmentChange() }
  }

  function handleSave() {
    const r = validate()
    if (r) onSave(r)
  }

  const previewUrl  = newFileBlobUrl ?? existing?.url ?? null
  const hasImage    = !!previewUrl
  const previewName = newFile?.name ?? '画像'

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={isSaving}
      title={editTarget ? 'ウィッシュを編集' : 'ウィッシュを追加'}
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
          placeholder="例：築地市場、壽司大、淺草寺"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="説明">
        <textarea
          value={state.description}
          onChange={e => setField('description', e.target.value)}
          placeholder="どんなところ？なぜ行きたい？"
          rows={2}
          className={`${inputClass(false)} resize-none leading-[1.6] py-2.5 h-auto`}
        />
      </FormField>

      <FormField label="リンク（URL）" error={errors.link}>
        <input
          type="url"
          inputMode="url"
          value={state.link}
          onChange={e => setField('link', e.target.value)}
          placeholder="https://maps.google.com/..."
          className={inputClass(!!errors.link)}
        />
      </FormField>

      <FormField label="カバー画像" error={imageError ?? undefined}>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_TYPES}
          onChange={onFilePicked}
          className="hidden"
        />
        {hasImage ? (
          <div className="flex items-center gap-3 px-2.5 py-2 rounded-input bg-app border border-border">
            <div className="w-12 h-12 rounded-md shrink-0 overflow-hidden bg-tile">
              {previewUrl
                ? <img src={previewUrl} alt="" className="w-full h-full object-cover" draggable={false} />
                : <div className="w-full h-full flex items-center justify-center text-muted"><FileText size={20} strokeWidth={1.6} /></div>}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-ink truncate">{previewName}</div>
              <button
                type="button"
                onClick={pickFile}
                className="text-[11px] text-accent font-medium border-none bg-transparent p-0 cursor-pointer hover:underline"
              >
                画像を変更
              </button>
            </div>
            <button
              type="button"
              onClick={clearImage}
              aria-label="画像を削除"
              className="w-8 h-8 rounded-full flex items-center justify-center bg-app text-muted border-none cursor-pointer hover:bg-border transition-colors shrink-0"
            >
              <XIcon size={14} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={pickFile}
            className="w-full h-[58px] rounded-input border-[1.5px] border-dashed border-border bg-app text-muted text-[12px] font-medium flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Plus size={16} strokeWidth={1.8} />
            <span>画像を追加（任意）</span>
          </button>
        )}
      </FormField>

      {onDelete && (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          className="mt-2 inline-flex items-center justify-center gap-1.5 self-start px-3 py-1.5 rounded-card text-[12px] font-medium text-danger border border-danger/30 bg-transparent cursor-pointer hover:bg-danger/5 transition-colors"
        >
          <Trash2 size={13} strokeWidth={2} />
          このウィッシュを削除
        </button>
      )}

      <ConfirmSheet
        isOpen={confirmDelete}
        title="削除しますか？"
        description="このウィッシュと投票が失われます。"
        confirmLabel="削除する"
        tone="danger"
        onConfirm={() => { setConfirmDelete(false); onDelete?.() }}
        onClose={() => setConfirmDelete(false)}
      />
    </FormModalShell>
  )
}
