// workers/ocr/src/settlement-route-write.ts
// Routed settlement — multi-hop debt simplification, Worker-authoritative.
//
// A route ("A paid C ¥10, via B", or a debt cycle cleared with no money
// moving) is stored as ORDINARY pair settlement docs — one per leg, each on
// a real debt edge — committed in one transaction. Every leg carries the
// same `route` header map (id, kind, payer/receiver/amount, participants,
// note, foreign trio), so:
//   - the debt math (computePairwiseRemaining), orphan replay, lineage and
//     expense locks treat each leg exactly like any pair settlement;
//   - one listener sees a route atomically (no second collection to lag);
//   - old bundles that strip unknown keys still read correct balances.
// Leg doc ids are derived (routeLegId(routeId, i) over canonical leg order),
// so create is idempotent on the first leg and delete finds every leg by id.
//
// Create, inside ONE transaction:
//   authorize (receiver / offset participant / owner for departed)
//   → idempotency on leg 0 (same payload = success, else collision)
//   → FX rate + expectedFxRate CAS (network, before any ledger read)
//   → read the route's ledger: expenses paidBy IN participants, every active
//     settlement, every touched pair lock (sorted) — all fail-closed on caps
//   → per leg, in canonical order, against the ledger INCLUDING the legs
//     already applied in this route: CAS on expectedRemainingMinor, capacity,
//     lineage (appliedSources + lock set)
//   → write legs + pair locks + ONE merged lock write per expense
// Delete: any leg id → the whole route (see buildRouteDeleteWrites); a single
// leg can never be cancelled on its own, or an intermediate's net would move.
import { getAdminToken, getProjectId }                      from './admin'
import { readString, type FsValue }                         from './firestore'
import { withTokenRetry, CascadeError }                     from './cascade'
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
  computePairwiseRemaining,
  pairRemaining,
  routeLegId,
  routeParticipants,
  validateRouteShape,
  type CoreSettlement,
}                                                           from '@tripmate/settlement-core'
import { buildSettlementLineage }                           from './settlement-lineage'
import {
  SettlementValidationError,
  type SettlementRouteCreateRequest,
}                                                           from './settlement-write-shared'
import {
  EXPENSE_READ_LIMIT,
  MAX_COMMIT_WRITES,
  MAX_APPLIED_SOURCES,
  authorizeMemberTx,
  decodeSettlementForDomain,
  decodePairExpenseForSettlement,
  encodeAppliedSources,
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

export { SettlementRouteCreateRequestSchema }               from './settlement-write-shared'
export type { SettlementRouteCreateRequest }

/** Whole-trip active settlement read for a route. Matches the client's
 *  SETTLEMENT_LIST_LIMIT: a trip past it can't be listed completely by the
 *  client either, so the ledger is refused rather than computed partially. */
export const ROUTE_SETTLEMENT_READ_LIMIT = 500

type RouteLegInput = SettlementRouteCreateRequest['legs'][number]

// ─── Route header (the `route` map on every leg) ──────────────────

/** The header as decoded from a leg doc. */
export interface StoredRouteHeader {
  id:        string
  legIndex:  number
  legCount:  number
  kind:      'TRANSFER' | 'OFFSET'
}

/** `route.id` + leg position, when the settlement is a route leg. Null for
 *  an ordinary pair settlement (or a malformed header — treated as not a
 *  route only when it carries no id at all; a header with an id but broken
 *  counts is a corrupt route and must not be cancelled leg-by-leg). */
export function readRouteHeader(fields: Record<string, FsValue>): StoredRouteHeader | null {
  const route = (fields.route as { mapValue?: { fields?: Record<string, FsValue> } } | undefined)?.mapValue?.fields
  if (!route) return null
  const id = readString(route, 'id')
  if (!id) return null
  const legIndex = readInteger(route, 'legIndex')
  const legCount = readInteger(route, 'legCount')
  const kind = readString(route, 'kind')
  if (legIndex === null || legCount === null || legCount < 1 || legCount > 99
      || (kind !== 'TRANSFER' && kind !== 'OFFSET')) {
    throw new CascadeError(500, `settlement route header for ${id} is malformed`)
  }
  return { id, legIndex, legCount, kind }
}

function isForeign(req: SettlementRouteCreateRequest): req is SettlementRouteCreateRequest & ForeignIntent & { kind: 'TRANSFER' } {
  return req.kind === 'TRANSFER' && req.sourceCurrency !== undefined
}

// ─── Authorization ────────────────────────────────────────────────

/** Who may record a route. Returns true when the trip owner is recording on
 *  behalf of departed members (written as `route.ownerRecorded`).
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
  const departed = async (uid: string) =>
    ctx.formerMemberUids.includes(uid)
    && !(await tx.get(`trips/${req.tripId}/members/${uid}`)).exists
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

/** Leg 0 already exists: the route committed before (all legs land in one
 *  commit). Same payload from the same caller → success without writing;
 *  anything else is an id collision. Never touches FX or the ledger, so a
 *  retry after a lost response succeeds even with the FX provider down. */
async function routeIdempotency(
  tx:        TxContext,
  req:       SettlementRouteCreateRequest,
  legs:      RouteLegInput[],
  legIds:    string[],
  firstLeg:  TxReadDoc,
  callerUid: string,
): Promise<TxResult<RouteCreateResult>> {
  const collision = () => new SettlementValidationError(
    'routeId',
    'routeId already exists with a different payload (id collision or replay attempt)',
  )
  if (isSoftDeleted(firstLeg.fields)) {
    throw new SettlementValidationError('routeId', 'routeId already exists but has been cancelled')
  }
  const header = (firstLeg.fields.route as { mapValue?: { fields?: Record<string, FsValue> } } | undefined)?.mapValue?.fields
  if (!header) throw collision()
  const same =
       readString(header, 'id') === req.routeId
    && readString(header, 'kind') === req.kind
    && readInteger(header, 'legCount') === legs.length
    && readString(firstLeg.fields, 'settledBy') === callerUid
    && (readString(header, 'note') ?? '') === (req.note ?? '')
    && (req.kind !== 'TRANSFER' || (
         readString(header, 'payerUid') === req.payerUid
      && readString(header, 'receiverUid') === req.receiverUid
      && readInteger(header, 'amountMinor') === req.amountMinor
      && readString(header, 'sourceCurrency') === req.sourceCurrency
      && readString(header, 'settledOn') === req.settledOn))
  if (!same) throw collision()
  for (let i = 0; i < legs.length; i++) {
    const doc = i === 0 ? firstLeg : await tx.get(`trips/${req.tripId}/settlements/${legIds[i]}`)
    const leg = legs[i]!
    if (!doc.exists
        || readString(doc.fields, 'fromUid') !== leg.fromUid
        || readString(doc.fields, 'toUid') !== leg.toUid
        || readInteger(doc.fields, 'amountMinor') !== leg.amountMinor) {
      throw collision()
    }
  }
  return { writes: [], result: { routeId: req.routeId, settlementIds: legIds } }
}

// ─── Create ───────────────────────────────────────────────────────

export interface RouteCreateResult {
  routeId:       string
  settlementIds: string[]
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
  const legIds = legs.map((_, i) => routeLegId(req.routeId, i))

  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  return runFirestoreTransaction(accessToken, projectId, async (tx) => {
    const ctx = await authorizeMemberTx(tx, req.tripId, callerUid)
    const ownerRecorded = await authorizeRoute(tx, req, ctx, callerUid, participants)

    const firstLeg = await tx.get(`trips/${req.tripId}/settlements/${legIds[0]}`)
    if (firstLeg.exists) return routeIdempotency(tx, req, legs, legIds, firstLeg, callerUid)

    // FX before any ledger doc enters the read set: a slow provider must not
    // hold the hot docs' conflict window open (same reasoning as the pair
    // endpoint). An FX failure here is definitively pre-commit.
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
      tx.runQuery({
        parent:     `trips/${req.tripId}`,
        collection: 'settlements',
        filters:    [{ fieldPath: 'deletedAt', op: 'IS_NULL' }],
        limit:      ROUTE_SETTLEMENT_READ_LIMIT + 1,
      }),
    ])
    // Pair locks one by one in sorted key order: two routes sharing pairs
    // always touch them in the same order.
    const lockPaths = [...new Set(legs.map(l => pairLockPath(req.tripId, l.fromUid, l.toUid)))].sort()
    for (const path of lockPaths) await tx.get(path)

    if (expenseReads.length > EXPENSE_READ_LIMIT) {
      throw new CascadeError(409, 'too many expenses to compute this route safely', 'PAIR_LEDGER_TOO_LARGE')
    }
    if (settlementReads.length > ROUTE_SETTLEMENT_READ_LIMIT) {
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
    const settlements = settlementReads.map(d => decodeSettlementForDomain(d.fields))

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
      // in foreign money), so the foreign trio lives on the route header only.
      foreign = deriveForeignArtifacts(req, ctx, req.amountMinor, foreignRate!)
      if (foreign.sourceAmountMinor <= 0) {
        throw new SettlementValidationError('sourceCurrency', 'amount is too small to settle in the chosen source currency')
      }
    }

    const header: Record<string, FsValue> = {
      id:              { stringValue: req.routeId },
      kind:            { stringValue: req.kind },
      legCount:        { integerValue: String(legs.length) },
      participantUids: encodeStringArray(participants),
    }
    if (req.kind === 'TRANSFER') {
      header.payerUid    = { stringValue: req.payerUid }
      header.receiverUid = { stringValue: req.receiverUid }
      header.amountMinor = { integerValue: String(req.amountMinor) }
    }
    if (ownerRecorded) header.ownerRecorded = { booleanValue: true }
    if (req.note != null && req.note !== '') header.note = { stringValue: req.note }
    if (foreign) {
      header.sourceCurrency    = { stringValue:  foreign.sourceCurrency }
      header.sourceAmountMinor = { integerValue: String(foreign.sourceAmountMinor) }
      header.settledOn         = { stringValue:  foreign.settledOn }
      header.fxSnapshot        = encodeFxSnapshot(foreign.fxSnapshot)
    }

    const legWrites: TxWrite[] = legs.map((leg, i) => {
      const lineage = legLineage[i]!
      const fields: Record<string, FsValue> = {
        tripId:      { stringValue: req.tripId },
        fromUid:     { stringValue: leg.fromUid },
        toUid:       { stringValue: leg.toUid },
        amountMinor: { integerValue: String(leg.amountMinor) },
        currency:    { stringValue: ctx.currency },
        settledBy:   { stringValue: callerUid },
        deletedAt:   { nullValue: null },
        route:       { mapValue: { fields: { ...header, legIndex: { integerValue: String(i) } } } },
      }
      const sources = lineage.appliedSources.slice(0, MAX_APPLIED_SOURCES)
      if (sources.length > 0) fields.appliedSources = encodeAppliedSources(sources)
      if (lineage.lockExpenseIds.length > 0) fields.appliedExpenseIds = encodeStringArray(lineage.lockExpenseIds)
      const updateTransforms: NonNullable<TxUpdateWrite['updateTransforms']> = [
        { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
      ]
      if (foreign) updateTransforms.push({ fieldPath: 'route.fxSnapshot.fetchedAt', setToServerValue: 'REQUEST_TIME' })
      return {
        document:        docResourceName(projectId, `trips/${req.tripId}/settlements/${legIds[i]}`),
        fields,
        currentDocument: { exists: false },
        updateTransforms,
      }
    })

    const lockWrites = lockPaths.map(path => buildLockWrite(projectId, path, legIds[0]!))

    // ONE write per expense carrying every leg id that locks it. Two legs
    // (A→B and C→B) can lock the same expense B paid; two separate writes
    // of the field in one commit would let the second overwrite the first
    // and silently drop a lock id.
    const lockersByExpense = new Map<string, string[]>()
    legLineage.forEach((lineage, i) => {
      for (const expenseId of lineage.lockExpenseIds) {
        const list = lockersByExpense.get(expenseId) ?? []
        list.push(legIds[i]!)
        lockersByExpense.set(expenseId, list)
      }
    })
    const currentLocks = new Map(activeExpenseReads.map((d, i) => [
      pairExpenses[i]!.id,
      decodeStringArrayField(d.fields, 'settlementLockIds'),
    ]))
    const expenseLockWrites: TxWrite[] = [...lockersByExpense.keys()].sort().map(expenseId => {
      const existing = currentLocks.get(expenseId) ?? []
      const next = [...existing, ...lockersByExpense.get(expenseId)!.filter(id => !existing.includes(id))]
      return {
        document:        docResourceName(projectId, `trips/${req.tripId}/expenses/${expenseId}`),
        fields:          { settlementLockIds: encodeStringArray(next) },
        updateMask:      ['settlementLockIds'],
        currentDocument: { exists: true },
      }
    })

    const writes = [...legWrites, ...lockWrites, ...expenseLockWrites]
    if (writes.length > MAX_COMMIT_WRITES) {
      throw new CascadeError(409, 'this route locks too many expenses to record in one atomic write', 'PAIR_LEDGER_TOO_LARGE')
    }
    return { writes, result: { routeId: req.routeId, settlementIds: legIds } }
  })
}

