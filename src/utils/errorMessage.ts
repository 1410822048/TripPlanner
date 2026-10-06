// src/utils/errorMessage.ts
// Turn a thrown error into user-facing 繁中 copy.
//
// Firebase errors carry English SDK messages ("Missing or insufficient
// permissions.", "Failed to get document because the client is offline.")
// that used to be shown verbatim in toasts and form banners. Worse,
// `permission-denied` is also what a rules VALIDATION failure looks like
// (e.g. an over-long field), so "permissions" misled users who did have
// access. Known codes map to Chinese; anything else keeps its own message
// (our own thrown errors are already written for users).

const FIRESTORE_CODES: Record<string, string> = {
  'permission-denied':   '資料未通過伺服器驗證，或你沒有這項操作的權限',
  'unauthenticated':     '登入狀態已失效，請重新登入',
  'unavailable':         '目前無法連線到伺服器，請確認網路後再試',
  'deadline-exceeded':   '伺服器回應逾時，請稍後再試',
  'resource-exhausted':  '操作過於頻繁，請稍後再試',
  'not-found':           '資料已不存在，可能已被其他成員刪除',
  'already-exists':      '資料已存在',
  'failed-precondition': '資料已被其他成員更新，請重新整理後再試',
  'aborted':             '資料同時被其他成員修改，請再試一次',
  'cancelled':           '操作已取消',
}

const AUTH_CODES: Record<string, string> = {
  'auth/network-request-failed': '網路連線失敗，請確認網路後再試',
  'auth/too-many-requests':      '嘗試次數過多，請稍後再試',
  'auth/user-disabled':          '此帳號已被停用',
  'auth/popup-blocked':          '瀏覽器封鎖了登入視窗，請允許彈出視窗後再試',
  'auth/internal-error':         '登入時發生錯誤，請再試一次',
}

/** Error code of a Firebase error (Firestore: `permission-denied`; Auth:
 *  `auth/...`), or undefined for anything else. Duck-typed so it works
 *  without importing the SDK. */
function firebaseCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const { code, name } = err as { code?: unknown; name?: unknown }
  if (typeof code !== 'string') return undefined
  if (name === 'FirebaseError' || code.startsWith('auth/') || code in FIRESTORE_CODES) return code
  return undefined
}

export function userErrorMessage(err: unknown, fallback: string): string {
  const code = firebaseCode(err)
  if (code) {
    const mapped = FIRESTORE_CODES[code] ?? AUTH_CODES[code]
    if (mapped) return mapped
  }
  if (err instanceof Error && err.message) return err.message
  return fallback
}
