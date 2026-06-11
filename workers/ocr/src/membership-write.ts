// workers/ocr/src/membership-write.ts
// Worker-authoritative membership lifecycle:
//   /invite-redeem        — invitee accepts a trip invite (creates member doc
//                           atomically with trip.memberIds-update, then runs
//                           cascadeMemberAdd to project ACL onto every
//                           subcollection doc).
//   /member-remove        — owner kicks a member (strips ACL projection from
//                           every subcollection doc + trip doc FIRST, then
//                           deletes the member doc).
//   /member-role-update   — owner flips a member between 'editor' / 'viewer'.
//
// Why these run on the Worker (Firestore REST + service account, NOT
// firebase-admin -- the SDK can't load in V8 isolates):
//   1. The /invite-redeem path needs to create the member doc AND
//      append callerUid to trip.memberIds in a single atomic step.
//      Two redeemers racing on the same trip must each see the other's
//      uid in the final roster, else `member A's memberIds = [owner, A]`
//      stays stale while `trip.memberIds = [owner, A, B]`, breaking
//      B's array-contains listener over /members. The REST transaction
//      (firestore-tx.ts) gives us snapshot isolation: concurrent redeemers
//      abort one, retry sees the just-committed roster, and reapplies.
//   2. /member-remove's correctness invariant is order-sensitive: ACL
//      projection (`memberIds` on trip + subcollection docs) MUST be
//      stripped BEFORE the member doc is deleted. If the cascade fails
//      mid-way, the only safe failure mode is "still member, retry the
//      kick", NEVER "member doc gone but collection-group reads still
//      leak via the stale memberIds projection". Doing this with a
//      client-side delete + best-effort sync (the pre-Worker world)
//      couldn't enforce that order under network partition.
//   3. firestore.rules closes all three paths via members create/update/delete
//      and direct memberIds projection writes. Worker is the only legitimate
//      membership writer after owner self-bootstrap.
//
// Shared helpers (only authz/read parsing, NOT domain decisions):
//   - requireTripMember(tx, tripId, uid)  → asserts trip exists + not
//                                            deleting + caller has member doc
//   - requireTripOwner(tx, tripId, uid)   → as above + ownerId == uid
//   - assertTripNotDeleting(trip)         → 410 if `deletingAt` present
//   - readTripRoster(trip)                → decodes trip.memberIds to string[]
// Each handler's domain logic stays inline — invite-token validation,
// remove-order, role-flip checks all read differently enough that pulling
// them into helpers would obscure rather than dedupe.
import { z }                                                from 'zod'
import { getAdminToken, getProjectId }                      from './admin'
import {
  readString,
  listDocNames,
  batchArrayRemoveMemberIds,
  deleteDoc,
  type FsValue,
}                                                           from './firestore'
import { mapWithConcurrency }                               from './concurrency'
import {
  cascadeMemberAdd,
  withTokenRetry,
  CascadeError,
  TRIP_SUBCOLLECTIONS,
}                                                           from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxReadDoc,
  type TxWrite,
}                                                           from './firestore-tx'

// ─── Request body schemas ─────────────────────────────────────────

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/
const UID_MAX  = 128
/** Invite tokens are 32 bytes (256 bits) hex-encoded -- see
 *  generateToken() in inviteService.ts. Hex-only regex doubles as
 *  a defense-in-depth check against URL injection via token field. */
const TokenRe  = /^[A-Fa-f0-9]{64}$/

/** /invite-redeem request. displayName + avatarUrl carried in the body
 *  because Firebase ID tokens don't always expose `name` / `picture`
 *  (email/password auth has neither), and we want the resulting member
 *  doc to satisfy MemberDocSchema's `displayName: z.string().min(1)`
 *  invariant without falling back to a generic "Member" placeholder for
 *  Google users who DO have a name. Caller (acceptInvite in
 *  inviteService.ts) passes `user.displayName` / `user.photoURL` from
 *  the Firebase user object -- both already validated by Firebase Auth. */
export const InviteRedeemRequestSchema = z.object({
  tripId:      z.string().regex(TripIdRe),
  token:       z.string().regex(TokenRe),
  displayName: z.string().min(1).max(100),
  avatarUrl:   z.string().url().max(2000).optional(),
}).strict()
export type InviteRedeemRequest = z.infer<typeof InviteRedeemRequestSchema>