// ─── Delete (called from /settlement-delete) ──────────────────────

/** Writes that cancel a WHOLE route, given any one of its legs (already
 *  read and authorized by the caller). All legs are soft-deleted together,
 *  every pair lock is touched in sorted order, and each locked expense
 *  loses every one of this route's leg ids in a single write. Legs already
 *  cancelled are skipped, so a repeat is a no-op. */
export async function buildRouteDeleteWrites(
  tx:        TxContext,
  projectId: string,
  tripId:    string,
  header:    StoredRouteHeader,
  callerUid: string,
): Promise<TxWrite[]> {
  const legIds = Array.from({ length: header.legCount }, (_, i) => routeLegId(header.id, i))
  const legDocs: Array<{ id: string; doc: TxReadDoc }> = []
  for (const id of legIds) legDocs.push({ id, doc: await tx.get(`trips/${tripId}/settlements/${id}`) })
  const active = legDocs.filter(({ doc }) => doc.exists && !isSoftDeleted(doc.fields))
  if (active.length === 0) return []

  const lockPaths = [...new Set(active.map(({ doc }) =>
    pairLockPath(tripId, readString(doc.fields, 'fromUid') ?? '', readString(doc.fields, 'toUid') ?? '')))].sort()
  for (const path of lockPaths) await tx.get(path)

  const routeLegIds = new Set(legIds)
  const expenseIds = [...new Set(active.flatMap(({ doc }) => decodeStringArrayField(doc.fields, 'appliedExpenseIds')))].sort()
  const unlockWrites: TxWrite[] = []
  for (const expenseId of expenseIds) {
    const doc = await tx.get(`trips/${tripId}/expenses/${expenseId}`)
    if (!doc.exists) continue
    const existing = decodeStringArrayField(doc.fields, 'settlementLockIds')
    const next = existing.filter(id => !routeLegIds.has(id))
    if (next.length === existing.length) continue
    unlockWrites.push({
      document:        docResourceName(projectId, `trips/${tripId}/expenses/${expenseId}`),
      fields:          { settlementLockIds: encodeStringArray(next) },
      updateMask:      ['settlementLockIds'],
      currentDocument: { exists: true },
    })
  }

  const softDeletes: TxWrite[] = active.map(({ id }) => ({
    document:        docResourceName(projectId, `trips/${tripId}/settlements/${id}`),
    fields:          { deletedBy: { stringValue: callerUid } },
    updateMask:      ['deletedBy'],
    currentDocument: { exists: true },
    updateTransforms: [{ fieldPath: 'deletedAt', setToServerValue: 'REQUEST_TIME' }],
  }))
  const lockWrites = lockPaths.map(path => buildLockWrite(projectId, path, legIds[0]!))
  const writes = [...softDeletes, ...lockWrites, ...unlockWrites]
  if (writes.length > MAX_COMMIT_WRITES) {
    throw new CascadeError(409, 'this route locks too many expenses to cancel in one atomic write', 'PAIR_LEDGER_TOO_LARGE')
  }
  return writes
}
