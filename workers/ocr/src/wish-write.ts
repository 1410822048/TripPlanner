// workers/ocr/src/wish-write.ts
// Worker-side wish create / content-update with image attachment.
//
// Phase 3.7 split:
//   - wish create WITH image    → /wish-file-create  (this module)
//   - wish create WITHOUT image → client setDoc      (unchanged)
//   - wish update WITH new image → /wish-file-update (this module)
//   - wish update text-only / detach / vote → client updateDoc (unchanged)
//
// Why these Worker endpoints exist:
//   1. The client-managed doc-first + upload-second flow caused the
//      realtime listener to fire at ~200ms with no image yet, then
//      again ~600ms later once the Worker patched `image` via a
//      separate round-trip. UX was a jarring "card flashes in
//      without image then gets one" — opposite of the optimistic ideal.
//   2. Worker-authoritative create lets the doc + image land in a
//      single Firestore tx, so the listener sees the wish for the
//      first time WITH the image already populated.
//   3. The doc-first race that the old flow created — wish doc write
//      → listener fires before image lands — is gone by construction.
//
// firestore.rules (Phase 3.7 Commit 4) tightens accordingly:
//   - wish create: image field must be ABSENT (no client-direct image)
//   - wish update: image deleteField allowed; arbitrary image writes
//                  rejected; this endpoint is the only path that can
//                  set a new image object
import { z }                                                        from 'zod'
import { getAdminToken, getProjectId }                              from './admin'
import {
  readString,
  readNestedString,
  type FsValue,
}                                                                   from './firestore'
import { withTokenRetry, CascadeError }                             from './cascade'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
}                                                                   from './firestore-tx'
import {
  consumeEntityIntents,
  buildAttachmentMapValue,
  type ConsumedIntent,
}                                                                   from './upload-intent'

// ─── Request body schema ──────────────────────────────────────────

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

export const WishFileCreateRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  /** Client mints via `doc(collection(...))` — matches the existing
   *  client-side `ref.id` pattern in `createWish`. Worker enforces
   *  `currentDocument.exists=false` at tx commit so a collision is a
   *  hard 409, not a silent overwrite. */
  wishId:    z.string().regex(TripIdRe),
  /** Validated against `CreateWishBodySchema` below after tripId/wishId
   *  are known. Reject `unknown` here so Worker controls the parse,
   *  not Zod's default discriminated parse on the wrapper. */
  wish:      z.unknown(),
  /** Phase 3.7 intent-driven image. Always present on this endpoint —
   *  text-only wish create stays on the client SDK path. 1 = full only
   *  (HEIC/HEIF pass-through where canvas couldn't decode a thumb),
   *  2 = full + thumb (the typical WebP flow). */
  intentIds: z.array(z.string().min(1).max(60)).min(1).max(2),
})
export type WishFileCreateRequest = z.infer<typeof WishFileCreateRequestSchema>

// ─── Wish body validation ──────────────────────────────────────────

/** Thrown for any wish body validation failure. `field` is a dotted
 *  path the caller can surface in form-level error UI. Mirrors
 *  ExpenseValidationError's contract so index.ts handles both the
 *  same way. */
export class WishValidationError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'WishValidationError'
    this.field = field
  }
}

/** Mirror of `CreateWishSchema` in src/types/wish.ts. Duplicated here
 *  because the Worker can't import client-side modules — the field
 *  caps (title 100 / description 500 / link 500 / address 500) and
 *  the category enum MUST stay in sync; CLAUDE.md's wish section is
 *  the single source of truth at the design level. Field-cap drift
 *  would surface as a "client says OK / Worker says 400" mismatch
 *  the user could only escape by trimming. */
const CreateWishBodySchema = z.object({
  category:    z.enum(['place', 'food']),
  title:       z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  link:        z.string().max(500).optional(),
  address:     z.string().max(500).optional(),
})
type CreateWishBody = z.infer<typeof CreateWishBodySchema>

function parseWishBody(raw: unknown): CreateWishBody {
  // Reject `image` if the caller tries to slip an image object into
  // the body — it must come from intents. Defense-in-depth: even with
  // firestore.rules tightening (Commit 4), keep this explicit so the
  // Worker layer's failure mode is a clear 400 rather than a Zod
  // `strip` silently drops + rules block at commit time.
  if (typeof raw === 'object' && raw !== null && 'image' in raw) {
    const img = (raw as { image?: unknown }).image
    if (img !== undefined && img !== null) {
      throw new WishValidationError(
        'image',
        'wish.image cannot be set directly; upload via /upload-intents and pass intentIds',
      )
    }
  }
  const parsed = CreateWishBodySchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new WishValidationError(issue.path.join('.'), issue.message)
  }
  return parsed.data
}

// ─── Authorization ─────────────────────────────────────────────────

