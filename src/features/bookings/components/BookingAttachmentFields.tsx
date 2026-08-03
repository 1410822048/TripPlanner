// src/features/bookings/components/BookingAttachmentFields.tsx
// The two attachment slots on a booking: the hotel cover image (hotels
// only — it's what the card renders) and the confirmation document, which
// takes a PDF or an image and doubles as the PDF-autofill source.
//
// Presentational. The hidden file inputs stay with the form so no ref
// crosses this boundary; picking is a callback.
import { Image as ImageIcon, Paperclip } from 'lucide-react'
import AttachmentRow from '@/components/ui/AttachmentRow'
import FormField from '@/components/ui/FormField'
import type { UseAttachmentResult } from '@/hooks/useAttachment'

export default function BookingAttachmentFields({
  coverAtt, docAtt, showCover, onPickCover, onPickDocument, onPreview, onClearDocument,
}: {
  coverAtt:  UseAttachmentResult
  docAtt:    UseAttachmentResult
  /** Cover image is a hotel-only field. */
  showCover: boolean
  onPickCover:     () => void
  onPickDocument:  () => void
  onPreview:       (target: 'cover' | 'document') => void
  /** Clearing the document also discards its PDF analysis. */
  onClearDocument: () => void
}) {
  return (
    <>
      {showCover && (
        <FormField label="封面圖片" error={coverAtt.error ?? undefined}>
          {coverAtt.hasAttachment ? (
            <div className="overflow-hidden rounded-card border border-border bg-surface">
              <button
                type="button"
                onClick={() => (coverAtt.hasNewFile || coverAtt.fullPath) && onPreview('cover')}
                disabled={!coverAtt.hasNewFile && !coverAtt.fullPath}
                className="relative block h-[154px] w-full overflow-hidden border-0 bg-tile p-0 text-left cursor-pointer disabled:cursor-default"
                aria-label="顯示封面圖片"
              >
                {coverAtt.previewUrl ? (
                  <img
                    src={coverAtt.previewUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted">
                    <ImageIcon size={28} strokeWidth={1.7} />
                    <span className="text-[12px] font-bold">封面圖片</span>
                  </div>
                )}
              </button>
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                <span className="min-w-0 truncate text-[12px] font-bold text-ink">
                  {coverAtt.hasNewFile ? coverAtt.attachmentName : '封面圖片'}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={onPickCover}
                    className="h-11 min-w-14 rounded-chip border border-border bg-surface px-3 text-[11.5px] font-bold text-muted"
                  >
                    更換
                  </button>
                  <button
                    type="button"
                    onClick={coverAtt.clear}
                    className="h-11 min-w-14 rounded-chip border border-danger-soft bg-danger-pale px-3 text-[11.5px] font-bold text-danger"
                  >
                    刪除
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={onPickCover}
              className="w-full h-[132px] rounded-card border-[1.5px] border-dashed border-border bg-app text-muted text-[12px] font-medium flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-accent hover:text-accent transition-colors"
            >
              <ImageIcon size={22} strokeWidth={1.7} />
              <span>新增飯店卡片圖片</span>
            </button>
          )}
        </FormField>
      )}

      <FormField label="訂單確認文件（PDF / 圖片）" error={docAtt.error ?? undefined}>
        {docAtt.hasAttachment ? (
          <AttachmentRow
            fileName={docAtt.attachmentName}
            previewUrl={docAtt.previewUrl}
            isImage={docAtt.previewIsImage}
            onReplace={onPickDocument}
            onClear={onClearDocument}
            onPreview={() => (docAtt.hasNewFile || docAtt.fullPath) && onPreview('document')}
            canPreview={docAtt.hasNewFile || !!docAtt.fullPath}
            replaceAriaLabel="更換檔案"
            previewAriaLabel="顯示附件"
            clearAriaLabel="刪除附件"
          />
        ) : (
          <button
            type="button"
            onClick={onPickDocument}
            className="w-full h-[58px] rounded-input border-[1.5px] border-dashed border-border bg-app text-muted text-[12px] font-medium flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Paperclip size={16} strokeWidth={1.8} />
            <span>上傳確認文件</span>
          </button>
        )}
      </FormField>
    </>
  )
}