export const MemberRemoveRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  memberUid: z.string().min(1).max(UID_MAX),
}).strict()
export type MemberRemoveRequest = z.infer<typeof MemberRemoveRequestSchema>

export const MemberRoleUpdateRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  memberUid: z.string().min(1).max(UID_MAX),
  role:      z.enum(['editor', 'viewer']),
}).strict()
export type MemberRoleUpdateRequest = z.infer<typeof MemberRoleUpdateRequestSchema>

/** Default invite lifetime when the client doesn't override. Mirrors the
 *  "5時間有効" copy in InviteModal. */
const INVITE_DEFAULT_EXPIRY_MS = 5 * 60 * 60 * 1000
/** Hard upper bound on an invite's lifetime. The UI only ever issues the
 *  5-hour default; the cap exists so neither a future longer-expiry UI nor
 *  a crafted request can mint an effectively-permanent bearer link. This is
 *  the authoritative cap now -- firestore.rules `invites create: if false`
 *  means there is no client write path left to enforce it at the rules
 *  layer. 7 days. */
const INVITE_MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

/** /invite-create request. Worker mints the token (client no longer does)
 *  and reads tripTitle / tripIcon off the trip doc, so the only trusted
 *  inputs are tripId + role + an optional capped expiry. */
export const InviteCreateRequestSchema = z.object({
  tripId:      z.string().regex(TripIdRe),
  role:        z.enum(['editor', 'viewer']),
  expiresInMs: z.number().int().positive().max(INVITE_MAX_EXPIRY_MS).optional(),
}).strict()
export type InviteCreateRequest = z.infer<typeof InviteCreateRequestSchema>

/** /invite-revoke request. Token must be the 64-hex bearer token; the
 *  Worker compares it against the authoritative inviteState/current
 *  pointer and 409s a stale (already-rotated) token. */
export const InviteRevokeRequestSchema = z.object({
  tripId: z.string().regex(TripIdRe),
  token:  z.string().regex(TokenRe),
}).strict()
export type InviteRevokeRequest = z.infer<typeof InviteRevokeRequestSchema>

// ─── Validation error ─────────────────────────────────────────────

/** Thrown for any membership validation failure. Same `{ field, message }`
 *  shape as Expense/Wish/Booking/Settlement so
 *  route-dispatch.validationErrorCatcher handles all five identically. */
export class MembershipValidationError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name  = 'MembershipValidationError'
    this.field = field
  }
}

// ─── Shared helpers ────────────────────────────────────────────────

/** 410 if `deletingAt` is set on the trip. Same gate as settlement-write,
 *  expense-write, etc. -- documented at the rules layer as the
 *  cascade-write-quiesce marker (firestore.rules `tripNotDeleting`). */
function assertTripNotDeleting(trip: TxReadDoc): void {
  if ('deletingAt' in trip.fields) {
    throw new CascadeError(410, 'trip is being deleted')
  }
}

/** Decode `memberIds` from a doc's REST fields. Returns empty array when
 *  the field is missing or contains non-string entries -- defensive
 *  decode that mirrors firestore.ts/getDocMemberIds without the round trip. */
function decodeMemberIds(fields: Record<string, FsValue>): string[] {
  const values = fields.memberIds?.arrayValue?.values ?? []
  return values
    .map(v => v.stringValue)
    .filter((v): v is string => typeof v === 'string')
}

function readTripRoster(trip: TxReadDoc): string[] {
  return decodeMemberIds(trip.fields)
}

/** Asserts: trip exists, not deleting, caller has a member doc.
 *  Returns the two reads so callers can inspect role / roster / fields
 *  without re-fetching. */
async function requireTripMember(
  tx:        TxContext,
  tripId:    string,
  callerUid: string,
): Promise<{ trip: TxReadDoc; member: TxReadDoc }> {
  const [trip, member] = await Promise.all([
    tx.get(`trips/${tripId}`),
    tx.get(`trips/${tripId}/members/${callerUid}`),
  ])
  if (!trip.exists)   throw new CascadeError(404, 'trip not found')
  assertTripNotDeleting(trip)
  if (!member.exists) throw new CascadeError(403, 'caller is not a trip member')
  return { trip, member }
}

