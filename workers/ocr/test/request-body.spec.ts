import { describe, expect, it, vi } from 'vitest'
import { MAX_JSON_BODY_BYTES, readBoundedJson, RequestBodyTooLargeError } from '../src/request-body'

function streamedRequest(chunks: Uint8Array[], cancel = vi.fn()): Request {
  let index = 0
  return new Request('https://example.com/ocr', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]!)
        else controller.close()
      },
      cancel,
    }),
  })
}

describe('bounded JSON request parsing', () => {
  it('preserves UTF-8 split across chunks without Content-Length', async () => {
    const bytes = new TextEncoder().encode('{"title":"繁體中文收據"}')
    const request = streamedRequest(Array.from(bytes, byte => Uint8Array.of(byte)))
    expect(request.headers.has('Content-Length')).toBe(false)
    await expect(readBoundedJson(request)).resolves.toEqual({ title: '繁體中文收據' })
  })

  it('accepts valid JSON at the exact byte limit', async () => {
    const bytes = new TextEncoder().encode('"' + 'a'.repeat(MAX_JSON_BODY_BYTES - 2) + '"')
    await expect(readBoundedJson(streamedRequest([bytes]))).resolves.toHaveLength(MAX_JSON_BODY_BYTES - 2)
  })

  it('rejects a headerless oversized stream and cancels unread input', async () => {
    const cancel = vi.fn()
    const request = streamedRequest([
      new Uint8Array(MAX_JSON_BODY_BYTES),
      Uint8Array.of(32),
      Uint8Array.of(32),
      Uint8Array.of(32),
    ], cancel)
    await expect(readBoundedJson(request)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })

  it('rejects oversized input even when Content-Length understates it', async () => {
    const request = streamedRequest([new Uint8Array(MAX_JSON_BODY_BYTES + 1)])
    request.headers.set('Content-Length', '2')
    await expect(readBoundedJson(request)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })

  it('preserves invalid JSON and empty-body errors', async () => {
    await expect(readBoundedJson(streamedRequest([new TextEncoder().encode('{')]))).rejects.toBeInstanceOf(SyntaxError)
    await expect(readBoundedJson(new Request('https://example.com', { method: 'POST' }))).rejects.toBeInstanceOf(SyntaxError)
  })
})
