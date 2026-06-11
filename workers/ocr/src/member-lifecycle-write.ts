// workers/ocr/src/member-lifecycle-write.ts
// Worker-authoritative member lifecycle: /member-remove (owner kicks),
// /member-leave (non-owner self-removal), /member-role-update (editor↔viewer),
// /owner-transfer (hand off ownership). Split out of membership-write.ts; the
// shared strip/authz helpers live in membership-shared.ts. Pure boundary move
// — the LOAD-BEARING strip-before-delete order and every authz check are
// unchanged.
import { z }                                                from 'zod'
import { getAdminToken, getProjectId }                      from './admin'
import { readString }                                       from './firestore'
import { withTokenRetry, CascadeError }                     from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxWrite,
}                                                           from './firestore-tx'
import {
  TripIdRe,
  UID_MAX,
  MembershipValidationError,
  requireTripMember,
  requireTripOwner,
  readTripRoster,
  buildMemberStripWrites,
  runMemberStripCascade,
}                                                           from './membership-shared'

// ─── Request body schemas ─────────────────────────────────────────

export const MemberRemoveRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  memberUid: z.string().min(1).max(UID_MAX),
}).strict()
export type MemberRemoveRequest = z.infer<typeof MemberRemoveRequestSchema>

/** /member-leave request. No memberUid: the caller removes THEMSELVES, so the
 *  target uid is the verified token's sub, never client-supplied (a memberUid
 *  field would just be an ignorable / spoofable no-op). */
export const MemberLeaveRequestSchema = z.object({
  tripId: z.string().regex(TripIdRe),
}).strict()
export type MemberLeaveRequest = z.infer<typeof MemberLeaveRequestSchema>

export const MemberRoleUpdateRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  memberUid: z.string().min(1).max(UID_MAX),
  role:      z.enum(['editor', 'viewer']),
}).strict()
export type MemberRoleUpdateRequest = z.infer<typeof MemberRoleUpdateRequestSchema>

/** /owner-transfer request. Current owner hands ownership to `targetUid` (an
 *  existing editor/viewer member). Worker-only — trip.ownerId is rules-
 *  immutable and member roles are `if false` for clients. */
export const OwnerTransferRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  targetUid: z.string().min(1).max(UID_MAX),
}).strict()
export type OwnerTransferRequest = z.infer<typeof OwnerTransferRequestSchema>

// ─── /member-remove ───────────────────────────────────────────────

export async function memberRemove(
  callerUid:          string,
  req:                MemberRemoveRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doMemberRemove(callerUid, req, serviceAccountJson))
}

async function doMemberRemove(
  callerUid:          string,
  req:                MemberRemoveRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  // Tx handles snapshot-consistent authz plus the small atomic writes
  // that must land before the non-tx cascade phase begins: the optional
  // removingAt marker and trip.memberIds strip. The bulk cascade
  // (arrayRemove + delete) runs OUTSIDE the tx because:
  //   - the array transforms (`removeAllFromArray`) aren't expressible
  //     via TxWrite's updateTransforms (which only support REQUEST_TIME)
  //   - cascading across hundreds of docs would exceed tx write caps
  //   - convergent semantics (idempotent arrayRemove + idempotent
  //     deleteDoc) make non-atomicity safe under retry
  const removePrecheck = await runFirestoreTransaction<{
    targetExists: boolean
  }>(accessToken, projectId, async (tx) => {
    const { trip } = await requireTripOwner(tx, req.tripId, callerUid)

    // Self-remove block. Owner unkicking themselves would orphan the
    // trip (no remaining members able to write or accept invites). The
    // ownerId-matches-callerUid check below also catches this, but the
    // explicit branch carries a precise field path so the client UI can
    // hide the kick-self button against the same constraint.
    if (req.memberUid === callerUid) {
      throw new MembershipValidationError(
        'memberUid',
        'cannot remove yourself (transfer ownership or delete the trip instead)',
      )
    }

    // Owner cannot be removed via this endpoint. Trip-cascade-delete is
    // the only legitimate path to remove the owner's member doc.
    const tripOwnerId = readString(trip.fields, 'ownerId')
    if (req.memberUid === tripOwnerId) {
      throw new MembershipValidationError(
        'memberUid',
        'cannot remove the trip owner',
      )
    }

    // Target existence: idempotent on missing. This still continues to
    // the cascade phase below, because legacy delete-first partial kicks
    // can leave subcollection memberIds carrying memberUid after the
    // members/{uid} doc is already gone. Returning early here would leave
    // a real read-leak via collection-group queries gated on same-doc
    // memberIds.
    const target = await tx.get(`trips/${req.tripId}/members/${req.memberUid}`)

    // Removal-quiesce marker + trip-roster strip, built by the shared
    // helper (see buildMemberStripWrites for the full race rationale).
    // Both writes commit atomically inside this authz tx -- BEFORE the
    // non-tx cascade -- coupled to the owner-authz read above so a
    // concurrent trip-cascade-delete can never land them on a trip being
    // torn down.
    const writes = buildMemberStripWrites(projectId, req.tripId, req.memberUid, target, trip)

    return {
      writes,
      result: { targetExists: target.exists },
    }
  })

  // Strip cascade (shared with /member-leave). Order is LOAD-BEARING --
  // ACL projection stripped before the member doc is deleted (see
  // runMemberStripCascade). The trip doc's memberIds was already stripped
  // in the precheck tx above; this covers subcollection docs + wish votes
  // + the final member-doc delete. The removingAt marker (set above when
  // the target doc exists) blocks the kicked user from creating docs
  // during this phase via firestore.rules canWrite(); a missing member
  // doc means this run is just repairing stale projections from a legacy
  // partial kick.
  await runMemberStripCascade(accessToken, projectId, req.tripId, req.memberUid, removePrecheck.targetExists)

  return { ok: true }
}