/** As `requireTripMember`, plus `ownerId == callerUid`. Returns the
 *  same shape so callers can branch on role / roster afterward. */
async function requireTripOwner(
  tx:        TxContext,
  tripId:    string,
  callerUid: string,
): Promise<{ trip: TxReadDoc; member: TxReadDoc }> {
  const { trip, member } = await requireTripMember(tx, tripId, callerUid)
  const ownerId = readString(trip.fields, 'ownerId')
  if (ownerId !== callerUid) {
    throw new CascadeError(403, 'caller is not the trip owner')
  }
  return { trip, member }
}

/** Encode a list of uids as a Firestore REST arrayValue payload. */
function encodeMemberIds(uids: string[]): FsValue {
  return {
    arrayValue: { values: uids.map(u => ({ stringValue: u })) },
  }
}

// ─── /invite-redeem ───────────────────────────────────────────────

/** Outcome reported back to the caller. Mirrors the existing
 *  `AcceptOutcome` shape from inviteService so the client wrapper can
 *  preserve its UX (already-member vs joined branching). */
export type InviteRedeemOutcome = 'joined' | 'already-member'

export async function inviteRedeem(
  callerUid:          string,
  req:                InviteRedeemRequest,
  serviceAccountJson: string,
): Promise<{ outcome: InviteRedeemOutcome; role: 'editor' | 'viewer' }> {
  return withTokenRetry(() => doInviteRedeem(callerUid, req, serviceAccountJson))
}

