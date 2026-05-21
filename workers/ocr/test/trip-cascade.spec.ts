// Tests for the trip cascade flow. The main thing we want to lock
// down at the unit level is the Storage prefix boundary: GCS list
// with `prefix=trips/abc` matches BOTH `trips/abc/*` AND
// `trips/abc2/*` because `prefix` is a literal string starts-with.
// Forgetting the trailing slash on cascade would cause cross-trip
// data loss; this regression is annoying to catch in integration
// (you'd need two real trips with adjacent IDs in GCS) so we pin it
// at the unit boundary instead.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Swap the helpers BEFORE importing the module under test so the
// mocked functions are the ones bound at module load. Importing
// trip-cascade.ts directly captures stable refs to ./storage and
// ./firestore at module evaluation, so we have to install mocks
// first.
vi.mock('../src/storage', () => ({
	purgeObjectsByPrefix: vi.fn(async (..._args: unknown[]) => 0),
}))
vi.mock('../src/firestore', () => ({
	getDocFields:    vi.fn(),
	listDocNames:    vi.fn(async () => []),
	batchDeleteDocs: vi.fn(),
	deleteDoc:       vi.fn(),
	updateDocFields: vi.fn(),
	readString:      vi.fn((fields: Record<string, { stringValue?: string }> | null | undefined, key: string) =>
		fields?.[key]?.stringValue,
	),
	buildDocName:    vi.fn(),
}))
vi.mock('../src/admin', () => ({
	getAdminToken:        vi.fn(async () => 'fake-admin-token'),
	getProjectId:         vi.fn(() => 'demo-project'),
	invalidateAdminToken: vi.fn(),
}))

import { cascadeTripDelete, TripDeleteRequestSchema } from '../src/trip-cascade'
import * as storage          from '../src/storage'
import * as firestore        from '../src/firestore'

beforeEach(() => {
	vi.clearAllMocks()
	// Default: owner check passes for our caller uid.
	vi.mocked(firestore.getDocFields).mockResolvedValue({
		ownerId: { stringValue: 'owner-uid' },
	})
})

