// workers/ocr/src/settlement-route-write.ts
// Settlement writes — Worker-authoritative. Every settlement is a ROUTE:
// "A paid C ¥10, via B", a debt cycle cleared with no money moving, or
// simply "A paid B" (a one-leg route). One route = ONE doc,
// trips/{tripId}/settlements/{routeId}:
//
//   legs[]            the ledger: ordinary from → to clears on real debt
//                     edges, in canonical order (canonicalRouteLegs)
//   payer / receiver / amount, foreign trio, note    TRANSFER header
//   appliedSources[]  display lineage, flattened, each tagged legIndex;
//                     trimmed to MAX_ROUTE_APPLIED_SOURCES across the route
//   lockedExpenses[]  the complete lock set, each expense once with the legs
//                     that lock it — expense.settlementLockIds holds this
//                     route's id for every one of them
//
// One doc, so a listener can never see half a route, a cancel is one
// write, and a notification fires once. The debt math reads `legs` only
// (projected query), so other routes' lineage never enters the ledger read.
//
// Create, inside ONE transaction:
//   authorize (receiver / offset participant / owner for departed)
//   → idempotency on the route doc (same payload = success, else collision)
//   → FX rate + expectedFxRate CAS (network, before any ledger read)
//   → read the route's ledger: expenses paidBy IN participants, every active
//     settlement's legs, every touched pair lock (sorted) — fail-closed caps
//   → per leg, in canonical order, against the ledger INCLUDING the legs
//     already applied in this route: CAS on expectedRemainingMinor, capacity,
//     lineage
//   → write the route doc + pair locks + ONE lock write per expense
// Delete (/settlement-delete): the route doc, as a whole — a single leg can
// never be cancelled on its own, or an intermediate's net would move.
import { getAdminToken, getProjectId }                      from './admin'
import { readString, type FsValue }                         from './firestore'
import { withTokenRetry, CascadeError }                     from './cascade'
import { checkTripAccess }                                  from './membership-shared'
import {
  runFirestoreTransaction,
  docResourceName,
  type TxContext,
  type TxWrite,
  type TxUpdateWrite,
  type TxReadDoc,
  type TxResult,
}                                                           from './firestore-tx'
import {
  canonicalRouteLegs,
  capRouteSources,
  computePairwiseRemaining,
  pairRemaining,
  routeParticipants,
  validateRouteShape,
  type CoreSettlement,
}                                                           from '@tripmate/settlement-core'
import { buildSettlementLineage }                           from './settlement-lineage'
import { documentSize }                                     from './firestore-size'
import {
  SettlementValidationError,
  type SettlementRouteCreateRequest,
  type SettlementDeleteRequest,
}                                                           from './settlement-write-shared'
import {
  EXPENSE_READ_LIMIT,
  MAX_COMMIT_WRITES,
  authorizeMemberTx,
  decodeLockedExpenseIds,
  decodeSettlementLegs,
  decodePairExpenseForSettlement,
  encodeAppliedSources,
  encodeLockedExpenses,
  readInteger,
  isSoftDeleted,
}                                                           from './settlement-codec'
import {
  resolveForeignRate,
  deriveForeignArtifacts,
  encodeFxSnapshot,
  type ForeignIntent,
  type ForeignRate,
}                                                           from './settlement-fx-write'
import {
  pairLockPath,
  buildLockWrite,
  encodeStringArray,
  decodeStringArrayField,
}                                                           from './settlement-lock-write'

export {
  SettlementRouteCreateRequestSchema,
  SettlementDeleteRequestSchema,
  SettlementValidationError,
}                                                           from './settlement-write-shared'
export type { SettlementRouteCreateRequest, SettlementDeleteRequest }

/** Whole-trip active settlement read. Matches the client's
 *  SETTLEMENT_LIST_LIMIT: a trip past it can't be listed completely by the
 *  client either, so the ledger is refused rather than computed partially. */
export const SETTLEMENT_READ_LIMIT = 500

/** Ceiling for the route doc's stored size (firestore-size.ts), with
 *  headroom under Firestore's 1 MiB. The read caps and
 *  MAX_ROUTE_APPLIED_SOURCES keep even the largest route well below it
 *  (pinned by a worst-case test); this is the backstop that turns a
 *  miscount into a clean refusal instead of a commit Firestore rejects. */
export const SETTLEMENT_DOC_BYTES_MAX = 1_000_000

type RouteLegInput = SettlementRouteCreateRequest['legs'][number]

