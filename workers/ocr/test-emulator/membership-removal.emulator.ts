import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { FsValue } from '../src/firestore'

vi.mock('../src/admin', () => ({
  getAdminToken: vi.fn(async () => 'owner'),
  getProjectId: vi.fn(() => 'demo-tripmate-emulator'),
  invalidateAdminToken: vi.fn(),
}))
import { memberRemove } from '../src/member-lifecycle-write'

const PROJECT = 'demo-tripmate-emulator'
const HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
const BASE = `http://${HOST}/v1`
const DOCS = `${BASE}/projects/${PROJECT}/databases/(default)/documents`
const realFetch = globalThis.fetch
const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
type Fields = Record<string, FsValue>
const roster: FsValue = { arrayValue: { values: [{ stringValue: 'owner' }, { stringValue: 'member' }] } }
let afterStripCommit: (() => Promise<Response | void>) | null = null

beforeAll(() => {
  globalThis.fetch = async (input, init) => {
    const url = String(input).replace('https://firestore.googleapis.com/v1', BASE)
    const response = await realFetch(url, init)
    if (response.ok && url.endsWith(':commit') && String(init?.body).includes('removeAllFromArray') && afterStripCommit) {
      const pause = afterStripCommit
      afterStripCommit = null
      return (await pause()) ?? response
    }
    return response
  }
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
beforeEach(async () => {
  afterStripCommit = null
  await realFetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' })
  await put('trips/t', { ownerId: { stringValue: 'owner' }, memberIds: roster })
  await put('trips/t/members/owner', { role: { stringValue: 'owner' }, memberIds: roster })
  await put('trips/t/members/member', { role: { stringValue: 'editor' }, displayName: { stringValue: 'Old' }, memberIds: roster })
  await put('trips/t/planning/p', {
    memberIds: roster, completedBy: { mapValue: { fields: { member: { booleanValue: true }, owner: { booleanValue: true } } } },
  })
  await put('trips/t/wishes/w', { memberIds: roster, votes: roster })
})

it('atomically strips ACL, wish votes and planning progress before deleting membership', async () => {
  await memberRemove('owner', { tripId: 't', memberUid: 'member' }, '{}')
  expect(await get('trips/t/members/member')).toBeNull()
  expect((await get('trips/t/planning/p'))?.completedBy?.mapValue?.fields).toEqual({ owner: { booleanValue: true } })
  expect((await get('trips/t/wishes/w'))?.votes).toEqual({ arrayValue: { values: [{ stringValue: 'owner' }] } })
})

it.each([false, true])('a delayed removal preserves a rejoined membership (expired token: %s)', async expiredToken => {
  let reached!: () => void
  let resume!: () => void
  const paused = new Promise<void>(resolve => { reached = resolve })
  const gate = new Promise<void>(resolve => { resume = resolve })
  afterStripCommit = async () => {
    reached()
    await gate
    if (expiredToken) return new Response('expired token', { status: 401 })
  }
  const oldRemoval = memberRemove('owner', { tripId: 't', memberUid: 'member' }, '{}')
  await paused
  try {
    await memberRemove('owner', { tripId: 't', memberUid: 'member' }, '{}')
    await put('trips/t/members/member', { role: { stringValue: 'editor' }, displayName: { stringValue: 'Rejoined' }, memberIds: roster })
    await put('trips/t', { ownerId: { stringValue: 'owner' }, memberIds: roster })
    await put('trips/t/planning/p', { memberIds: roster })
  } finally {
    resume()
  }
  await oldRemoval
  expect((await get('trips/t/members/member'))?.displayName?.stringValue).toBe('Rejoined')
  expect((await get('trips/t/planning/p'))?.memberIds).toEqual(roster)
})
