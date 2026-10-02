import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerAmbiguous, workerFetch, workerRawUpload } from './workerBase'

afterEach(() => vi.restoreAllMocks())
const calls = {
  json: () => workerFetch('https://example.com', 'token', '/write', {}),
  binary: () => workerRawUpload('https://example.com', 'token', '/upload',
    { tripId: 't', intentId: 'i' }, new Blob(['file'], { type: 'image/webp' })),
}
describe.each(Object.entries(calls))('%s success response body', (_name, call) => {
  it('classifies malformed JSON after a successful commit as ambiguous', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('broken', { status: 200 }))
    await expect(call()).rejects.toBeInstanceOf(WorkerAmbiguous)
  })
  it('preserves the original body-read abort as an ambiguous cause', async () => {
    const error = new DOMException('body aborted', 'AbortError')
    const response = new Response('{}', { status: 200 })
    vi.spyOn(response, 'json').mockRejectedValue(error)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    await expect(call()).rejects.toMatchObject({ name: 'WorkerAmbiguous', cause: error })
  })
  it('keeps successful JSON payloads unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"committed"}', { status: 200 }))
    expect(await call()).toEqual({ id: 'committed' })
  })
})