function isForeign(req: SettlementRouteCreateRequest): req is SettlementRouteCreateRequest & ForeignIntent & { kind: 'TRANSFER' } {
  return req.kind === 'TRANSFER' && req.sourceCurrency !== undefined
}

const settlementPath = (tripId: string, routeId: string) => `trips/${tripId}/settlements/${routeId}`

// ─── Authorization ────────────────────────────────────────────────

/** Who may record a route. Returns true when the trip owner is recording on
 *  behalf of departed members (written as `ownerRecorded`).
 *
 *    TRANSFER — the receiver (they confirm they got the money); or the
 *               owner when the receiver has LEFT the trip, since nobody
 *               else could ever clear debts owed to them. Payer and
 *               intermediates may be anyone on the ledger, departed or not:
 *               the payer's debt outlives their membership, and an
 *               intermediate's net does not move.
 *    OFFSET   — any participant (their net does not move either, and the
 *               route is one connected component, so they can only clear
 *               cycles they are part of); or the owner when every
 *               participant has left.
 *  "Departed" = recorded in trip.formerMemberNames AND no member doc. A
 *  departed member never regains any membership operation here — they
 *  only appear as ledger parties. */
async function authorizeRoute(
  tx:           TxContext,
  req:          SettlementRouteCreateRequest,
  ctx:          { ownerId: string | undefined; formerMemberUids: string[] },
  callerUid:    string,
  participants: string[],
): Promise<boolean> {
  // Reads OTHER parties' member docs; the caller's own access already went
  // through requireTripAccess (authorizeMemberTx).
  const departed = async (memberUid: string) =>
    ctx.formerMemberUids.includes(memberUid)
    && !(await tx.get(`trips/${req.tripId}/members/${memberUid}`)).exists
  const isOwner = ctx.ownerId === callerUid

  if (req.kind === 'TRANSFER') {
    if (req.receiverUid === callerUid) return false
    if (isOwner && await departed(req.receiverUid)) return true
    throw new SettlementValidationError(
      'receiverUid',
      'only the receiver may record a payment (the trip owner may record for a receiver who has left the trip)',
    )
  }

  if (participants.includes(callerUid)) return false
  if (isOwner) {
    let allDeparted = true
    for (const uid of participants) {
      if (!(await departed(uid))) { allDeparted = false; break }
    }
    if (allDeparted) return true
  }
  throw new SettlementValidationError(
    'legs',
    'only someone in this offset may record it (the trip owner may record it when everyone in it has left the trip)',
  )
}

// ─── Idempotency ──────────────────────────────────────────────────

/** The route doc already exists: same payload from the same caller →
 *  success without writing (a retry after a lost response); anything else
 *  is an id collision. Never touches FX or the ledger, so the retry
 *  succeeds even with the FX provider down. */
function routeIdempotency(
  req:       SettlementRouteCreateRequest,
  legs:      RouteLegInput[],
  existing:  TxReadDoc,
  callerUid: string,
): TxResult<RouteCreateResult> {
  if (isSoftDeleted(existing.fields)) {
    throw new SettlementValidationError('routeId', 'routeId already exists but has been cancelled')
  }
  const f = existing.fields
  const stored = (() => {
    try { return decodeSettlementLegs(f) } catch { return null }
  })()
  const same =
       stored !== null
    && stored.length === legs.length
    && stored.every((leg, i) =>
         leg.fromUid === legs[i]!.fromUid && leg.toUid === legs[i]!.toUid && leg.amountMinor === legs[i]!.amountMinor)
    && readString(f, 'kind') === req.kind
    && readString(f, 'settledBy') === callerUid
    && (readString(f, 'note') ?? '') === (req.note ?? '')
    && (req.kind !== 'TRANSFER' || (
         readString(f, 'payerUid') === req.payerUid
      && readString(f, 'receiverUid') === req.receiverUid
      && readInteger(f, 'amountMinor') === req.amountMinor
      && readString(f, 'sourceCurrency') === req.sourceCurrency
      && readString(f, 'settledOn') === req.settledOn))
  if (!same) {
    throw new SettlementValidationError(
      'routeId',
      'routeId already exists with a different payload (id collision or replay attempt)',
    )
  }
  return { writes: [], result: { routeId: req.routeId } }
}

// ─── Create ───────────────────────────────────────────────────────

export interface RouteCreateResult {
  routeId: string
}

export async function settlementRouteCreate(
  callerUid:          string,
  req:                SettlementRouteCreateRequest,
  serviceAccountJson: string,
): Promise<RouteCreateResult> {
  return withTokenRetry(() => doRouteCreate(callerUid, req, serviceAccountJson))
}

