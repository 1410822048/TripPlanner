import { getAdminToken } from './admin'
import { readString, type FsValue } from './firestore'
import { requireTripMember } from './membership-shared'
import { docResourceName, runFirestoreTransaction, type TxReadDoc, type TxWrite } from './firestore-tx'
import { routeScheduleFingerprint, scheduleFromDoc, type RouteSchedule } from './route-preview'
import { verifyPreviewToken, stableHash } from './route-security'
import type { RouteApplyRequest, RouteApplyStatusRequest } from './route-schema'

export class RouteApplyError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'RouteApplyError'
    this.status = status
    this.code = code
  }
}

function encodeString(value: string): FsValue {
  return { stringValue: value }
}

function encodeInteger(value: number): FsValue {
  return { integerValue: String(value) }
}

function routeApplyErrorCatcher(error: unknown): { log: string; body: unknown; status: number; precommit?: boolean } | null {
  return error instanceof RouteApplyError
    ? { log: `${error.code}: ${error.message}`, body: { error: error.message, code: error.code }, status: error.status, precommit: true }
    : null
}

function assertRouteMemberActive(member: TxReadDoc): void {
  if ('removingAt' in member.fields) {
    throw new RouteApplyError(403, 'FORBIDDEN', 'caller is leaving the trip')
  }
}

export { routeApplyErrorCatcher }

export async function applyRoute(
  uid: string,
  input: RouteApplyRequest,
  serviceAccountJson: string,
  projectId: string,
  previewSecret: string | undefined,
): Promise<{ status: 'applied' | 'already_applied'; revision: string }> {
  if (!previewSecret) throw new RouteApplyError(503, 'ROUTE_NOT_CONFIGURED', 'preview signing is not configured')
  let claims: Awaited<ReturnType<typeof verifyPreviewToken>>
  try {
    claims = await verifyPreviewToken(input.previewToken, previewSecret)
  } catch {
    // Token parsing/signature/expiry failures are client-auth errors, not
    // internal failures. Keep the reason generic so HMAC details never leak.
    throw new RouteApplyError(401, 'PREVIEW_TOKEN_INVALID', 'preview token is invalid or expired')
  }
  if (claims.uid !== uid || claims.tripId !== input.tripId || claims.revision !== input.revision) {
    throw new RouteApplyError(403, 'PREVIEW_ACTOR_MISMATCH', 'preview token does not belong to this actor')
  }
  const payloadHash = await stableHash({ revision: input.revision, date: input.date, schedules: input.schedules })
  if (claims.payloadHash !== payloadHash) {
    throw new RouteApplyError(409, 'PREVIEW_PAYLOAD_MISMATCH', 'preview payload does not match the signed preview')
  }
  const accessToken = await getAdminToken(serviceAccountJson)
  return runFirestoreTransaction<{ status: 'applied' | 'already_applied'; revision: string }>(accessToken, projectId, async tx => {
    const { member } = await requireTripMember(tx, input.tripId, uid)
    assertRouteMemberActive(member)
    const role = readString(member.fields, 'role')
    if (role !== 'owner' && role !== 'editor') throw new RouteApplyError(403, 'FORBIDDEN', 'editor permission is required')

    const receiptPath = `trips/${input.tripId}/routeApplications/${input.revision}`
    const receipt = await tx.get(receiptPath)
    if (receipt.exists) {
      const previousPayload = readString(receipt.fields, 'payloadHash')
      const previousActor = readString(receipt.fields, 'actorUid')
      if (previousPayload === payloadHash && previousActor === uid) {
        return { writes: [], result: { status: 'already_applied' as const, revision: input.revision } }
      }
      throw new RouteApplyError(409, 'REVISION_CONFLICT', 'revision was already used with a different payload')
    }

    const allDocs = await tx.runQuery({
      parent: `trips/${input.tripId}`,
      collection: 'schedules',
      filters: [{ fieldPath: 'date', op: 'EQUAL', value: { stringValue: input.date } }],
      orderBy: [{ fieldPath: 'order', direction: 'ASCENDING' }],
      // Sentinel row detects a post-preview 13th schedule instead of
      // truncating the query to the exact preview size.
      limit: 13,
    })
    if (allDocs.length !== input.schedules.length) throw new RouteApplyError(409, 'PREVIEW_STALE', 'schedule set changed after preview')
    const current = allDocs.map(scheduleFromDoc).filter((schedule): schedule is RouteSchedule => Boolean(schedule))
    const currentIds = new Set(current.map(schedule => schedule.id))
    if (currentIds.size !== input.schedules.length || input.schedules.some(schedule => !currentIds.has(schedule.id))) {
      throw new RouteApplyError(409, 'PREVIEW_STALE', 'schedule set changed after preview')
    }
    const currentHash = await routeScheduleFingerprint(current)
    if (currentHash !== claims.inputHash) throw new RouteApplyError(409, 'PREVIEW_STALE', 'schedule constraints changed after preview')

    const writes: TxWrite[] = input.schedules.map(schedule => ({
      document: docResourceName(projectId, `trips/${input.tripId}/schedules/${schedule.id}`),
      fields: {
        order: encodeInteger(schedule.order),
        routeRevision: encodeString(input.revision),
        updatedBy: encodeString(uid),
      },
      updateMask: ['order', 'routeRevision', 'updatedBy'],
      updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: true },
    }))
    writes.push({
      document: docResourceName(projectId, receiptPath),
      fields: {
        inputHash: encodeString(claims.inputHash),
        payloadHash: encodeString(payloadHash),
        actorUid: encodeString(uid),
        expiresAt: { timestampValue: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      },
      updateMask: ['inputHash', 'payloadHash', 'actorUid', 'expiresAt'],
      updateTransforms: [{ fieldPath: 'appliedAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: false },
    })
    return { writes, result: { status: 'applied' as const, revision: input.revision } }
  })
}

export async function routeApplyStatus(
  uid: string,
  input: RouteApplyStatusRequest,
  serviceAccountJson: string,
  projectId: string,
): Promise<{ status: 'applied' | 'not_found'; revision: string; appliedAt?: string }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  return runFirestoreTransaction<{ status: 'applied' | 'not_found'; revision: string; appliedAt?: string }>(accessToken, projectId, async tx => {
    const { member } = await requireTripMember(tx, input.tripId, uid)
    assertRouteMemberActive(member)
    const role = readString(member.fields, 'role')
    if (role !== 'owner' && role !== 'editor') throw new RouteApplyError(403, 'FORBIDDEN', 'editor permission is required')
    const receipt = await tx.get(`trips/${input.tripId}/routeApplications/${input.revision}`)
    if (!receipt.exists) return { writes: [], result: { status: 'not_found' as const, revision: input.revision } }
    if (readString(receipt.fields, 'actorUid') !== uid) throw new RouteApplyError(403, 'FORBIDDEN', 'only the original actor can query this revision')
    const appliedAt = receipt.fields.appliedAt?.timestampValue
    return { writes: [], result: { status: 'applied' as const, revision: input.revision, ...(appliedAt ? { appliedAt } : {}) } }
  })
}
