import { describe, expect, it } from 'vitest'
import { userErrorMessage } from './errorMessage'
import { WorkerRejected } from '@/services/workerBase'

function firebaseError(code: string, message: string) {
  return Object.assign(new Error(message), { name: 'FirebaseError', code })
}

describe('userErrorMessage', () => {
  it('maps Firestore codes to Chinese instead of the English SDK message', () => {
    expect(userErrorMessage(firebaseError('permission-denied', 'Missing or insufficient permissions.'), 'x'))
      .toBe('資料未通過伺服器驗證，或你沒有這項操作的權限')
    expect(userErrorMessage(firebaseError('unavailable', 'Failed to get document because the client is offline.'), 'x'))
      .toBe('目前無法連線到伺服器，請確認網路後再試')
  })

  it('maps known auth codes', () => {
    expect(userErrorMessage(firebaseError('auth/network-request-failed', 'Firebase: Error (auth/network-request-failed).'), 'x'))
      .toBe('網路連線失敗，請確認網路後再試')
  })

  it('keeps our own error messages and falls back for non-errors', () => {
    expect(userErrorMessage(new Error('結束日期不可早於開始日期'), 'x')).toBe('結束日期不可早於開始日期')
    expect(userErrorMessage('boom', '儲存失敗')).toBe('儲存失敗')
    expect(userErrorMessage(firebaseError('auth/some-new-code', 'Firebase: raw'), 'x')).toBe('Firebase: raw')
  })

  it('never shows a Worker rejection\'s English log text', () => {
    expect(userErrorMessage(new WorkerRejected(409, 'settlement suggestion is stale; refresh balances and retry', 'SETTLEMENT_STALE'), 'x'))
      .toBe('欠款金額已有變動，請重新開啟清算後再試')
    expect(userErrorMessage(new WorkerRejected(409, 'too many expenses for this pair to compute remaining safely', 'PAIR_LEDGER_TOO_LARGE'), 'x'))
      .toContain('上限')
    expect(userErrorMessage(new WorkerRejected(400, 'fromUid: no remaining debt from uid-a to uid-b', undefined, 'fromUid'), 'x'))
      .toBe('這筆欠款已經結清，請重新整理後確認')
    expect(userErrorMessage(new WorkerRejected(403, 'caller is not a trip member'), 'x')).toBe('你沒有這項操作的權限')
    expect(userErrorMessage(new WorkerRejected(502, 'upstream', 'SOMETHING_NEW'), 'x')).toBe('伺服器暫時無法處理，請稍後再試')
  })

  it('tells invite and upload expiry apart from a deleting trip', () => {
    expect(userErrorMessage(new WorkerRejected(410, 'invite expired'), 'x')).toBe('此邀請連結已過期')
    expect(userErrorMessage(new WorkerRejected(404, 'invite not found'), 'x')).toBe('此邀請連結已失效，請向擁有者索取新連結')
    expect(userErrorMessage(new WorkerRejected(410, 'trip is being deleted'), 'x')).toBe('這趟旅程正在刪除中')
    expect(userErrorMessage(new WorkerRejected(410, 'intent abc expired'), 'x')).toBe('上傳逾時，請重新選擇檔案')
    expect(userErrorMessage(new WorkerRejected(410, 'something else'), 'x')).toBe('資料已失效，請重新整理後再試')
  })

  it('keeps a Worker message that is already written in Chinese', () => {
    expect(userErrorMessage(new WorkerRejected(409, '附件仍被使用，請先透過原項目的編輯流程移除或替換附件'), 'x'))
      .toBe('附件仍被使用，請先透過原項目的編輯流程移除或替換附件')
  })
})
