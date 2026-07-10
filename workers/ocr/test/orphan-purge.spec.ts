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
		// queryOrphanPurgeCandidates replaces the previous trips-list +
		// per-trip listDocNames sequence. Each test stubs it with the
		// page(s) of queue docs the run should observe.
		queryOrphanPurgeCandidates: vi.fn(async () => ({ docs: [] })),
		getDocFields:               vi.fn(),
		deleteDoc:                  vi.fn(async (..._args: unknown[]) => undefined),
		updateDocFields:            vi.fn(async (..._args: unknown[]) => true),
		readNestedString:           actual.readNestedString,
		readTimestampMs:            actual.readTimestampMs,
		stripDocPrefix:             actual.stripDocPrefix,
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

/** Stub the collection-group runQuery to return a single page of queue
 *  docs (each with full resource name + inline fields). drainOrphanPurges
 *  pages until short page → one call returning N < PAGE_SIZE docs is
 *  treated as "all done", which is what every test below wants. */
function mockOrphanPurgePage(docs: { name: string; fields: Record<string, unknown> }[]) {
	vi.mocked(firestore.queryOrphanPurgeCandidates).mockResolvedValueOnce({
		docs: docs as { name: string; fields: Record<string, import('../src/firestore').FsValue> }[],
	})
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('drainOrphanPurges', () => {
	it('confirmed orphan: entity does not reference path → delete blob + queue entry', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p1`
		mockOrphanPurgePage([{ name: purgeDocName, fields: purgeDoc() }])
		// Only ONE getDocFields call now: the entity read (purge fields
		// come inline from the runQuery). Has receipt but at a DIFFERENT
		// path → confirmed orphan.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
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
		mockOrphanPurgePage([{ name: purgeDocName, fields: purgeDoc() }])
		const orphanPath = `trips/${TRIP_ID}/expenses/exp-1/abc.webp`
		// Entity has the SAME path → false orphan.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
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
		mockOrphanPurgePage([{ name: purgeDocName, fields: purgeDoc({
			// entityRef under a DIFFERENT trip (trip-B).
			entityRef: { stringValue: `trips/trip-B/expenses/exp-1` },
			// path under trip-A (the scanning trip).
			path:      { stringValue: `trips/${TRIP_ID}/expenses/exp-1/orphan.webp` },
		}) }])
		// No entity read expected -- parse rejects before that step.

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
		mockOrphanPurgePage([{ name: purgeDocName, fields: purgeDoc() }])
		// Only entity read is mocked now; runQuery delivered purge fields
		// inline. Transient 5xx on entity verification → leave queue
		// entry intact for tomorrow's run.
		vi.mocked(firestore.getDocFields).mockRejectedValueOnce(
			new Error('getDocFields trips/trip-1/expenses/exp-1 -> 503: backend overload'),
		)

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
		mockOrphanPurgePage([{ name: purgeDocName, fields: purgeDoc({
			entityRef: { stringValue: `trips/${TRIP_ID}/schedules/sched-1` },
			path:      { stringValue: `trips/${TRIP_ID}/schedules/sched-1/orphan.webp` },
		}) }])

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
		mockOrphanPurgePage([{ name: purgeDocName, fields: purgeDoc({
			entityRef: { stringValue: `trips/${TRIP_ID}/expenses/exp-1` },
			path:      { stringValue: `trips/${TRIP_ID}/bookings/b-victim/legit.webp` },
		}) }])

		await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(firestore.deleteDoc).toHaveBeenCalledOnce()
	})

	it('entity doc deleted entirely → confirmed orphan, delete blob', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p3`
		mockOrphanPurgePage([{ name: purgeDocName, fields: purgeDoc() }])
		// Entity 404 → null → confirmed orphan.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(null)

		const report = await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).toHaveBeenCalledOnce()
		expect(report.blobsDeleted).toBe(1)
	})

	it('storage delete fails: bump attempts, keep queue entry', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p4`
		mockOrphanPurgePage([{
			name: purgeDocName,
			fields: purgeDoc({ attempts: { integerValue: '2' } }),
		}])
		// Entity deleted → confirmed orphan path.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(null)
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
		// attempts 9 → next bump would hit MAX_ATTEMPTS (10) → give up.
		mockOrphanPurgePage([{
			name: purgeDocName,
			fields: purgeDoc({ attempts: { integerValue: '9' } }),
		}])
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce(null)
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
		// In production the runQuery's `where createdAt < cutoff` filter
		// would prevent a fresh entry from ever reaching processPurgeEntry.
		// This test simulates the defense-in-depth check inside
		// processPurgeEntry that still re-validates the age (covers clock
		// skew between query time and process time).
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p6`
		mockOrphanPurgePage([{
			name: purgeDocName,
			fields: purgeDoc({ createdAt: { timestampValue: FRESH_ISO } }),
		}])

		const report = await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(firestore.deleteDoc).not.toHaveBeenCalled()
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
		// `scanned` ticks up (we did read the doc) but nothing else happened.
		expect(report.scanned).toBe(1)
		expect(report.blobsDeleted).toBe(0)
	})

	it('booking entityRef: check document.filePath / thumbPath', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p7`
		const orphanPath = `trips/${TRIP_ID}/bookings/b-1/abc.webp`
		mockOrphanPurgePage([{
			name: purgeDocName,
			fields: purgeDoc({
				entityRef: { stringValue: `trips/${TRIP_ID}/bookings/b-1` },
				path:      { stringValue: orphanPath },
			}),
		}])
		// Booking entity references a DIFFERENT path under document.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
			document: { mapValue: { fields: {
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
		mockOrphanPurgePage([{
			name: purgeDocName,
			fields: purgeDoc({ entityRef: undefined as unknown as { stringValue: string } }),
		}])

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
		mockOrphanPurgePage([{
			name: purgeDocName,
			fields: purgeDoc({ path: undefined as unknown as { stringValue: string } }),
		}])

		await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(firestore.deleteDoc).toHaveBeenCalledOnce()
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
	})

	it('wish entityRef: check image.path / thumbPath', async () => {
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p8`
		const orphanPath = `trips/${TRIP_ID}/wishes/w-1/abc.webp`
		mockOrphanPurgePage([{
			name: purgeDocName,
			fields: purgeDoc({
				entityRef: { stringValue: `trips/${TRIP_ID}/wishes/w-1` },
				path:      { stringValue: orphanPath },
			}),
		}])
		// Wish references SAME path → false orphan.
		vi.mocked(firestore.getDocFields).mockResolvedValueOnce({
			image: { mapValue: { fields: {
				path: { stringValue: orphanPath },
			} } },
		})

		const report = await drainOrphanPurges('{}', BUCKET)

		expect(storage.deleteObject).not.toHaveBeenCalled()
		expect(report.falseOrphans).toBe(1)
	})

	it('P2: first-page query failure → drainOrphanPurges rejects (cron log routes to failure path)', async () => {
		// Regression: a previous version caught queryOrphanPurgeCandidates
		// rejections and `break`d the pagination loop, returning a clean
		// `{ scanned: 0, ... }` report. That meant a missing collection-
		// group index, auth blip, or Firestore 5xx silently turned into
		// the cron's `[cron] orphan-purge done scanned=0` success line --
		// the entire queue would go stale with no observable signal.
		// Fix: re-throw so the Worker scheduled handler's .catch fires
		// `[cron] orphan-purge failed: ...` instead.
		vi.mocked(firestore.queryOrphanPurgeCandidates).mockRejectedValueOnce(
			new Error('FAILED_PRECONDITION: query requires an index'),
		)

		await expect(drainOrphanPurges('{}', BUCKET)).rejects.toThrow(
			/queryOrphanPurgeCandidates failed mid-drain.*FAILED_PRECONDITION/,
		)
	})

	it('P2: mid-drain query failure preserves partial counts in the error message', async () => {
		// Mid-drain failure case: first page succeeds (processes one
		// confirmed orphan -- blobsDeleted=1), second page rejects.
		// The thrown error must encode the partial accounting so cron
		// logs aren't only "failed" with no per-run breakdown.
		const purgeDocName = `projects/${PROJECT_ID}/databases/(default)/documents/trips/${TRIP_ID}/_purges/p-page1`
		vi.mocked(firestore.queryOrphanPurgeCandidates)
			// Page 1: PAGE_SIZE=500 → returning a short page (1 doc)
			// would terminate pagination cleanly. So we return PAGE_SIZE
			// (500) of the SAME doc to force a second-page query, then
			// reject on page 2. The deduped doc IDs don't matter for this
			// test -- we're only checking the error path, not state.
			.mockResolvedValueOnce({
				docs: Array.from({ length: 500 }, (_, i) => ({
					name: purgeDocName.replace('p-page1', `p-page1-${i}`),
					fields: purgeDoc(),
				})),
			})
			.mockRejectedValueOnce(new Error('503 backend overload'))

		// Every doc on page 1 hits the entity-read path; mock 500 nulls
		// so each is a confirmed orphan that gets deleted.
		vi.mocked(firestore.getDocFields).mockResolvedValue(null)

		await expect(drainOrphanPurges('{}', BUCKET)).rejects.toThrow(
			/queryOrphanPurgeCandidates failed mid-drain.*scanned=500.*blobsDeleted=500.*503/,
		)
	})
})