async function doRouteCreate(
  callerUid:          string,
  req:                SettlementRouteCreateRequest,
  serviceAccountJson: string,
): Promise<RouteCreateResult> {
  // Structural invariants first: pure, no reads. The client's route is a
  // proposal; nothing about it is trusted beyond what is re-checked here
  // and against the ledger below.
  const legs = canonicalRouteLegs(req.legs)
  const shapeError = validateRouteShape(req.kind === 'TRANSFER'
    ? { kind: 'TRANSFER', payerUid: req.payerUid, receiverUid: req.receiverUid, amountMinor: req.amountMinor, legs }
    : { kind: 'OFFSET', legs })
  if (shapeError) {
    throw new SettlementValidationError('legs', `invalid route: ${shapeError}`)
  }
  const participants = routeParticipants(legs)
  const docPath = settlementPath(req.tripId, req.routeId)

  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  return runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const ctx = await authorizeMemberTx(tx, req.tripId, callerUid)
    const ownerRecorded = await authorizeRoute(tx, req, ctx, callerUid, participants)

    const existing = await tx.get(docPath)
    if (existing.exists) return routeIdempotency(req, legs, existing, callerUid)

    // FX before any ledger doc enters the read set: a slow provider must not
    // hold the hot docs' conflict window open. An FX failure here is
    // definitively pre-commit.
    let foreignRate: ForeignRate | undefined
    if (isForeign(req)) foreignRate = await resolveForeignRate(req, ctx, serviceAccountJson)

    const participantValues: FsValue = { arrayValue: { values: participants.map(uid => ({ stringValue: uid })) } }
    const [expenseReads, settlementReads] = await Promise.all([
      // Every expense that can create debt between two route participants
      // is paid by one of them — complete for every leg's pair.
      tx.runQuery({
        parent:     `trips/${req.tripId}`,
        collection: 'expenses',
        filters:    [{ fieldPath: 'paidBy', op: 'IN', value: participantValues }],
        limit:      EXPENSE_READ_LIMIT + 1,
      }),
      // The ledger needs each settlement's legs and order, nothing else:
      // other routes' lineage never enters this read.
      tx.runQuery({
        parent:     `trips/${req.tripId}`,
        collection: 'settlements',
        filters:    [{ fieldPath: 'deletedAt', op: 'IS_NULL' }],
        select:     ['legs', 'createdAt'],
        limit:      SETTLEMENT_READ_LIMIT + 1,
      }),
    ])
    // Pair locks one by one in sorted key order: two routes sharing pairs
    // always touch them in the same order.
    const lockPaths = [...new Set(legs.map(l => pairLockPath(req.tripId, l.fromUid, l.toUid)))].sort()
    for (const path of lockPaths) await tx.get(path)

    if (expenseReads.length > EXPENSE_READ_LIMIT) {
      throw new CascadeError(409, 'too many expenses to compute this route safely', 'PAIR_LEDGER_TOO_LARGE')
    }
    if (settlementReads.length > SETTLEMENT_READ_LIMIT) {
      throw new CascadeError(409, 'too many settlements to compute this route safely', 'PAIR_LEDGER_TOO_LARGE')
    }

    const activeExpenseReads = expenseReads
      .filter(d => !(d.fields.deletedAt as { timestampValue?: string } | undefined)?.timestampValue)
    const pairKeys = new Set(legs.map(l => [l.fromUid, l.toUid].sort().join('\u0000')))
    const touchesLegPair = (paidBy: string, splitUids: string[]) =>
      splitUids.some(uid => uid !== paidBy && pairKeys.has([paidBy, uid].sort().join('\u0000')))
    const pairExpenses = activeExpenseReads.map(decodePairExpenseForSettlement)
    // Never add up minor units of different currencies on any leg's pair.
    activeExpenseReads.forEach((d, i) => {
      const currency = readString(d.fields, 'currency')
      const e = pairExpenses[i]!
      if (currency !== undefined && currency !== ctx.currency && touchesLegPair(e.paidBy, e.splits.map(s => s.memberId))) {
        throw new CascadeError(
          409,
          `route ledger contains an expense recorded in ${currency} but the trip currency is ${ctx.currency}`,
          'LEDGER_CURRENCY_MISMATCH',
        )
      }
    })
    const coreExpenses = pairExpenses.map(e => ({ amountMinor: e.amountMinor, paidBy: e.paidBy, splits: e.splits }))
    const settlements = settlementReads.flatMap(d => decodeSettlementLegs(d.fields))

    // Sequential consumption: each leg is checked and attributed against the
    // ledger with this route's earlier legs already applied, so a later
    // consumption of the same debt can never re-use what an earlier one took.
    const applied: CoreSettlement[] = []
    const after = settlements.reduce((max, s) => Math.max(max, s.createdAtMs), 0) + 1
    const legLineage = legs.map((leg, i) => {
      const ledger = [...settlements, ...applied]
      const remaining = pairRemaining(computePairwiseRemaining(coreExpenses, ledger), leg.fromUid, leg.toUid)
      if (remaining !== leg.expectedRemainingMinor || leg.amountMinor > remaining) {
        throw new CascadeError(409, 'settlement suggestion is stale; refresh balances and retry', 'SETTLEMENT_STALE')
      }
      const inPair = (a: string, b: string) =>
        (a === leg.fromUid && b === leg.toUid) || (a === leg.toUid && b === leg.fromUid)
      const lineage = buildSettlementLineage(
        pairExpenses.filter(e => e.paidBy === leg.fromUid || e.paidBy === leg.toUid),
        ledger.filter(s => inPair(s.fromUid, s.toUid)),
        leg.fromUid,
        leg.toUid,
        leg.amountMinor,
      )
      applied.push({ fromUid: leg.fromUid, toUid: leg.toUid, amountMinor: leg.amountMinor, createdAtMs: after + i })
      return lineage
    })

    let foreign: ReturnType<typeof deriveForeignArtifacts> | undefined
    if (isForeign(req)) {
      // The receiver got `amountMinor` worth of trip currency in another
      // currency; the legs stay in trip currency (nobody in the middle paid
      // in foreign money), so the foreign trio describes the route only.
      foreign = deriveForeignArtifacts(req, ctx, req.amountMinor, foreignRate!)
      if (foreign.sourceAmountMinor <= 0) {
        throw new SettlementValidationError('sourceCurrency', 'amount is too small to settle in the chosen source currency')
      }
    }

    const sources = capRouteSources(legLineage.map(l => l.appliedSources))
    const locked = encodeLockedExpenses(legLineage.map(l => l.lockExpenseIds))

    const fields: Record<string, FsValue> = {
      tripId:          { stringValue: req.tripId },
      kind:            { stringValue: req.kind },
      currency:        { stringValue: ctx.currency },
      participantUids: encodeStringArray(participants),
      legs: {
        arrayValue: {
          values: legs.map(leg => ({ mapValue: { fields: {
            fromUid:     { stringValue: leg.fromUid },
            toUid:       { stringValue: leg.toUid },
            amountMinor: { integerValue: String(leg.amountMinor) },
          } } })),
        },
      },
      settledBy:       { stringValue: callerUid },
      deletedAt:       { nullValue: null },
    }
    if (req.kind === 'TRANSFER') {
      fields.payerUid    = { stringValue: req.payerUid }
      fields.receiverUid = { stringValue: req.receiverUid }
      fields.amountMinor = { integerValue: String(req.amountMinor) }
    }
    if (ownerRecorded) fields.ownerRecorded = { booleanValue: true }
    if (req.note != null && req.note !== '') fields.note = { stringValue: req.note }
    if (foreign) {
      fields.sourceCurrency    = { stringValue:  foreign.sourceCurrency }
      fields.sourceAmountMinor = { integerValue: String(foreign.sourceAmountMinor) }
      fields.settledOn         = { stringValue:  foreign.settledOn }
      fields.fxSnapshot        = encodeFxSnapshot(foreign.fxSnapshot)
    }
    if (sources.some(list => list.length > 0)) fields.appliedSources = encodeAppliedSources(sources)
    if (locked.ids.length > 0) fields.lockedExpenses = locked.value

    const updateTransforms: NonNullable<TxUpdateWrite['updateTransforms']> = [
      { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
    ]
    if (foreign) updateTransforms.push({ fieldPath: 'fxSnapshot.fetchedAt', setToServerValue: 'REQUEST_TIME' })
    if (documentSize(docPath, fields, updateTransforms.map(t => t.fieldPath)) > SETTLEMENT_DOC_BYTES_MAX) {
      throw new CascadeError(409, 'this settlement is too large to store as one record', 'PAIR_LEDGER_TOO_LARGE')
    }
    const routeWrite: TxWrite = {
      document:        docResourceName(projectId, docPath),
      fields,
      currentDocument: { exists: false },
      updateTransforms,
    }

    const lockWrites = lockPaths.map(path => buildLockWrite(projectId, path, req.routeId))

    // ONE write per locked expense, adding this route's id once however many
    // of its legs lock the expense.
    const currentLocks = new Map(activeExpenseReads.map((d, i) => [
      pairExpenses[i]!.id,
      decodeStringArrayField(d.fields, 'settlementLockIds'),
    ]))
    const expenseLockWrites: TxWrite[] = locked.ids.map(expenseId => {
      const existingLocks = currentLocks.get(expenseId) ?? []
      return {
        document:        docResourceName(projectId, `trips/${req.tripId}/expenses/${expenseId}`),
        fields:          { settlementLockIds: encodeStringArray([...existingLocks.filter(id => id !== req.routeId), req.routeId]) },
        updateMask:      ['settlementLockIds'],
        currentDocument: { exists: true },
      }
    })

    const writes = [routeWrite, ...lockWrites, ...expenseLockWrites]
    if (writes.length > MAX_COMMIT_WRITES) {
      throw new CascadeError(409, 'this route locks too many expenses to record in one atomic write', 'PAIR_LEDGER_TOO_LARGE')
    }
    return { writes, result: { routeId: req.routeId } }
  })
}

