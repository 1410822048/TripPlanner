import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FsValue } from '../src/firestore'

const { deleteObject } = vi.hoisted(() => ({ deleteObject: vi.fn() }))
vi.mock('../src/admin', () => ({ getAdminToken: async () => 'token', getProjectId: () => 'demo', invalidateAdminToken: vi.fn() }))
vi.mock('../src/r2-storage', () => ({ deleteR2Object: deleteObject, getR2Object: vi.fn() }))
import { handleAttachmentDelete } from '../src/attachment-content'

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('attachment cleanup transaction races', () => {
  it.each(['settlement', 'membership', 'reference', 'intent-consume'] as const)('revalidates %s after a commit conflict before touching R2', async changed => {
    let attempt = 0
    let commits = 0
    const blobPath = 'trips/t/expenses/e/receipt.png'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes(':beginTransaction')) {
        attempt += 1
        return Response.json({ transaction: `tx-${attempt}` })
      }
      if (url.includes(':batchGet')) {
        const body = JSON.parse(String(init?.body)) as { documents: string[]; transaction: string }
        expect(body.transaction).toBe(`tx-${attempt}`)
        const name = body.documents[0]!
        let fields: Record<string, FsValue> = {}
        if (name.endsWith('/trips/t')) fields = { ownerId: { stringValue: 'owner' } }
        if (name.endsWith('/members/editor')) {
          fields = { role: { stringValue: 'editor' } }
          if (attempt > 1 && changed === 'membership') fields.removingAt = { timestampValue: '2026-10-02T00:00:00Z' }
        }
        if (name.endsWith('/expenses/e') && attempt > 1) {
          if (changed === 'settlement') fields.settlementLockIds = { arrayValue: { values: [{ stringValue: 's' }] } }
          if (changed === 'reference' || changed === 'intent-consume') fields.receipt = { mapValue: { fields: { path: { stringValue: blobPath } } } }
        }
        return Response.json([{ found: { name, fields, updateTime: '2026-10-02T00:00:00Z' } }])
      }
      if (url.includes(':commit')) {
        commits += 1
        expect(deleteObject).not.toHaveBeenCalled()
        const body = JSON.parse(String(init?.body)) as { writes: object[]; transaction: string }
        expect(body.writes).toEqual(changed === 'intent-consume' ? [{
          delete: 'projects/demo/databases/(default)/documents/trips/t/uploadIntents/i', currentDocument: { exists: true },
        }] : [])
        expect(body.transaction).toBe('tx-1')
        return Response.json({ error: { status: 'ABORTED', message: 'concurrent change' } }, { status: 409 })
      }
      if (url.includes(':runQuery')) return Response.json(changed === 'intent-consume' ? [{ document: {
        name: 'projects/demo/databases/(default)/documents/trips/t/uploadIntents/i',
        fields: { status: { stringValue: 'uploaded' }, uid: { stringValue: 'editor' } },
      } }] : [])
      if (url.includes(':rollback')) return Response.json({})
      throw new Error(`unexpected RPC: ${url}`)
    }))
    const response = await handleAttachmentDelete({
      body: { tripId: 't', path: blobPath }, uid: 'editor', cors: {},
      env: { FIREBASE_SERVICE_ACCOUNT: '{}', ATTACHMENTS: {} as R2Bucket }, report: vi.fn(),
    })
    expect(response.status).toBe(changed === 'reference' || changed === 'intent-consume' ? 409 : 403)
    expect(attempt).toBe(2)
    expect(commits).toBe(1)
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it.each(['uploaded', 'used'] as const)('cleans an unreferenced %s object only after its intent transaction commits', async status => {
    const blobPath = 'trips/t/expenses/e/receipt.png'
    const intentName = 'projects/demo/databases/(default)/documents/trips/t/uploadIntents/i'
    let committed = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes(':beginTransaction')) return Response.json({ transaction: 'tx' })
      if (url.includes(':batchGet')) {
        const body = JSON.parse(String(init?.body)) as { documents: string[] }
        const name = body.documents[0]!
        const fields: Record<string, FsValue> = name.endsWith('/trips/t')
          ? { ownerId: { stringValue: 'owner' } }
          : name.endsWith('/members/editor') ? { role: { stringValue: 'editor' } } : {}
        return Response.json([{ found: { name, fields } }])
      }
      if (url.includes(':runQuery')) return Response.json([{ document: {
        name: intentName, fields: { status: { stringValue: status }, uid: { stringValue: 'editor' } },
      } }])
      if (url.includes(':commit')) {
        expect(deleteObject).not.toHaveBeenCalled()
        const body = JSON.parse(String(init?.body)) as { writes: object[] }
        expect(body.writes).toEqual(status === 'used' ? [] : [{ delete: intentName, currentDocument: { exists: true } }])
        committed = true
        return Response.json({})
      }
      throw new Error(`unexpected RPC: ${url}`)
    }))
    deleteObject.mockImplementationOnce(async () => { expect(committed).toBe(true) })
    const response = await handleAttachmentDelete({
      body: { tripId: 't', path: blobPath }, uid: 'editor', cors: {},
      env: { FIREBASE_SERVICE_ACCOUNT: '{}', ATTACHMENTS: {} as R2Bucket }, report: vi.fn(),
    })
    expect(response.status).toBe(200)
    expect(deleteObject).toHaveBeenCalledOnce()
  })
})