// ─── /member-leave ────────────────────────────────────────────────
// A non-owner member removes THEMSELVES from a trip. Same strip/cascade
// machinery as /member-remove (shared helpers), but the authz inverts:
//   - /member-remove: caller must be OWNER, target is someone else.
//   - /member-leave:  caller IS the target; owner is the only role that
//                     CANNOT use it (single-owner invariant -- an owner
//                     must transfer ownership or delete the trip).
// No idempotent-on-missing path: requireTripMember 403s when the caller's
// own member doc is gone (= already left). Unlike /member-remove (which
// continues-on-missing to repair an OTHER user's legacy partial kick),
// a self-leaver can't even reach this UI once their member doc is gone
// (their /members collection-group listener drops the trip), so there's
// nothing to repair here.

export async function memberLeave(
  callerUid:          string,
  req:                MemberLeaveRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doMemberLeave(callerUid, req, serviceAccountJson))
}

async function doMemberLeave(
  callerUid:          string,
  req:                MemberLeaveRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  // Tx phase: authz (caller is a member, trip not deleting) + the atomic
  // removingAt / trip-roster strip writes that must precede the non-tx
  // cascade. runFirestoreTransaction resolves to the body's `result`
  // (writes are applied internally), so we only destructure targetExists.
  const { targetExists } = await runFirestoreTransaction<{ targetExists: boolean }>(
    accessToken, projectId, async (tx) => {
      const { trip, member } = await requireTripMember(tx, req.tripId, callerUid)

      // Owner cannot leave: it would orphan the trip (no remaining owner
      // to manage / invite / delete). Transfer ownership or delete the
      // trip instead. The client hides the leave affordance for owners;
      // this is the server-side enforcement of that same constraint.
      const ownerId = readString(trip.fields, 'ownerId')
      if (ownerId === callerUid) {
        throw new MembershipValidationError(
          'tripId',
          'owner cannot leave (transfer ownership or delete the trip instead)',
        )
      }

      // requireTripMember already asserted member.exists (403 otherwise),
      // so targetExists is invariably true -- but we route it through the
      // same helper shape as /member-remove for a single code path.
      const writes = buildMemberStripWrites(projectId, req.tripId, callerUid, member, trip)
      return {
        writes,
        result: { targetExists: member.exists },
      }
    },
  )

  await runMemberStripCascade(accessToken, projectId, req.tripId, callerUid, targetExists)

  return { ok: true }
}

// ─── /member-role-update ──────────────────────────────────────────

export async function memberRoleUpdate(
  callerUid:          string,
  req:                MemberRoleUpdateRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doMemberRoleUpdate(callerUid, req, serviceAccountJson))
}

