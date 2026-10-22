// src/hooks/draftModalRegistry.ts
// 「目前是否有帶草稿的表單開著」的唯讀登記處。給不在表單樹內、卻可能把頁面
// 換掉的流程使用（例如通知點擊 → 切旅程 / 換路由會卸載整個表單，草稿就沒了）。
//
// 刻意只有計數、沒有 subscribe：讀取端只在決策當下問一次，不需要因為表單
// 開關而重新渲染。登記由 FormModalShell 統一負責（涵蓋 5 個 entity form 與
// SettlementRecordSheet）；不走 FormModalShell 的草稿表單自行呼叫
// `useRegisterDraftModal(isOpen)`。
import { useEffect } from 'react'

let openCount = 0

/** 登記一個開著的草稿表單；回傳的解除函式可重複呼叫（只生效一次）。 */
export function registerOpenDraftModal(): () => void {
  openCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    openCount -= 1
  }
}

export function isAnyDraftModalOpen(): boolean {
  return openCount > 0
}

/** 表單開著期間登記；關閉或卸載時自動解除。 */
export function useRegisterDraftModal(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return
    return registerOpenDraftModal()
  }, [isOpen])
}
