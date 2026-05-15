// src/hooks/useOnlineStatus.ts
// 監聽 navigator.onLine 與 online/offline events,讓 UI 能在離線時做出
// 回應(banner / toast / 寫入排隊提示)。
//
// 為什麼這個 hook 自己做 state,不是直接靠 navigator.onLine:
//   - navigator.onLine 是同步值,但 React 不會在它變動時 re-render
//   - 必須訂閱 'online' / 'offline' window event 才能驅動畫面更新
//
// Firestore persistence 本身在離線下能讀,寫入會自動排隊到 IndexedDB,
// 連線恢復時自動 flush。但使用者看不見這個機制 — 他只看到「按了儲存
// 是不是有上去?」沒安全感。這個 hook 是「告知」層,不是「處理」層。
import { useEffect, useState } from 'react'

export function useOnlineStatus(): boolean {
  // navigator 在 SSR / Node 環境不存在(本 app 是 SPA + PWA 不會 SSR,
  // 但守一下 cheap insurance — 同樣讓 unit test 不會因為 jsdom 差異炸)。
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )

  useEffect(() => {
    const goOnline  = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online',  goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online',  goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return online
}
