import { afterEach, expect, it, vi } from 'vitest'
import { getScanCursor, setScanCursor } from '../src/firestore'

afterEach(() => { vi.unstubAllGlobals() })

it('loads a first-page checkpoint with its processed key', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ fields: {
    pageToken: { stringValue: '' },
    afterKey: { stringValue: 'trips/t/expenses/e/file.webp' },
    savedAt: { timestampValue: '2026-10-20T00:00:00Z' },
  } })))
  expect(await getScanCursor('token', 'demo', 'scan')).toEqual({
    pageToken: '', afterKey: 'trips/t/expenses/e/file.webp', savedAtMs: Date.parse('2026-10-20T00:00:00Z'),
  })
})

it('clears the old page-local checkpoint when advancing to another page', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}))
  vi.stubGlobal('fetch', fetch)
  await setScanCursor('token', 'demo', 'scan', 'next')
  const [input, init] = fetch.mock.calls[0]!
  expect(new URL(String(input)).searchParams.getAll('updateMask.fieldPaths')).toContain('afterKey')
  expect(JSON.parse(String(init?.body)).fields).not.toHaveProperty('afterKey')
})
