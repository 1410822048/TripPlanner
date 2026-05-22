// Tests for the Level 4 orphan-storage reconciliation cron.
//
// Cases locked in:
//   1. Confirmed orphan (entity doc missing) → blob deleted.
//   2. Confirmed orphan (entity exists but doesn't reference this path
//      anymore, e.g. user replaced attachment) → blob deleted.
//   3. Still-referenced blob → skipped, never deleted.
//   4. Grace window: timeCreated within 24h → skipped, never read.
//   5. Unparseable path (outside trips/{ALLOWED}/{X}/Y/...) → skipped.
//   6. Entity Firestore read failure → fail-closed, blob NOT deleted.
//   7. Pagination: nextPageToken threading through multiple pages.
//   8. listObjects throws → drainScan re-throws with partial counts in
//      the message (so cron failure log line stays informative).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/storage', () => ({
	listObjects:  vi.fn(),
	deleteObject: vi.fn(async (..._args: unknown[]) => true),
}))
vi.mock('../src/sentry', () => ({
	captureMessage: vi.fn(async () => undefined),
}))
// Partial mock: stub the network calls (getDocFields, scan cursor) but
// keep the pure-decode helpers REAL -- referencedPaths (re-exported
// from orphan-purge.ts) uses readNestedString internally, so a fully-
// stubbed firestore module would make ref checks always return an
// empty Set and falsely classify every blob as orphan.
vi.mock('../src/firestore', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
	return {
		getDocFields:     vi.fn(),
		// Cursor helpers default to no-op so existing tests work unchanged
		// (no saved cursor → start from top, no save on completion).
		// Starvation tests override these with stateful closures.
		getScanCursor:    vi.fn(async () => null),
		setScanCursor:    vi.fn(async () => undefined),
		clearScanCursor:  vi.fn(async () => undefined),
		readNestedString: actual.readNestedString,
		readTimestampMs:  actual.readTimestampMs,
	}
})
vi.mock('../src/admin', () => ({
	getAdminToken: vi.fn(async () => 'fake-admin-token'),
	getProjectId:  vi.fn(() => 'demo-project'),
}))

import { scanOrphanStorage } from '../src/storage-scan'
import * as storage          from '../src/storage'
import * as firestore        from '../src/firestore'
import * as sentry           from '../src/sentry'

const BUCKET   = 'demo.firebasestorage.app'
const TRIP_ID  = 'trip-1'

// Two hours ago in ISO → comfortably outside the 24h grace window when
// MIN_AGE_MS is measured from now? No -- two hours ago IS within 24h.
// We want OLD enough to pass the grace gate, so use 2 days ago.
const OLD_ISO   = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
const FRESH_ISO = new Date(Date.now() - 30 * 60 * 1000).toISOString()  // 30 min ago