async function doMemberRoleUpdate(
  callerUid:          string,
  req:                MemberRoleUpdateRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const { trip } = await requireTripOwner(tx, req.tripId, callerUid)

    // Owner cannot demote themselves. Single-owner invariant: ownership
    // transfer is a deliberate decision out of scope for this endpoint.
    const tripOwnerId = readString(trip.fields, 'ownerId')
    if (req.memberUid === tripOwnerId || req.memberUid === callerUid) {
      throw new MembershipValidationError(
        'memberUid',
        'cannot change the trip owner\'s role',
      )
    }

    const target = await tx.get(`trips/${req.tripId}/members/${req.memberUid}`)
    if (!target.exists) {
      throw new CascadeError(404, 'target member not found')
    }

    // Disallow flipping owner role via this path; defensive guard for
    // a state where ownerId on the trip doc and member.role disagree
    // (data-at-rest corruption). Real change set is editor↔viewer only.
    const existingRole = readString(target.fields, 'role')
    if (existingRole === 'owner') {
      throw new MembershipValidationError(
        'memberUid',
        'cannot change role of a member with role=owner',
      )
    }

    // No-op when nothing changes -- skip the write entirely so we don't
    // burn an updateTime bump (which would invalidate any concurrent
    // tx's snapshot for the same member doc).
    if (existingRole === req.role) {
      return { writes: [], result: undefined }
    }

    const write: TxWrite = {
      document:   docResourceName(projectId, `trips/${req.tripId}/members/${req.memberUid}`),
      fields:     { role: { stringValue: req.role } },
      updateMask: ['role'],
      // exists: true rejects a race where target was deleted between
      // the tx.get above and commit. Tx already tracks the read, but
      // belt-and-suspenders for the commit step's currentDocument check.
      currentDocument: { exists: true },
    }
    return { writes: [write], result: undefined }
  })

  return { ok: true }
}

// ─── /owner-transfer ──────────────────────────────────────────────
// Current owner hands ownership to an existing editor/viewer member. Three
// docs change ATOMICALLY in one tx -- trip.ownerId, old-owner role→editor,
// target role→owner -- so the trip never observes 0 or 2 owners. ownerId is
// rules-immutable and member roles are client-`if false`, so this MUST be a
// Worker admin write. Mirrors /member-role-update's authz shape.

export async function ownerTransfer(
  callerUid:          string,
  req:                OwnerTransferRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doOwnerTransfer(callerUid, req, serviceAccountJson))
}

async function doOwnerTransfer(
  callerUid:          string,
  req:                OwnerTransferRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    // Caller must be the CURRENT owner (also asserts trip exists + not
    // deleting). requireTripOwner reads trip + caller member doc.
    const { trip } = await requireTripOwner(tx, req.tripId, callerUid)

    if (req.targetUid === callerUid) {
      throw new MembershipValidationError('targetUid', 'already the owner')
    }

    const target = await tx.get(`trips/${req.tripId}/members/${req.targetUid}`)
    if (!target.exists) {
      throw new CascadeError(404, 'target member not found')
    }
    // Don't hand ownership to a member mid-removal (kick in flight).
    if ('removingAt' in target.fields) {
      throw new MembershipValidationError('targetUid', 'target is being removed')
    }
    const targetRole = readString(target.fields, 'role')
    if (targetRole !== 'editor' && targetRole !== 'viewer') {
      // Defensive: target.role already 'owner' (or malformed) is a
      // data-at-rest disagreement; refuse rather than mint a second owner.
      throw new MembershipValidationError('targetUid', 'target has an unexpected role')
    }
    // Single-source-of-truth guards: the uid we promote MUST be the member
    // doc's own userId AND a genuine roster member -- ownerId must never
    // point at someone not actually in the trip.
    if (readString(target.fields, 'userId') !== req.targetUid) {
      throw new MembershipValidationError('targetUid', 'target member uid mismatch')
    }
    if (!readTripRoster(trip).includes(req.targetUid)) {
      throw new MembershipValidationError('targetUid', 'target is not in trip roster')
    }

    // Three atomic writes. updateMask scopes each so memberIds / other
    // fields stay untouched. currentDocument.exists on all three is
    // defense-in-depth against a concurrent delete between read and commit.
    const writes: TxWrite[] = [
      {
        document:        docResourceName(projectId, `trips/${req.tripId}`),
        fields:          { ownerId: { stringValue: req.targetUid } },
        updateMask:      ['ownerId'],
        currentDocument: { exists: true },
      },
      {
        document:        docResourceName(projectId, `trips/${req.tripId}/members/${callerUid}`),
        fields:          { role: { stringValue: 'editor' } },
        updateMask:      ['role'],
        currentDocument: { exists: true },
      },
      {
        document:        docResourceName(projectId, `trips/${req.tripId}/members/${req.targetUid}`),
        fields:          { role: { stringValue: 'owner' } },
        updateMask:      ['role'],
        currentDocument: { exists: true },
      },
    ]
    return { writes, result: undefined }
  })

  return { ok: true }
}
