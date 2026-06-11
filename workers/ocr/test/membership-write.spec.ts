// Endpoint-level tests for membership-write.ts.
//
// The three endpoints under test share the settlement-write tx-mock
// strategy: stub runFirestoreTransaction so each test seeds tx.get
// responses per-path and captures the TxResult to assert on the writes
// list. The non-tx REST helpers used by /member-remove
// (listDocNames + batchArrayRemoveMemberIds + deleteDoc) and the
// /invite-redeem post-tx cascade (cascadeMemberAdd) are mocked
// separately so each can be asserted independently.
//
// Critical invariant under test (file header rationale in
// membership-write.ts): /member-remove MUST strip ACL projection
// BEFORE deleting the member doc. A reversed sequence would leave a
// kicked user with a stale memberIds entry on every subcollection doc
// and let them keep reading via collection-group queries. This is the
// only place that load-bearing order shows up at the assertion layer.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo'),
	invalidateAdminToken: vi.fn(),
}))

interface MockReadDoc {
	exists:     boolean
	fields:     Record<string, unknown>
	name:       string
	updateTime: string | null
}

const txGetResponses = new Map<string, MockReadDoc>()
const txGetCalls: string[] = []
let capturedTxResult: { writes: unknown[]; result: unknown } | null = null

vi.mock('../src/firestore-tx', () => ({
	runFirestoreTransaction: vi.fn(async (_token, _pid, body) => {
		const ctx = {
			get: async (path: string) => {
				txGetCalls.push(path)
				const resp = txGetResponses.get(path)
				if (resp) return resp
				// /invite-redeem reads inviteState/current on EVERY tx (the
				// single-active gate). Default it to a valid pointer naming the
				// happy-path token so the pre-existing redeem tests don't each
				// need a 4th explicit seed; the gate-specific tests (missing /
				// mismatched) and the create/revoke tests seed this path
				// explicitly to override. Inline literal token ('a'×64 ==
				// VALID_TOK) avoids a vi.mock-factory out-of-scope reference.
				if (path.endsWith('/inviteState/current')) {
					return {
						exists:     true,
						name:       `projects/demo/databases/(default)/documents/${path}`,
						updateTime: '2026-05-28T00:00:00Z',
						fields:     { token: { stringValue: 'a'.repeat(64) }, role: { stringValue: 'editor' } },
					}
				}
				throw new Error(`unexpected tx.get('${path}') -- not seeded`)
			},
			runQuery: async () => [],
		}
		const result = await body(ctx)
		capturedTxResult = result
		return result.result
	}),
	docResourceName: (pid: string, path: string) =>
		`projects/${pid}/databases/(default)/documents/${path}`,
}))

// Non-tx REST helpers used by /member-remove cascade phase. Each is
// recorded so tests can assert call ordering (strip-before-delete).
// `batchRemoveDocs` captures the docNames argument so individual
// tests can assert membership / absence (specifically: the trip doc
// MUST NOT be in this batch -- its memberIds is stripped inside the
// precheck tx instead).
const restCallOrder: string[] = []
let batchRemoveDocs: string[] = []
vi.mock('../src/firestore', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
	return {
		...actual,
		listDocNames: vi.fn(async (_t: string, _p: string, parent: string) => {
			restCallOrder.push(`listDocNames:${parent}`)
			// Return one fake subdoc per subcollection so the batchArrayRemove
			// receives a non-empty list (otherwise the implementation might
			// short-circuit). The exact name shape doesn't matter for the
			// ordering assertion -- it just needs to be a plausible doc path.
			return [`projects/demo/databases/(default)/documents/${parent}/doc-1`]
		}),
		batchArrayRemoveMemberIds: vi.fn(async (_t: string, _p: string, docNames: string[], uid: string) => {
			restCallOrder.push(`batchArrayRemoveMemberIds:${docNames.length}:${uid}`)
			batchRemoveDocs = [...docNames]
		}),
		deleteDoc: vi.fn(async (_t: string, _p: string, path: string) => {
			restCallOrder.push(`deleteDoc:${path}`)
		}),
		buildDocName: (projectId: string, path: string) =>
			`projects/${projectId}/databases/(default)/documents/${path}`,
	}
})

// Pass withTokenRetry straight through (its retry policy is tested in
// cascade.spec.ts). Stub cascadeMemberAdd: just record + resolve, real
// implementation needs full REST mocks we don't want to wire here.
const cascadeCalls: Array<{ tripId: string; memberUid: string }> = []
vi.mock('../src/cascade', async () => {
	const actual = await vi.importActual<typeof import('../src/cascade')>('../src/cascade')
	return {
		...actual,
		withTokenRetry:    <T,>(fn: () => Promise<T>) => fn(),
		cascadeMemberAdd:  vi.fn(async (_uid: string, req: { tripId: string; memberUid: string }) => {
			cascadeCalls.push({ tripId: req.tripId, memberUid: req.memberUid })
			return { updatedDocs: 1 }
		}),
	}
})

import {
	inviteCreate,
	inviteRevoke,
	inviteRedeem,
	memberRemove,
	memberRoleUpdate,
	InviteCreateRequestSchema,
	InviteRevokeRequestSchema,
	MembershipValidationError,
} from '../src/membership-write'
import { CascadeError } from '../src/cascade'

const TRIP_ID    = 'trip-1'
const OWNER_UID  = 'owner-uid'
const INVITEE    = 'invitee-uid'
const VALID_TOK  = 'a'.repeat(64)
const DISPLAY    = 'Invitee'

