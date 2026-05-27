// src/features/wish/components/WishFormModal.tsx
// Add / edit a wish item. Single optional cover image (vs Journal's
// multi-image gallery — wish items are "is this the place" reference,
// not photo memories). Form state via useReducer; image via the same
// tri-state pattern as bookings.
import { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Wish, WishCategory, WishImage, CreateWishInput } from '@/types'
import FormModalShell from '@/components/ui/FormModalShell'
import FormField from '@/components/ui/FormField'
import DeleteConfirm from '@/components/ui/DeleteConfirm'
import AttachmentRow from '@/components/ui/AttachmentRow'
import { inputClass } from '@/components/ui/inputStyle'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'
import { useImageCropFlow } from '@/hooks/useImageCropFlow'
import { useBlobUrl } from '@/hooks/useBlobUrl'

const ACCEPT_TYPES = 'image/*'
const MAX_FILE_BYTES = 5 * 1024 * 1024

const CATEGORIES: { value: WishCategory; emoji: string; label: string }[] = [
  { value: 'place', emoji: '🗺️', label: '景點' },
  { value: 'food',  emoji: '🍜', label: '餐廳' },
]

// `type` (not `interface`): TS won't widen interfaces to satisfy
// `Record<string, unknown>` since interfaces are open for declaration
// merging. Type aliases are closed and pass useFormReducer's constraint.
type FormState = {
  category:    WishCategory
  title:       string
  description: string
  link:        string
  address:     string
}

function initFromTarget(t: Wish | null, defaultCategory: WishCategory): FormState {
  return {
    category:    t?.category ?? defaultCategory,
    title:       t?.title ?? '',
    description: t?.description ?? '',
    link:        t?.link ?? '',
    address:     t?.address ?? '',
  }
}

type AttachmentChange = File | null | undefined

export interface WishFormResult {
  input:      CreateWishInput
  attachment: AttachmentChange
}

interface Props {
  editTarget: Wish | null
  /** Pre-select this category when adding a new wish. Lets WishPage's
   *  current tab pre-fill the form so users don't have to re-pick. */
  defaultCategory?: WishCategory
  isOpen:     boolean
  isSaving:   boolean
  /** Inline error from the last save attempt — surfaced via FormModalShell
   *  above the SaveButton. Sticks until the next attempt / modal close. */
  saveError?: string | null
  onClose:    () => void
  onSave:     (data: WishFormResult) => void
  /** Only present in edit mode for the proposer. Hidden otherwise. */
  onDelete?:  () => void
}

export default function WishFormModal({
  editTarget, defaultCategory = 'place', isOpen, isSaving, saveError, onClose, onSave, onDelete,
}: Props) {
  const { state, setField } = useFormReducer<FormState>(
    () => initFromTarget(editTarget, defaultCategory),
  )

  // Image state — single optional. Mirror booking's tri-state contract.
  const [existing, setExisting] = useState<WishImage | null>(editTarget?.image ?? null)
  const [newFile,  setNewFile]  = useState<File | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)

  // Blob URL lifecycle (create + auto-revoke) lives in useBlobUrl.
  const newFileBlobUrl = useBlobUrl(newFile)

  const [errors, setErrors] = useState<Record<string, string>>({})

  // Crop flow: picked file lands in the hook's pending slot, dialog
  // shows, and on confirm the cropped File flows back into setNewFile.
  // Wish only accepts images so non-image fallthrough never triggers.
  const crop = useImageCropFlow(setNewFile)

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
    crop.intercept(f)
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
      address:     state.address.trim() || undefined,
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
      saveError={saveError}
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
          placeholder="https://example.com/restaurant"
          className={inputClass(!!errors.link)}
        />
      </FormField>

      <FormField label="住所（任意）">
        {/* Free-text — Google Maps treats the value as a search query so
            anything from "Shibuya Sky" to a full street address resolves.
            No URL formatting required from the user. */}
        <input
          value={state.address}
          onChange={e => setField('address', e.target.value)}
          placeholder="例：東京都港区芝公園 4-2-8"
          maxLength={200}
          className={inputClass(false)}
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
          <AttachmentRow
            fileName={previewName}
            previewUrl={previewUrl}
            isImage={true}
            onReplace={pickFile}
            onClear={clearImage}
            replaceAriaLabel="画像を変更"
            clearAriaLabel="画像を削除"
          />
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

      {editTarget && onDelete && <DeleteConfirm noun="ウィッシュ" onDelete={onDelete} />}

      {crop.dialog}
    </FormModalShell>
  )
}
