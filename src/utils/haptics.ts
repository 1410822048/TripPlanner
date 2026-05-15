// src/utils/haptics.ts
// 觸感回饋封裝。Android Chrome / Edge 支援 `navigator.vibrate`,
// iOS Safari(含 PWA standalone)目前完全不支援 — 我們不繞、不裝懂,
// 不支援的環境直接 noop。
//
// 為何不曝露 raw vibrate(pattern):
//   - 全 app 用三種強度就夠:light(滑開、投票、保存)、medium(刪除
//     確認)、success(完成大動作)— 集中收斂避免散落各處用奇怪的數
//     字。
//   - 之後要全域關閉(例如使用者設定 toggle)只要改這支檔。
//
// reduced-motion 怎麼處理:刻意「不」也 gate haptic — 觸感跟視覺動畫
// 是兩個獨立的無障礙需求,有些使用者開了 reduced-motion 反而更依賴
// 觸覺定位。要 opt-out 該另外做設定,不能跟 motion 綁。

export type HapticStrength = 'light' | 'medium' | 'success'

const PATTERN: Record<HapticStrength, number | number[]> = {
  light:   8,           // swipe latch / vote / save tap
  medium:  18,          // 第一段刪除確認(露出 "確認削除" 紅字時)
  success: [12, 40, 12], // 完成大動作(刪除成功 / OCR 完成)
}

export function haptic(strength: HapticStrength = 'light'): void {
  if (typeof navigator === 'undefined') return
  // 用 'in' check 而非 truthy — 某些瀏覽器有 navigator.vibrate 但回傳
  // false 表示拒絕(無視窗 focus / 權限 deny),這時呼叫也無害。
  if (!('vibrate' in navigator)) return
  try {
    navigator.vibrate(PATTERN[strength])
  } catch {
    // 任何例外 swallow — haptic 是 nice-to-have,不該擋住其他邏輯。
  }
}
