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
// Partial mock: stub the network calls (getDocFields) but keep the
// pure-decode helpers REAL -- referencedPaths (re-exported from
// orphan-purge.ts) uses readNestedString internally, so a fully-stubbed
// firestore module would make ref checks always return an empty Set
// and falsely classify every blob as orphan.
vi.mock('../src/firestore', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
	return {
		getDocFields:     vi.fn(),
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
})