interface TripContext {
  memberIds: string[]
}

/** Wish create authz: caller must be a member of the trip (any role
 *  including viewer — wishes are intentionally low-friction). Trip
 *  must exist and not be cascade-deleting. memberIds returned for
 *  the wish doc's denormalized field.
 *
 *  Why no proposer check on create: proposer identity is callerUid
 *  by construction here (the Worker stamps `proposedBy = callerUid`
 *  in `encodeWish`). The doc doesn't exist yet, so there's nothing
 *  to compare against — matches authorizeUpload's mode='create' branch
 *  in upload-intent.ts. */
async function authorizeWishCreateTx(
  tx:        TxContext,
  tripId:    string,
  callerUid: string,
): Promise<TripContext> {
  const [trip, member] = await Promise.all([
    tx.get(`trips/${tripId}`),
    tx.get(`trips/${tripId}/members/${callerUid}`),
  ])
  if (!trip.exists)               throw new CascadeError(404, 'trip not found')
  if ('deletingAt' in trip.fields) throw new CascadeError(410, 'trip is being deleted')
  if (!member.exists)              throw new CascadeError(403, 'caller is not a trip member')

  const role = readString(member.fields, 'role')
  if (role !== 'owner' && role !== 'editor' && role !== 'viewer') {
    throw new CascadeError(403, 'caller role invalid')
  }

  const arr = (trip.fields.memberIds as { arrayValue?: { values?: FsValue[] } } | undefined)?.arrayValue?.values ?? []
  const memberIds = arr
    .map(v => v.stringValue)
    .filter((s): s is string => typeof s === 'string')
  if (memberIds.length === 0) {
    throw new CascadeError(500, 'trip.memberIds is empty')
  }
  return { memberIds }
}

// ─── Firestore value encoder ───────────────────────────────────────

/** Encode a validated CreateWishBody + Worker-built image into Firestore
 *  REST fields. createdAt / updatedAt stamped via updateTransforms
 *  (REQUEST_TIME) — same reasoning as expense-write's encodeExpense:
 *  CF Workers' Date.now() drifts vs Firestore commit time, and the
 *  feature-badge / activity-tracking signals downstream sort by these. */
function encodeWish(
  body:      CreateWishBody,
  tripId:    string,
  memberIds: string[],
  proposer:  string,
  image:     FsValue,
): Record<string, FsValue> {
  const fields: Record<string, FsValue> = {
    tripId:     { stringValue: tripId },
    category:   { stringValue: body.category },
    title:      { stringValue: body.title },
    proposedBy: { stringValue: proposer },
    updatedBy:  { stringValue: proposer },
    memberIds:  {
      arrayValue: { values: memberIds.map(uid => ({ stringValue: uid })) },
    },
    votes: {
      // Proposer's own +1 — matches the existing client-side createWish
      // contract (`votes: [proposedBy]`). Without this, the proposer's
      // own wish wouldn't count toward sort order until they tapped the
      // heart, which is a UX surprise that's existed since v1.
      arrayValue: { values: [{ stringValue: proposer }] },
    },
    image,
  }
  if (body.description != null) fields.description = { stringValue: body.description }
  if (body.link        != null) fields.link        = { stringValue: body.link }
  if (body.address     != null) fields.address     = { stringValue: body.address }
  return fields
}

// ─── Endpoint: wish-file-create ────────────────────────────────────

export async function wishFileCreate(
  callerUid:          string,
  req:                WishFileCreateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ wishId: string }> {
  return withTokenRetry(() => doCreate(callerUid, req, serviceAccountJson, bucket))
}

async function doCreate(
  callerUid:          string,
  req:                WishFileCreateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ wishId: string }> {
  // Parse the wish body BEFORE entering the tx — Zod parse is local,
  // no value in burning a tx retry on a malformed body.
  const body = parseWishBody(req.wish)

  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  return runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const ctx = await authorizeWishCreateTx(tx, req.tripId, callerUid)

    // Consume intents inside the tx so the markUsed writes commit
    // atomically with the wish doc write. Mirrors expense-create.
    const { consumed, markUsedWrites } = await consumeEntityIntents(
      tx, req.intentIds, callerUid, accessToken, projectId, bucket,
      { tripId: req.tripId, entityType: 'wish', entityId: req.wishId },
    )

    // Build the WishImage field from intents.
    const primary = consumed.find(c => c.kind === 'full')
    if (!primary) {
      throw new WishValidationError(
        'intentIds',
        'must include a full intent (primary image missing)',
      )
    }
    const thumb = consumed.find(c => c.kind === 'thumb')
    // Wish doesn't accept PDFs — static validation in /upload-intents
    // already rejects (entityType='wish' + kind='pdf'). Defense in depth:
    // if some future change to /upload-intents accepted PDFs for wish,
    // the consumed primary would have kind !== 'full', caught above.
    const imageValue = buildAttachmentMapValue('wish', primary, thumb)

    // Create-only: tx's optimistic-concurrency catches a concurrent
    // wishId collision via currentDocument.exists=false on the write.
    // Pre-tx read here gives a clear 409 with a meaningful message
    // ahead of the commit-time conflict reason.
    const existing = await tx.get(`trips/${req.tripId}/wishes/${req.wishId}`)
    if (existing.exists) {
      throw new CascadeError(409, 'wish already exists at this id')
    }

    const fields = encodeWish(body, req.tripId, ctx.memberIds, callerUid, imageValue)

    const write: TxWrite = {
      document:        docResourceName(projectId, `trips/${req.tripId}/wishes/${req.wishId}`),
      fields,
      currentDocument: { exists: false },
      updateTransforms: [
        { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    }
    // markUsed writes go FIRST so the whole set commits atomically.
    // If the wish write 409s, intents stay pending and a retry can
    // re-consume them; if both succeed, intents are used and the
    // wish doc owns the image. No half-state.
    return {
      writes: [...markUsedWrites, write],
      result: { wishId: req.wishId },
    }
  })
}

