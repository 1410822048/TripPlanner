// Tests for the orphan-blob purge cron. This is the durable next
// layer below `deleteStorageObject`'s in-process retry -- when a
// client-side purge.catch finally gives up, the service enqueues a
// `_purges` doc; this cron drains them daily.
//
// The cases we want to lock in:
//   1. Confirmed orphan: entity doc doesn't reference the path → blob
//      deleted, queue entry deleted.
//   2. False orphan: entity doc STILL references the path (user re-
//      uploaded between enqueue and drain) → no blob delete, queue
//      entry deleted (we're done with this purge attempt either way).
//   3. Entity doc was deleted entirely → confirmed orphan path.
//   4. Storage delete fails → attempts++ written, queue entry stays.
//   5. Storage delete fails with attempts == MAX → give up, drop the
//      queue entry to stop infinite retries on permanently-bad paths.
//   6. Age gate: queue entry younger than MIN_AGE_MS is skipped (so
//      in-flight retries finish naturally before cron races them).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/storage', () => ({
	deleteObject: vi.fn(async (..._args: unknown[]) => true),
}))
vi.mock('../src/firestore', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
	return {
		listDocNames:     vi.fn(),
		getDocFields:     vi.fn(),
		deleteDoc:        vi.fn(async (..._args: unknown[]) => undefined),
		updateDocFields:  vi.fn(async (..._args: unknown[]) => true),
		readNestedString: actual.readNestedString,
		readTimestampMs:  actual.readTimestampMs,
	}
})
vi.mock('../src/admin', () => ({
	getAdminToken: vi.fn(async () => 'fake-admin-token'),
	getProjectId:  vi.fn(() => 'demo-project'),
}))

import { drainOrphanPurges } from '../src/orphan-purge'
import * as storage from '../src/storage'
import * as firestore from '../src/firestore'

const PROJECT_ID = 'demo-project'
const BUCKET = 'demo.firebasestorage.app'
const TRIP_ID = 'trip-1'

/** Hour-old purge entry — passes the 1h age gate. */
const HOUR_AGO_ISO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
/** Brand-new purge entry — fails the 1h age gate. */
const FRESH_ISO    = new Date().toISOString()

/** Build a Firestore REST-shape purge doc with sane defaults. */
function purgeDoc(overrides: Record<string, unknown> = {}) {
	return {
		entityRef: { stringValue: `trips/${TRIP_ID}/expenses/exp-1` },
		path:      { stringValue: `trips/${TRIP_ID}/expenses/exp-1/abc.webp` },
		source:    { stringValue: 'updateExpense/purge-old-receipt' },
		attempts:  { integerValue: '0' },
		createdAt: { timestampValue: HOUR_AGO_ISO },
		tripId:    { stringValue: TRIP_ID },
		...overrides,
	}
}

/** Tell the mocked listDocNames to return a sequence of values across
 *  successive calls — first the trips collection, then each trip's
 *  _purges subcollection. */
