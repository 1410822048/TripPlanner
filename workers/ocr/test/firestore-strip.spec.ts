import { afterEach, describe, expect, it, vi } from 'vitest'
import { batchStripDepartedMember } from '../src/firestore'

const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
	vi.restoreAllMocks()
})

describe('batchStripDepartedMember', () => {
	it('strips planning completedBy uid in the same commit as memberIds', async () => {
		const scheduleName = 'projects/demo/databases/(default)/documents/trips/t1/schedules/s1'
		const planningName = 'projects/demo/databases/(default)/documents/trips/t1/planning/p1'
		const wishName = 'projects/demo/databases/(default)/documents/trips/t1/wishes/w1'
		let commitBody: { writes: Array<Record<string, unknown>> } | null = null

		globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			commitBody = JSON.parse(String(init?.body))
			return new Response('{}', { status: 200 })
		}) as typeof fetch

		await batchStripDepartedMember(
			'token',
			'demo',
			[scheduleName, planningName, wishName],
			[wishName],
			'uid.with.dot',
		)

		expect(commitBody?.writes).toHaveLength(3)
		expect(commitBody?.writes[0]).toEqual({
			transform: {
				document: scheduleName,
				fieldTransforms: [
					{ fieldPath: 'memberIds', removeAllFromArray: { values: [{ stringValue: 'uid.with.dot' }] } },
				],
			},
		})
		expect(commitBody?.writes[1]).toEqual({
			update: { name: planningName, fields: {} },
			updateMask: { fieldPaths: ['completedBy.`uid.with.dot`'] },
			updateTransforms: [
				{ fieldPath: 'memberIds', removeAllFromArray: { values: [{ stringValue: 'uid.with.dot' }] } },
			],
		})
		expect(commitBody?.writes[2]).toEqual({
			transform: {
				document: wishName,
				fieldTransforms: [
					{ fieldPath: 'memberIds', removeAllFromArray: { values: [{ stringValue: 'uid.with.dot' }] } },
					{ fieldPath: 'votes', removeAllFromArray: { values: [{ stringValue: 'uid.with.dot' }] } },
				],
			},
		})
	})
})