// ─── Fixture builders (REST `fields` shape) ───────────────────────

function tripReadDoc(opts: { ownerId?: string; memberIds?: string[]; deleting?: boolean; title?: string; icon?: string } = {}): MockReadDoc {
	const fields: Record<string, unknown> = {
		ownerId: { stringValue: opts.ownerId ?? OWNER_UID },
	}
	if (opts.memberIds) {
		fields.memberIds = {
			arrayValue: { values: opts.memberIds.map(u => ({ stringValue: u })) },
		}
	}
	if (opts.title !== undefined) fields.title = { stringValue: opts.title }
	if (opts.icon  !== undefined) fields.icon  = { stringValue: opts.icon }
	if (opts.deleting) {
		fields.deletingAt = { timestampValue: '2026-05-28T00:00:00Z' }
	}
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}`,
		updateTime: '2026-05-28T00:00:00Z',
		fields,
	}
}

function memberReadDoc(
	uid: string,
	role: 'owner' | 'editor' | 'viewer' = 'editor',
	opts: { removingAt?: string } = {},
): MockReadDoc {
	const fields: Record<string, unknown> = { role: { stringValue: role } }
	if (opts.removingAt) {
		fields.removingAt = { timestampValue: opts.removingAt }
	}
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/members/${uid}`,
		updateTime: '2026-05-28T00:00:00Z',
		fields,
	}
}

