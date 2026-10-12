// readTripAccess (the non-transactional trip-access read) must refresh a
// stale cached admin token like every other admin-token caller, instead of
// failing every OCR / FX-preview / route request until the isolate recycles.
import { afterEach, describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAdminToken:        vi.fn(async () => 'token'),
  invalidateAdminToken: vi.fn(),
  getDocFields:         vi.fn(),
}))

vi.mock('../src/admin', () => ({
  getAdminToken:        mocks.getAdminToken,
  getProjectId:         () => 'proj',
  invalidateAdminToken: mocks.invalidateAdminToken,
}))
vi.mock('../src/firestore', async () => {
  const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
  return { ...actual, getDocFields: mocks.getDocFields }
})

import { readTripAccess } from '../src/membership-shared'

const UID = 'caller'
const TRIP = {
  ownerId:   { stringValue: 'owner' },
  memberIds: { arrayValue: { values: [{ stringValue: 'owner' }, { stringValue: UID }] } },
}
const MEMBER = { role: { stringValue: 'editor' } }

afterEach(() => vi.clearAllMocks())

describe('readTripAccess', () => {
  it('invalidates the cached admin token on a Firestore 401 and retries once', async () => {
    mocks.getDocFields
      .mockRejectedValueOnce(new Error('getDocFields trips/t1 → 401: UNAUTHENTICATED'))
      .mockResolvedValueOnce(MEMBER)
      .mockImplementation(async (_t: string, _p: string, path: string) =>
        path.includes('/members/') ? MEMBER : TRIP)

    const access = await readTripAccess('{}', 't1', UID)
    expect(access.role).toBe('editor')
    expect(mocks.invalidateAdminToken).toHaveBeenCalledTimes(1)
    expect(mocks.getAdminToken).toHaveBeenCalledTimes(2)
  })

  it('does not retry a non-auth failure', async () => {
    mocks.getDocFields.mockRejectedValue(new Error('getDocFields trips/t1 → 500: boom'))
    await expect(readTripAccess('{}', 't1', UID)).rejects.toThrow(/500/)
    expect(mocks.invalidateAdminToken).not.toHaveBeenCalled()
    expect(mocks.getAdminToken).toHaveBeenCalledTimes(1)
  })
})