describe('cascadeTripDelete - Storage prefix boundary', () => {
	it('passes trips/<tripId>/ (trailing slash) to purgeObjectsByPrefix', async () => {
		await cascadeTripDelete(
			'owner-uid',
			{ tripId: 'abc' },
			'{"client_email":"x","private_key":"y","token_uri":"z","project_id":"demo-project"}',
			'demo-bucket',
		)
		// Two sweeps now: pre-drain (step 2) + final defence-in-depth
		// sweep (step 3.5) that catches uploads slipping past the
		// cross-service rules-eval timing. Both must use the
		// trailing-slash prefix.
		expect(storage.purgeObjectsByPrefix).toHaveBeenCalledTimes(2)
		const calls = vi.mocked(storage.purgeObjectsByPrefix).mock.calls
		for (const call of calls) {
			expect(call[2]).toBe('trips/abc/')
			// Defensive: explicitly assert the slash. A naive
			// `trips/${tripId}` (without slash) would still pass the
			// equality check above if anyone introduced a default-suffix
			// helper later, so the slash assertion is the load-bearing
			// one for the abc / abc2 cross-prefix regression.
			expect(call[2].endsWith('/')).toBe(true)
		}
	})

	it('different tripIds get independent prefixes (no shared boundary)', async () => {
		await cascadeTripDelete('owner-uid', { tripId: 'abc' },  'sa', 'bucket')
		await cascadeTripDelete('owner-uid', { tripId: 'abc2' }, 'sa', 'bucket')
		const calls = vi.mocked(storage.purgeObjectsByPrefix).mock.calls
		// Two sweeps per cascade × two cascades = 4 calls.
		expect(calls).toHaveLength(4)
		const abcPrefixes  = calls.slice(0, 2).map(c => c[2])
		const abc2Prefixes = calls.slice(2, 4).map(c => c[2])
		expect(abcPrefixes).toEqual(['trips/abc/',  'trips/abc/'])
		expect(abc2Prefixes).toEqual(['trips/abc2/', 'trips/abc2/'])
		// Critical invariant: the abc prefix does NOT match the abc2
		// path, so abc cascade can't touch abc2's storage objects.
		expect('trips/abc2/some-file'.startsWith('trips/abc/')).toBe(false)
	})

	it('rejects when caller uid does not match trip ownerId', async () => {
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
			ownerId: { stringValue: 'someone-else' },
		})
		await expect(
			cascadeTripDelete('owner-uid', { tripId: 'abc' }, 'sa', 'bucket'),
		).rejects.toThrow(/not the trip owner/)
		// Storage MUST NOT be touched when ownership check fails.
		expect(storage.purgeObjectsByPrefix).not.toHaveBeenCalled()
	})

	it('treats missing trip doc as idempotent success (no-op cascade)', async () => {
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(null)
		const result = await cascadeTripDelete('owner-uid', { tripId: 'abc' }, 'sa', 'bucket')
		expect(result).toEqual({ deletedDocs: 0, deletedObjects: 0 })
		// Already gone → nothing to delete in Storage either.
		expect(storage.purgeObjectsByPrefix).not.toHaveBeenCalled()
		// And the quiesce stamp wasn't written either -- no trip to write to.
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
	})

	it('writes deletingAt write-quiesce stamp BEFORE Storage purge', async () => {
		// The whole point of the flag: it must land before any
		// subcollection drain so that editors-on-other-devices get
		// their CREATE writes rejected the moment cascade begins.
		// Establish ordering by recording the order of mocked calls.
		const callOrder: string[] = []
		vi.mocked(firestore.updateDocFields).mockImplementationOnce(async (..._args) => {
			callOrder.push('updateDocFields')
		})
		vi.mocked(storage.purgeObjectsByPrefix).mockImplementationOnce(async (..._args) => {
			callOrder.push('purgeObjectsByPrefix')
			return 0
		})
		await cascadeTripDelete('owner-uid', { tripId: 'abc' }, 'sa', 'bucket')
		expect(callOrder).toEqual(['updateDocFields', 'purgeObjectsByPrefix'])
		// Verify the patch shape: targets the trip doc, sets
		// deletingAt to a Timestamp (NOT null -- the field's
		// existence is what tripNotDeleting checks for).
		const calls = vi.mocked(firestore.updateDocFields).mock.calls
		expect(calls[0][2]).toBe('trips/abc')
		const patch = calls[0][3] as Record<string, { timestampValue?: string }>
		expect(patch.deletingAt?.timestampValue).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	})

	it('does NOT write the quiesce stamp when ownership check fails', async () => {
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
			ownerId: { stringValue: 'someone-else' },
		})
		await expect(
			cascadeTripDelete('owner-uid', { tripId: 'abc' }, 'sa', 'bucket'),
		).rejects.toThrow(/not the trip owner/)
		// Non-owner caller -- the flag MUST NOT land, otherwise a
		// failed-auth attempt would freeze the trip from legitimate
		// owner writes.
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
	})
})

describe('TripDeleteRequestSchema - tripId path-injection rejection', () => {
	it('accepts plain auto-IDs and underscore/dash variants', () => {
		for (const id of ['abc123', 'TRIP-001', 'snake_case', '0123456789abcdef']) {
			expect(TripDeleteRequestSchema.safeParse({ tripId: id }).success).toBe(true)
		}
	})

	it('rejects path traversal via embedded slash', () => {
		// The motivating case: a tripId of "abc/expenses/xyz" would be
		// interpolated into Firestore REST paths and target a doc the
		// caller never owned. Schema rejects at parse-time before any
		// admin token is minted.
		const res = TripDeleteRequestSchema.safeParse({ tripId: 'abc/expenses/xyz' })
		expect(res.success).toBe(false)
	})

	it('rejects URL-special chars (?#) that could confuse REST query parsing', () => {
		expect(TripDeleteRequestSchema.safeParse({ tripId: 'abc?foo=1' }).success).toBe(false)
		expect(TripDeleteRequestSchema.safeParse({ tripId: 'abc#frag'  }).success).toBe(false)
		expect(TripDeleteRequestSchema.safeParse({ tripId: 'abc def'   }).success).toBe(false)
	})

	it('rejects empty and over-length tripIds', () => {
		expect(TripDeleteRequestSchema.safeParse({ tripId: '' }).success).toBe(false)
		expect(TripDeleteRequestSchema.safeParse({ tripId: 'a'.repeat(61) }).success).toBe(false)
	})
})
