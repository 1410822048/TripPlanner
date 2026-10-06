export const MAX_JSON_BODY_BYTES = 9 * 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Body too large')
    this.name = 'RequestBodyTooLargeError'
  }
}

/** Content-Length 只供提早拒絕；實際串流也必須逐塊驗證位元組上限。 */
export async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) return request.json()
  let total = 0
  const bounded = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength
      if (total > MAX_JSON_BODY_BYTES) {
        controller.error(new RequestBodyTooLargeError())
        return
      }
      controller.enqueue(chunk)
    },
  }))
  return new Response(bounded).json()
}