async function doInviteRedeem(
  callerUid:          string,
  req:                InviteRedeemRequest,
  serviceAccountJson: string,
): Promise<{ outcome: InviteRedeemOutcome; role: 'editor' | 'viewer' }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  // Tx phase. Snapshot-isolated reads of trip + invite + member; writes
  // limited to the new member doc + trip.memberIds overwrite. Two
  // concurrent redeemers both read trip.memberIds = [owner], compute
  // disjoint new rosters, only one commit lands -- the loser ABORTs,
  // retries, reads the now-committed roster and reapplies on top.
  //
  // `tripRosterIncludesCaller` is an internal-only signal -- post-tx
  // we use it to decide whether to run cascadeMemberAdd on the
  // already-member branch (see "Cascade-recovery contract" comment at
  // the call site below). NOT surfaced in the public response.
  //
  // Explicit return-type annotation: the two branches inside return
  // different `outcome` literal types ('already-member' vs 'joined'),
  // which TS would otherwise pick from the first branch and reject the
  // second. The annotation widens to the InviteRedeemOutcome union up
  // front so both branches type-check.
  type InviteTxResult = {
    outcome:                    InviteRedeemOutcome
    role:                       'editor' | 'viewer'
    tripRosterIncludesCaller:   boolean
  }
  const result = await runFirestoreTransaction<InviteTxResult>(accessToken, projectId, async (tx) => {
    const [trip, invite, existingMember, current] = await Promise.all([
      tx.get(`trips/${req.tripId}`),
      tx.get(`trips/${req.tripId}/invites/${req.token}`),
      tx.get(`trips/${req.tripId}/members/${callerUid}`),
      tx.get(`trips/${req.tripId}/inviteState/current`),
    ])

    if (!trip.exists)   throw new CascadeError(404, 'trip not found')
    assertTripNotDeleting(trip)

    if (!invite.exists) throw new CascadeError(404, 'invite not found')

    // Single-active-invite gate. inviteState/current is the authoritative
    // pointer the owner's last /invite-create wrote. A missing pointer (no
    // active invite) OR a mismatch (owner rotated to a newer invite, so this
    // token is stale even though its doc may briefly linger before the
    // best-effort delete) both mean THIS token is no longer redeemable.
    // Surfaced as the SAME 404 as a missing invite doc so we never leak
    // whether the doc still exists. Reading `current` inside the tx puts
    // redeem in the same conflict domain as create/revoke: a concurrent
    // rotation aborts this redeem, the retry re-reads, and the decision is
    // taken against the committed pointer.
    if (readString(current.fields, 'token') !== req.token) {
      throw new CascadeError(404, 'invite not found')
    }

    const invitedRole = readString(invite.fields, 'role')
    if (invitedRole !== 'editor' && invitedRole !== 'viewer') {
      // Defensive -- createInvite Zod-validates role at creation; a doc
      // with a malformed role here is data-at-rest corruption.
      throw new CascadeError(500, 'invite has malformed role')
    }

    const expiresIso = invite.fields.expiresAt?.timestampValue
    const expiresMs  = typeof expiresIso === 'string' ? Date.parse(expiresIso) : Number.NaN
    if (!Number.isFinite(expiresMs)) {
      throw new CascadeError(500, 'invite has malformed expiresAt')
    }
    // Worker clock vs Firestore server clock can drift by 100s of ms;
    // we mirror the rule's `expiresAt > request.time` boundary using
    // Date.now() which is the closest Worker-side approximation. The
    // rule layer (until M4) would still reject if our clock leads
    // Firestore's; surfacing the same 410 here keeps the client-error
    // contract consistent.
    if (expiresMs <= Date.now()) {
      throw new CascadeError(410, 'invite expired')
    }

    // Read trip roster once: needed BOTH for the joined-branch's
    // newRoster computation AND for the already-member branch's
    // needsCascade signal, so we hoist it above both.
    const currentRoster = readTripRoster(trip)

    // existingMember.exists branches into three states. Distinguishing
    // them by `removingAt` (NOT by roster membership alone) is the
    // load-bearing decision -- conflating "roster missing caller" with
    // "kick in progress" leaves legacy half-joins permanently stuck
    // (member doc created but trip roster never bumped, e.g. old
    // acceptInvite Step-2a arrayUnion failed mid-flight).
    //
    //   (A) removingAt present                                → kick
    //       mid-flight (/member-remove committed its authz tx; cascade
    //       is actively stripping ACL). Re-running cascadeMemberAdd
    //       would silently undo the kick. Throw 409.
    //
    //   (B) removingAt absent + roster MISSING callerUid      → legacy
    //       half-join recovery. The member doc exists from an earlier
    //       redeem attempt whose post-create trip-roster bump failed
    //       (old-client acceptInvite Step 1 succeeded, Step 2a
    //       arrayUnion failed). Repair: write the missing roster entry
    //       inside this same tx so the post-tx cascade's "trip roster
    //       includes memberUid" check passes and projects ACL onto
    //       every subcollection doc. Do NOT overwrite the existing
    //       member doc -- only the trip roster needs repair.
    //
    //   (C) removingAt absent + roster HAS callerUid          → genuine
    //       idempotent already-member. A prior redeem committed its tx
    //       and roster; the post-tx cascade may have failed. Re-run
    //       cascade (it's idempotent via arrayUnion).
    //
    // In all three cases, `role` reported back is the INVITE's role
    // (not the existing member doc's role) -- post-redeem
    // /member-role-update can diverge member.role from invitedRole;
    // the response carries the contract of the invite the user clicked.
    if (existingMember.exists) {
      const existingRole = readString(existingMember.fields, 'role')
      if (existingRole !== 'owner' && existingRole !== 'editor' && existingRole !== 'viewer') {
        throw new CascadeError(500, 'existing member doc has malformed role')
      }

      const hasRemovingAt   = 'removingAt' in existingMember.fields
      const rosterHasCaller = currentRoster.includes(callerUid)

      // Case A: refuse — kick in flight.
      if (hasRemovingAt) {
        throw new CascadeError(
          409,
          'member is being removed; retry after the kick completes',
        )
      }

      // Case B: repair — half-join recovery.
      if (!rosterHasCaller) {
        const repairedRoster = [...currentRoster, callerUid]
        const repairWrite: TxWrite = {
          document:   docResourceName(projectId, `trips/${req.tripId}`),
          fields:     { memberIds: encodeMemberIds(repairedRoster) },
          updateMask: ['memberIds'],
        }
        return {
          writes: [repairWrite],
          result: {
            outcome:                  'already-member' as const,
            role:                     invitedRole,
            tripRosterIncludesCaller: true,  // just repaired
          },
        }
      }

      // Case C: idempotent already-member.
      return {
        writes: [],
        result: {
          outcome:                  'already-member' as const,
          role:                     invitedRole,
          tripRosterIncludesCaller: true,
        },
      }
    }

    // Fresh redemption. Compute new roster = old + callerUid. Write the
    // member doc with the FULL roster so the caller is immediately
    // discoverable via existing members' array-contains listeners (no
    // post-cascade arrayUnion-self-doc step required as a separate
    // round-trip -- cascadeMemberAdd's seed step becomes a no-op).
    if (currentRoster.includes(callerUid)) {
      // Trip.memberIds carries callerUid but member doc doesn't exist.
      // Inconsistent prior state (e.g. a previous remove that stripped
      // the doc but lost the trip arrayRemove); treat the redeem as
      // legitimate and let it re-establish the doc, but do NOT bump
      // trip.memberIds again (avoid duplicate).
      const writes = buildInviteWrites(projectId, req, callerUid, invitedRole, currentRoster, { bumpTrip: false })
      return {
        writes,
        result: {
          outcome:                  'joined' as const,
          role:                     invitedRole,
          tripRosterIncludesCaller: true,
        },
      }
    }
    const newRoster = [...currentRoster, callerUid]
    const writes = buildInviteWrites(projectId, req, callerUid, invitedRole, newRoster, { bumpTrip: true })
    return {
      writes,
      result: {
        outcome:                  'joined' as const,
        role:                     invitedRole,
        tripRosterIncludesCaller: true,  // we just put them in
      },
    }
  })

  // Cascade-recovery contract. By the time we reach this point, the tx
  // body has either thrown (kick-in-flight → 409) or normalized the
  // state to "trip roster includes callerUid" -- the legacy half-join
  // case (B above) writes the missing roster entry inside the tx,
  // making tripRosterIncludesCaller true for both joined and
  // already-member outcomes.
  //
  //   - outcome === 'joined' → tx just created the member doc; ACL
  //     projection MUST be cascaded onto every subcollection doc.
  //   - outcome === 'already-member' AND tripRosterIncludesCaller →
  //     either (B) we just repaired the trip roster, or (C) a prior
  //     redeem's post-tx cascade failed. Both cases require running
  //     cascadeMemberAdd: idempotent via arrayUnion, and the ONLY
  //     mechanism that recovers a torn subcollection ACL state. The
  //     cascade's own removal-aware refuse (trip roster MUST include
  //     the cascade target) is a defense-in-depth check; the
  //     tripRosterIncludesCaller invariant above is the primary gate.
  //
  // tripRosterIncludesCaller=false on the already-member branch is
  // unreachable -- case A throws, case B repairs, case C is the only
  // remaining shape. The OR guard below stays as a defensive narrow.
  const needsCascade =
       result.outcome === 'joined'
    || (result.outcome === 'already-member' && result.tripRosterIncludesCaller)
  if (needsCascade) {
    await cascadeMemberAdd(
      callerUid,
      { tripId: req.tripId, memberUid: callerUid },
      serviceAccountJson,
    )
  }

  return { outcome: result.outcome, role: result.role }
}

