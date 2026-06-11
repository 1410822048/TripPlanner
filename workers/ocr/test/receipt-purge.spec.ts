// Tests for the daily receipt-purge cron. The defects we want to
// lock in regression coverage for are exactly the ones that already
// shipped silently:
//   1. Reading the WRONG field path (top-level `receiptPath` vs.
//      nested `receipt.path` map) — silent no-op, looks like a
//      success because `scanned` ticks up but `receiptsDeleted`
//      stays 0 forever.
//   2. Patching with `nullValue` on `receipt` — would clash with
//      the Zod schema's optional() (accepts undefined, NOT null)
//      so the next client read parses incorrectly. Correct path
//      is `deleteDocFields(['receipt'])` (updateMask-no-body),
//      which maps back to `undefined` for clients.
//   3. Not stamping `receiptPurgedAt` after cleanup — the
//      filtered query (`receiptPurgedAt == null AND deletedAt <
//      cutoff`) would keep matching the cleaned doc every day
//      forever (O(all historical tombstones) per cron run).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// IMPORTANT: keep `readNestedString` REAL (not a stub) so a regression
// in the helper itself (e.g. someone "simplifies" the mapValue.fields
// walk) immediately breaks these tests. vi.importActual pulls the
// actual implementation and we cherry-pick it back into the mock.
vi.mock('../src/storage', () => ({
	deleteObject: vi.fn(async (..._args: unknown[]) => true),
}))
vi.mock('../src/firestore', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
	return {
		queryReceiptPurgeCandidates: vi.fn(),
		// Default `true` matches the helper's "doc existed, patch
		// landed" success return. Individual tests overwrite with
		// `false` to simulate the doc-vanished race.
		deleteDocFields:             vi.fn(async (..._args: unknown[]) => true),
		updateDocFields:             vi.fn(async (..._args: unknown[]) => true),
		readNestedString:            actual.readNestedString,
		readTimestampMs:             actual.readTimestampMs,
	}
})
vi.mock('../src/admin', () => ({
	getAdminToken: vi.fn(async () => 'fake-admin-token'),
	getProjectId:  vi.fn(() => 'demo-project'),
}))

import { purgeExpiredReceipts } from '../src/receipt-purge'
import * as storage             from '../src/storage'
import * as firestore           from '../src/firestore'

beforeEach(() => {
	vi.clearAllMocks()
	// Default: empty page → loop exits immediately. Individual tests
	// override before invoking purgeExpiredReceipts.
	vi.mocked(firestore.queryReceiptPurgeCandidates).mockResolvedValue({ docs: [] })
})

/** Helper: shape a Firestore REST doc with the nested receipt map the
 *  schema uses. Mirrors `ExpenseDocSchema.receipt: { path, type,
 *  thumbPath? }`. */
function docWithReceipt(name: string, opts: {
	path?:       string | null
	thumbPath?:  string | null
	deletedAtMs: number
}) {
	const receipt: Record<string, { stringValue?: string }> = {}
	if (opts.path != null)      receipt.path      = { stringValue: opts.path }
	if (opts.thumbPath != null) receipt.thumbPath = { stringValue: opts.thumbPath }
	return {
		name,
		fields: {
			deletedAt: { timestampValue: new Date(opts.deletedAtMs).toISOString() },
			...(Object.keys(receipt).length > 0
				? { receipt: { mapValue: { fields: receipt } } }
				: {}),
		},
	}
}

describe('purgeExpiredReceipts - reads nested receipt fields', () => {
	it('deletes both receipt.path and receipt.thumbPath when present', async () => {
		vi.mocked(firestore.queryReceiptPurgeCandidates).mockResolvedValueOnce({
			docs: [
				docWithReceipt('projects/demo-project/databases/(default)/documents/trips/t1/expenses/e1', {
					path:        'trips/t1/expenses/e1/receipt.webp',
					thumbPath:   'trips/t1/expenses/e1/thumb.webp',
					deletedAtMs: Date.now() - 11 * 24 * 3600 * 1000,
				}),
			],
		})
		const report = await purgeExpiredReceipts('sa-json', 'demo-bucket')
		expect(report.scanned).toBe(1)
		expect(report.receiptsDeleted).toBe(2)
		expect(report.docsPatched).toBe(1)
		const calls = vi.mocked(storage.deleteObject).mock.calls
		expect(calls.map(c => c[2])).toEqual([
			'trips/t1/expenses/e1/receipt.webp',
			'trips/t1/expenses/e1/thumb.webp',
		])
	})

	it('deletes only main receipt when thumbPath absent (PDF receipts have no thumb)', async () => {
		vi.mocked(firestore.queryReceiptPurgeCandidates).mockResolvedValueOnce({
			docs: [
				docWithReceipt('projects/demo-project/databases/(default)/documents/trips/t1/expenses/e2', {
					path:        'trips/t1/expenses/e2/receipt.pdf',
					deletedAtMs: Date.now() - 11 * 24 * 3600 * 1000,
				}),
			],
		})
		const report = await purgeExpiredReceipts('sa-json', 'demo-bucket')
		expect(report.receiptsDeleted).toBe(1)
		expect(vi.mocked(storage.deleteObject).mock.calls.map(c => c[2])).toEqual([
			'trips/t1/expenses/e2/receipt.pdf',
		])
	})

	it('does not touch Storage when doc has no receipt, but still stamps the marker', async () => {
		// Edge case: a doc somehow matched the query (deletedAt <
		// cutoff AND receiptPurgedAt == null) yet has no receipt
		// fields. We MUST still stamp receiptPurgedAt so the cron
		// doesn't re-visit it forever -- otherwise the no-receipt
		// edge case becomes the same O(all historical) scan that
		// this whole marker was meant to prevent.
		vi.mocked(firestore.queryReceiptPurgeCandidates).mockResolvedValueOnce({
			docs: [
				docWithReceipt('projects/demo-project/databases/(default)/documents/trips/t1/expenses/e3', {
					deletedAtMs: Date.now() - 11 * 24 * 3600 * 1000,
				}),
			],
		})
		const report = await purgeExpiredReceipts('sa-json', 'demo-bucket')
		expect(report.scanned).toBe(1)
		expect(report.receiptsDeleted).toBe(0)
		expect(report.docsPatched).toBe(1)
		expect(storage.deleteObject).not.toHaveBeenCalled()
		// deleteDocFields(['receipt']) NOT called when there was no
		// receipt -- pure no-op write would be wasteful.
		expect(firestore.deleteDocFields).not.toHaveBeenCalled()
		// updateDocFields stamping receiptPurgedAt IS called.
		expect(firestore.updateDocFields).toHaveBeenCalledTimes(1)
		const stampPatch = vi.mocked(firestore.updateDocFields).mock.calls[0][3]
		expect(Object.keys(stampPatch)).toEqual(['receiptPurgedAt'])
		expect(stampPatch.receiptPurgedAt.timestampValue).toBeTruthy()
	})
})

