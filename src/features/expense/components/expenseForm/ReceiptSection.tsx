// src/features/expense/components/expenseForm/ReceiptSection.tsx
// Pure presentational section for the 「レシート」 FormField, split out of
// ExpenseFormModal (item 3 — the form's JSX is extracted into sections; the
// receipt / OCR / attachment STATE stays in the modal and its hooks). This
// component owns only the two hidden <input> refs (local to the picker UI);
// every handler + display value is passed in.
import { useRef, useState, type ChangeEvent } from 'react'
import { AlertTriangle, Camera, Loader2, Plus, ScanLine, Upload } from 'lucide-react'
import FormField from '@/components/ui/FormField'
import AttachmentRow from '@/components/ui/AttachmentRow'
import PickerDialog from '@/components/ui/pickers/PickerDialog'

const IMAGE_ACCEPT = 'image/*'
const ANY_ACCEPT   = 'image/*,application/pdf'

/** OCR 等待中的內嵌提示。給使用者三件事:
 *   1) 還在跑(spinner 動)
 *   2) 跑了多久(N.Ns)→ 比純 spinner 安心,知道沒卡死
 *   3) 慢的時候給原因 / 鼓勵繼續等(8s 後切換文案 + 黃色強調)
 *
 * Worker p99 ~5s,8s 為界把「正常」與「比較慢」分開 — slow 路徑
 * 通常是收據複雜 / line items 多 / 字跡模糊,讓使用者知道沒問題、
 * 不要急著按取消。 */
function OcrLoadingHint({ elapsedMs }: { elapsedMs: number }) {
  const elapsedSec = (elapsedMs / 1000).toFixed(1)
  const slow = elapsedMs > 8_000

  return (
    <div
      className={[
        'flex items-start gap-2 px-3 py-2 rounded-input text-[12px] font-medium',
        slow
          ? 'bg-[#FFF4E0] text-[#B5651D] border border-[#F0D49B]'
          : 'bg-teal-pale text-teal',
      ].join(' ')}
      role="status"
      aria-live="polite"
    >
      <Loader2 size={14} strokeWidth={2.2} className="animate-spin mt-px shrink-0" />
      <div className="flex-1 min-w-0 leading-[1.45]">
        <div className="flex items-center justify-between gap-2">
          <span>
            {slow ? 'もう少しで完了します…' : '明細を読み取り中…'}
          </span>
          <span className="text-[10.5px] tabular-nums opacity-80 shrink-0">
            {elapsedSec}s
          </span>
        </div>
        <div className="text-[10.5px] opacity-75 mt-0.5">
          {slow
            ? '複雑なレシートは少し時間がかかります'
            : 'AI で店名・品目・金額を解析しています'}
        </div>
      </div>
    </div>
  )
}

function ReceiptAddActionSheet({
  isOpen,
  onClose,
  onCamera,
  onUpload,
}: {
  isOpen: boolean
  onClose: () => void
  onCamera: () => void
  onUpload: () => void
}) {
  return (
    <PickerDialog isOpen={isOpen} onClose={onClose} title="レシートを追加" placement="bottom">
      <div className="shrink-0 border-b border-border px-5 pb-3 pt-3">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
        <h3 className="m-0 text-[16px] font-black text-ink">
          レシートを追加
        </h3>
      </div>

      <div className="flex flex-col gap-2 px-5 py-4">
        <button
          type="button"
          onClick={() => {
            onClose()
            onCamera()
          }}
          className="flex w-full items-center gap-3 rounded-input border border-border bg-surface px-3.5 py-3 text-left cursor-pointer transition-colors hover:border-accent hover:bg-teal-pale/50"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-pale text-teal">
            <Camera size={17} strokeWidth={2.2} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-bold text-ink">撮影して読み取る</span>
            <span className="mt-0.5 block text-[11.5px] font-medium leading-[1.45] text-muted">
              カメラで撮影後、自動で明細を読み取ります
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            onClose()
            onUpload()
          }}
          className="flex w-full items-center gap-3 rounded-input border border-border bg-surface px-3.5 py-3 text-left cursor-pointer transition-colors hover:border-accent hover:bg-teal-pale/50"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-app text-muted">
            <Upload size={17} strokeWidth={2.2} />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-bold text-ink">ファイルを添付</span>
            <span className="mt-0.5 block text-[11.5px] font-medium leading-[1.45] text-muted">
              画像 / PDF を追加します。必要なら後で読み取れます
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={onClose}
          className="mt-1 h-11 rounded-input border border-border bg-app text-[13px] font-semibold text-ink cursor-pointer hover:bg-tile transition-colors"
        >
          キャンセル
        </button>
      </div>
    </PickerDialog>
  )
}

