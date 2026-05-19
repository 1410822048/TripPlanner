// Unit tests for the global rate limiter scoping. We test the
// composition of the DO ID key (scope:uid) without spinning up a real
// Durable Object, because the partition logic is purely in
// checkGlobalRateLimit() -- the DO itself only sees an opaque ID.
import { describe, it, expect, vi } from 'vitest'
import { checkGlobalRateLimit } from '../src/rate-limiter'

interface FakeDOId { name: string }

function fakeNamespace(allowed: boolean): {
	namespace: DurableObjectNamespace
	idFromName: ReturnType<typeof vi.fn>
	fetchCalls: string[]
} {
	const fetchCalls: string[] = []
	const idFromName = vi.fn<(name: string) => FakeDOId>(name => ({ name }))
	const get = vi.fn((id: FakeDOId) => ({
		fetch: async (url: string) => {
			fetchCalls.push(`${id.name}|${url}`)
			return new Response(JSON.stringify({
				allowed,
				count:   allowed ? 1 : 999,
				resetMs: 0,
			}), { headers: { 'content-type': 'application/json' } })
		},
	}))
	const namespace = { idFromName, get } as unknown as DurableObjectNamespace
	return { namespace, idFromName, fetchCalls }
}

describe('checkGlobalRateLimit', () => {
	it('partitions counters by (scope, uid) so /ocr and /cascade do not share', async () => {
		const fake = fakeNamespace(true)
		await checkGlobalRateLimit(fake.namespace, 'ocr',     'user-1', 60, 60_000)
		await checkGlobalRateLimit(fake.namespace, 'cascade', 'user-1', 10, 60_000)
		expect(fake.idFromName).toHaveBeenCalledTimes(2)
		expect(fake.idFromName).toHaveBeenNthCalledWith(1, 'ocr:user-1')
		expect(fake.idFromName).toHaveBeenNthCalledWith(2, 'cascade:user-1')
	})

	it('different uids in the same scope produce different DO instances', async () => {
		const fake = fakeNamespace(true)
		await checkGlobalRateLimit(fake.namespace, 'ocr', 'alice', 60, 60_000)
		await checkGlobalRateLimit(fake.namespace, 'ocr', 'bob',   60, 60_000)
		expect(fake.idFromName).toHaveBeenNthCalledWith(1, 'ocr:alice')
		expect(fake.idFromName).toHaveBeenNthCalledWith(2, 'ocr:bob')
	})

	it('propagates the DO outcome verbatim', async () => {
		const fake = fakeNamespace(false)
		const out = await checkGlobalRateLimit(fake.namespace, 'ocr', 'u', 60, 60_000)
		expect(out.allowed).toBe(false)
		expect(out.count).toBe(999)
	})
})
