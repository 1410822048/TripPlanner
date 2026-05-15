// src/components/ui/OfflineBanner.tsx
// 離線提示細條。離線時黃色 amber banner;從離線恢復後 2 秒內顯示綠
// 色「同期しました」短暫提示讓使用者放心。
//
// 為何接在 main 內(scroll 容器內)而不是 fixed:
//   - fixed 蓋在 page 上方會擋內容
//   - 接在 main 頂部 → 跟頁面一起捲,進入 page 時必看到一次,使用者
//     滑下去不用一直擋,回到頂部又會看到 — 自動 surface 但不打擾
//   - 同步成功的綠條只露 2 秒就消失,不會永久佔位
//
// 為何不用 toast:toast 在底部 + 4 秒自動消失,離線狀態是「持續事實」
// 不該自動消失。需要的是一個可被忽略但持續存在的 status surface。
import { useEffect, useState } from 'react'
import { WifiOff, CheckCircle2 } from 'lucide-react'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'

const RECOVERY_MS = 2_000

export default function OfflineBanner() {
  const online = useOnlineStatus()
  // 「剛從離線回來」短暫提示。online → false → true 的轉折時亮起 2 秒。
  const [justRecovered, setJustRecovered] = useState(false)
  // 用 ref 替代 effect 內 prev — React Compiler 友善,且這裡語意就是
  // 「上一個 render 值」,純檢測 transition 不算副作用。
  const [wasOffline, setWasOffline] = useState(false)

  if (online && wasOffline && !justRecovered) {
    setWasOffline(false)
    setJustRecovered(true)
  } else if (!online && !wasOffline) {
    setWasOffline(true)
  }

  useEffect(() => {
    if (!justRecovered) return
    const t = window.setTimeout(() => setJustRecovered(false), RECOVERY_MS)
    return () => window.clearTimeout(t)
  }, [justRecovered])

  if (online && !justRecovered) return null

  if (!online) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#FFF4E0] text-[#B5651D] border-b border-[#F0D49B] text-[11.5px] font-medium"
      >
        <WifiOff size={12} strokeWidth={2.2} className="shrink-0" />
        <span>オフライン — 変更は接続後に同期されます</span>
      </div>
    )
  }

  // online && justRecovered
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-teal-pale text-teal border-b border-teal/20 text-[11.5px] font-medium"
    >
      <CheckCircle2 size={12} strokeWidth={2.2} className="shrink-0" />
      <span>同期しました</span>
    </div>
  )
}
