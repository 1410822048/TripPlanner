import { afterEach, describe, expect, it, vi } from 'vitest'
import { batchStripDepartedMember, StripDocVanishedError } from '../src/firestore'

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
		// Holder object, not a `let`: TypeScript narrows a let to its
		// initializer when the only reassignment it can see is inside a
		// callback, which collapsed the reads below to `never`.
		const captured: { body: { writes: Array<Record<string, unknown>> } | null } = { body: null }

		globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			captured.body = JSON.parse(String(init?.body))
			return new Response('{}', { status: 200 })
		}) as typeof fetch

		await batchStripDepartedMember(
			'token',
			'demo',
			[scheduleName, planningName, wishName],
			[wishName],
			'uid.with.dot',
		)

		expect(captured.body?.writes).toHaveLength(3)
		expect(captured.body?.writes[0]).toEqual({
			transform: {
				document: scheduleName,
				fieldTransforms: [
					{ fieldPath: 'memberIds', removeAllFromArray: { values: [{ stringValue: 'uid.with.dot' }] } },
				],
			},
			currentDocument: { exists: true },
		})
		expect(captured.body?.writes[1]).toEqual({
			update: { name: planningName, fields: {} },
			updateMask: { fieldPaths: ['completedBy.`uid.with.dot`'] },
			updateTransforms: [
				{ fieldPath: 'memberIds', removeAllFromArray: { values: [{ stringValue: 'uid.with.dot' }] } },
			],
			currentDocument: { exists: true },
		})
		expect(captured.body?.writes[2]).toEqual({
			transform: {
				document: wishName,
				fieldTransforms: [
					{ fieldPath: 'memberIds', removeAllFromArray: { values: [{ stringValue: 'uid.with.dot' }] } },
					{ fieldPath: 'votes', removeAllFromArray: { values: [{ stringValue: 'uid.with.dot' }] } },
				],
			},
			currentDocument: { exists: true },
		})
	})

	it('every write carries exists:true so a vanished doc is never recreated as a shell', async () => {
		const names = ['schedules/s1', 'planning/p1', 'wishes/w1', 'bookings/b1']
			.map(p => 'projects/demo/databases/(default)/documents/trips/t1/' + p)
		const captured: { writes: Array<Record<string, unknown>> } = { writes: [] }
		globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			captured.writes = JSON.parse(String(init?.body)).writes
			return new Response('{}', { status: 200 })
		}) as typeof fetch

		await batchStripDepartedMember('token', 'demo', names, [names[2]!], 'u1')

		expect(captured.writes).toHaveLength(names.length)
		for (const write of captured.writes) {
			expect(write.currentDocument).toEqual({ exists: true })
		}
	})

	it('a 404 commit (doc deleted after listing) surfaces as StripDocVanishedError', async () => {
		globalThis.fetch = vi.fn(async () => new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 })) as typeof fetch
		await expect(batchStripDepartedMember(
			'token', 'demo', ['projects/demo/databases/(default)/documents/trips/t1/schedules/s1'], [], 'u1',
		)).rejects.toBeInstanceOf(StripDocVanishedError)
	})
})