function inviteReadDoc(opts: { role?: 'editor' | 'viewer'; expiresInMs?: number } = {}): MockReadDoc {
	const expiresMs = Date.now() + (opts.expiresInMs ?? 60_000)
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/invites/${VALID_TOK}`,
		updateTime: '2026-05-28T00:00:00Z',
		fields: {
			role:      { stringValue: opts.role ?? 'editor' },
			expiresAt: { timestampValue: new Date(expiresMs).toISOString() },
		},
	}
}

function notFoundReadDoc(path: string): MockReadDoc {
	return {
		exists:     false,
		name:       `projects/demo/databases/(default)/documents/${path}`,
		fields:     {},
		updateTime: null,
	}
}

/** inviteState/current pointer fixture. Defaults to the happy-path token +
 *  editor role; pass a different token to simulate a rotated/stale pointer. */
function currentReadDoc(token: string = VALID_TOK, role: 'editor' | 'viewer' = 'editor'): MockReadDoc {
	return {
		exists:     true,
		name:       `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/inviteState/current`,
		updateTime: '2026-05-28T00:00:00Z',
		fields: {
			token:     { stringValue: token },
			role:      { stringValue: role },
			createdBy: { stringValue: OWNER_UID },
			expiresAt: { timestampValue: new Date(Date.now() + 60_000).toISOString() },
		},
	}
}

beforeEach(() => {
	txGetResponses.clear()
	txGetCalls.length      = 0
	restCallOrder.length   = 0
	batchRemoveDocs.length = 0
	cascadeCalls.length    = 0
	capturedTxResult       = null
})

// ─── /invite-redeem ──────────────────────────────────────────────

describe('inviteRedeem endpoint', () => {
	function seedFreshRedeem(opts: { existingRoster?: string[] } = {}): void {
		txGetResponses.set(
			`trips/${TRIP_ID}`,
			tripReadDoc({ memberIds: opts.existingRoster ?? [OWNER_UID] }),
		)
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${INVITEE}`),
		)
	}

	it('happy path: creates member doc with full roster + bumps trip.memberIds + cascade runs', async () => {
		seedFreshRedeem()

		const result = await inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)

		expect(result).toEqual({ outcome: 'joined', role: 'editor' })

		// Two writes: member doc + trip.memberIds overwrite
		const writes = capturedTxResult!.writes as Array<{
			document:        string
			fields:          Record<string, unknown>
			currentDocument?: { exists?: boolean }
			updateMask?:     string[]
			updateTransforms?: Array<{ fieldPath: string; setToServerValue: string }>
		}>
		expect(writes).toHaveLength(2)

		const memberWrite = writes[0]
		expect(memberWrite.document).toContain(`/members/${INVITEE}`)
		// create-only precondition: rejects a tx-retry-race where the member
		// doc was already created by the prior loser attempt.
		expect(memberWrite.currentDocument).toEqual({ exists: false })
		expect(memberWrite.fields.displayName).toEqual({ stringValue: DISPLAY })
		expect(memberWrite.fields.role).toEqual({ stringValue: 'editor' })
		expect(memberWrite.fields.inviteToken).toEqual({ stringValue: VALID_TOK })
		// Full computed roster ([owner, invitee]) lands on the member doc
		// so existing members' array-contains listeners see the new joiner.
		expect(memberWrite.fields.memberIds).toEqual({
			arrayValue: { values: [
				{ stringValue: OWNER_UID },
				{ stringValue: INVITEE },
			] },
		})
		// joinedAt via REQUEST_TIME -- Worker Date.now() would drift relative
		// to Firestore server clock and break joinedAt-based listInvites sort.
		expect(memberWrite.updateTransforms).toEqual([
			{ fieldPath: 'joinedAt', setToServerValue: 'REQUEST_TIME' },
		])

		const tripWrite = writes[1]
		expect(tripWrite.document).toMatch(/\/documents\/trips\/trip-1$/)
		expect(tripWrite.updateMask).toEqual(['memberIds'])
		expect(tripWrite.fields.memberIds).toEqual({
			arrayValue: { values: [
				{ stringValue: OWNER_UID },
				{ stringValue: INVITEE },
			] },
		})

		// Post-tx cascade fires for the invitee uid.
		expect(cascadeCalls).toEqual([{ tripId: TRIP_ID, memberUid: INVITEE }])
	})

	it('avatarUrl: included on member doc when present in request body', async () => {
		seedFreshRedeem()

		await inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY, avatarUrl: 'https://example.com/x.png' },
			'{}',
		)

		const memberWrite = capturedTxResult!.writes[0] as { fields: Record<string, unknown> }
		expect(memberWrite.fields.avatarUrl).toEqual({ stringValue: 'https://example.com/x.png' })
	})

	it('already-member + roster includes caller: no writes, BUT cascade re-runs (recovery from prior cascade failure)', async () => {
		// The recovery path the previous test got wrong. Previous redeem's
		// tx committed (member doc exists + caller in trip.memberIds), but
		// post-tx cascade crashed before projecting ACL onto subcollection
		// docs. On retry, the user hits the already-member branch -- if we
		// don't re-run cascade here, the subcollection memberIds[] stays
		// missing the caller forever (their listeners filter by
		// array-contains uid and silently match nothing).
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc({ memberIds: [OWNER_UID, INVITEE] }))
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${INVITEE}`,   memberReadDoc(INVITEE, 'editor'))

		const result = await inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)

		expect(result).toEqual({ outcome: 'already-member', role: 'editor' })
		expect(capturedTxResult!.writes).toEqual([])
		// Critical: cascade DOES re-run on this branch -- idempotent
		// (arrayUnion) and required to recover from a prior cascade
		// failure. Removing this fires permanently silently-broken state.
		expect(cascadeCalls).toEqual([{ tripId: TRIP_ID, memberUid: INVITEE }])
	})

	it('already-member + roster MISSING caller + NO removingAt: legacy half-join repair (bump trip roster + cascade runs)', async () => {
		// The P1 fix this test guards against: the previous implementation
		// treated "member doc exists but trip roster missing caller" as
		// "kick in progress" and refused cascade. That conflation traps
		// any user whose acceptInvite Step 1 (setDoc members/{uid}) landed
		// but Step 2a (arrayUnion trip.memberIds) failed -- e.g. the
		// pre-Worker legacy client flow under partial network failure.
		// Symptom: member doc exists forever, trip.memberIds missing the
		// uid, no removingAt marker (no kick was ever started). Retry
		// must REPAIR the trip roster and cascade, not refuse.
		//
		// Discriminator: `removingAt` on the existing member doc. Absent
		// here, so the redeem is a recovery, not a kick race.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc({ memberIds: [OWNER_UID] }))
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${INVITEE}`,   memberReadDoc(INVITEE, 'editor'))

		const result = await inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)

		expect(result).toEqual({ outcome: 'already-member', role: 'editor' })

		// Single write: trip.memberIds overwrite restoring caller to the
		// roster. Member doc is NOT re-created (already exists) -- only
		// the trip-side projection is missing.
		const writes = capturedTxResult!.writes as Array<{
			document:   string
			fields:     Record<string, unknown>
			updateMask: string[]
		}>
		expect(writes).toHaveLength(1)
		const repairWrite = writes[0]
		expect(repairWrite.document).toMatch(/\/documents\/trips\/trip-1$/)
		expect(repairWrite.updateMask).toEqual(['memberIds'])
		expect(repairWrite.fields.memberIds).toEqual({
			arrayValue: { values: [
				{ stringValue: OWNER_UID },
				{ stringValue: INVITEE },
			] },
		})

		// Cascade MUST run after repair -- subcollection memberIds[] are
		// still missing caller and require arrayUnion projection.
		expect(cascadeCalls).toEqual([{ tripId: TRIP_ID, memberUid: INVITEE }])
	})

	it('already-member + removingAt set: kick-in-flight → 409, no writes, no cascade', async () => {
		// removingAt is the PROPER kick-in-progress signal (written by
		// /member-remove's authz tx). When set, refuse the redeem to
		// preserve the kick -- running cascadeMemberAdd would silently
		// undo the strip. Defense in depth: cascade.ts's removal-aware
		// refuse would also catch this if it ran, but throwing inside
		// the tx surfaces a precise 409 to the caller and saves the
		// downstream round trip.
		txGetResponses.set(
			`trips/${TRIP_ID}`,
			tripReadDoc({ memberIds: [OWNER_UID] }),  // already stripped
		)
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			memberReadDoc(INVITEE, 'editor', { removingAt: '2026-05-28T00:00:00Z' }),
		)

		await expect(inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)).rejects.toMatchObject({ status: 409, name: 'CascadeError' })

		// No cascade ran.
		expect(cascadeCalls).toEqual([])
	})

	it('already-member + removingAt set + roster STILL contains caller: 409 (kick committed marker but arrayRemove not yet flushed)', async () => {
		// Mid-window state: /member-remove's authz tx committed the
		// removingAt marker, but the subsequent non-tx batch arrayRemove
		// hasn't run yet (or crashed before flushing). Trip roster
		// transiently still has the caller. We refuse on the marker
		// alone -- roster-membership is not a tie-breaker against an
		// in-flight kick. Same 409, same defense-in-depth contract.
		txGetResponses.set(
			`trips/${TRIP_ID}`,
			tripReadDoc({ memberIds: [OWNER_UID, INVITEE] }),  // roster still has caller
		)
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			memberReadDoc(INVITEE, 'editor', { removingAt: '2026-05-28T00:00:00Z' }),
		)

		await expect(inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)).rejects.toMatchObject({ status: 409 })

		expect(cascadeCalls).toEqual([])
	})

	it('already-member: response role tracks invite role (not member-doc role)', async () => {
		// Role-update post-redeem can diverge member.role from invitedRole.
		// Public response carries the INVITE's role -- the client only
		// cares "did my redeem succeed for the role I clicked".
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc({ memberIds: [OWNER_UID, INVITEE] }))
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc({ role: 'editor' }))
		// Existing member doc has 'viewer' (post-redeem demotion via
		// /member-role-update); response should still report 'editor'.
		txGetResponses.set(`trips/${TRIP_ID}/members/${INVITEE}`,   memberReadDoc(INVITEE, 'viewer'))

		const result = await inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)
		expect(result.role).toBe('editor')
	})

	it('inconsistent prior state: trip.memberIds carries invitee but member doc missing → bumpTrip=false', async () => {
		// Pre-existing bug shape this branch defends against: a prior remove
		// stripped the member doc but lost the trip.memberIds arrayRemove.
		// Re-redeem must restore the doc WITHOUT duplicating the uid in the
		// trip roster.
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc({ memberIds: [OWNER_UID, INVITEE] }))
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${INVITEE}`),
		)

		const result = await inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)

		expect(result).toEqual({ outcome: 'joined', role: 'editor' })
		// Only the member doc write -- no trip.memberIds overwrite.
		expect(capturedTxResult!.writes).toHaveLength(1)
		const memberWrite = capturedTxResult!.writes[0] as { document: string }
		expect(memberWrite.document).toContain(`/members/${INVITEE}`)
	})

	it('rejects: invite not found → 404', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`,                    tripReadDoc({ memberIds: [OWNER_UID] }))
		txGetResponses.set(
			`trips/${TRIP_ID}/invites/${VALID_TOK}`,
			notFoundReadDoc(`trips/${TRIP_ID}/invites/${VALID_TOK}`),
		)
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${INVITEE}`),
		)

		await expect(inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)).rejects.toMatchObject({ status: 404, name: 'CascadeError' })
	})

	it('rejects: invite expired → 410', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc({ memberIds: [OWNER_UID] }))
		txGetResponses.set(
			`trips/${TRIP_ID}/invites/${VALID_TOK}`,
			inviteReadDoc({ expiresInMs: -1_000 }),
		)
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${INVITEE}`),
		)

		await expect(inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)).rejects.toMatchObject({ status: 410 })
	})

	it('rejects: trip not found → 404', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, notFoundReadDoc(`trips/${TRIP_ID}`))
		txGetResponses.set(
			`trips/${TRIP_ID}/invites/${VALID_TOK}`,
			inviteReadDoc(),
		)
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${INVITEE}`),
		)

		await expect(inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)).rejects.toMatchObject({ status: 404 })
	})

	it('rejects: trip is being deleted → 410 (window race fix between invite-redeem and trip-cascade-delete)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc({ memberIds: [OWNER_UID], deleting: true }))
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${INVITEE}`),
		)

		await expect(inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)).rejects.toMatchObject({ status: 410 })
	})
})

