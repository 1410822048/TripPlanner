// assertRouteEditor: the read-only owner/editor gate in front of
// /route-autocomplete and /route-resolve-place.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { docFields } = vi.hoisted(() => ({
  docFields: new Map<string, Record<string, unknown> | null>(),
}))

vi.mock('../src/admin', () => ({
  getAdminToken: vi.fn(async () => 'admin-token'),
  getProjectId:  vi.fn(() => 'demo'),
}))

vi.mock('../src/firestore', async () => {
  const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
  return {
    ...actual,
    getDocFields: vi.fn(async (_token: string, _pid: string, path: string) => docFields.get(path) ?? null),
  }
})

import { assertRouteEditor } from '../src/route-preview'

const TRIP = 'trip-1'
const UID  = 'caller'
const run = () => assertRouteEditor(UID, TRIP, '{}', 'demo')

beforeEach(() => {
  docFields.clear()
  docFields.set(`trips/${TRIP}`, { ownerId: { stringValue: 'owner' } })
})

describe('assertRouteEditor', () => {
  it.each(['owner', 'editor'])('allows an active %s', async role => {
    docFields.set(`trips/${TRIP}/members/${UID}`, { role: { stringValue: role } })
    await expect(run()).resolves.toBeUndefined()
  })

  it('refuses a viewer with ROUTE_EDITOR_REQUIRED', async () => {
    docFields.set(`trips/${TRIP}/members/${UID}`, { role: { stringValue: 'viewer' } })
    await expect(run()).rejects.toMatchObject({ status: 403, code: 'ROUTE_EDITOR_REQUIRED' })
  })

  it('refuses a member being removed with ROUTE_MEMBER_INACTIVE', async () => {
    docFields.set(`trips/${TRIP}/members/${UID}`, {
      role: { stringValue: 'editor' }, removingAt: { timestampValue: '2026-10-07T00:00:00Z' },
    })
    await expect(run()).rejects.toMatchObject({ status: 403, code: 'ROUTE_MEMBER_INACTIVE' })
  })

  it('refuses a stranger, and answers 404 / 410 first', async () => {
    await expect(run()).rejects.toMatchObject({ status: 403 })
    docFields.set(`trips/${TRIP}`, { deletingAt: { timestampValue: '2026-10-07T00:00:00Z' } })
    await expect(run()).rejects.toMatchObject({ status: 410 })
    docFields.delete(`trips/${TRIP}`)
    await expect(run()).rejects.toMatchObject({ status: 404 })
  })
})
