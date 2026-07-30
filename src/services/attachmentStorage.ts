import {
  preflightIdToken,
  requireWorkerWriteBase,
  workerFetch,
  WorkerAmbiguous,
  WORKER_FETCH_TIMEOUT_MS,
} from './workerBase'
import { retry } from '@/utils/retry'

const TRIP_ID_RE = /^[A-Za-z0-9_-]{1,60}$/
const ATTACHMENT_TRIP_HEADER = 'X-Attachment-Trip-Id'
const ATTACHMENT_PATH_HEADER = 'X-Attachment-Path'

class AttachmentFetchError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`attachment-content -> ${status}`)
    this.name = 'AttachmentFetchError'
    this.status = status
  }
}

function isTransientAttachmentError(error: unknown): boolean {
  // 429 is intentionally terminal: immediate retries without scheduling from
  // Retry-After would amplify the rate limit instead of allowing recovery.
  if (error instanceof AttachmentFetchError) return error.status >= 500
  if (error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError'
  }
  return error instanceof TypeError
}

export function tripIdFromAttachmentPath(path: string): string {
  const parts = path.split('/')
  if (
    parts.length !== 5
    || parts[0] !== 'trips'
    || !TRIP_ID_RE.test(parts[1] ?? '')
    || !(parts[2] === 'expenses' || parts[2] === 'bookings' || parts[2] === 'wishes')
    || !TRIP_ID_RE.test(parts[3] ?? '')
    || !parts[4]
  ) {
    throw new Error('invalid attachment path')
  }
  return parts[1]!
}

export async function fetchAttachmentBlob(path: string): Promise<Blob | null> {
  const tripId = tripIdFromAttachmentPath(path)
  const base = requireWorkerWriteBase()
  const token = await preflightIdToken()
  const url = new URL(`${base}/attachment-content`)
  return retry(
    async () => {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          [ATTACHMENT_TRIP_HEADER]: tripId,
          [ATTACHMENT_PATH_HEADER]: path,
        },
        signal: AbortSignal.timeout(WORKER_FETCH_TIMEOUT_MS),
      })
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new AttachmentFetchError(response.status)
      }
      return response.blob()
    },
    { shouldRetry: isTransientAttachmentError },
  )
}

/** Delete is idempotent, so an ambiguous response is safe to retry. */
export async function deleteAttachmentObject(path: string): Promise<void> {
  const tripId = tripIdFromAttachmentPath(path)
  const base = requireWorkerWriteBase()
  const token = await preflightIdToken()
  await retry(
    async () => {
      await workerFetch(base, token, '/attachment-delete', { tripId, path })
    },
    { shouldRetry: error => error instanceof WorkerAmbiguous },
  )
}
