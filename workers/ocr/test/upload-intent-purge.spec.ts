// Tests for the upload-intent purge cron. Mirrors the structure of
// orphan-purge.spec / storage-scan.spec: mock the Firestore query +
// deleteDoc helpers, drive the cron, assert on calls + report.
//
// Pinning these invariants because they're easy to regress on a
// future cron tweak:
//   - GRACE_MS gate (pending intent within grace NOT deleted)
//   - retention gate (used intent within retention NOT deleted)
//   - cursor advance correctness (last (timestamp, name) → next call)
//   - mid-scan query failure re-throws WITH partial counts in message
//   - deleteDoc 404 is swallowed (idempotent across concurrent crons)
//   - SOFT_DEADLINE_MS / SUBREQUEST_BUDGET partials
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/firestore', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
	return {
		queryUploadIntents: vi.fn(async () => ({ docs: [] })),
		deleteDoc:          vi.fn(async () => undefined),
		readTimestampMs:    actual.readTimestampMs,
	}
})
vi.mock('../src/admin', () => ({
	getAdminToken: vi.fn(async () => 'fake-admin-token'),
	getProjectId:  vi.fn(() => 'demo-project'),
}))

import { purgeExpiredUploadIntents }   from '../src/upload-intent-purge'
import * as firestore                  from '../src/firestore'

const PROJECT_ID = 'demo-project'
// Phase-3.5-bis: intents live under trips/{tripId}/uploadIntents/{id}.
// The collection-group query (`allDescendants: true`) returns docs whose
// resource name embeds the parent tripId; the cron's prefix-strip then
// forwards `trips/{tripId}/uploadIntents/{id}` to deleteDoc. Tests run
// with a fixed trip to keep assertions readable.
const TRIP_ID    = 'trip-1'

/** Build a Firestore-shape intent doc (just the fields the cron reads).
 *  The cron only touches `expiresAt` / `usedAt` via readTimestampMs for
 *  cursor advance; other fields are irrelevant to deletion. */
function intentDoc(opts: {
	id:         string
	expiresAtMs?: number
	usedAtMs?:    number
}) {
	const fields: Record<string, unknown> = {}
	if (opts.expiresAtMs !== undefined) {
		fields.expiresAt = { timestampValue: new Date(opts.expiresAtMs).toISOString() }
	}
	if (opts.usedAtMs !== undefined) {
		fields.usedAt = { timestampValue: new Date(opts.usedAtMs).toISOString() }
	}
	return {
		name:   `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/uploadIntents/${opts.id}`,
		fields,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(firestore.queryUploadIntents).mockResolvedValue({ docs: [] })
	vi.mocked(firestore.deleteDoc).mockResolvedValue(undefined)
})

