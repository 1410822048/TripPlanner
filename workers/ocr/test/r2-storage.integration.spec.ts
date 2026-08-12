import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createR2Object,
  deleteR2Object,
  getR2Object,
} from '../src/r2-storage'

const key = `tests/create-only/${crypto.randomUUID()}.bin`

afterEach(async () => {
  await deleteR2Object(env.ATTACHMENTS, key)
})

describe('R2 create-only condition', () => {
  it("treats etagDoesNotMatch='*' as create-only and preserves the first body", async () => {
    const first = await createR2Object(
      env.ATTACHMENTS,
      key,
      new Uint8Array([1, 2, 3]),
      'application/octet-stream',
      { sha256: 'first' },
    )
    const second = await createR2Object(
      env.ATTACHMENTS,
      key,
      new Uint8Array([9, 9, 9]),
      'application/octet-stream',
      { sha256: 'second' },
    )

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    const stored = await getR2Object(env.ATTACHMENTS, key)
    expect(stored).not.toBeNull()
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(stored!.customMetadata?.sha256).toBe('first')
  })
})
