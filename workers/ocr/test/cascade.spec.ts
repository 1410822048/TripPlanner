// Unit tests for the cascade 401-retry policy. The retry logic is
// extracted into withTokenRetry() so it can be exercised without
// mocking the entire Firestore REST helper stack -- the policy is
// pure (catch error, sniff message, invalidate-and-retry once) and
// belongs at the test boundary independent of the cascade body.
//
// Also: the removal-aware refuse in cascadeMemberAdd is exercised
// via a tightly-mocked happy/refuse pair -- the security-critical
// invariant ("a member not in trip.memberIds cannot re-cascade
// themselves back in") earns a dedicated test even though the rest
// of the cascade body has no other unit coverage.
//
// runFirestoreTransaction is mocked to RUN the real body, so the
// roster guard inside each chunk transaction is the thing under test;
// only the REST plumbing is faked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FsValue } from '../src/firestore'
import type { TxWrite, TxReadDoc } from '../src/firestore-tx'

vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo'),
	invalidateAdminToken: vi.fn(),
}))

vi.mock('../src/firestore', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
	return {
		...actual,
		docExists:    vi.fn(async () => true),
		getDocFields: vi.fn(async () => ({})),
		listDocNames: vi.fn(async () => [] as string[]),
		buildDocName: (pid: string, p: string) => `projects/${pid}/databases/(default)/documents/${p}`,
	}
})

/** Trip docs the mocked tx.get hands back, one per transaction, in order.
 *  The LAST entry repeats once exhausted — so a single-entry queue means
 *  "every transaction sees this trip". Letting the tx read diverge from
 *  the plain-GET precheck is the whole point: that divergence IS the
 *  kick-lands-mid-cascade race. */
const txReads: Array<Record<string, FsValue>> = []
/** Write batches captured per committed transaction. */
let txCommits: TxWrite[][] = []

vi.mock('../src/firestore-tx', () => ({
	runFirestoreTransaction: vi.fn(async (
		_token:   string,
		_project: string,
		body:     (tx: { get: (p: string) => Promise<TxReadDoc>; runQuery: () => Promise<TxReadDoc[]> }) => Promise<{ writes: TxWrite[]; result: unknown }>,
	) => {
		const fields = txReads.length > 1 ? txReads.shift()! : (txReads[0] ?? {})
		const tx = {
			get: async (path: string): Promise<TxReadDoc> => ({
				exists:     true,
				fields,
				name:       `projects/demo/databases/(default)/documents/${path}`,
				updateTime: null,
			}),
			runQuery: async () => [],
		}
		const { writes, result } = await body(tx)
		txCommits.push(writes)
		return result
	}),
}))

import { withTokenRetry, cascadeMemberAdd, CascadeError } from '../src/cascade'
import * as admin from '../src/admin'
import * as firestore from '../src/firestore'

/** Firestore REST "fields" object carrying memberIds. Mirrors what both
 *  getDocFields and tx.get return -- the cascade reads
 *  fields.memberIds?.arrayValue?.values directly. */
const rosterFields = (uids: string[]): Record<string, FsValue> => ({
	memberIds: { arrayValue: { values: uids.map(stringValue => ({ stringValue })) } },
})

const cascade = () => cascadeMemberAdd(
	'caller-uid',
	{ tripId: 'trip-1', memberUid: 'caller-uid' },
	'{}',
)

/** Every document touched across all committed transactions. */
const committedDocs = () => txCommits.flat().map(w => w.document)

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(admin.getAdminToken).mockResolvedValue('fake-admin-token')
	vi.mocked(admin.getProjectId).mockReturnValue('demo')
	vi.mocked(firestore.docExists).mockResolvedValue(true)
	vi.mocked(firestore.getDocFields).mockResolvedValue({})
	vi.mocked(firestore.listDocNames).mockResolvedValue([])
	txReads.length = 0
	txCommits = []
})

describe('withTokenRetry', () => {
	it('returns the result when fn succeeds on first try', async () => {
		const fn = vi.fn(async () => 'ok')
		const invalidateSpy = vi.spyOn(admin, 'invalidateAdminToken').mockImplementation(() => {})
		const result = await withTokenRetry(fn)
		expect(result).toBe('ok')
		expect(fn).toHaveBeenCalledTimes(1)
		expect(invalidateSpy).not.toHaveBeenCalled()
	})

	it('on Firestore 401 error: invalidates token + retries exactly once', async () => {
		const fn = vi.fn()
			.mockRejectedValueOnce(new Error('docExists trips/x/members/y -> 401: token expired'))
			.mockResolvedValueOnce({ updatedDocs: 5 })
		const invalidateSpy = vi.spyOn(admin, 'invalidateAdminToken').mockImplementation(() => {})

		const result = await withTokenRetry(fn)
		expect(result).toEqual({ updatedDocs: 5 })
		expect(fn).toHaveBeenCalledTimes(2)
		expect(invalidateSpy).toHaveBeenCalledTimes(1)
	})

	it('non-401 errors propagate without retry', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('listDocNames foo -> 500: upstream'))
		const invalidateSpy = vi.spyOn(admin, 'invalidateAdminToken').mockImplementation(() => {})
		await expect(withTokenRetry(fn)).rejects.toThrow('500')
		expect(fn).toHaveBeenCalledTimes(1)
		expect(invalidateSpy).not.toHaveBeenCalled()
	})

	it('does not retry a second 401: at most one retry per call', async () => {
		const fn = vi.fn()
			.mockRejectedValueOnce(new Error('docExists -> 401: first'))
			.mockRejectedValueOnce(new Error('docExists -> 401: second'))
		vi.spyOn(admin, 'invalidateAdminToken').mockImplementation(() => {})
		await expect(withTokenRetry(fn)).rejects.toThrow('second')
		expect(fn).toHaveBeenCalledTimes(2)
	})
})