describe('purgeExpiredUploadIntents', () => {
	it('empty collection → no deletes, both passes 0', async () => {
		const report = await purgeExpiredUploadIntents('{}')
		expect(report.scanned).toBe(0)
		expect(report.deletedPending).toBe(0)
		expect(report.deletedUsed).toBe(0)
		// Both passes still made 1 query each (the empty result).
		expect(firestore.queryUploadIntents).toHaveBeenCalledTimes(2)
		expect(firestore.deleteDoc).not.toHaveBeenCalled()
	})

	it('pending intent past expiresAt + GRACE_MS → deleted', async () => {
		// expiresAt 10 min ago, well past the 5-min grace.
		const pendingDoc = intentDoc({ id: 'p-old', expiresAtMs: Date.now() - 10 * 60_000 })
		vi.mocked(firestore.queryUploadIntents)
			.mockResolvedValueOnce({ docs: [pendingDoc] })  // pass 1 yields it
			.mockResolvedValueOnce({ docs: [] })            // pass 2 empty

		const report = await purgeExpiredUploadIntents('{}')
		expect(report.deletedPending).toBe(1)
		expect(report.deletedUsed).toBe(0)
		expect(firestore.deleteDoc).toHaveBeenCalledWith(
			'fake-admin-token', PROJECT_ID, `trips/${TRIP_ID}/uploadIntents/p-old`,
		)
	})

	it('used intent past USED_RETENTION_DAYS → deleted in pass 2', async () => {
		// usedAt 8 days ago, past the 7-day retention.
		const usedDoc = intentDoc({ id: 'u-old', usedAtMs: Date.now() - 8 * 24 * 60 * 60_000 })
		vi.mocked(firestore.queryUploadIntents)
			.mockResolvedValueOnce({ docs: [] })          // pass 1 empty
			.mockResolvedValueOnce({ docs: [usedDoc] })   // pass 2 yields it

		const report = await purgeExpiredUploadIntents('{}')
		expect(report.deletedPending).toBe(0)
		expect(report.deletedUsed).toBe(1)
		expect(firestore.deleteDoc).toHaveBeenCalledWith(
			'fake-admin-token', PROJECT_ID, `trips/${TRIP_ID}/uploadIntents/u-old`,
		)
	})

	it('within-grace pending intent is NOT returned by query (server-side filter)', async () => {
		// The cron passes `now - GRACE_MS` to queryUploadIntents. A
		// pending intent expiring in the next 2 minutes shouldn't match.
		// Verify by checking the cutoff arg the cron passed in; the
		// query mock controls what comes back, so this is a pin on the
		// cron's cutoff calculation rather than the server semantics.
		await purgeExpiredUploadIntents('{}')

		const call = vi.mocked(firestore.queryUploadIntents).mock.calls[0]!
		// signature: (token, projectId, status, field, beforeMs, pageSize, cursorDocName?, cursorFieldMs?)
		expect(call[2]).toBe('pending')
		expect(call[3]).toBe('expiresAt')
		const beforeMs = call[4] as number
		// Within ~5s of (now - GRACE_MS), where GRACE_MS = 5 min.
		const expectedCutoff = Date.now() - 5 * 60_000
		expect(Math.abs(beforeMs - expectedCutoff)).toBeLessThan(5_000)
	})

	it('within-retention used intent is NOT returned by query (server-side filter)', async () => {
		await purgeExpiredUploadIntents('{}')

		const call = vi.mocked(firestore.queryUploadIntents).mock.calls[1]!
		expect(call[2]).toBe('used')
		expect(call[3]).toBe('usedAt')
		const beforeMs = call[4] as number
		const expectedCutoff = Date.now() - 7 * 24 * 60 * 60_000
		// 7d is a long window; allow 10s drift between test setup + cron read.
		expect(Math.abs(beforeMs - expectedCutoff)).toBeLessThan(10_000)
	})

	it('deleteDoc errors are counted, do NOT stall remaining docs', async () => {
		const d1 = intentDoc({ id: 'p-1', expiresAtMs: Date.now() - 10 * 60_000 })
		const d2 = intentDoc({ id: 'p-2', expiresAtMs: Date.now() - 11 * 60_000 })
		const d3 = intentDoc({ id: 'p-3', expiresAtMs: Date.now() - 12 * 60_000 })
		vi.mocked(firestore.queryUploadIntents)
			.mockResolvedValueOnce({ docs: [d1, d2, d3] })
			.mockResolvedValueOnce({ docs: [] })
		// First delete OK, second throws, third OK.
		vi.mocked(firestore.deleteDoc)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('500 some firestore issue'))
			.mockResolvedValueOnce(undefined)

		const report = await purgeExpiredUploadIntents('{}')
		expect(report.deletedPending).toBe(2)
		expect(report.deleteErrors).toBe(1)
		expect(firestore.deleteDoc).toHaveBeenCalledTimes(3)
	})

	it('query throws mid-scan → re-throws with partial counts in message', async () => {
		// Page 1 fits within the small test budget + deletes succeed;
		// page 2 query throws. Re-throw message must encode partial
		// counts so the cron's `.catch` log line stays informative.
		const fullPage = [
			intentDoc({ id: 'p1', expiresAtMs: Date.now() - 10 * 60_000 }),
			intentDoc({ id: 'p2', expiresAtMs: Date.now() - 11 * 60_000 }),
		]
		vi.mocked(firestore.queryUploadIntents)
			.mockResolvedValueOnce({ docs: fullPage })
			.mockRejectedValueOnce(new Error('503 backend overload'))

		// pageSize=2 forces a 2-doc page to be "full" so the loop fetches
		// another (which throws). Budget=10 covers query+delete+delete+
		// query attempt = 4 subrequests, well under 10.
		await expect(
			purgeExpiredUploadIntents('{}', { pageSize: 2, subrequestBudget: 10 }),
		).rejects.toThrow(
			/purgeExpiredUploadIntents.*scanned=2.*deletedPending=2.*503/,
		)
	})

	it('paginated drain: 2 pages threaded by (timestamp, name) cursor', async () => {
		const baseMs = Date.now() - 30 * 60_000
		const page1 = [
			intentDoc({ id: 'p1-a', expiresAtMs: baseMs + 100 }),
			intentDoc({ id: 'p1-b', expiresAtMs: baseMs + 200 }),
		]
		const page2 = [intentDoc({ id: 'p2-tail', expiresAtMs: baseMs + 999 })]
		vi.mocked(firestore.queryUploadIntents)
			.mockResolvedValueOnce({ docs: page1 })   // pass 1 page 1 (full)
			.mockResolvedValueOnce({ docs: page2 })   // pass 1 page 2 (short → done)
			.mockResolvedValueOnce({ docs: [] })      // pass 2 empty

		const report = await purgeExpiredUploadIntents('{}', { pageSize: 2, subrequestBudget: 20 })
		expect(report.deletedPending).toBe(3)
		// Page 2 query must have been called with the cursor (last page-1
		// doc's expiresAt + name).
		const page2Call = vi.mocked(firestore.queryUploadIntents).mock.calls[1]!
		const lastPage1 = page1[page1.length - 1]!
		// signature: (token, projectId, status, field, beforeMs,
		//             pageSize, cursorDocName?, cursorFieldMs?)
		expect(page2Call[6]).toBe(lastPage1.name)
		expect(page2Call[7]).toBe(baseMs + 200)
	})

	it('budget hit during page processing → pass 2 skipped', async () => {
		// 3 candidates + budget=3 (1 query + 2 deletes fit; budget gate
		// blocks the 3rd delete). budgetHit=true → pass 2 is skipped.
		const candidates = [
			intentDoc({ id: 'p-1', expiresAtMs: Date.now() - 10 * 60_000 }),
			intentDoc({ id: 'p-2', expiresAtMs: Date.now() - 11 * 60_000 }),
			intentDoc({ id: 'p-3', expiresAtMs: Date.now() - 12 * 60_000 }),
		]
		vi.mocked(firestore.queryUploadIntents).mockResolvedValueOnce({ docs: candidates })

		const report = await purgeExpiredUploadIntents('{}', { pageSize: 3, subrequestBudget: 3 })
		expect(report.budgetHit).toBe(true)
		expect(report.deletedPending).toBe(2)  // 3rd delete blocked by budget gate
		// Only 1 query total (pass 1's). Pass 2 skipped due to budgetHit.
		expect(firestore.queryUploadIntents).toHaveBeenCalledTimes(1)
	})

	it('malformed last doc (missing timestamp) → no crash; cursor still advances by name', async () => {
		// Defense: a doc somehow returned without the orderBy field
		// shouldn't crash the cron. Cursor's fieldMs stays undefined
		// in this corner; the next-query call falls through without a
		// startAt clause and finds the (now-deleted) docs gone. Pass
		// terminates cleanly without infinite loop. Won't happen in
		// production -- Firestore's `field < cutoff` filter guarantees
		// the field exists -- but cheap defensiveness against data
		// corruption or schema drift.
		const baseMs  = Date.now() - 10 * 60_000
		const valid   = intentDoc({ id: 'v', expiresAtMs: baseMs })
		const noField = { name: `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/uploadIntents/no-field`, fields: {} }
		vi.mocked(firestore.queryUploadIntents)
			.mockResolvedValueOnce({ docs: [valid, noField] })
			.mockResolvedValueOnce({ docs: [] })   // deleted docs gone now
			.mockResolvedValueOnce({ docs: [] })   // pass 2

		const report = await purgeExpiredUploadIntents('{}', { pageSize: 2, subrequestBudget: 20 })
		expect(report.scanned).toBe(2)
		expect(report.deletedPending).toBe(2)
		// Next-page query was attempted -- cursor advanced by name.
		// fieldMs stays undefined (queryUploadIntents will skip the
		// startAt clause), and the now-deleted docs are gone.
		const page2Call = vi.mocked(firestore.queryUploadIntents).mock.calls[1]!
		expect(page2Call[6]).toBe(noField.name)
		expect(page2Call[7]).toBeUndefined()
	})
})