describe('purgeExpiredReceipts - clears receipt + stamps marker', () => {
	it('clears the WHOLE receipt map field, not individual nested keys', async () => {
		// Critical correctness invariant: clearing only receipt.path
		// would leave a doc whose schema requires `path` when receipt
		// is present — next read would Zod-fail. Worker MUST drop
		// the entire `receipt` field as a unit.
		vi.mocked(firestore.queryReceiptPurgeCandidates).mockResolvedValueOnce({
			docs: [
				docWithReceipt('projects/demo-project/databases/(default)/documents/trips/t1/expenses/e4', {
					path:        'trips/t1/expenses/e4/receipt.webp',
					thumbPath:   'trips/t1/expenses/e4/thumb.webp',
					deletedAtMs: Date.now() - 11 * 24 * 3600 * 1000,
				}),
			],
		})
		await purgeExpiredReceipts('sa-json', 'demo-bucket')
		const calls = vi.mocked(firestore.deleteDocFields).mock.calls
		expect(calls).toHaveLength(1)
		// Field list MUST be exactly ['receipt'] — not ['receipt.path']
		// or ['receipt.path', 'receipt.thumbPath']. Dropping the map as
		// a whole keeps the schema "receipt absent OR fully present"
		// invariant intact.
		expect(calls[0][3]).toEqual(['receipt'])
		expect(calls[0][2]).toBe('trips/t1/expenses/e4')
	})

	it('stamps receiptPurgedAt after the cleanup so the doc exits the candidate set', async () => {
		// This is THE invariant that prevents the O(all historical)
		// daily re-scan: every doc that the cron successfully
		// processes must carry a non-null receiptPurgedAt afterwards.
		vi.mocked(firestore.queryReceiptPurgeCandidates).mockResolvedValueOnce({
			docs: [
				docWithReceipt('projects/demo-project/databases/(default)/documents/trips/t1/expenses/e5', {
					path:        'trips/t1/expenses/e5/receipt.webp',
					deletedAtMs: Date.now() - 11 * 24 * 3600 * 1000,
				}),
			],
		})
		await purgeExpiredReceipts('sa-json', 'demo-bucket')
		const stampCalls = vi.mocked(firestore.updateDocFields).mock.calls
		expect(stampCalls).toHaveLength(1)
		expect(stampCalls[0][2]).toBe('trips/t1/expenses/e5')
		// The patch must set receiptPurgedAt to a Timestamp, not null.
		// A null-set would re-enter the candidate set on the next
		// cron run.
		const stampPatch = stampCalls[0][3]
		expect(stampPatch.receiptPurgedAt.timestampValue).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		expect(stampPatch.receiptPurgedAt.nullValue).toBeUndefined()
	})

	it('skips stamping receiptPurgedAt when the doc was deleted mid-cron (race with trip cascade)', async () => {
		// The race: cron query returns doc Y; concurrent trip
		// cascade hard-deletes Y; cron loops to process Y and
		// tries to clear `receipt`. Pre-fix this would resurrect Y
		// as a zombie via PATCH-upsert. Post-fix the helper returns
		// `false` (412 FAILED_PRECONDITION) and the cron skips
		// onward instead of stamping receiptPurgedAt on a
		// half-resurrected doc.
		vi.mocked(firestore.queryReceiptPurgeCandidates).mockResolvedValueOnce({
			docs: [
				docWithReceipt('projects/demo-project/databases/(default)/documents/trips/t1/expenses/e-race', {
					path:        'trips/t1/expenses/e-race/receipt.webp',
					deletedAtMs: Date.now() - 11 * 24 * 3600 * 1000,
				}),
			],
		})
		// Simulate the race: deleteDocFields returns false (doc
		// vanished between query and patch).
		vi.mocked(firestore.deleteDocFields).mockResolvedValueOnce(false)

		const report = await purgeExpiredReceipts('sa-json', 'demo-bucket')
		// scanned counts; docsPatched stays 0 because we bailed
		// before the stamp step.
		expect(report.scanned).toBe(1)
		expect(report.docsPatched).toBe(0)
		// Critical: updateDocFields MUST NOT fire for this doc --
		// stamping receiptPurgedAt on a vanished doc would
		// resurrect it as a zombie carrying only that field.
		expect(firestore.updateDocFields).not.toHaveBeenCalled()
	})
})