describe('cascadeMemberAdd removal-aware refuse', () => {
	it('proceeds when target uid is in trip.memberIds (happy path)', async () => {
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(
			rosterFields(['caller-uid', 'other-member']),
		)
		txReads.push(rosterFields(['caller-uid', 'other-member']))

		const result = await cascade()

		// Trip doc itself is pushed onto docNames after the 6 subcollection
		// list results (each defaulted to [] by the global mock), so
		// updatedDocs = 1.
		expect(result.updatedDocs).toBe(1)
		// One chunk transaction + the member-doc seed transaction.
		expect(txCommits).toHaveLength(2)
		expect(committedDocs()).toEqual([
			'projects/demo/databases/(default)/documents/trips/trip-1',
			'projects/demo/databases/(default)/documents/trips/trip-1/members/caller-uid',
		])
	})

	it('guards every transform with exists:true so no deleted doc is resurrected', async () => {
		// A transform on a MISSING doc does not fail -- Firestore creates it
		// carrying only the transformed field. A doc deleted between
		// listDocNames and commit would come back as a memberIds-only shell
		// that no schema parses and orphan-purge reads as "still referenced".
		vi.mocked(firestore.listDocNames).mockResolvedValueOnce([
			'projects/demo/databases/(default)/documents/trips/trip-1/expenses/e1',
		])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(rosterFields(['caller-uid']))
		txReads.push(rosterFields(['caller-uid']))

		await cascade()

		const writes = txCommits.flat()
		expect(writes.length).toBeGreaterThan(1)   // entity doc + trip doc + seed
		for (const w of writes) {
			expect(w.currentDocument).toEqual({ exists: true })
		}
	})

	it('seeds the member doc with the roster read INSIDE its transaction', async () => {
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(rosterFields(['caller-uid', 'other-member']))
		txReads.push(rosterFields(['caller-uid', 'other-member']))

		await cascade()

		// Not a separate GET: a roster fetched outside the transaction could
		// be stale by commit time.
		const seed = txCommits.at(-1)![0]!
		expect(seed).toMatchObject({
			op:       'transform',
			document: 'projects/demo/databases/(default)/documents/trips/trip-1/members/caller-uid',
		})
		expect(seed.op === 'transform' && seed.fieldTransforms[0]!.appendMissingElements.values)
			.toEqual([{ stringValue: 'caller-uid' }, { stringValue: 'other-member' }])
	})

	it('refuses with 403 when target uid is NOT in trip.memberIds (kick in progress)', async () => {
		// member doc still exists (kick hasn't deleted it yet) but ACL strip
		// already removed the uid from trip.memberIds -- this is the exact
		// state where a re-cascade would silently undo the kick.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(rosterFields(['someone-else']))

		await expect(cascade()).rejects.toThrow(CascadeError)

		// Critical: no writes happen on the refuse path. Any commit here
		// would be silently undoing the kick.
		expect(txCommits).toHaveLength(0)
	})

	it('refuses with 403 when trip.memberIds is missing entirely', async () => {
		// Empty fields = no memberIds key at all. Defensive: a malformed or
		// freshly-soft-deleted trip should not accidentally pass the gate.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({})

		await expect(cascade()).rejects.toThrow(/cascade refused/)

		expect(txCommits).toHaveLength(0)
	})

	it('refuses inside the transaction when the kick lands AFTER the precheck', async () => {
		// The TOCTOU this whole design exists for: the plain-GET precheck
		// sees the caller on the roster, then /member-remove commits its
		// roster strip before the cascade writes. The in-transaction re-read
		// is what catches it -- in production the same window also surfaces
		// as a commit ABORT, since the strip writes the very doc each chunk
		// transaction read.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(rosterFields(['caller-uid']))
		txReads.push(rosterFields(['someone-else']))

		await expect(cascade()).rejects.toThrow(/cascade refused/)

		expect(txCommits).toHaveLength(0)
	})

	it('stops mid-cascade when the kick lands between chunks', async () => {
		// 501 docs = two chunks. The roster is intact for the first chunk and
		// stripped for the second, so the ACL projection must stop dead
		// rather than finish re-adding the kicked uid.
		vi.mocked(firestore.listDocNames).mockResolvedValueOnce(
			Array.from({ length: 501 }, (_, i) => `projects/demo/databases/(default)/documents/trips/trip-1/expenses/e${i}`),
		)
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(rosterFields(['caller-uid']))
		txReads.push(rosterFields(['caller-uid']), rosterFields(['someone-else']))

		await expect(cascade()).rejects.toThrow(/cascade refused/)

		// First chunk committed (500 writes, the cap); the second refused, so
		// the member-doc seed never ran either.
		expect(txCommits).toHaveLength(1)
		expect(txCommits[0]).toHaveLength(500)
	})

	it('refuses when the trip starts deleting mid-cascade', async () => {
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(rosterFields(['caller-uid']))
		txReads.push({
			...rosterFields(['caller-uid']),
			deletingAt: { timestampValue: '2026-08-17T00:00:00Z' },
		})

		await expect(cascade()).rejects.toThrow(/trip is being deleted/)

		expect(txCommits).toHaveLength(0)
	})
})