// ─── single-active gate + /invite-create + /invite-revoke ────────

describe('inviteRedeem single-active gate (inviteState/current)', () => {
	it('rejects: pointer missing → 404 (treated as invite not found, no leak)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc({ memberIds: [OWNER_UID] }))
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${INVITEE}`),
		)
		// No active pointer -- redeem must 404 even though the invite doc
		// still exists (e.g. a stale doc the rotate hadn't yet deleted).
		txGetResponses.set(
			`trips/${TRIP_ID}/inviteState/current`,
			notFoundReadDoc(`trips/${TRIP_ID}/inviteState/current`),
		)

		await expect(inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)).rejects.toMatchObject({ status: 404, name: 'CascadeError' })
		expect(cascadeCalls).toEqual([])
	})

	it('rejects: pointer names a DIFFERENT token → 404 (stale redeem after rotation)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc({ memberIds: [OWNER_UID] }))
		txGetResponses.set(`trips/${TRIP_ID}/invites/${VALID_TOK}`, inviteReadDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			notFoundReadDoc(`trips/${TRIP_ID}/members/${INVITEE}`),
		)
		// Owner rotated to a newer invite; the pointer no longer names the
		// redeemer's token. Stale → 404, no member doc created, no cascade.
		txGetResponses.set(`trips/${TRIP_ID}/inviteState/current`, currentReadDoc('f'.repeat(64)))

		await expect(inviteRedeem(
			INVITEE,
			{ tripId: TRIP_ID, token: VALID_TOK, displayName: DISPLAY },
			'{}',
		)).rejects.toMatchObject({ status: 404 })
		expect(cascadeCalls).toEqual([])
	})
})

describe('inviteCreate endpoint', () => {
	function seedOwner(opts: { current?: MockReadDoc } = {}): void {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc({ title: 'Kyoto Trip', icon: '⛩️' }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`, memberReadDoc(OWNER_UID, 'owner'))
		txGetResponses.set(
			`trips/${TRIP_ID}/inviteState/current`,
			opts.current ?? notFoundReadDoc(`trips/${TRIP_ID}/inviteState/current`),
		)
	}

	it('first invite (no prior pointer): writes invite doc + current pointer, no delete', async () => {
		seedOwner()

		const result = await inviteCreate(OWNER_UID, { tripId: TRIP_ID, role: 'editor' }, '{}')

		// Worker minted a 64-hex token + computed an ISO expiry.
		expect(result.token).toMatch(/^[a-f0-9]{64}$/)
		expect(Number.isFinite(Date.parse(result.expiresAt))).toBe(true)

		const writes = capturedTxResult!.writes as Array<{
			op?:               string
			document:          string
			fields?:           Record<string, unknown>
			currentDocument?:  { exists?: boolean }
			updateTransforms?: Array<{ fieldPath: string; setToServerValue: string }>
		}>
		// No prior pointer → no delete; invite doc + current pointer only.
		expect(writes).toHaveLength(2)

		const inviteWrite = writes[0]
		expect(inviteWrite.document).toContain(`/invites/${result.token}`)
		expect(inviteWrite.currentDocument).toEqual({ exists: false })
		expect(inviteWrite.fields!.tripId).toEqual({ stringValue: TRIP_ID })
		expect(inviteWrite.fields!.role).toEqual({ stringValue: 'editor' })
		expect(inviteWrite.fields!.createdBy).toEqual({ stringValue: OWNER_UID })
		// tripTitle / tripIcon read off the trip doc, NOT the client request.
		expect(inviteWrite.fields!.tripTitle).toEqual({ stringValue: 'Kyoto Trip' })
		expect(inviteWrite.fields!.tripIcon).toEqual({ stringValue: '⛩️' })
		// createdAt via REQUEST_TIME -- client InviteDocSchema needs a server
		// Timestamp, not Worker clock drift.
		expect(inviteWrite.updateTransforms).toEqual([
			{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
		])

		const pointerWrite = writes[1]
		expect(pointerWrite.document).toContain('/inviteState/current')
		expect(pointerWrite.fields!.token).toEqual({ stringValue: result.token })
		expect(pointerWrite.fields!.role).toEqual({ stringValue: 'editor' })
		expect(pointerWrite.fields!.createdBy).toEqual({ stringValue: OWNER_UID })
	})

	it('rotate (prior pointer present): deletes old invite doc + writes new invite + pointer', async () => {
		const OLD_TOKEN = 'd'.repeat(64)
		seedOwner({ current: currentReadDoc(OLD_TOKEN) })

		const result = await inviteCreate(OWNER_UID, { tripId: TRIP_ID, role: 'viewer' }, '{}')

		const writes = capturedTxResult!.writes as Array<{ op?: string; document: string }>
		// delete old invite + new invite doc + pointer overwrite.
		expect(writes).toHaveLength(3)
		expect(writes[0].op).toBe('delete')
		expect(writes[0].document).toContain(`/invites/${OLD_TOKEN}`)
		expect(writes[1].document).toContain(`/invites/${result.token}`)
		expect(writes[2].document).toContain('/inviteState/current')
	})

	it('non-owner cannot create → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/editor-uid`, memberReadDoc('editor-uid', 'editor'))

		await expect(
			inviteCreate('editor-uid', { tripId: TRIP_ID, role: 'editor' }, '{}'),
		).rejects.toMatchObject({ status: 403, name: 'CascadeError' })
	})

	it('schema: caps expiresInMs at 7 days + role allowlist', () => {
		const base = { tripId: TRIP_ID, role: 'editor' as const }
		// 8 days > 7-day cap → rejected at the Zod layer (route safeParse).
		expect(InviteCreateRequestSchema.safeParse({ ...base, expiresInMs: 8 * 24 * 60 * 60_000 }).success).toBe(false)
		// 6 days within cap → accepted.
		expect(InviteCreateRequestSchema.safeParse({ ...base, expiresInMs: 6 * 24 * 60 * 60_000 }).success).toBe(true)
		// role 'owner' rejected -- no co-owner invites.
		expect(InviteCreateRequestSchema.safeParse({ tripId: TRIP_ID, role: 'owner' }).success).toBe(false)
	})
})

