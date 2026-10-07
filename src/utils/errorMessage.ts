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

// Worker rejections carry the Worker's own message, which is English and
// written for logs (and once carried raw uids). Stable `code`s map first,
// then a few known messages, then the HTTP status. A message that is
// already Chinese was written for users and is kept.
const WORKER_CODES: Record<string, string> = {
  PAIR_LEDGER_TOO_LARGE:      '這兩位成員之間的費用或清算筆數超過系統可計算的上限，無法自動清算',
  SETTLEMENT_STALE:           '欠款金額已有變動，請重新開啟清算後再試',
  LEDGER_CURRENCY_MISMATCH:   '帳本中有以其他幣別記錄的費用，請聯絡旅程擁有者修正',
  TX_RETRY_EXHAUSTED:         '資料同時被其他成員修改，請再試一次',
  FX_PROVIDER_UNAVAILABLE:    '匯率服務暫時無法使用，請稍後再試',
  FX_PROVIDER_REJECTED:       '匯率服務無法提供這個幣別或日期的匯率',
  FX_FUTURE_DATE_UNSUPPORTED: '無法取得未來日期的匯率',
  FX_INVALID_CURRENCY:        '不支援這個幣別的匯率換算',
  FX_INVALID_DATE:            '日期格式不正確',
  ROUTE_PROVIDER_ERROR:       '路線服務暫時無法使用，請稍後再試',
}

const WORKER_MESSAGES: Array<[RegExp, string]> = [
  [/trip is being deleted/i,        '這趟旅程正在刪除中'],
  [/invite expired/i,               '此邀請連結已過期'],
  [/invite not found/i,             '此邀請連結已失效，請向擁有者索取新連結'],
  [/invite token is stale/i,        '已有更新的邀請連結，請重新整理後再試'],
  [/member is being removed|caller is being removed/i, '你已被移出這趟旅程'],
  [/target is being removed/i,      '這位成員正在被移出旅程'],
  [/intent .*expired/i,             '上傳逾時，請重新選擇檔案'],
  [/no remaining debt/i,            '這筆欠款已經結清，請重新整理後確認'],
  [/tombstoned expense/i,           '這筆費用已被刪除'],
  [/already exists at this id/i,    '資料已存在，請重新整理後確認'],
  [/only the receiver may record/i, '只有收款人可以記錄這筆清算'],
]

const WORKER_STATUS: Record<number, string> = {
  400: '資料未通過伺服器驗證，請檢查輸入內容',
  401: '登入狀態已失效，請重新登入',
  403: '你沒有這項操作的權限',
  404: '資料已不存在，可能已被其他成員刪除',
  409: '資料已被其他成員更新，請重新整理後再試',
  410: '資料已失效，請重新整理後再試',
  413: '內容或檔案太大',
  415: '不支援這個檔案格式',
  429: '操作過於頻繁，請稍後再試',
}

const HAS_CJK = /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/

function workerRejectionMessage(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const { name, status, code, message } = err as {
    name?: unknown; status?: unknown; code?: unknown; message?: unknown
  }
  if (name !== 'WorkerRejected' || typeof status !== 'number') return undefined
  if (typeof code === 'string' && WORKER_CODES[code]) return WORKER_CODES[code]
  const text = typeof message === 'string' ? message : ''
  if (text && HAS_CJK.test(text)) return text
  for (const [pattern, copy] of WORKER_MESSAGES) {
    if (pattern.test(text)) return copy
  }
  return WORKER_STATUS[status] ?? '伺服器暫時無法處理，請稍後再試'
}

export function userErrorMessage(err: unknown, fallback: string): string {
  const code = firebaseCode(err)
  if (code) {
    const mapped = FIRESTORE_CODES[code] ?? AUTH_CODES[code]
    if (mapped) return mapped
  }
  const worker = workerRejectionMessage(err)
  if (worker) return worker
  if (err instanceof Error && err.message) return err.message
  return fallback
}