/** Helper to stage a single listObjects page (no further pages). */
function mockSinglePage(items: { name: string; timeCreated?: string }[]) {
	vi.mocked(storage.listObjects).mockResolvedValueOnce({ items })
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('scanOrphanStorage', () => {
	it('confirmed orphan: entity doc missing → delete blob', async () => {
		const orphanPath = `trips/${TRIP_ID}/expenses/exp-1/receipt.webp`
		mockSinglePage([{ name: orphanPath, timeCreated: OLD_ISO }])
		// getDocFields returns null → entity doesn't exist.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(null)

		const report = await scanOrphanStorage('{}', BUCKET)

		expect(storage.deleteObject).toHaveBeenCalledWith(
			'fake-admin-token', BUCKET, orphanPath,
		)
		expect(report.deleted).toBe(1)
		expect(report.referenced).toBe(0)
		expect(report.readErrors).toBe(0)
	})

	it('confirmed orphan: entity exists but does NOT reference blob path → delete', async () => {
		const orphanPath = `trips/${TRIP_ID}/expenses/exp-1/old-receipt.webp`
		mockSinglePage([{ name: orphanPath, timeCreated: OLD_ISO }])
		// Entity exists but receipt.path points elsewhere (user replaced).
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
			receipt: { mapValue: { fields: {
				path:      { stringValue: `trips/${TRIP_ID}/expenses/exp-1/NEW-receipt.webp` },
				thumbPath: { stringValue: `trips/${TRIP_ID}/expenses/exp-1/NEW-receipt.thumb.webp` },
			} } },
		})

		const report = await scanOrphanStorage('{}', BUCKET)

		expect(storage.deleteObject).toHaveBeenCalledWith(
			'fake-admin-token', BUCKET, orphanPath,
		)
		expect(report.deleted).toBe(1)
	})

	it('still-referenced blob: entity references this path → skip, never delete', async () => {
		const livePath = `trips/${TRIP_ID}/expenses/exp-1/receipt.webp`
		mockSinglePage([{ name: livePath, timeCreated: OLD_ISO }])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
			receipt: { mapValue: { fields: {
				path: { stringValue: livePath },
			} } },
		})

		const report = await scanOrphanStorage('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(report.referenced).toBe(1)
		expect(report.deleted).toBe(0)
	})

	it('grace window: fresh blob (< 24h) → skip, never even read entity', async () => {
		// Headline guard: editor abuse mid-upload shouldn't be racy --
		// the 24h grace lets a multi-second upload + OCR + retry pipeline
		// complete naturally before we'd ever consider it orphan. Even
		// IF the entity isn't there yet, we don't look (no Firestore read).
		const freshPath = `trips/${TRIP_ID}/expenses/exp-1/receipt.webp`
		mockSinglePage([{ name: freshPath, timeCreated: FRESH_ISO }])

		const report = await scanOrphanStorage('{}', BUCKET)

		expect(firestore.getDocFields).not.toHaveBeenCalled()
		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(report.freshSkipped).toBe(1)
	})

	it('unparseable path: outside trips/{expenses|bookings|wishes}/{Y}/... → skip', async () => {
		// A manual upload to an unmanaged prefix (e.g. trips/X/other/...)
		// MUST NOT be touched -- we have no doc schema to verify it
		// against. Fail-closed.
		mockSinglePage([
			{ name: `trips/${TRIP_ID}/other/abc/file.webp`, timeCreated: OLD_ISO },
			{ name: `random-toplevel-file.txt`,             timeCreated: OLD_ISO },
			{ name: `trips/${TRIP_ID}/schedules/s-1/x.webp`, timeCreated: OLD_ISO },
		])

		const report = await scanOrphanStorage('{}', BUCKET)

		expect(firestore.getDocFields).not.toHaveBeenCalled()
		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(report.unparseable).toBe(3)
	})

	it('entity read fails (5xx / network) → fail-closed, blob NOT deleted', async () => {
		// Mirrors orphan-purge cron: a transient Firestore failure MUST
		// NOT let the scan misclassify a possibly-live blob as orphan
		// and delete it. Leave the blob, count the error, tomorrow tries
		// again.
		const path = `trips/${TRIP_ID}/expenses/exp-1/receipt.webp`
		mockSinglePage([{ name: path, timeCreated: OLD_ISO }])
		vi.mocked(firestore.getDocFields).mockRejectedValueOnce(
			new Error('getDocFields -> 503 backend overload'),
		)

		const report = await scanOrphanStorage('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(report.readErrors).toBe(1)
		expect(report.deleted).toBe(0)
	})

	it('pagination: nextPageToken threads through multiple pages', async () => {
		const path1 = `trips/${TRIP_ID}/expenses/exp-1/p1.webp`
		const path2 = `trips/${TRIP_ID}/expenses/exp-2/p2.webp`
		// Page 1: 1 item + nextPageToken.
		vi.mocked(storage.listObjects)
			.mockResolvedValueOnce({
				items: [{ name: path1, timeCreated: OLD_ISO }],
				nextPageToken: 'token-1',
			})
			// Page 2: 1 item, no next page.
			.mockResolvedValueOnce({
				items: [{ name: path2, timeCreated: OLD_ISO }],
			})
		// Both entities missing → both orphan.
		vi.mocked(firestore.getDocFields).mockResolvedValue(null)

		const report = await scanOrphanStorage('{}', BUCKET)

		// 2 list calls (page 1 + page 2).
		expect(storage.listObjects).toHaveBeenCalledTimes(2)
		// Second list call passed the page-1 token.
		expect(vi.mocked(storage.listObjects).mock.calls[1]).toEqual(
			expect.arrayContaining(['token-1']),
		)
		// Both blobs deleted.
		expect(storage.deleteObject).toHaveBeenCalledTimes(2)
		expect(report.deleted).toBe(2)
		expect(report.scanned).toBe(2)
	})

	it('listObjects throws mid-scan → re-throw with partial counts encoded in message', async () => {
		// Regression for the observability invariant: a query failure
		// must NOT degrade into a phantom "scanned=0" cron success.
		// Re-throw routes through index.ts's `.catch` log line, and the
		// message carries the partial counts so the operator sees what
		// was accomplished before the failure.
		const path = `trips/${TRIP_ID}/expenses/exp-1/p.webp`
		vi.mocked(storage.listObjects)
			// Page 1 succeeds with 1 confirmed orphan.
			.mockResolvedValueOnce({
				items: [{ name: path, timeCreated: OLD_ISO }],
				nextPageToken: 'token-1',
			})
			// Page 2 throws (e.g. auth blip, 5xx).
			.mockRejectedValueOnce(new Error('503 GCS overload'))
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(null)

		await expect(scanOrphanStorage('{}', BUCKET)).rejects.toThrow(
			/storage-scan listObjects failed mid-scan.*scanned=1 deleted=1.*503/,
		)
	})

	it('booking path: parses + routes to attachment.filePath/thumbPath check', async () => {
		// Cross-collection coverage: same scan applies to bookings.
		// Tests that the path regex correctly distinguishes the
		// collection segment and feeds it to referencedPaths().
		const orphanPath = `trips/${TRIP_ID}/bookings/b-1/old.webp`
		mockSinglePage([{ name: orphanPath, timeCreated: OLD_ISO }])
		// Booking exists but attachment is on a different path.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
			attachment: { mapValue: { fields: {
				filePath: { stringValue: `trips/${TRIP_ID}/bookings/b-1/NEW.webp` },
			} } },
		})

		const report = await scanOrphanStorage('{}', BUCKET)

		expect(storage.deleteObject).toHaveBeenCalledWith(
			'fake-admin-token', BUCKET, orphanPath,
		)
		expect(report.deleted).toBe(1)
	})

	it('wish path: parses + routes to image.path/thumbPath check', async () => {
		const wishPath = `trips/${TRIP_ID}/wishes/w-1/cover.webp`
		mockSinglePage([{ name: wishPath, timeCreated: OLD_ISO }])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
			image: { mapValue: { fields: {
				path: { stringValue: wishPath },
			} } },
		})

		const report = await scanOrphanStorage('{}', BUCKET)

		// Wish references the path → skip.
		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(report.referenced).toBe(1)
	})

	it('listObjects passes PAGE_SIZE=1000 (scan-specific, not the default 500)', async () => {
		// Locks in the design decision: scan opts for 1000 to halve
		// round-trips vs trip-cascade / receipt-purge's default 500.
		// If a future change accidentally drops the 5th positional arg,
		// this catches it.
		mockSinglePage([])

		await scanOrphanStorage('{}', BUCKET)

		expect(storage.listObjects).toHaveBeenCalledWith(
			'fake-admin-token', BUCKET, 'trips/', undefined, 1000,
		)
	})

	it('P2: subrequest budget exhausted mid-page → budgetHit + not-all-processed', async () => {
		// Regression for the hard-budget gate. CONCURRENCY=5 only bounds
		// parallelism, not total fetch count -- without the budget gate
		// an all-orphan page would fire 1000 reads + 1000 deletes and
		// blow Cloudflare's 1000-subrequest-per-invocation ceiling for
		// scheduled handlers.
		//
		// Test shape: stage MANY more orphans than the budget allows,
		// then assert (a) the gate fires (budgetHit=true) AND (b) we
		// didn't process all of them. Exact "deleted" count is racy
		// because CONCURRENCY=5 workers can all clear the pre-check
		// before any of them finishes its delete -- that's a deliberate
		// design trade-off (bounded race-overshoot of ≤ CONCURRENCY is
		// harmless given the 100-subrequest buffer below 1000 cap), and
		// the test reflects the contract, not the exact arithmetic.
		const ORPHAN_COUNT = 20
		const paths = Array.from(
			{ length: ORPHAN_COUNT },
			(_, i) => `trips/${TRIP_ID}/expenses/exp-${i}/p.webp`,
		)
		mockSinglePage(paths.map(p => ({ name: p, timeCreated: OLD_ISO })))
		vi.mocked(firestore.getDocFields).mockResolvedValue(null)

		const report = await scanOrphanStorage('{}', BUCKET, { subrequestBudget: 4 })

		expect(report.budgetHit).toBe(true)
		// Critical contract: gate prevented running ALL of them.
		expect(report.deleted).toBeLessThan(ORPHAN_COUNT)
		// And we DID make progress on at least one (otherwise the gate
		// is over-tight and effectively a no-op).
		expect(report.deleted).toBeGreaterThanOrEqual(1)
	})

	it('P2 starvation guard: budget-hit on all-live page advances cursor for next run', async () => {
		// Critical regression: without cross-run cursor persistence, a
		// bucket whose first page is mostly live-referenced blobs would
		// re-read the same head items every cron run, burning the budget
		// before reaching later pages where the actual orphans live.
		// Fix: save page.nextPageToken on budgetHit so tomorrow advances.
		//
		// Test shape: stateful cursor mock simulates Firestore across two
		// scanOrphanStorage calls. Run 1 stalls on page 1 (all referenced
		// → all reads, never deletes). Run 2 must invoke listObjects with
		// the saved pageToken from run 1.
		let mockCursorState: { pageToken: string; savedAtMs: number } | null = null
		vi.mocked(firestore.getScanCursor).mockImplementation(async () => mockCursorState)
		vi.mocked(firestore.setScanCursor).mockImplementation(async (_t, _p, _k, pt) => {
			mockCursorState = { pageToken: pt, savedAtMs: Date.now() }
		})
		vi.mocked(firestore.clearScanCursor).mockImplementation(async () => {
			mockCursorState = null
		})

		const LIVE_PATHS = Array.from(
			{ length: 20 },
			(_, i) => `trips/${TRIP_ID}/expenses/live-${i}/p.webp`,
		)
		// Every entity returns "still references this path" → no deletes,
		// no cursor advance from "items disappearing on next list".
		// Only cross-run cursor save can save us.
		vi.mocked(firestore.getDocFields).mockImplementation(async (_t, _p, path) => {
			// Reconstruct the live path from the entity doc path so the
			// ref check matches exactly. entity path = trips/T/expenses/E,
			// referenced path = trips/T/expenses/E/p.webp.
			return {
				receipt: { mapValue: { fields: {
					path: { stringValue: `${path}/p.webp` },
				} } },
			}
		})

		// Run 1: page 1 (20 live items), has nextPageToken.
		vi.mocked(storage.listObjects).mockResolvedValueOnce({
			items: LIVE_PATHS.map(p => ({ name: p, timeCreated: OLD_ISO })),
			nextPageToken: 'cursor-after-page-1',
		})

		const report1 = await scanOrphanStorage('{}', BUCKET, { subrequestBudget: 4 })
		expect(report1.budgetHit).toBe(true)
		expect(report1.deleted).toBe(0)             // all references confirmed live
		expect(mockCursorState).not.toBeNull()      // cursor SAVED, not cleared
		expect(mockCursorState?.pageToken).toBe('cursor-after-page-1')

		// Run 2: now stage page 2. listObjects must be called with the
		// saved cursor, NOT undefined (which would mean "restart from
		// page 1" = the starvation we're testing for).
		vi.mocked(storage.listObjects).mockReset()
		vi.mocked(storage.listObjects).mockResolvedValueOnce({
			items: [],  // empty page just to confirm the call, no further work
			nextPageToken: undefined,
		})

		await scanOrphanStorage('{}', BUCKET, { subrequestBudget: 4 })

		// THE assertion that closes the starvation hole:
		expect(storage.listObjects).toHaveBeenCalledWith(
			'fake-admin-token', BUCKET, 'trips/', 'cursor-after-page-1', 1000,
		)
		// And the cursor was cleared on this run's natural drain (last
		// page had no nextPageToken).
		expect(mockCursorState).toBeNull()
	})

	it('cursor age > 7 days → ignore stale cursor, restart from top', async () => {
		// Defensive guard against a cursor from a much earlier deploy /
		// long-broken cron. The pageToken's "position" in the bucket
		// becomes meaningless after weeks of mutations; fresh start
		// avoids accidentally jumping past head-of-bucket orphans that
		// piled up while the cron was stuck.
		const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
		vi.mocked(firestore.getScanCursor).mockResolvedValueOnce({
			pageToken: 'ancient-cursor',
			savedAtMs: eightDaysAgo,
		})
		mockSinglePage([])  // empty page; this test only verifies the load gate

		await scanOrphanStorage('{}', BUCKET)

		// listObjects was called with undefined pageToken (NOT the stale one).
		expect(storage.listObjects).toHaveBeenCalledWith(
			'fake-admin-token', BUCKET, 'trips/', undefined, 1000,
		)
	})

	it('Phase 2: orphansByUid attribution from customMetadata', async () => {
		// Verifies the abuse-detection input pipeline:
		// 1. listObjects returns metadata.uploaderUid in the partial response
		// 2. confirmed orphans get bucketed in report.orphansByUid by that uid
		// 3. legacy blobs without metadata land in '<unknown>'
		mockSinglePage([
			{
				name:        `trips/${TRIP_ID}/expenses/exp-1/p1.webp`,
				timeCreated: OLD_ISO,
				metadata:    { uploaderUid: 'user-A' },
			},
			{
				name:        `trips/${TRIP_ID}/expenses/exp-2/p2.webp`,
				timeCreated: OLD_ISO,
				metadata:    { uploaderUid: 'user-A' },
			},
			{
				name:        `trips/${TRIP_ID}/expenses/exp-3/p3.webp`,
				timeCreated: OLD_ISO,
				metadata:    { uploaderUid: 'user-B' },
			},
			{
				name:        `trips/${TRIP_ID}/expenses/exp-4/p4.webp`,
				timeCreated: OLD_ISO,
				// No metadata -- legacy / pre-Phase-2 blob.
			},
		])
		// All entities missing → all 4 confirmed orphans.
		vi.mocked(firestore.getDocFields).mockResolvedValue(null)

		const report = await scanOrphanStorage('{}', BUCKET)

		expect(report.deleted).toBe(4)
		expect(report.orphansByUid).toEqual({
			'user-A':    2,
			'user-B':    1,
			'<unknown>': 1,
		})
	})

	it('Phase 2: abuse threshold exceeded → captureMessage fires (warning)', async () => {
		// ABUSE_THRESHOLD is 10; stage 12 orphans from same uid to trip it.
		// Goal of the test: confirm the alert path is wired up + carries
		// uid + count in tags/extra so Sentry rendering shows the abuser.
		const ABUSE_COUNT = 12
		const items = Array.from({ length: ABUSE_COUNT }, (_, i) => ({
			name:        `trips/${TRIP_ID}/expenses/exp-${i}/p.webp`,
			timeCreated: OLD_ISO,
			metadata:    { uploaderUid: 'editor-abusive' },
		}))
		mockSinglePage(items)
		vi.mocked(firestore.getDocFields).mockResolvedValue(null)

		const fakeEnv = { SENTRY_DSN: 'https://test@example.sentry.io/1' }
		await scanOrphanStorage('{}', BUCKET, { sentryEnv: fakeEnv })

		// Sentry captureMessage was called with the abuser attribution.
		expect(sentry.captureMessage).toHaveBeenCalledTimes(1)
		const call = vi.mocked(sentry.captureMessage).mock.calls[0]!
		expect(call[0]).toBe(fakeEnv)                                          // env threaded
		expect(call[1]).toMatch(/editor-abusive.*12/)                          // message has uid + count
		expect(call[2]).toBe('warning')                                        // severity level
		expect(call[3]).toMatchObject({ uid: 'editor-abusive' })               // tags
		expect(call[4]).toMatchObject({ orphanCount: ABUSE_COUNT, threshold: 10 })  // extra
	})

	it('Phase 2: under threshold → no Sentry; <unknown> uid never counted', async () => {
		// 5 orphans from a real uid (under threshold 10) + 50 legacy
		// '<unknown>' orphans (way over threshold but excluded). Neither
		// should fire an abuse alert. Important: the <unknown> exclusion
		// is what stops the rollout window of legacy blobs from spamming
		// false-positive alerts during Phase 2 rollout.
		const items = [
			...Array.from({ length: 5 }, (_, i) => ({
				name:        `trips/${TRIP_ID}/expenses/normal-${i}/p.webp`,
				timeCreated: OLD_ISO,
				metadata:    { uploaderUid: 'user-normal' },
			})),
			...Array.from({ length: 50 }, (_, i) => ({
				name:        `trips/${TRIP_ID}/expenses/legacy-${i}/p.webp`,
				timeCreated: OLD_ISO,
				// No metadata.
			})),
		]
		mockSinglePage(items)
		vi.mocked(firestore.getDocFields).mockResolvedValue(null)

		const fakeEnv = { SENTRY_DSN: 'https://test@example.sentry.io/1' }
		const report = await scanOrphanStorage('{}', BUCKET, { sentryEnv: fakeEnv })

		expect(sentry.captureMessage).not.toHaveBeenCalled()
		expect(report.orphansByUid['user-normal']).toBe(5)
		expect(report.orphansByUid['<unknown>']).toBe(50)
	})

	it('deleteObject returns false (404, already gone) → NOT counted as deleted', async () => {
		// Polish: trip-cascade or another scheduled handler can race us
		// between the listObjects page and our delete call. deleteObject
		// returns false on 404 (idempotent already-gone); the scan's
		// `deleted` stat is "blobs WE removed", not "blobs that no
		// longer exist". Counting 404s would inflate the metric and
		// mislead observability ("scan caught N orphans" → really N-K
		// orphans, K already-gone).
		const path = `trips/${TRIP_ID}/expenses/exp-1/p.webp`
		mockSinglePage([{ name: path, timeCreated: OLD_ISO }])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(null)
		// deleteObject returns false (object already gone).
		vi.mocked(storage.deleteObject).mockResolvedValueOnce(false)

		const report = await scanOrphanStorage('{}', BUCKET)

		expect(storage.deleteObject).toHaveBeenCalledTimes(1)
		expect(report.deleted).toBe(0)
		expect(report.deleteErrors).toBe(0)
	})
})