describe('inviteRevoke endpoint', () => {
	function seedOwner(current: MockReadDoc): void {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`, memberReadDoc(OWNER_UID, 'owner'))
		txGetResponses.set(`trips/${TRIP_ID}/inviteState/current`, current)
	}

	it('active token: deletes invite doc + clears pointer', async () => {
		seedOwner(currentReadDoc(VALID_TOK))

		const result = await inviteRevoke(OWNER_UID, { tripId: TRIP_ID, token: VALID_TOK }, '{}')
		expect(result).toEqual({ ok: true })

		const writes = capturedTxResult!.writes as Array<{ op?: string; document: string }>
		expect(writes).toHaveLength(2)
		expect(writes[0].op).toBe('delete')
		expect(writes[0].document).toContain(`/invites/${VALID_TOK}`)
		expect(writes[1].op).toBe('delete')
		expect(writes[1].document).toContain('/inviteState/current')
	})

	it('no active pointer: idempotent ok, deletes the (possibly-stale) invite doc only', async () => {
		seedOwner(notFoundReadDoc(`trips/${TRIP_ID}/inviteState/current`))

		const result = await inviteRevoke(OWNER_UID, { tripId: TRIP_ID, token: VALID_TOK }, '{}')
		expect(result).toEqual({ ok: true })

		const writes = capturedTxResult!.writes as Array<{ op?: string; document: string }>
		expect(writes).toHaveLength(1)
		expect(writes[0].op).toBe('delete')
		expect(writes[0].document).toContain(`/invites/${VALID_TOK}`)
	})

	it('stale token (pointer names a newer invite) → 409', async () => {
		seedOwner(currentReadDoc('e'.repeat(64)))

		await expect(
			inviteRevoke(OWNER_UID, { tripId: TRIP_ID, token: VALID_TOK }, '{}'),
		).rejects.toMatchObject({ status: 409, name: 'CascadeError' })
	})

	it('non-owner cannot revoke → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/editor-uid`, memberReadDoc('editor-uid', 'editor'))

		await expect(
			inviteRevoke('editor-uid', { tripId: TRIP_ID, token: VALID_TOK }, '{}'),
		).rejects.toMatchObject({ status: 403 })
	})
})