// ─── Endpoint: wish-file-update ────────────────────────────────────

export const WishFileUpdateRequestSchema = z.object({
  tripId:    z.string().regex(TripIdRe),
  wishId:    z.string().regex(TripIdRe),
  /** Partial text patch; all fields optional. Parsed inside doUpdate
   *  so the Worker controls the field allowlist + the image-rejection
   *  defense-in-depth check (Zod's default `strip` would silently
   *  drop unknown keys; explicit reject makes the contract obvious). */
  patch:     z.unknown(),
  /** Stale-replace guard. The client passes the `image.path` value it
   *  loaded the wish with (`null` = first-attach: editor saw no image).
   *  Worker reads the current wish.image.path inside the tx and rejects
   *  with 409 on mismatch — closes the Tab-A-overwrites-Tab-B race
   *  where two editors finalize different replacements concurrently.
   *  Mirrors /booking-file-update's `expectedCurrentPath` contract;
   *  same shape on purpose so the failure mode is uniform. */
  expectedCurrentPath: z.union([z.string(), z.null()]),
  /** REQUIRED on this endpoint. Image-replace is the reason
   *  /wish-file-update exists; text-only edits stay on the client
   *  setDoc / updateDoc path (no Worker round-trip). */
  intentIds: z.array(z.string().min(1).max(60)).min(1).max(2),
})
export type WishFileUpdateRequest = z.infer<typeof WishFileUpdateRequestSchema>

/** Updatable wish text fields. Mirrors CreateWishBodySchema but all
 *  optional. `image` is NOT here — it lands via intentIds and is
 *  encoded by the Worker. `tripId` / `proposedBy` / `createdAt` /
 *  `votes` / `memberIds` are immutable from this endpoint's view. */
const UpdateWishBodySchema = z.object({
  category:    z.enum(['place', 'food']).optional(),
  title:       z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  link:        z.string().max(500).optional(),
  address:     z.string().max(500).optional(),
})
type UpdateWishBody = z.infer<typeof UpdateWishBodySchema>

const UPDATABLE_WISH_FIELDS = new Set([
  'category', 'title', 'description', 'link', 'address',
])

function parseWishUpdateBody(raw: unknown): UpdateWishBody {
  if (typeof raw !== 'object' || raw === null) {
    throw new WishValidationError('patch', 'patch must be an object')
  }
  // Reject `image` explicitly. Same reasoning as parseWishBody: even
  // with firestore.rules (Commit 4) blocking arbitrary image writes,
  // surface the rejection as a Worker 400 with a clear field path
  // rather than a rules-commit deny.
  if ('image' in raw) {
    const img = (raw as { image?: unknown }).image
    if (img !== undefined && img !== null) {
      throw new WishValidationError(
        'image',
        'patch.image cannot be set directly; upload via /upload-intents and pass intentIds (or use client updateDoc to detach by deleteField)',
      )
    }
  }
  for (const k of Object.keys(raw)) {
    if (!UPDATABLE_WISH_FIELDS.has(k)) {
      throw new WishValidationError(k, 'field is not updatable via this endpoint')
    }
  }
  const parsed = UpdateWishBodySchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new WishValidationError(issue.path.join('.'), issue.message)
  }
  return parsed.data
}

/** Wish update authz: trip exists + not deleting + caller is a member
 *  AND caller is the wish proposer AND the wish.image.path still
 *  matches what the editor loaded with (stale-replace guard).
 *  Mirrors firestore.rules' proposer-only update gate. Wish doc must
 *  exist (404 otherwise — client races a delete or guesses an id).
 *
 *  Stale-replace 409: client passes `expectedCurrentPath` = the
 *  `image.path` the editor saw on load (`null` = first-attach, editor
 *  saw no image). If the live doc has drifted (Tab B already
 *  replaced/detached), this caller's upload would silently overwrite
 *  Tab B's commit AND orphan Tab B's blob — reject so the client can
 *  re-load and re-confirm. */