interface ReceiptSectionProps {
  /** Receipt error copy (attachment error ?? OCR error). */
  error:          string | undefined
  /** Lines-vs-bill mismatch warning (null when reconciled). Surfaced at
   *  the scan locus so an OCR misread is caught before the user scrolls
   *  to the items; the ✓ reconciled case stays silent (LineItemsSection
   *  owns the live sum-check display). */
  reconcileWarning: string | null
  hasAttachment:  boolean
  attachmentName: string
  previewUrl:     string | null
  previewIsImage: boolean
  ocrLoading:     boolean
  ocrElapsedMs:   number
  /** Manual 「明細を読み取る」 button visible (image attached, not yet OCR'd). */
  canAnalyze:     boolean
  /** 「もう一度読み取る」 link visible (already has items). */
  canReanalyze:   boolean
  canFallback:    boolean
  /** Whether the full preview is openable (a new file or an existing
   *  fullPath) — independent of whether a thumbnail URL resolved. */
  canPreview:     boolean
  onCameraPicked: (e: ChangeEvent<HTMLInputElement>) => void
  onUploadPicked: (e: ChangeEvent<HTMLInputElement>) => void
  onClear:        () => void
  onAnalyze:      () => void
  onFallback:     () => void
  onPreview:      () => void
}

export default function ReceiptSection({
  error, reconcileWarning, hasAttachment, attachmentName, previewUrl, previewIsImage, canPreview,
  ocrLoading, ocrElapsedMs, canAnalyze, canReanalyze,
  canFallback,
  onCameraPicked, onUploadPicked, onClear, onAnalyze, onPreview,
  onFallback,
}: ReceiptSectionProps) {
  // Two separate <input>s — we CAN'T detect "camera vs gallery" from one
  // input, so the UX branches on which button was tapped. Refs are local to
  // this picker UI, so they live here rather than in the modal.
  const cameraRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const [addSheetOpen, setAddSheetOpen] = useState(false)

  return (
    // レシート appears EARLY in the form because OCR auto-fills 金額 + 明細
    // below. Putting it after 金額 would mean the user types an amount only
    // to have OCR overwrite it.
    <FormField label="レシート（任意）" error={error}>
      <input ref={cameraRef} type="file" accept={IMAGE_ACCEPT} capture="environment" onChange={onCameraPicked} className="hidden" />
      <input ref={uploadRef} type="file" accept={ANY_ACCEPT}                          onChange={onUploadPicked} className="hidden" />

      {hasAttachment ? (
        <div className="flex flex-col gap-2">
          <AttachmentRow
            fileName={attachmentName}
            previewUrl={previewUrl}
            isImage={previewIsImage}
            onReplace={() => uploadRef.current?.click()}
            onClear={onClear}
            onPreview={onPreview}
            canPreview={canPreview}
            replaceAriaLabel="レシートを変更"
            previewAriaLabel="レシートを拡大表示"
            clearAriaLabel="レシートを削除"
          />

          {/* Manual read-items button (only when not yet OCR'd). ScanLine
              + "読み取る" reads as scanning a receipt, not AI magic. */}
          {canAnalyze && (
            <button
              type="button"
              onClick={onAnalyze}
              className="w-full h-10 rounded-input bg-teal text-white text-[13px] font-bold border-none cursor-pointer flex items-center justify-center gap-2 transition-all hover:-translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
            >
              <ScanLine size={16} strokeWidth={2.2} />
              明細を読み取る
            </button>
          )}

          {canReanalyze && (
            <button
              type="button"
              onClick={onAnalyze}
              className="flex items-center gap-1 text-[11.5px] text-accent font-medium border-none bg-transparent p-0 cursor-pointer hover:underline self-start"
            >
              <ScanLine size={12} strokeWidth={2} />
              もう一度読み取る
            </button>
          )}

          {canFallback && (
            <button
              type="button"
              onClick={onFallback}
              className="flex items-center gap-1 text-[11.5px] text-muted font-medium border-none bg-transparent p-0 cursor-pointer hover:text-accent hover:underline self-start"
            >
              <ScanLine size={12} strokeWidth={2} />
              別モデルで再読み取り
            </button>
          )}

          {ocrLoading && <OcrLoadingHint elapsedMs={ocrElapsedMs} />}

          {/* Suppress while rescanning so stale residuals don't flash. No
              live region: this derives from amount/items and would otherwise
              announce intermediate residuals on every edit. */}
          {!ocrLoading && reconcileWarning && (
            <div
              className="flex items-start gap-2 rounded-input bg-warn-bg text-warn border border-warn/20 px-3 py-2 text-[11.5px] font-semibold leading-[1.45]"
            >
              <AlertTriangle size={14} strokeWidth={2.2} className="shrink-0 mt-px" />
              <span>{reconcileWarning}</span>
            </div>
          )}

        </div>
      ) : (
        <>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={addSheetOpen}
            onClick={() => setAddSheetOpen(true)}
            className="h-[52px] w-full rounded-input border-[1.5px] border-dashed border-border bg-app text-muted text-[12px] font-semibold flex items-center justify-center gap-2 cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Plus size={16} strokeWidth={2.2} />
            <span>レシートを追加</span>
          </button>
          <ReceiptAddActionSheet
            isOpen={addSheetOpen}
            onClose={() => setAddSheetOpen(false)}
            onCamera={() => cameraRef.current?.click()}
            onUpload={() => uploadRef.current?.click()}
          />
        </>
      )}
    </FormField>
  )
}