function mockListDocNamesSequence(sequence: string[][]) {
	let i = 0
	vi.mocked(firestore.listDocNames).mockImplementation(async () => {
		return sequence[i++] ?? []
	})
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('drainOrphanPurges', () => {
	it('confirmed orphan: entity does not reference path → delete blob + queue entry', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p1`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields)
			// First call: read the purge doc.
			.mockResolvedValueOnce(purgeDoc())
			// Second call: read the entity. Has receipt but at a DIFFERENT path.
			.mockResolvedValueOnce({
				receipt: { mapValue: { fields: {
					path:      { stringValue: `trips/${TRIP_ID}/expenses/exp-1/different.webp` },
					thumbPath: { stringValue: `trips/${TRIP_ID}/expenses/exp-1/different.thumb.webp` },
				} } },
			})

		const report = await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).toHaveBeenCalledWith(
			'fake-admin-token', BUCKET, `trips/${TRIP_ID}/expenses/exp-1/abc.webp`,
		)
		expect(firestore.deleteDoc).toHaveBeenCalledWith(
			'fake-admin-token', PROJECT_ID, `trips/${TRIP_ID}/_purges/p1`,
		)
		expect(report.blobsDeleted).toBe(1)
		expect(report.falseOrphans).toBe(0)
	})

	it('false orphan: entity STILL references path → no blob delete, drop queue entry', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p2`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		const orphanPath = `trips/${TRIP_ID}/expenses/exp-1/abc.webp`
		vi.mocked(firestore.getDocFields)
			.mockResolvedValueOnce(purgeDoc())
			// Entity has the SAME path → false orphan.
			.mockResolvedValueOnce({
				receipt: { mapValue: { fields: {
					path: { stringValue: orphanPath },
				} } },
			})

		const report = await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(firestore.deleteDoc).toHaveBeenCalledTimes(1)
		expect(report.blobsDeleted).toBe(0)
		expect(report.falseOrphans).toBe(1)
	})

	it('P2: queue entry under trip-A claims entityRef in trip-B → drop without touching Storage', async () => {
		// Data-at-rest defense: rules layer pins entityRef tripId to
		// match the URL var, but a manually-edited / corrupted queue
		// entry could carry a cross-trip entityRef. Cron MUST refuse
		// to process it -- otherwise it would read trip-B's entity
		// to decide whether to delete what looks like trip-B's blob.
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p-crosstrip`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(purgeDoc({
			// entityRef under a DIFFERENT trip (trip-B).
			entityRef: { stringValue: `trips/trip-B/expenses/exp-1` },
			// path under trip-A (the scanning trip).
			path:      { stringValue: `trips/${TRIP_ID}/expenses/exp-1/orphan.webp` },
		}))

		await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		// Cross-trip queue entries are parser-rejected → dropped.
		expect(firestore.deleteDoc).toHaveBeenCalledOnce()
	})

	it('P1: transient entity read failure leaves queue entry, does NOT delete blob', async () => {
		// Headline regression: previously the cron caught ALL getDocFields
		// throws as "entity doesn't exist → confirmed orphan", but
		// getDocFields only returns null for 404. A Firestore 5xx /
		// network / auth blip would silently misclassify an active
		// doc's blob as orphan and delete it. Fail-closed semantics:
		// throw → leave queue entry intact, retry next run.
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p-transient`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields)
			// First call: read the purge doc (succeeds).
			.mockResolvedValueOnce(purgeDoc())
			// Second call: read the entity (transient 5xx).
			.mockRejectedValueOnce(new Error('getDocFields trips/trip-1/expenses/exp-1 -> 503: backend overload'))

		await drainOrphanPurges('{}', BUCKET)

		// Storage NOT touched -- we couldn't verify the path is orphan.
		expect(storage.deleteObject).not.toHaveBeenCalled()
		// Queue entry NOT deleted -- next cron run retries when the
		// transient condition clears.
		expect(firestore.deleteDoc).not.toHaveBeenCalled()
		// attempts NOT bumped either -- this isn't a Storage-delete
		// retry, it's a verification-step retry. (The attempts counter
		// only counts blob-delete failures.)
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
	})

	it('P1: malformed entityRef pattern (e.g. legacy schedule) dropped without touching Storage', async () => {
		// Schedule entityRefs are blocked at the rules layer for new
		// enqueues, but data-at-rest from before the rules tightening
		// could exist. parsePurgeEntry rejects them → drop the queue
		// entry, do NOT touch Storage. The borrow-the-blade vector that
		// schedule entityRefs originally enabled (cron treats ANY path
		// as orphan because schedule has no attachment field) is closed
		// before the cron even gets to the verification step.
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p-sched`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(purgeDoc({
			entityRef: { stringValue: `trips/${TRIP_ID}/schedules/sched-1` },
			path:      { stringValue: `trips/${TRIP_ID}/schedules/sched-1/orphan.webp` },
		}))

		await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(firestore.deleteDoc).toHaveBeenCalledOnce()  // queue entry dropped
	})

	it('P1: path outside entityRef folder dropped without touching Storage', async () => {
		// Data-at-rest defense against cross-collection borrow-the-
		// blade. entityRef=expenses/X + path=bookings/Y/legit -- the
		// rules layer blocks this on enqueue, but parsePurgeEntry has
		// to defend against legacy / corrupted entries that bypassed.
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p-cross`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(purgeDoc({
			entityRef: { stringValue: `trips/${TRIP_ID}/expenses/exp-1` },
			path:      { stringValue: `trips/${TRIP_ID}/bookings/b-victim/legit.webp` },
		}))

		await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(firestore.deleteDoc).toHaveBeenCalledOnce()
	})

	it('entity doc deleted entirely → confirmed orphan, delete blob', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p3`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields)
			.mockResolvedValueOnce(purgeDoc())
			// Entity 404 → null → confirmed orphan.
			.mockResolvedValueOnce(null)

		const report = await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).toHaveBeenCalledOnce()
		expect(report.blobsDeleted).toBe(1)
	})

	it('storage delete fails: bump attempts, keep queue entry', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p4`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields)
			.mockResolvedValueOnce(purgeDoc({ attempts: { integerValue: '2' } }))
			.mockResolvedValueOnce(null)  // entity deleted → confirmed orphan
		vi.mocked(storage.deleteObject).mockRejectedValueOnce(new Error('5xx blip'))

		await drainOrphanPurges('{}', BUCKET)

		// Attempts bumped from 2 → 3
		expect(firestore.updateDocFields).toHaveBeenCalledWith(
			'fake-admin-token', PROJECT_ID, `trips/${TRIP_ID}/_purges/p4`,
			expect.objectContaining({ attempts: expect.objectContaining({ integerValue: '3' }) }),
		)
		// Queue entry NOT deleted (we'll retry tomorrow).
		expect(firestore.deleteDoc).not.toHaveBeenCalled()
	})

	it('storage delete fails at MAX_ATTEMPTS: give up + drop queue entry', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p5`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields)
			// attempts 9 → next bump would hit MAX_ATTEMPTS (10).
			.mockResolvedValueOnce(purgeDoc({ attempts: { integerValue: '9' } }))
			.mockResolvedValueOnce(null)
		vi.mocked(storage.deleteObject).mockRejectedValueOnce(new Error('still failing'))

		const report = await drainOrphanPurges('{}', BUCKET)

		// Should NOT have bumped attempts (we're giving up instead)
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
		// Queue entry deleted to avoid infinite retries on bad path.
		expect(firestore.deleteDoc).toHaveBeenCalledWith(
			'fake-admin-token', PROJECT_ID, `trips/${TRIP_ID}/_purges/p5`,
		)
		expect(report.giveUps).toBe(1)
	})

	it('age gate: fresh queue entry is skipped (in-flight retries get grace window)', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p6`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields)
			.mockResolvedValueOnce(purgeDoc({ createdAt: { timestampValue: FRESH_ISO } }))

		const report = await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(firestore.deleteDoc).not.toHaveBeenCalled()
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
		// `scanned` ticks up (we did read the doc) but nothing else happened.
		expect(report.scanned).toBe(1)
		expect(report.blobsDeleted).toBe(0)
	})

	it('booking entityRef: check attachment.filePath / thumbPath', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p7`
		const orphanPath = `trips/${TRIP_ID}/bookings/b-1/abc.webp`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields)
			.mockResolvedValueOnce(purgeDoc({
				entityRef: { stringValue: `trips/${TRIP_ID}/bookings/b-1` },
				path:      { stringValue: orphanPath },
			}))
			.mockResolvedValueOnce({
				// Booking entity references a DIFFERENT path under attachment.
				attachment: { mapValue: { fields: {
					filePath: { stringValue: `trips/${TRIP_ID}/bookings/b-1/different.webp` },
				} } },
			})

		await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).toHaveBeenCalledWith(
			'fake-admin-token', BUCKET, orphanPath,
		)
	})

	it('malformed queue doc (missing entityRef): drop entry, do NOT touch storage', async () => {
		// Fail-closed regression: a corrupt / legacy queue entry without
		// the bindings the cron needs MUST drop without retrying. Without
		// this guard a missing entityRef would skip the still-referenced
		// check and the cron would either crash or treat ANY path as
		// orphan -- the latter is the exact borrow-the-blade fail mode
		// the rules layer fixes for live writes but the cron has to
		// defend against on legacy / corrupted data.
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p-malformed`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(
			purgeDoc({ entityRef: undefined as unknown as { stringValue: string } }),
		)

		await drainOrphanPurges('{}', BUCKET)

		// Storage NOT touched (we don't know what to verify against).
		expect(storage.deleteObject).not.toHaveBeenCalled()
		// Queue entry deleted to stop infinite retry on a doc the cron
		// can never reason about.
		expect(firestore.deleteDoc).toHaveBeenCalledWith(
			'fake-admin-token', PROJECT_ID, `trips/${TRIP_ID}/_purges/p-malformed`,
		)
		// attempts NOT bumped (this isn't a transient retry case).
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
	})

	it('malformed queue doc (missing path): same fail-closed drop', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p-malformed2`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(
			purgeDoc({ path: undefined as unknown as { stringValue: string } }),
		)

		await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(firestore.deleteDoc).toHaveBeenCalledOnce()
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
	})

	it('wish entityRef: check image.path / thumbPath', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p8`
		const orphanPath = `trips/${TRIP_ID}/wishes/w-1/abc.webp`
		mockListDocNamesSequence([
			[`projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}`],
			[purgeDocName],
		])
		vi.mocked(firestore.getDocFields)
			.mockResolvedValueOnce(purgeDoc({
				entityRef: { stringValue: `trips/${TRIP_ID}/wishes/w-1` },
				path:      { stringValue: orphanPath },
			}))
			.mockResolvedValueOnce({
				// Wish references SAME path → false orphan.
				image: { mapValue: { fields: {
					path: { stringValue: orphanPath },
				} } },
			})

		const report = await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(report.falseOrphans).toBe(1)
	})
})