/** Build the write set for /invite-redeem. Two writes:
 *   1. Create the member doc with full computed roster. `exists: false`
 *      precondition rejects a race where the doc lands between tx-read
 *      and tx-commit (TxContext.get would see it during a retry).
 *   2. Overwrite trip.memberIds with the new roster (when bumpTrip is
 *      true). updateMask scopes the write to memberIds only.
 *  Caller branches on bumpTrip to handle the inconsistent-prior-state
 *  case where trip.memberIds already carries callerUid. */
function buildInviteWrites(
  projectId:   string,
  req:         InviteRedeemRequest,
  callerUid:   string,
  role:        'editor' | 'viewer',
  roster:      string[],
  opts:        { bumpTrip: boolean },
): TxWrite[] {
  const memberFields: Record<string, FsValue> = {
    tripId:      { stringValue: req.tripId },
    userId:      { stringValue: callerUid },
    displayName: { stringValue: req.displayName },
    role:        { stringValue: role },
    inviteToken: { stringValue: req.token },
    memberIds:   encodeMemberIds(roster),
  }
  if (req.avatarUrl) {
    memberFields.avatarUrl = { stringValue: req.avatarUrl }
  }
  const memberWrite: TxWrite = {
    document:        docResourceName(projectId, `trips/${req.tripId}/members/${callerUid}`),
    fields:          memberFields,
    currentDocument: { exists: false },
    // joinedAt via REQUEST_TIME -- mirrors serverTimestamp() in the
    // client path. Worker's Date.now() would drift relative to Firestore
    // server clock and break listInvites/subscribeToInvites's joinedAt-
    // based sort.
    updateTransforms: [
      { fieldPath: 'joinedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  }
  const writes: TxWrite[] = [memberWrite]
  if (opts.bumpTrip) {
    writes.push({
      document:   docResourceName(projectId, `trips/${req.tripId}`),
      fields:     { memberIds: encodeMemberIds(roster) },
      updateMask: ['memberIds'],
    })
  }
  return writes
}

// ─── /invite-create + /invite-revoke ──────────────────────────────
// Owner mints / revokes reusable invite links. Worker-authoritative
// (firestore.rules `invites create/delete: if false`) so two invariants
// rules can't express are enforced server-side:
//   1. Single active invite. A fixed pointer doc inviteState/current is
//      the transaction conflict point -- two owner tabs racing a create
//      both read the same current, only one commit lands, the loser
//      ABORTs + retries. Scanning the invites collection (the pre-Worker
//      client batch) was NOT a reliable uniqueness lock.
//   2. Capped expiry. INVITE_MAX_EXPIRY_MS bounds the bearer link's
//      lifetime; there is no client write path left to forge a far-future
//      expiresAt.
// The token is minted HERE (client no longer does) and tripTitle/tripIcon
// are read off the trip doc, so the only trusted client inputs are
// tripId + role + an optional capped expiry.

/** 256-bit crypto-random invite token, hex-encoded (64 chars). Matches the
 *  `TokenRe` shape the redeem path validates. WebCrypto is in the CF
 *  Workers global scope. */
function generateInviteToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** Result of /invite-create. Carries the Worker-minted token + computed
 *  expiry (ISO) back so the client can build the optimistic Invite row
 *  without re-reading; createdAt is server-stamped (REQUEST_TIME) and
 *  arrives on the next realtime push, so the client uses a local sentinel
 *  until then -- same pattern the old client createInvite used. */
export interface InviteCreateResult {
  token:     string
  expiresAt: string
}

export async function inviteCreate(
  callerUid:          string,
  req:                InviteCreateRequest,
  serviceAccountJson: string,
): Promise<InviteCreateResult> {
  return withTokenRetry(() => doInviteCreate(callerUid, req, serviceAccountJson))
}

async function doInviteCreate(
  callerUid:          string,
  req:                InviteCreateRequest,
  serviceAccountJson: string,
): Promise<InviteCreateResult> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  // Token + expiry computed once, OUTSIDE the tx body, so a retry reuses
  // the same values (the body re-runs on ABORT; a fresh token per attempt
  // would orphan the loser's not-yet-committed invite doc id). expiresAt is
  // an absolute instant = now + window, capped by the Zod schema already.
  const token        = generateInviteToken()
  const expiresInMs   = req.expiresInMs ?? INVITE_DEFAULT_EXPIRY_MS
  const expiresAtIso  = new Date(Date.now() + expiresInMs).toISOString()

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const { trip } = await requireTripOwner(tx, req.tripId, callerUid)
    const current  = await tx.get(`trips/${req.tripId}/inviteState/current`)

    const tripTitle = readString(trip.fields, 'title') ?? ''
    const tripIcon  = readString(trip.fields, 'icon')  ?? '✈️'

    const writes: TxWrite[] = []

    // Drop the previous active invite doc so the invites collection holds
    // exactly the current token. Redeem already gates on the pointer, so a
    // lingering stale doc is harmless -- this is hygiene, kept atomic here
    // because TxWrite supports `op: 'delete'`. Skip when the pointer somehow
    // names the freshly-minted token (impossible collision) to avoid
    // deleting the doc we're about to create.
    const prevToken = readString(current.fields, 'token')
    if (prevToken && prevToken !== token) {
      writes.push({
        op:       'delete',
        document: docResourceName(projectId, `trips/${req.tripId}/invites/${prevToken}`),
      })
    }

    // New invite doc (bearer lookup). createdAt via REQUEST_TIME so the
    // client's InviteDocSchema sees a server-stamped Timestamp, not Worker
    // clock drift. exists:false rejects the ~0-probability token collision.
    const inviteFields: Record<string, FsValue> = {
      tripId:    { stringValue: req.tripId },
      tripTitle: { stringValue: tripTitle },
      tripIcon:  { stringValue: tripIcon },
      role:      { stringValue: req.role },
      createdBy: { stringValue: callerUid },
      expiresAt: { timestampValue: expiresAtIso },
    }
    writes.push({
      document:         docResourceName(projectId, `trips/${req.tripId}/invites/${token}`),
      fields:           inviteFields,
      currentDocument:  { exists: false },
      updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
    })

    // Authoritative single-active pointer. Full overwrite (no updateMask)
    // replaces the prior pointer wholesale, including its stale createdAt.
    // Stores role/createdBy/expiresAt as well so revoke-stale detection +
    // audit/debug never need to re-read the invite doc. Worker-only:
    // firestore.rules deny all client access to inviteState.
    const currentFields: Record<string, FsValue> = {
      token:     { stringValue: token },
      role:      { stringValue: req.role },
      createdBy: { stringValue: callerUid },
      expiresAt: { timestampValue: expiresAtIso },
    }
    writes.push({
      document:         docResourceName(projectId, `trips/${req.tripId}/inviteState/current`),
      fields:           currentFields,
      updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }],
    })

    return { writes, result: undefined }
  })

  return { token, expiresAt: expiresAtIso }
}

