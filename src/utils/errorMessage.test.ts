import { describe, expect, it } from 'vitest'
import { userErrorMessage } from './errorMessage'

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
})
