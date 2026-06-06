// src/features/expense/components/expenseForm/ReceiptSection.tsx
// Pure presentational section for the 「レシート」 FormField, split out of
// ExpenseFormModal (item 3 — the form's JSX is extracted into sections; the
// receipt / OCR / attachment STATE stays in the modal and its hooks). This
// component owns only the two hidden <input> refs (local to the picker UI);
// every handler + display value is passed in.
import { useRef, type ChangeEvent } from 'react'
import { Camera, Loader2, ScanLine, Upload } from 'lucide-react'
import FormField from '@/components/ui/FormField'
import AttachmentRow from '@/components/ui/AttachmentRow'

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
            : 'Gemini で店名・品目・金額を解析しています'}
        </div>
      </div>
    </div>
  )
}

interface ReceiptSectionProps {
  /** Receipt error copy (attachment error ?? OCR error). */
  error:          string | undefined
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
  onCameraPicked: (e: ChangeEvent<HTMLInputElement>) => void
  onUploadPicked: (e: ChangeEvent<HTMLInputElement>) => void
  onClear:        () => void
  onAnalyze:      () => void
  onPreview:      () => void
}

export default function ReceiptSection({
  error, hasAttachment, attachmentName, previewUrl, previewIsImage,
  ocrLoading, ocrElapsedMs, canAnalyze, canReanalyze,
  onCameraPicked, onUploadPicked, onClear, onAnalyze, onPreview,
}: ReceiptSectionProps) {
  // Two separate <input>s — we CAN'T detect "camera vs gallery" from one
  // input, so the UX branches on which button was tapped. Refs are local to
  // this picker UI, so they live here rather than in the modal.
  const cameraRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

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

          {ocrLoading && <OcrLoadingHint elapsedMs={ocrElapsedMs} />}
        </div>
      ) : (
        // Compact dual-button (52px instead of 68px). Receipt is an optional
        // add-on, not a hero action — the previous chunky empty state pulled
        // too much attention from the rest of the form.
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            className="h-[52px] rounded-input border-[1.5px] border-dashed border-border bg-app text-muted text-[11.5px] font-medium flex items-center justify-center gap-1.5 cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Camera size={16} strokeWidth={1.8} />
            <span>撮影</span>
          </button>
          <button
            type="button"
            onClick={() => uploadRef.current?.click()}
            className="h-[52px] rounded-input border-[1.5px] border-dashed border-border bg-app text-muted text-[11.5px] font-medium flex items-center justify-center gap-1.5 cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Upload size={15} strokeWidth={1.8} />
            <span>ファイルから追加</span>
          </button>
        </div>
      )}
    </FormField>
  )
}
