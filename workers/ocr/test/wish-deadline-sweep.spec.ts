// Tests for the 5-min Wish-deadline sweep cron. The query updateTime is
// carried into a conditional PATCH, preventing stale query results from
// stamping a deadline that an owner extended or cleared in the meantime.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/firestore', async () => {
	const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
	return {
		queryWishDeadlineSweepCandidates:       vi.fn(),
		stampWishDeadlineNotifiedIfUnchanged:  vi.fn(async (..._args: unknown[]) => true),
		readTimestampMs:                        actual.readTimestampMs,
		stripDocPrefix:                         actual.stripDocPrefix,
	}
})
vi.mock('../src/admin', () => ({
	getAdminToken: vi.fn(async () => 'fake-admin-token'),
	getProjectId:  vi.fn(() => 'demo-project'),
}))

import { sweepWishVotingDeadlines } from '../src/wish-deadline-sweep'
import * as firestore                from '../src/firestore'

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(firestore.queryWishDeadlineSweepCandidates).mockResolvedValue({ docs: [] })
})

function tripDoc(name: string, deadlineAtMs: number, updateTime = '2026-07-10T01:02:03.000000Z') {
	return {
		name,
		fields: {
			wishVotingDeadlineAt: { timestampValue: new Date(deadlineAtMs).toISOString() },
		},
		updateTime,
	}
}

describe('sweepWishVotingDeadlines', () => {
	it('stamps every unchanged candidate with its query updateTime', async () => {
		const pastMs = Date.now() - 60_000
		vi.mocked(firestore.queryWishDeadlineSweepCandidates).mockResolvedValueOnce({
			docs: [
				tripDoc('projects/demo-project/databases/(default)/documents/trips/t1', pastMs, '2026-07-10T01:00:00Z'),
				tripDoc('projects/demo-project/databases/(default)/documents/trips/t2', pastMs, '2026-07-10T01:01:00Z'),
			],
		})

		const report = await sweepWishVotingDeadlines('sa-json')
		expect(report).toEqual({ scanned: 2, notified: 2, deadlineHit: false })

		const calls = vi.mocked(firestore.stampWishDeadlineNotifiedIfUnchanged).mock.calls
		expect(calls.map(c => c.slice(0, 4))).toEqual([
			['fake-admin-token', 'demo-project', 'trips/t1', '2026-07-10T01:00:00Z'],
			['fake-admin-token', 'demo-project', 'trips/t2', '2026-07-10T01:01:00Z'],
		])
		for (const call of calls) expect(call[4]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	})

	it('treats a vanished document as a benign conflict and continues', async () => {
		const pastMs = Date.now() - 60_000
		vi.mocked(firestore.queryWishDeadlineSweepCandidates).mockResolvedValueOnce({
			docs: [
				tripDoc('projects/demo-project/databases/(default)/documents/trips/t1', pastMs),
				tripDoc('projects/demo-project/databases/(default)/documents/trips/t2', pastMs),
			],
		})
		vi.mocked(firestore.stampWishDeadlineNotifiedIfUnchanged)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true)

		const report = await sweepWishVotingDeadlines('sa-json')
		expect(report).toEqual({ scanned: 2, notified: 1, deadlineHit: false })
		expect(firestore.stampWishDeadlineNotifiedIfUnchanged).toHaveBeenCalledTimes(2)
	})

	it.each(['extended', 'cleared'])('does not count an owner-%s deadline updateTime conflict', async () => {
		const pastMs = Date.now() - 60_000
		vi.mocked(firestore.queryWishDeadlineSweepCandidates).mockResolvedValueOnce({
			docs: [tripDoc('projects/demo-project/databases/(default)/documents/trips/raced', pastMs)],
		})
		// Both owner actions change the document updateTime. The REST helper
		// maps Firestore's failed updateTime precondition to this benign false.
		vi.mocked(firestore.stampWishDeadlineNotifiedIfUnchanged).mockResolvedValueOnce(false)

		const report = await sweepWishVotingDeadlines('sa-json')
		expect(report.notified).toBe(0)
		expect(report.scanned).toBe(1)
	})

	it('continues to later candidates after an updateTime conflict', async () => {
		const pastMs = Date.now() - 60_000
		vi.mocked(firestore.queryWishDeadlineSweepCandidates).mockResolvedValueOnce({
			docs: [
				tripDoc('projects/demo-project/databases/(default)/documents/trips/conflict', pastMs),
				tripDoc('projects/demo-project/databases/(default)/documents/trips/next', pastMs),
			],
		})
		vi.mocked(firestore.stampWishDeadlineNotifiedIfUnchanged)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true)

		const report = await sweepWishVotingDeadlines('sa-json')
		expect(report.notified).toBe(1)
		expect(vi.mocked(firestore.stampWishDeadlineNotifiedIfUnchanged).mock.calls[1][2]).toBe('trips/next')
	})
})