// ─── /member-remove ──────────────────────────────────────────────

describe('memberRemove endpoint', () => {
	const TARGET = 'target-uid'

	function seedAuthorizedRemove(opts: {
		targetExists?:   boolean
		rosterIncludes?: boolean  // default true; flip to false to exercise
		                          // the legacy partial-kick "roster missing target"
		                          // shape (no strip write expected).
	} = {}): void {
		const rosterIncludesTarget = opts.rosterIncludes ?? true
		txGetResponses.set(
			`trips/${TRIP_ID}`,
			tripReadDoc({
				memberIds: rosterIncludesTarget
					? [OWNER_UID, TARGET]
					: [OWNER_UID],
			}),
		)
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`, memberReadDoc(OWNER_UID, 'owner'))
		const targetPath = `trips/${TRIP_ID}/members/${TARGET}`
		txGetResponses.set(
			targetPath,
			opts.targetExists === false
				? notFoundReadDoc(targetPath)
				: memberReadDoc(TARGET, 'editor'),
		)
	}

	it('happy path: ACL strip BEFORE member doc delete -- the load-bearing order', async () => {
		seedAuthorizedRemove()

		const result = await memberRemove(OWNER_UID, { tripId: TRIP_ID, memberUid: TARGET }, '{}')

		expect(result).toEqual({ ok: true })

		// restCallOrder captures EVERY non-tx REST call in invocation order.
		// The contract under test: every listDocNames + the batchArrayRemove
		// must come BEFORE the deleteDoc call. We don't assert exact
		// ordering between the parallel listDocNames calls (concurrency=3
		// makes that non-deterministic).
		const deleteIdx     = restCallOrder.findIndex(c => c.startsWith('deleteDoc:'))
		const batchRemoveIdx = restCallOrder.findIndex(c => c.startsWith('batchArrayRemoveMemberIds:'))
		expect(deleteIdx).toBeGreaterThan(-1)
		expect(batchRemoveIdx).toBeGreaterThan(-1)
		expect(batchRemoveIdx).toBeLessThan(deleteIdx)
		// Every listDocNames must precede the batch remove (the cascade
		// needs the full doc-name set before calling commit).
		const listIndices = restCallOrder
			.map((c, i) => c.startsWith('listDocNames:') ? i : -1)
			.filter(i => i >= 0)
		expect(listIndices.length).toBeGreaterThan(0)
		for (const li of listIndices) {
			expect(li).toBeLessThan(batchRemoveIdx)
		}
		// The single deleteDoc call targets the member doc itself.
		const deleteCall = restCallOrder[deleteIdx]
		expect(deleteCall).toContain(`/members/${TARGET}`)
	})

	it('precheck tx commits BOTH removingAt marker AND trip.memberIds strip BEFORE the cascade phase begins', async () => {
		// Two security-critical assertions stacked here -- both invariants
		// MUST hold atomically inside the same tx before any non-tx work
		// runs. See membership-write.ts comment block above the tx body.
		//
		// Invariant 1 -- removingAt marker on members/<target>:
		//   `updateMask: ['removingAt']` so role / userId / joinedAt etc.
		//   survive until deleteDoc strips the doc entirely. Blocks the
		//   kicked user from continuing to write (canWrite refuses when
		//   this field is present).
		//
		// Invariant 2 -- trip.memberIds strip:
		//   Closes the race where another editor/owner reads a stale
		//   trip.memberIds (still carrying memberUid) AFTER our
		//   listDocNames snapshot, copies that roster onto a new
		//   subcollection doc, and slips past the batch arrayRemove which
		//   only sees pre-snapshot docs. Stripping inside the tx means
		//   any post-commit new-doc creation reads the already-stripped
		//   roster. The write uses `updateMask: ['memberIds']` (NOT a full
		//   overwrite) so trip-level fields like title / ownerId stay
		//   untouched.
		//
		// Stamping order in writes[] is irrelevant -- commit is atomic.
		seedAuthorizedRemove()  // trip roster = [OWNER, TARGET]

		await memberRemove(OWNER_UID, { tripId: TRIP_ID, memberUid: TARGET }, '{}')

		expect(capturedTxResult).not.toBeNull()
		const writes = capturedTxResult!.writes as Array<{
			document:   string
			fields:     Record<string, unknown>
			updateMask: string[]
		}>
		expect(writes).toHaveLength(2)

		const markerWrite = writes.find(w => w.document.includes(`/members/${TARGET}`))
		expect(markerWrite).toBeDefined()
		expect(markerWrite!.updateMask).toEqual(['removingAt'])
		expect(markerWrite!.fields.removingAt).toMatchObject({
			timestampValue: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		})

		const rosterWrite = writes.find(w => w.document.match(/\/documents\/trips\/trip-1$/))
		expect(rosterWrite).toBeDefined()
		expect(rosterWrite!.updateMask).toEqual(['memberIds'])
		expect(rosterWrite!.fields.memberIds).toEqual({
			arrayValue: { values: [{ stringValue: OWNER_UID }] },  // TARGET stripped
		})
	})

	it('trip doc is NOT in the cascade-phase batch arrayRemove (tx owns the trip-side strip)', async () => {
		// Invariant lock: future refactor that moves the trip.memberIds
		// strip back into the cascade phase reopens the race the tx-side
		// strip closes (another editor creates a new subcollection doc
		// between listDocNames and the cascade-phase trip arrayRemove,
		// reading a stale roster that still carries memberUid). The
		// batch should ONLY operate on subcollection docs -- the trip
		// doc was already stripped atomically in the precheck tx above.
		seedAuthorizedRemove()

		await memberRemove(OWNER_UID, { tripId: TRIP_ID, memberUid: TARGET }, '{}')

		const tripDocResource = `projects/demo/databases/(default)/documents/trips/${TRIP_ID}`
		expect(batchRemoveDocs).not.toContain(tripDocResource)

		// Sanity: the batch DID receive subcollection docs (otherwise the
		// "not.toContain" assertion would be vacuously true against an
		// empty batch). One fake doc per TRIP_SUBCOLLECTIONS entry seeds
		// the list -- members + schedules + expenses + bookings + wishes
		// + planning = 6 docs.
		expect(batchRemoveDocs.length).toBe(6)
		for (const docName of batchRemoveDocs) {
			expect(docName.startsWith(`${tripDocResource}/`)).toBe(true)
		}
	})

	it('roster missing target uid (legacy partial kick): only removingAt marker write, no roster strip', async () => {
		// Defensive: if a prior failed kick stripped trip.memberIds but
		// didn't delete the member doc, a retry MUST still establish the
		// marker and run the cascade -- but it skips the no-op roster
		// write (Firestore would accept it, but it's a needless write).
		// The cascade still converges: batch arrayRemove on subcollections
		// + deleteDoc on the member doc finish the kick.
		seedAuthorizedRemove({ rosterIncludes: false })

		const result = await memberRemove(OWNER_UID, { tripId: TRIP_ID, memberUid: TARGET }, '{}')
		expect(result).toEqual({ ok: true })

		const writes = capturedTxResult!.writes as Array<{ document: string; updateMask: string[] }>
		expect(writes).toHaveLength(1)
		expect(writes[0].document).toContain(`/members/${TARGET}`)
		expect(writes[0].updateMask).toEqual(['removingAt'])
	})

	it('target member doc missing: still strips stale ACL projections, no marker write', async () => {
		seedAuthorizedRemove({ targetExists: false })

		const result = await memberRemove(OWNER_UID, { tripId: TRIP_ID, memberUid: TARGET }, '{}')

		expect(result).toEqual({ ok: true })

		const deleteIdx = restCallOrder.findIndex(c => c.startsWith('deleteDoc:'))
		const batchRemoveIdx = restCallOrder.findIndex(c => c.startsWith('batchArrayRemoveMemberIds:'))
		expect(deleteIdx).toBe(-1)
		expect(batchRemoveIdx).toBeGreaterThan(-1)
		expect(batchRemoveDocs.length).toBe(6)

		// Critical: removingAt marker is suppressed when target doesn't
		// exist. Stamping removingAt on a non-existent member doc would
		// create a stub doc the cascade can't clean up. The trip roster
		// strip still lands when the stale roster carries the target uid.
		expect(capturedTxResult).not.toBeNull()
		const writes = capturedTxResult!.writes as Array<{
			document:   string
			fields:     Record<string, unknown>
			updateMask: string[]
		}>
		expect(writes).toHaveLength(1)
		expect(writes[0].document).toMatch(/\/documents\/trips\/trip-1$/)
		expect(writes[0].updateMask).toEqual(['memberIds'])
		expect(writes[0].fields.memberIds).toEqual({
			arrayValue: { values: [{ stringValue: OWNER_UID }] },
		})
	})

	it('target missing + trip roster already stripped: still scans subcollections to repair delete-first partial state', async () => {
		seedAuthorizedRemove({ targetExists: false, rosterIncludes: false })

		const result = await memberRemove(OWNER_UID, { tripId: TRIP_ID, memberUid: TARGET }, '{}')

		expect(result).toEqual({ ok: true })
		expect(capturedTxResult).not.toBeNull()
		expect(capturedTxResult!.writes).toEqual([])
		expect(restCallOrder.some(c => c.startsWith('deleteDoc:'))).toBe(false)
		expect(restCallOrder.some(c => c.startsWith('batchArrayRemoveMemberIds:'))).toBe(true)
		expect(batchRemoveDocs.length).toBe(6)
	})

	it('rejects: caller not owner → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			memberReadDoc(INVITEE, 'editor'),
		)

		await expect(memberRemove(
			INVITEE,
			{ tripId: TRIP_ID, memberUid: TARGET },
			'{}',
		)).rejects.toMatchObject({ status: 403 })
		// Authz fail bails before any non-tx work.
		expect(restCallOrder).toEqual([])
	})

	it('rejects: self-remove → 400 MembershipValidationError on memberUid', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`, memberReadDoc(OWNER_UID, 'owner'))

		const err = await memberRemove(
			OWNER_UID,
			{ tripId: TRIP_ID, memberUid: OWNER_UID },
			'{}',
		).catch(e => e)
		expect(err).toBeInstanceOf(MembershipValidationError)
		expect((err as MembershipValidationError).field).toBe('memberUid')
	})

	it('rejects: caller not a member (no member doc at all) → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		const callerMemberPath = `trips/${TRIP_ID}/members/${OWNER_UID}`
		txGetResponses.set(callerMemberPath, notFoundReadDoc(callerMemberPath))

		await expect(memberRemove(
			OWNER_UID,
			{ tripId: TRIP_ID, memberUid: TARGET },
			'{}',
		)).rejects.toMatchObject({ status: 403 })
	})

	it('rejects: trip deleting → 410', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc({ deleting: true }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`, memberReadDoc(OWNER_UID, 'owner'))

		await expect(memberRemove(
			OWNER_UID,
			{ tripId: TRIP_ID, memberUid: TARGET },
			'{}',
		)).rejects.toMatchObject({ status: 410 })
	})
})

// ─── /member-role-update ─────────────────────────────────────────

describe('memberRoleUpdate endpoint', () => {
	const TARGET = 'target-uid'

	function seedAuthorizedRoleUpdate(opts: { existingRole?: 'editor' | 'viewer' | 'owner'; targetExists?: boolean } = {}): void {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`, memberReadDoc(OWNER_UID, 'owner'))
		const targetPath = `trips/${TRIP_ID}/members/${TARGET}`
		txGetResponses.set(
			targetPath,
			opts.targetExists === false
				? notFoundReadDoc(targetPath)
				: memberReadDoc(TARGET, opts.existingRole ?? 'editor'),
		)
	}

	it('happy path: editor → viewer, single updateMask write', async () => {
		seedAuthorizedRoleUpdate({ existingRole: 'editor' })

		const result = await memberRoleUpdate(
			OWNER_UID,
			{ tripId: TRIP_ID, memberUid: TARGET, role: 'viewer' },
			'{}',
		)

		expect(result).toEqual({ ok: true })
		const writes = capturedTxResult!.writes as Array<{
			document:        string
			fields:          Record<string, unknown>
			updateMask?:     string[]
			currentDocument?: { exists?: boolean }
		}>
		expect(writes).toHaveLength(1)
		expect(writes[0].document).toContain(`/members/${TARGET}`)
		expect(writes[0].updateMask).toEqual(['role'])
		expect(writes[0].fields.role).toEqual({ stringValue: 'viewer' })
		// belt-and-suspenders precondition: target still exists at commit.
		expect(writes[0].currentDocument).toEqual({ exists: true })
	})

	it('no-op: role unchanged → no writes', async () => {
		seedAuthorizedRoleUpdate({ existingRole: 'viewer' })

		await memberRoleUpdate(
			OWNER_UID,
			{ tripId: TRIP_ID, memberUid: TARGET, role: 'viewer' },
			'{}',
		)
		expect(capturedTxResult!.writes).toEqual([])
	})

	it('rejects: target not found → 404', async () => {
		seedAuthorizedRoleUpdate({ targetExists: false })

		await expect(memberRoleUpdate(
			OWNER_UID,
			{ tripId: TRIP_ID, memberUid: TARGET, role: 'viewer' },
			'{}',
		)).rejects.toMatchObject({ status: 404 })
	})

	it('rejects: caller not owner → 403', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc())
		txGetResponses.set(
			`trips/${TRIP_ID}/members/${INVITEE}`,
			memberReadDoc(INVITEE, 'editor'),
		)

		await expect(memberRoleUpdate(
			INVITEE,
			{ tripId: TRIP_ID, memberUid: TARGET, role: 'viewer' },
			'{}',
		)).rejects.toMatchObject({ status: 403 })
	})

	it('rejects: target uid matches trip ownerId → 400 (owner role flip blocked)', async () => {
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc({ ownerId: OWNER_UID }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`, memberReadDoc(OWNER_UID, 'owner'))

		const err = await memberRoleUpdate(
			OWNER_UID,
			{ tripId: TRIP_ID, memberUid: OWNER_UID, role: 'viewer' },
			'{}',
		).catch(e => e)
		expect(err).toBeInstanceOf(MembershipValidationError)
		expect((err as MembershipValidationError).field).toBe('memberUid')
	})

	it('rejects: existing target.role == owner → 400 (defensive against data-at-rest disagreement)', async () => {
		// ownerId on trip is OWNER_UID; target uid is a DIFFERENT uid whose
		// member doc somehow has role=owner (data corruption). The endpoint
		// must refuse rather than silently change role on a doc whose
		// ownerId branch the trip doesn't agree with.
		const STRAY_OWNER = 'stray-owner'
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc({ ownerId: OWNER_UID }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`, memberReadDoc(OWNER_UID, 'owner'))
		txGetResponses.set(`trips/${TRIP_ID}/members/${STRAY_OWNER}`, memberReadDoc(STRAY_OWNER, 'owner'))

		const err = await memberRoleUpdate(
			OWNER_UID,
			{ tripId: TRIP_ID, memberUid: STRAY_OWNER, role: 'viewer' },
			'{}',
		).catch(e => e)
		expect(err).toBeInstanceOf(MembershipValidationError)
		expect((err as MembershipValidationError).field).toBe('memberUid')
	})

	it('CascadeError tagging stays intact through the validation-error catcher', async () => {
		// Quick sanity: trip-not-deleting fires through CascadeError, not
		// MembershipValidationError -- the dispatcher's catch order
		// (validationErrorCatcher → CascadeError → 500) hinges on this.
		txGetResponses.set(`trips/${TRIP_ID}`, tripReadDoc({ deleting: true }))
		txGetResponses.set(`trips/${TRIP_ID}/members/${OWNER_UID}`, memberReadDoc(OWNER_UID, 'owner'))

		const err = await memberRoleUpdate(
			OWNER_UID,
			{ tripId: TRIP_ID, memberUid: TARGET, role: 'viewer' },
			'{}',
		).catch(e => e)
		expect(err).toBeInstanceOf(CascadeError)
		expect((err as CascadeError).status).toBe(410)
	})
})
