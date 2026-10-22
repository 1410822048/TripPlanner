import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { batchStripDepartedMember, StripDocVanishedError } from '../src/firestore'

const originalFetch = globalThis.fetch
let activeRemoval: string | null = 'removal-1'
beforeEach(() => { activeRemoval = 'removal-1' })
function txFetch(commit: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith(':beginTransaction')) return Response.json({ transaction: 'tx' })
    if (url.endsWith(':batchGet')) return Response.json([{ found: {
      name: 'projects/demo/databases/(default)/documents/trips/t1/members/u1',
      fields: activeRemoval ? { removalId: { stringValue: activeRemoval } } : {},
      updateTime: '2026-10-20T00:00:00Z',
    } }])
    if (url.endsWith(':rollback')) return Response.json({})
    return commit(input, init)
  }) as typeof fetch
}

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

		globalThis.fetch = txFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
			captured.body = JSON.parse(String(init?.body))
			return new Response('{}', { status: 200 })
		}) as typeof fetch

		await batchStripDepartedMember(
			'token',
			'demo',
			[scheduleName, planningName, wishName],
			[wishName],
			'uid.with.dot',
      { tripId: 't1', id: 'removal-1' },
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
		globalThis.fetch = txFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
			captured.writes = JSON.parse(String(init?.body)).writes
			return new Response('{}', { status: 200 })
		}) as typeof fetch

		await batchStripDepartedMember('token', 'demo', names, [names[2]!], 'u1', { tripId: 't1', id: 'removal-1' })

		expect(captured.writes).toHaveLength(names.length)
		for (const write of captured.writes) {
			expect(write.currentDocument).toEqual({ exists: true })
		}
	})

	it('a 404 commit (doc deleted after listing) surfaces as StripDocVanishedError', async () => {
		globalThis.fetch = txFetch(async () => new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 })) as typeof fetch
		await expect(batchStripDepartedMember(
			'token', 'demo', ['projects/demo/databases/(default)/documents/trips/t1/schedules/s1'], [], 'u1', { tripId: 't1', id: 'removal-1' },
		)).rejects.toBeInstanceOf(StripDocVanishedError)
	})
})


describe('removal generation fences', () => {
  it('stops old chunks after the user rejoins', async () => {
    let commits = 0
    globalThis.fetch = txFetch(async (_input, init) => {
      if (JSON.parse(String(init?.body)).writes.length > 0) commits++
      activeRemoval = null
      return Response.json({})
    })
    const names = Array.from({ length: 501 }, (_, i) =>
      `projects/demo/databases/(default)/documents/trips/t1/schedules/s${i}`)
    await batchStripDepartedMember('token', 'demo', names, [], 'u1', { tripId: 't1', id: 'removal-1' })
    expect(commits).toBe(1)
  })

  it('does not repair absent-member ACLs after a rejoin', async () => {
    activeRemoval = null
    const commit = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}))
    globalThis.fetch = txFetch(commit)
    await batchStripDepartedMember('token', 'demo',
      ['projects/demo/databases/(default)/documents/trips/t1/schedules/s1'], [], 'u1',
      { tripId: 't1', id: null })
    expect(commit).toHaveBeenCalledOnce()
    expect(JSON.parse(String(commit.mock.calls[0]?.[1]?.body)).writes).toEqual([])
  })
})
