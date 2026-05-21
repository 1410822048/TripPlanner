// Wire-protocol tests for the Firestore REST query builder. These
// stub `fetch` (NOT the higher-level firestore.ts exports the cron
// imports) so the actual `structuredQuery` body we'd send to Firestore
// is observable and assertable.
//
// Why this layer exists separately from receipt-purge.spec.ts: that
// spec mocks `queryReceiptPurgeCandidates` wholesale, which hides any
// REST shape errors inside the function. A real production regression
// (e.g. shipping `fieldFilter EQUAL {nullValue}` against a null doc,
// which Firestore silently treats as zero matches) would slip past
// that test layer. The shape-assertion below catches it at the wire
// boundary so receipt-purge.spec.ts can keep its higher-level scope.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
	queryReceiptPurgeCandidates,
	updateDocFields,
	deleteDocFields,
} from '../src/firestore'

const originalFetch = globalThis.fetch

beforeEach(() => {
	// Default stub: return one matching doc so the function exits
	// cleanly. Individual tests overwrite when needed.
	globalThis.fetch = vi.fn(async () =>
		new Response(JSON.stringify([
			{
				document: {
					name: 'projects/demo/databases/(default)/documents/trips/t1/expenses/e1',
					fields: {
						deletedAt: { timestampValue: '2026-05-01T00:00:00Z' },
					},
				},
			},
		]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
	) as typeof fetch
})

afterEach(() => {
	globalThis.fetch = originalFetch
})

async function callQuery() {
	return queryReceiptPurgeCandidates(
		'fake-token',
		'demo-project',
		Date.parse('2026-05-11T00:00:00Z'),
		200,
	)
}

async function capturedBody(): Promise<{
	structuredQuery: {
		from?: Array<{ collectionId: string; allDescendants?: boolean }>
		where?: {
			compositeFilter?: {
				op?: string
				filters?: Array<{
					unaryFilter?: { field?: { fieldPath?: string }; op?: string }
					fieldFilter?: {
						field?: { fieldPath?: string }
						op?:    string
						value?: { nullValue?: null; timestampValue?: string }
					}
				}>
			}
		}
		orderBy?: Array<{ field?: { fieldPath?: string }; direction?: string }>
		limit?: number
	}
}> {
	const calls = vi.mocked(globalThis.fetch).mock.calls
	expect(calls).toHaveLength(1)
	const init = calls[0][1] as RequestInit
	return JSON.parse(init.body as string)
}

describe('queryReceiptPurgeCandidates - REST query shape', () => {
	it('null check on receiptPurgedAt uses unaryFilter IS_NULL (not fieldFilter EQUAL nullValue)', async () => {
		await callQuery()
		const body = await capturedBody()
		const filters = body.structuredQuery.where?.compositeFilter?.filters ?? []
		const nullFilter = filters.find(f => f.unaryFilter?.field?.fieldPath === 'receiptPurgedAt')
		// The bug we're regression-guarding: anyone re-writing this as
		// `fieldFilter EQUAL {nullValue: null}` would compile, look
		// right at a glance, AND silently return zero docs in
		// production. Firestore's wire protocol treats null equality
		// as a unary op; Admin SDK does the same translation
		// internally (see field-filter-internal.js).
		expect(nullFilter).toBeDefined()
		expect(nullFilter?.unaryFilter?.op).toBe('IS_NULL')
		// Nothing should ever rebuild this as the broken shape:
		const wrongShape = filters.find(f =>
			f.fieldFilter?.field?.fieldPath === 'receiptPurgedAt' &&
			f.fieldFilter?.op === 'EQUAL'
		)
		expect(wrongShape).toBeUndefined()
	})

	it('deletedAt uses fieldFilter LESS_THAN with timestampValue', async () => {
		await callQuery()
		const body = await capturedBody()
		const filters = body.structuredQuery.where?.compositeFilter?.filters ?? []
		const dateFilter = filters.find(f => f.fieldFilter?.field?.fieldPath === 'deletedAt')
		expect(dateFilter?.fieldFilter?.op).toBe('LESS_THAN')
		expect(dateFilter?.fieldFilter?.value?.timestampValue).toMatch(/^\d{4}-\d{2}-\d{2}T/)
	})

	it('targets the expenses collection group (allDescendants: true)', async () => {
		await callQuery()
		const body = await capturedBody()
		expect(body.structuredQuery.from).toEqual([
			{ collectionId: 'expenses', allDescendants: true },
		])
	})

	it('orders by deletedAt ASC + __name__ ASC for stable pagination', async () => {
		await callQuery()
		const body = await capturedBody()
		expect(body.structuredQuery.orderBy).toEqual([
			{ field: { fieldPath: 'deletedAt' },  direction: 'ASCENDING' },
			{ field: { fieldPath: '__name__' },   direction: 'ASCENDING' },
		])
	})

	it('limit is forwarded as-is', async () => {
		await callQuery()
		const body = await capturedBody()
		expect(body.structuredQuery.limit).toBe(200)
	})
})

describe('PATCH helpers - currentDocument.exists precondition', () => {
	// Stub a generic 200 response so the helpers exit cleanly. Each
	// test then inspects the URL fetch was called with.
	beforeEach(() => {
		globalThis.fetch = vi.fn(async () =>
			new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
		) as typeof fetch
	})

	function calledUrl(): URL {
		const calls = vi.mocked(globalThis.fetch).mock.calls
		expect(calls).toHaveLength(1)
		const arg0 = calls[0][0] as URL | string
		return arg0 instanceof URL ? arg0 : new URL(String(arg0))
	}

	it('updateDocFields includes currentDocument.exists=true in the URL', async () => {
		// The bug we're guarding: a PATCH on a missing doc with no
		// precondition silently upserts an empty zombie with only the
		// patched fields. If the receipt-purge cron races a trip
		// cascade that just deleted the expense, the cron's
		// receiptPurgedAt stamp would resurrect the expense as a
		// zero-content doc. Precondition turns that into a 412 /
		// FAILED_PRECONDITION the helper returns `false` from.
		await updateDocFields(
			'fake-token', 'demo', 'trips/t1/expenses/e1',
			{ receiptPurgedAt: { timestampValue: '2026-05-21T03:00:00Z' } },
		)
		const url = calledUrl()
		expect(url.searchParams.get('currentDocument.exists')).toBe('true')
	})

	it('deleteDocFields includes currentDocument.exists=true in the URL', async () => {
		// Without the precondition, an empty-body PATCH (the
		// updateMask-no-body field-delete trick) on a missing doc
		// would upsert an empty zombie. Same race regression as
		// updateDocFields above.
		await deleteDocFields('fake-token', 'demo', 'trips/t1/expenses/e1', ['receipt'])
		const url = calledUrl()
		expect(url.searchParams.get('currentDocument.exists')).toBe('true')
	})

	it('updateDocFields returns false on 412 FAILED_PRECONDITION (doc already gone)', async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response('precondition failed', { status: 412 }),
		) as typeof fetch
		const ok = await updateDocFields(
			'fake-token', 'demo', 'trips/t1/expenses/e1',
			{ receiptPurgedAt: { timestampValue: '2026-05-21T03:00:00Z' } },
		)
		expect(ok).toBe(false)
	})

	it('deleteDocFields returns false on 404 (doc already gone, idempotent)', async () => {
		globalThis.fetch = vi.fn(async () =>
			new Response('not found', { status: 404 }),
		) as typeof fetch
		const ok = await deleteDocFields('fake-token', 'demo', 'trips/t1/expenses/e1', ['receipt'])
		expect(ok).toBe(false)
	})

	it('updateDocFields throws on other non-2xx statuses (not silent)', async () => {
		// Verify the helpers DON'T over-swallow -- 500s and 403s
		// should still throw so real failures bubble up. Only the
		// "doc gone" pair (404 / 412) is treated as idempotent.
		globalThis.fetch = vi.fn(async () =>
			new Response('forbidden', { status: 403 }),
		) as typeof fetch
		await expect(
			updateDocFields(
				'fake-token', 'demo', 'trips/t1/expenses/e1',
				{ receiptPurgedAt: { timestampValue: '2026-05-21T03:00:00Z' } },
			),
		).rejects.toThrow(/403/)
	})
})