export async function inviteRevoke(
  callerUid:          string,
  req:                InviteRevokeRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doInviteRevoke(callerUid, req, serviceAccountJson))
}

async function doInviteRevoke(
  callerUid:          string,
  req:                InviteRevokeRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    await requireTripOwner(tx, req.tripId, callerUid)
    const current = await tx.get(`trips/${req.tripId}/inviteState/current`)

    // No active invite. Idempotent ok -- also delete the named invite doc
    // in case a stale doc lingers without a pointer (defensive; deleteDoc
    // of a missing doc is a no-op at commit).
    if (!current.exists) {
      return {
        writes: [{
          op:       'delete' as const,
          document: docResourceName(projectId, `trips/${req.tripId}/invites/${req.token}`),
        }],
        result: undefined,
      }
    }

    // Stale token: the caller is revoking a token that is no longer the
    // active one (another tab/owner already rotated the invite via
    // /invite-create). Refuse with 409 rather than silently "succeeding" --
    // a silent ok would let the stale UI report "current invite revoked"
    // while a newer invite is in fact live. 409 ∈ client DEFINITIVE_REJECT
    // → the revoke mutation rolls back + the realtime listener resyncs the
    // owner to the actual active invite.
    if (readString(current.fields, 'token') !== req.token) {
      throw new CascadeError(409, 'invite token is stale; a newer invite is active')
    }

    // Active token: drop both the invite doc and the pointer atomically.
    return {
      writes: [
        { op: 'delete' as const, document: docResourceName(projectId, `trips/${req.tripId}/invites/${req.token}`) },
        { op: 'delete' as const, document: docResourceName(projectId, `trips/${req.tripId}/inviteState/current`) },
      ],
      result: undefined,
    }
  })

  return { ok: true }
}

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

    // Removal-quiesce marker + trip-roster strip. Both writes commit
    // atomically inside the same authz tx that read the owner /
    // target / roster state, BEFORE the non-tx cascade phase begins.
    //
    // Write 1 -- `removingAt` on the target member doc. Blocks the
    //   kicked user from continuing to write (firestore.rules'
    //   canWrite() refuses when this field is present), closing the
    //   race where they could addDoc-then-be-stripped during the
    //   cascade phase.
    //
    // Write 2 -- `trip.memberIds := currentRoster \ [memberUid]`.
    //   Closes the OTHER race window: any OTHER editor/owner that
    //   creates a subcollection doc between (a) the cascade phase's
    //   listDocNames snapshot and (b) the trip-roster strip would
    //   otherwise read a stale trip.memberIds (still carrying
    //   memberUid), copy that roster to the new doc, and slip past
    //   the batch arrayRemove which only knows about docs in the
    //   pre-list snapshot. By stripping trip.memberIds inside the
    //   tx, any new-doc creation that lands AFTER tx commit sees the
    //   roster already missing the target uid, so the new doc's
    //   memberIds[] never carries the kicked user. Write 2 is
    //   skipped when the roster doesn't actually contain memberUid
    //   (data-at-rest inconsistency from a prior partial kick) --
    //   the marker still fires when the target doc exists, and the
    //   cascade still converges.
    //
    // Why inside the tx rather than as separate PATCHes:
    // - Atomic with the owner-authz read above. A concurrent
    //   trip-cascade-delete that mid-commits the trip doc would either
    //   ABORT this tx (we retry, observe deletingAt, return 410) or
    //   commit before ours (we observe deletingAt and return 410 on
    //   the next read). Without atomic coupling the marker / strip
    //   could land on a trip being torn down.
    // - Snapshot isolation guarantees write 2's roster computation
    //   sees the same trip.memberIds we read for the owner check --
    //   two concurrent kicks each filter disjoint subsets, only one
    //   commit lands, the loser ABORTs + retries + reads the now-
    //   committed roster + reapplies. Idempotent and convergent.
    //
    // `removingAt` uses a client-stamped Date value (not REQUEST_TIME)
    // because (a) the field is consumed as exists/not-exists in
    // rules, value is never compared, and (b) any future cron cleanup
    // using this timestamp tolerates CF/Firestore clock drift orders
    // of magnitude wider than the few-second skew we'd see in
    // practice. updateTransforms can't express the trip-roster strip
    // anyway (only REQUEST_TIME), so we stay consistent on Date.now().
    const writes: TxWrite[] = []
    if (target.exists) {
      const removingAtIso = new Date().toISOString()
      const targetDocResource = docResourceName(
        projectId,
        `trips/${req.tripId}/members/${req.memberUid}`,
      )
      writes.push({
        document:   targetDocResource,
        fields:     { removingAt: { timestampValue: removingAtIso } },
        updateMask: ['removingAt'],
      })
    }

    const currentRoster = readTripRoster(trip)
    if (currentRoster.includes(req.memberUid)) {
      const newRoster = currentRoster.filter(u => u !== req.memberUid)
      writes.push({
        document:   docResourceName(projectId, `trips/${req.tripId}`),
        fields:     { memberIds: encodeMemberIds(newRoster) },
        updateMask: ['memberIds'],
      })
    }

    return {
      writes,
      result: { targetExists: target.exists },
    }
  })

  // Cascade phase. Order is LOAD-BEARING -- see file header rationale:
  //   1. List every subcollection doc carrying memberIds.
  //   2. arrayRemove memberUid from all of them (single batch via
  //      the commit endpoint).
  //   3. ONLY THEN delete the members/{memberUid} doc.
  // Mid-step failure between (2) and (3) leaves "user still a member
  // doc, ACL projection gone" -- they keep formally listed membership
  // but lose subcollection visibility; a retry converges. The other
  // direction (delete first, then strip) would leave a kicked user
  // still able to read via collection-group queries that match on
  // resource.data.memberIds -- a real exfiltration surface.
  //
  // Note: the trip doc's memberIds was already stripped in the
  // precheck tx above (load-bearing -- closes the race where another
  // editor reads stale trip.memberIds and creates a new subcollection
  // doc carrying memberUid AFTER the listDocNames snapshot below).
  // The batch here only covers subcollection docs.
  //
  // The removingAt marker (when the target member doc still exists)
  // blocks the kicked user themselves from creating a doc during this
  // phase: firestore.rules' canWrite() refuses when their member doc
  // carries removingAt. If the member doc was already missing, this run
  // is repairing stale projections left by a legacy partial kick, so
  // there is no remaining member doc to gate.
  const lists = await mapWithConcurrency(TRIP_SUBCOLLECTIONS, 3, sub =>
    listDocNames(accessToken, projectId, `trips/${req.tripId}/${sub}`),
  )
  const docNames: string[] = lists.flat()
  await batchArrayRemoveMemberIds(accessToken, projectId, docNames, req.memberUid)

  // Member doc delete is the very last step. By this point every
  // subcollection doc + trip doc has had memberUid stripped from
  // memberIds, so collection-group queries that filter
  // `array-contains memberUid` will no longer match this trip's docs.
  if (removePrecheck.targetExists) {
    await deleteDoc(accessToken, projectId, `trips/${req.tripId}/members/${req.memberUid}`)
  }

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

// Re-export TxReadDoc for the test file's mock typing -- same pattern
// settlement-write uses.
export type { TxReadDoc }
