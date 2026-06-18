import { compressReceiptImageLocally } from './receiptImageProcessor'
import type { CompressedImage } from './imageEncoding'

type ReceiptImageWorkerRequest = {
  file: File
}

type ReceiptImageWorkerResponse =
  | { ok: true; result: CompressedImage }
  | { ok: false }

addEventListener('message', async (event: MessageEvent<ReceiptImageWorkerRequest>) => {
  const { file } = event.data
  try {
    const result = await compressReceiptImageLocally(file)
    postMessage({ ok: true, result } satisfies ReceiptImageWorkerResponse)
  } catch {
    postMessage({ ok: false } satisfies ReceiptImageWorkerResponse)
  }
})
