// Shared by the window and the service worker. The SW cannot read
// localStorage, so push delivery ownership lives in IndexedDB.
const DB_NAME = 'tripmate-push-owner'
const DB_VERSION = 1
const STORE_NAME = 'state'
const CURRENT_KEY = 'current'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise

  const idb = globalThis.indexedDB ?? null
  if (!idb) return Promise.resolve(null)

  dbPromise = new Promise(resolve => {
    let settled = false
    const finish = (db: IDBDatabase | null) => {
      if (settled) return
      settled = true
      if (!db) dbPromise = null
      resolve(db)
    }

    const request = idb.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => {
      const db = request.result
      if (settled) {
        db.close()
        return
      }
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      finish(db)
    }
    request.onerror = () => finish(null)
    request.onblocked = () => finish(null)
  })

  return dbPromise
}

export async function readPushOwnerUid(): Promise<string | null> {
  const db = await openDb()
  if (!db) return null

  try {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(CURRENT_KEY)
    const uid = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
    })
    return typeof uid === 'string' && uid.length > 0 ? uid : null
  } catch {
    return null
  }
}

export async function writePushOwnerUid(uid: string | null): Promise<void> {
  const db = await openDb()
  if (!db) return

  try {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(uid, CURRENT_KEY)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'))
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
    })
  } catch {
    // Non-fatal: push display gate falls back to "no current owner".
  }
}
