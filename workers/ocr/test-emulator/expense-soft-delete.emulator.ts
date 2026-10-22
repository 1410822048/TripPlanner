import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { FsValue } from '../src/firestore'

vi.mock('../src/admin', () => ({
  getAdminToken: vi.fn(async () => 'owner'),
  getProjectId: vi.fn(() => 'demo-tripmate-emulator'),
  invalidateAdminToken: vi.fn(),
}))
import { expenseSoftDelete } from '../src/expense-write'

// /expense-soft-delete against real Firestore: the REQUEST_TIME transforms,
// the updateMask that must leave every other field intact, idempotency and
// the settlement-lock gate.
const PROJECT = 'demo-tripmate-emulator'
const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
const BASE = `http://${HOST}/v1`
const DOCS = `${BASE}/projects/${PROJECT}/databases/(default)/documents`
const realFetch = globalThis.fetch
const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
type Fields = Record<string, FsValue>
const roster: FsValue = { arrayValue: { values: [{ stringValue: 'owner' }, { stringValue: 'editor' }] } }
const EXPENSE = 'trips/t/expenses/e'

beforeAll(() => {
  globalThis.fetch = (input, init) =>
    realFetch(String(input).replace('https://firestore.googleapis.com/v1', BASE), init)
})
afterAll(() => { globalThis.fetch = realFetch })

async function put(path: string, fields: Fields) {
  const response = await realFetch(`${DOCS}/${path}`, { method: 'PATCH', headers, body: JSON.stringify({ fields }) })
  if (!response.ok) throw new Error(await response.text())
}
async function get(path: string): Promise<Fields | null> {
  const response = await realFetch(`${DOCS}/${path}`, { headers })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(await response.text())
  return ((await response.json()) as { fields: Fields }).fields
}

function expenseFields(extra: Fields = {}): Fields {
  return {
    tripId:          { stringValue: 't' },
    title:           { stringValue: 'Lunch' },
    amountMinor:     { integerValue: '1000' },
    currency:        { stringValue: 'JPY' },
    paidBy:          { stringValue: 'editor' },
    memberIds:       roster,
    receipt:         { mapValue: { fields: { path: { stringValue: 'trips/t/expenses/e/r.webp' } } } },
    createdBy:       { stringValue: 'editor' },
    updatedBy:       { stringValue: 'editor' },
    createdAt:       { timestampValue: '2026-05-01T00:00:00Z' },
    updatedAt:       { timestampValue: '2026-05-01T00:00:00Z' },
    deletedAt:       { nullValue: null },
    receiptPurgedAt: { nullValue: null },
    ...extra,
  }
}

beforeEach(async () => {
  await realFetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  await put('trips/t', { ownerId: { stringValue: 'owner' }, memberIds: roster, currency: { stringValue: 'JPY' } })
  await put('trips/t/members/owner', { role: { stringValue: 'owner' }, memberIds: roster })
  await put('trips/t/members/editor', { role: { stringValue: 'editor' }, memberIds: roster })
})

it('stamps deletedAt / updatedAt with server time and keeps every other field', async () => {
  await put(EXPENSE, expenseFields())
  const before = Date.now()

  await expect(expenseSoftDelete('editor', { tripId: 't', expenseId: 'e' }, '{}')).resolves.toEqual({ ok: true })

  const after = await get(EXPENSE)
  const deletedAt = (after?.deletedAt as { timestampValue?: string }).timestampValue
  expect(deletedAt).toBeDefined()
  expect(Date.parse(deletedAt!)).toBeGreaterThanOrEqual(before - 60_000)
  expect((after?.updatedAt as { timestampValue?: string }).timestampValue).toBe(deletedAt)
  expect(after?.updatedBy).toEqual({ stringValue: 'editor' })
  const { deletedAt: _d, updatedAt: _u, updatedBy: _b, ...rest } = after!
  const { deletedAt: _d0, updatedAt: _u0, updatedBy: _b0, ...expected } = expenseFields()
  expect(rest).toEqual(expected)
})

it('is idempotent: a second call leaves the first tombstone untouched', async () => {
  await put(EXPENSE, expenseFields())
  await expenseSoftDelete('editor', { tripId: 't', expenseId: 'e' }, '{}')
  const first = await get(EXPENSE)

  await expect(expenseSoftDelete('owner', { tripId: 't', expenseId: 'e' }, '{}')).resolves.toEqual({ ok: true })
  expect(await get(EXPENSE)).toEqual(first)
})

it('settlement lock: editor is refused without a write, owner may delete', async () => {
  const locked = expenseFields({ settlementLockIds: { arrayValue: { values: [{ stringValue: 's1' }] } } })
  await put(EXPENSE, locked)

  await expect(expenseSoftDelete('editor', { tripId: 't', expenseId: 'e' }, '{}')).rejects.toMatchObject({ status: 403 })
  expect((await get(EXPENSE))?.deletedAt).toEqual({ nullValue: null })

  await expenseSoftDelete('owner', { tripId: 't', expenseId: 'e' }, '{}')
  expect((await get(EXPENSE))?.deletedAt).toHaveProperty('timestampValue')
})

it('a missing expense is 404 and is not created', async () => {
  await expect(expenseSoftDelete('editor', { tripId: 't', expenseId: 'e' }, '{}')).rejects.toMatchObject({ status: 404 })
  expect(await get(EXPENSE)).toBeNull()
})
