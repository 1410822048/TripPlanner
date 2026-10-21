// src/components/ui/PendingIndicator.tsx
// Spinner + label for a row whose write is still in flight (overlay op
// pending)。三個 list row（expense / booking / wish）共用,文字依連線狀態切換:
//   線上  → 儲存中…    寫入正在飛行,等 server 回音
//   離線  → 等待連線   寫入已排隊(SDK 佇列或暫停中的 Worker 寫入),恢復連線才會送出
// 沒有「儲存中」卻永遠轉圈的狀態 —— 離線時說「儲存中」是謊言。
import { Loader2 } from 'lucide-react'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'

interface Props {
  size?:        number
  strokeWidth?: number
}

export default function PendingIndicator({ size = 11, strokeWidth = 2.4 }: Props) {
  const online = useOnlineStatus()
  return (
    <>
      <Loader2 size={size} strokeWidth={strokeWidth} className="animate-spin shrink-0" />
      <span>{online ? '儲存中…' : '等待連線'}</span>
    </>
  )
}