// ─── Delete: /settlement-delete ───────────────────────────────────

/** Cancel a route — the whole doc, every leg at once. Recorder (settledBy)
 *  or the trip owner. Missing / already-cancelled → no-op success, so a
 *  double tap or a retry after a lost response is harmless. */
export async function settlementDelete(
  callerUid:          string,
  req:                SettlementDeleteRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  return withTokenRetry(() => doDelete(callerUid, req, serviceAccountJson))
}

async function doDelete(
  callerUid:          string,
  req:                SettlementDeleteRequest,
  serviceAccountJson: string,
): Promise<{ ok: true }> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)
  const docPath     = settlementPath(req.tripId, req.settlementId)

  await runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const [trip, member, settlement] = await Promise.all([
      tx.get(`trips/${req.tripId}`),
      tx.get(`trips/${req.tripId}/members/${callerUid}`),
      tx.get(docPath),
    ])
    checkTripAccess(trip.exists ? trip.fields : null, member.exists ? member.fields : null, callerUid)
    if (!settlement.exists) return { writes: [], result: undefined }

    // Owner from trip.ownerId — the same source of truth as every other
    // Worker endpoint (members/{uid}.role could drift from it).
    const isOwner    = readString(trip.fields, 'ownerId') === callerUid
    const isRecorder = readString(settlement.fields, 'settledBy') === callerUid
    if (!isOwner && !isRecorder) {
      throw new CascadeError(403, 'only the recorder (settledBy) or trip owner may delete a settlement')
    }
    // After authz, so a stranger can't probe cancellation state.
    if (isSoftDeleted(settlement.fields)) return { writes: [], result: undefined }

    // Fail-closed: a doc without decodable legs is corrupt (500), never
    // cancelled without knowing which pairs it touched.
    const legs = decodeSettlementLegs(settlement.fields)
    const lockPaths = [...new Set(legs.map(l => pairLockPath(req.tripId, l.fromUid, l.toUid)))].sort()
    for (const path of lockPaths) await tx.get(path)

    const unlockWrites: TxWrite[] = []
    for (const expenseId of decodeLockedExpenseIds(settlement.fields)) {
      const doc = await tx.get(`trips/${req.tripId}/expenses/${expenseId}`)
      if (!doc.exists) continue
      const existingLocks = decodeStringArrayField(doc.fields, 'settlementLockIds')
      if (!existingLocks.includes(req.settlementId)) continue
      unlockWrites.push({
        document:        docResourceName(projectId, `trips/${req.tripId}/expenses/${expenseId}`),
        fields:          { settlementLockIds: encodeStringArray(existingLocks.filter(id => id !== req.settlementId)) },
        updateMask:      ['settlementLockIds'],
        currentDocument: { exists: true },
      })
    }

    const softDelete: TxWrite = {
      document:         docResourceName(projectId, docPath),
      fields:           { deletedBy: { stringValue: callerUid } },
      updateMask:       ['deletedBy'],
      currentDocument:  { exists: true },
      updateTransforms: [{ fieldPath: 'deletedAt', setToServerValue: 'REQUEST_TIME' }],
    }
    const lockWrites = lockPaths.map(path => buildLockWrite(projectId, path, req.settlementId))
    const writes = [softDelete, ...lockWrites, ...unlockWrites]
    if (writes.length > MAX_COMMIT_WRITES) {
      throw new CascadeError(409, 'this route locks too many expenses to cancel in one atomic write', 'PAIR_LEDGER_TOO_LARGE')
    }
    return { writes, result: undefined }
  })
  return { ok: true }
}