async function authorizeWishUpdateTx(
  tx:                  TxContext,
  tripId:              string,
  wishId:              string,
  callerUid:           string,
  expectedCurrentPath: string | null,
): Promise<void> {
  const [trip, member, wish] = await Promise.all([
    tx.get(`trips/${tripId}`),
    tx.get(`trips/${tripId}/members/${callerUid}`),
    tx.get(`trips/${tripId}/wishes/${wishId}`),
  ])
  if (!trip.exists)               throw new CascadeError(404, 'trip not found')
  if ('deletingAt' in trip.fields) throw new CascadeError(410, 'trip is being deleted')
  if (!member.exists)              throw new CascadeError(403, 'caller is not a trip member')

  const role = readString(member.fields, 'role')
  if (role !== 'owner' && role !== 'editor' && role !== 'viewer') {
    throw new CascadeError(403, 'caller role invalid')
  }
  if (!wish.exists) {
    throw new CascadeError(404, 'wish not found')
  }
  const proposer = readString(wish.fields, 'proposedBy')
  if (proposer !== callerUid) {
    throw new CascadeError(403, 'only the wish proposer can update this wish')
  }

  // Stale-replace guard. `readNestedString` returns `undefined` when
  // the image map is absent — normalise to `null` for the comparison
  // so absent and explicit-null collapse the same way (matches the
  // client's `existingImage?.path ?? null` convention).
  const currentImagePath = readNestedString(wish.fields, 'image', 'path') ?? null
  if (currentImagePath !== expectedCurrentPath) {
    throw new CascadeError(
      409,
      'wish image has been replaced or removed since the editor loaded',
    )
  }
}

export async function wishFileUpdate(
  callerUid:          string,
  req:                WishFileUpdateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doUpdate(callerUid, req, serviceAccountJson, bucket))
}

async function doUpdate(
  callerUid:          string,
  req:                WishFileUpdateRequest,
  serviceAccountJson: string,
  bucket:             string,
): Promise<{ ok: true }> {
  // Parse the patch body BEFORE entering the tx — pure-local check, no
  // value in burning a tx retry on a malformed patch.
  const patch = parseWishUpdateBody(req.patch)

  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    await authorizeWishUpdateTx(
      tx, req.tripId, req.wishId, callerUid, req.expectedCurrentPath,
    )

    // Consume intents inside the tx so markUsed commits atomically
    // with the wish doc patch. Mirrors expense-update's pattern.
    const { consumed, markUsedWrites } = await consumeEntityIntents(
      tx, req.intentIds, callerUid, accessToken, projectId, bucket,
      { tripId: req.tripId, entityType: 'wish', entityId: req.wishId },
    )

    const primary = consumed.find(c => c.kind === 'full')
    if (!primary) {
      throw new WishValidationError(
        'intentIds',
        'must include a full intent (primary image missing)',
      )
    }
    const thumb = consumed.find(c => c.kind === 'thumb')
    const imageValue = buildAttachmentMapValue('wish', primary, thumb)

    // Build the patch field map. `image` always present (this endpoint's
    // reason for existing); text fields conditionally present per patch.
    // `updatedBy` always present so feature-badge unread tracking sees
    // the edit just like an ordinary text update.
    const patchFields: Record<string, FsValue> = {
      image:     imageValue,
      updatedBy: { stringValue: callerUid },
    }
    if (patch.category    !== undefined) patchFields.category    = { stringValue: patch.category }
    if (patch.title       !== undefined) patchFields.title       = { stringValue: patch.title }
    if (patch.description !== undefined) patchFields.description = { stringValue: patch.description }
    if (patch.link        !== undefined) patchFields.link        = { stringValue: patch.link }
    if (patch.address     !== undefined) patchFields.address     = { stringValue: patch.address }

    const write: TxWrite = {
      document:        docResourceName(projectId, `trips/${req.tripId}/wishes/${req.wishId}`),
      fields:          patchFields,
      updateMask:      Object.keys(patchFields),
      currentDocument: { exists: true },
      updateTransforms: [
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    }
    // markUsed first so the whole set commits atomically. If the wish
    // patch hits commit-conflict (concurrent edit), intents stay
    // pending and a retry can re-consume them. No half-state.
    return {
      writes: [...markUsedWrites, write],
      result: undefined,
    }
  })

  return { ok: true }
}

// `ConsumedIntent` re-exported for downstream symmetry with expense-write;
// keeps the surface aligned if future code wants to share helpers.
export type { ConsumedIntent }
