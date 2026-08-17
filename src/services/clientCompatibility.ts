// Client-side write compatibility contract for installed PWA bundles.
//
// The manifest is deliberately fetched out-of-band by PwaUpdateProvider.
// Mutation paths only read this in-memory snapshot synchronously; allowing a
// network request here would destroy the immediate optimistic interaction.

/** Bump whenever a deployed bundle stops being able to produce a valid
 *  write — a new mandatory request field, a changed wire contract, a
 *  removed endpoint. Raising the manifest's `minimumWriteEpoch` past an
 *  installed bundle's value is the ONLY thing that stops it writing;
 *  shipping Pages does not evict a Service Worker already on a device.
 *
 *  Epoch 2: `/expense-update` requires `expectedCurrentReceiptPath` on
 *  receipt-touching writes, which epoch-1 bundles never send. */
export const CLIENT_SCHEMA_EPOCH = 2 as const
export const CLIENT_COMPATIBILITY_STORAGE_KEY = 'tripmate:client-compatibility:v1'

const MANIFEST_URL = '/compatibility.json'
const MAX_MANIFEST_BYTES = 1_024
const FETCH_TIMEOUT_MS = 5_000
const UPDATE_REQUIRED_MESSAGE = '請先更新 App 才能儲存'
/** Empty-state wording for the same condition. Separate from the message
 *  above because an empty list is explaining why the add button is missing,
 *  not why a save was refused — and it must not be mistaken for the
 *  role-based 「你目前以檢視者身分加入」 copy. */
export const UPDATE_REQUIRED_EMPTY_STATE = '此版本已停止寫入，更新 App 後即可繼續新增。'

export interface CompatibilityManifest {
  revision: number
  minimumWriteEpoch: number
}

export interface ClientCompatibilitySnapshot {
  manifest: CompatibilityManifest | null
  updateRequired: boolean
}

export class CompatibilityManifestError extends Error {
  override name = 'CompatibilityManifestError'
}

export class UpdateRequiredError extends Error {
  override name = 'UpdateRequiredError'

  constructor() {
    super(UPDATE_REQUIRED_MESSAGE)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function parseCompatibilityManifest(value: unknown): CompatibilityManifest {
  if (!isRecord(value)) {
    throw new CompatibilityManifestError('相容性設定必須是 JSON object')
  }

  // Unknown fields are deliberately tolerated: this parser ships inside every
  // deployed bundle, so adding a manifest field later must not break older
  // clients' ability to read minimumWriteEpoch — rejecting unknown keys would
  // permanently fail-open every already-installed PWA. Only the two decision
  // fields are validated and projected; repo-side strictness lives in
  // scripts/check-client-compatibility.mjs.
  if (!isEpoch(value.revision) || !isEpoch(value.minimumWriteEpoch)) {
    throw new CompatibilityManifestError('相容性版本必須是非負安全整數')
  }

  return {
    revision: value.revision,
    minimumWriteEpoch: value.minimumWriteEpoch,
  }
}

function readStoredManifest(): CompatibilityManifest | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CLIENT_COMPATIBILITY_STORAGE_KEY)
    if (!raw) return null
    return parseCompatibilityManifest(JSON.parse(raw) as unknown)
  } catch {
    // Corrupt or inaccessible storage is an unknown state, which is fail-open.
    // Firestore Rules / Worker validation remain the authoritative boundary.
    return null
  }
}

function snapshotFor(manifest: CompatibilityManifest | null): ClientCompatibilitySnapshot {
  return Object.freeze({
    manifest,
    updateRequired: manifest !== null && CLIENT_SCHEMA_EPOCH < manifest.minimumWriteEpoch,
  })
}

let snapshot = snapshotFor(readStoredManifest())
let refreshInFlight: Promise<ClientCompatibilitySnapshot> | null = null
const listeners = new Set<() => void>()

function publish(nextManifest: CompatibilityManifest, persist: boolean): ClientCompatibilitySnapshot {
  const current = snapshot.manifest
  if (current) {
    if (nextManifest.revision < current.revision) return snapshot
    if (nextManifest.revision === current.revision) {
      if (nextManifest.minimumWriteEpoch !== current.minimumWriteEpoch) {
        throw new CompatibilityManifestError('相同 revision 不得改變 minimumWriteEpoch')
      }
      return snapshot
    }
  }

  snapshot = snapshotFor(Object.freeze({ ...nextManifest }))
  if (persist && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        CLIENT_COMPATIBILITY_STORAGE_KEY,
        JSON.stringify(nextManifest),
      )
    } catch {
      // The in-memory decision is still valid. Storage is only cross-session
      // resilience, not an authorization boundary.
    }
  }
  for (const listener of listeners) listener()
  return snapshot
}

export function getClientCompatibilitySnapshot(): ClientCompatibilitySnapshot {
  return snapshot
}

export function subscribeClientCompatibility(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function syncClientCompatibilityFromStorage(raw: string | null): void {
  // Clearing storage in another tab must not forget a cutoff that this tab
  // already confirmed. A newer revision can still lower the minimum for an
  // intentional emergency rollback.
  if (raw === null) return
  publish(parseCompatibilityManifest(JSON.parse(raw) as unknown), false)
}

async function fetchCompatibilityManifest(): Promise<CompatibilityManifest> {
  const response = await fetch(MANIFEST_URL, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new CompatibilityManifestError(`相容性設定讀取失敗 (${response.status})`)
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) {
    throw new CompatibilityManifestError('相容性設定不是 JSON response')
  }

  const body = await response.text()
  if (body.length > MAX_MANIFEST_BYTES) {
    throw new CompatibilityManifestError('相容性設定超過大小上限')
  }
  try {
    return parseCompatibilityManifest(JSON.parse(body) as unknown)
  } catch (error) {
    if (error instanceof CompatibilityManifestError) throw error
    throw new CompatibilityManifestError('相容性設定不是合法 JSON', { cause: error })
  }
}

export function refreshClientCompatibility(): Promise<ClientCompatibilitySnapshot> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = fetchCompatibilityManifest()
    .then(manifest => publish(manifest, true))
    .finally(() => { refreshInFlight = null })
  return refreshInFlight
}

export function getClientWriteBlockReason(): string | null {
  return snapshot.updateRequired ? UPDATE_REQUIRED_MESSAGE : null
}

export function assertClientWriteCompatible(): void {
  if (snapshot.updateRequired) throw new UpdateRequiredError()
}

export function isUpdateRequiredError(error: unknown): error is UpdateRequiredError {
  return error instanceof UpdateRequiredError
    || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'UpdateRequiredError')
}
