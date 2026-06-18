// src/utils/image.ts
import {
  compressReceiptImageLocally,
} from './receiptImageProcessor'
import {
  drawToBlob,
  PASSTHROUGH_TYPES,
  scaleToLongEdge,
  THUMB_LONG_EDGE,
  THUMB_QUALITY,
  type CompressedImage,
} from './imageEncoding'
export type { CompressedImage } from './imageEncoding'

// Canvas-based image compression for booking attachments. Produces TWO
// variants per image upload:
//   - full:  WebP @ 0.8 quality, 1920px long edge — for the in-app preview
//            modal. Still print-quality on a 6" screen.
//   - thumb: WebP @ 0.7 quality, 192px long edge — for the list thumbnail.
//            One bookings list (10 items) was downloading ~3MB of full
//            images for icon-sized slots; the thumb cuts that to <100KB.
//
// Single decode → two re-encodes from the same ImageBitmap, so the cost
// is barely above generating the full variant alone.
//
// HEIC fallback (strategy A): if canvas can't decode the file (HEIC that
// slipped past iOS auto-conversion), we return only the original File as
// `full`, with no thumb. The booking row will fall back to the type emoji
// for the leading slot — better than failing the upload.
//
// PDFs and non-image MIMEs short-circuit at the top: pass-through, no
// thumb.
//
// We deliberately avoid WASM codecs (mozjpeg / jsquash) — they add ~100KB
// to the bundle to save ~50KB per image, which never breaks even at our
// upload volume.

const FULL_LONG_EDGE  = 1920
const FULL_QUALITY    = 0.8

/**
 * Compress an image File for upload. Returns:
 *   - `{ full, thumb }` when input is a decodable image — both WebP.
 *   - `{ full: <original> }` for pass-throughs (PDF, HEIC) or decode failures.
 *
 * Filenames get `.webp` (full) and `.thumb.webp` (thumbnail) so the bucket-
 * side content-type stays consistent with the binary, and the two paths
 * never collide.
 */
export async function compressImage(file: File): Promise<CompressedImage> {
  if (!file.type.startsWith('image/')) return { full: file }
  if (PASSTHROUGH_TYPES.has(file.type)) return { full: file }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // Decode failed — likely HEIC misreporting its mime, or corrupt JPEG.
    // Upload the original; the row falls back to type emoji.
    return { full: file }
  }

  const { width: srcW, height: srcH } = bitmap
  const baseName = file.name.replace(/\.[^./]+$/, '')

  const fullDims  = scaleToLongEdge(srcW, srcH, FULL_LONG_EDGE)
  const thumbDims = scaleToLongEdge(srcW, srcH, THUMB_LONG_EDGE)

  const [fullBlob, thumbBlob] = await Promise.all([
    drawToBlob(bitmap, fullDims.w,  fullDims.h,  FULL_QUALITY),
    drawToBlob(bitmap, thumbDims.w, thumbDims.h, THUMB_QUALITY),
  ])
  bitmap.close()

  if (!fullBlob) return { full: file }  // encode catastrophically failed
  const full = new File([fullBlob], `${baseName}.webp`, {
    type: 'image/webp', lastModified: Date.now(),
  })
  if (!thumbBlob) return { full }
  const thumb = new File([thumbBlob], `${baseName}.thumb.webp`, {
    type: 'image/webp', lastModified: Date.now(),
  })
  return { full, thumb }
}

/**
 * Expense receipts need a higher-quality full image than generic booking /
 * wish attachments because the stored full image is also the source for
 * future re-OCR. Normal receipts target a 1568px long edge; very tall
 * receipts preserve text width with a short-edge floor instead of crushing
 * the whole strip into 1568px. Low-resolution receipts are upscaled up to 2x.
 * The thumbnail remains the normal lightweight list asset.
 */
export async function compressReceiptImage(file: File): Promise<CompressedImage> {
  try {
    return await compressReceiptImageInWorker(file)
  } catch {
    return compressReceiptImageLocally(file)
  }
}

type ReceiptImageWorkerResponse =
  | { ok: true; result: CompressedImage }
  | { ok: false }

function compressReceiptImageInWorker(file: File): Promise<CompressedImage> {
  if (!canUseReceiptImageWorker(file)) {
    return Promise.reject(new Error('receipt-image-worker-unavailable'))
  }

  return new Promise<CompressedImage>((resolve, reject) => {
    const worker = new Worker(new URL('./receiptImage.worker.ts', import.meta.url), {
      type: 'module',
    })
    const cleanup = () => worker.terminate()

    worker.addEventListener('message', (event: MessageEvent<ReceiptImageWorkerResponse>) => {
      cleanup()
      const response = event.data
      if (response.ok) resolve(response.result)
      else reject(new Error('receipt-image-worker-failed'))
    }, { once: true })
    worker.addEventListener('error', () => {
      cleanup()
      reject(new Error('receipt-image-worker-error'))
    }, { once: true })

    try {
      worker.postMessage({ file })
    } catch {
      cleanup()
      reject(new Error('receipt-image-worker-post-failed'))
    }
  })
}

function canUseReceiptImageWorker(file: File): boolean {
  return (
    file.type.startsWith('image/') &&
    !PASSTHROUGH_TYPES.has(file.type) &&
    typeof Worker !== 'undefined' &&
    typeof createImageBitmap !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  )
}

/**
 * Crop pixel rectangle on `source`'s natural image and return a new File
 * with the same name + mime. Used by the ImageCropDialog flow: user
 * picks a file → drags a viewbox → confirm → we slice out the rectangle
 * here, then hand the new File to the existing upload pipeline (which
 * still runs `compressImage` for the WebP + thumb encoding).
 *
 * Returns the original File untouched when:
 *   - The mime is in PASSTHROUGH_TYPES (HEIC / PDF — canvas can't decode)
 *   - createImageBitmap fails (corrupt JPEG, mis-reported HEIC)
 *   - The canvas encode catastrophically fails
 *
 * Crop coords are pixel-space (matches react-easy-crop's
 * `croppedAreaPixels` callback).
 */
export interface PixelCrop {
  x:      number
  y:      number
  width:  number
  height: number
}

export async function cropImage(source: File, area: PixelCrop): Promise<File> {
  if (!source.type.startsWith('image/')) return source
  if (PASSTHROUGH_TYPES.has(source.type)) return source

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(source)
  } catch {
    return source
  }

  const blob = await drawToBlob(
    bitmap,
    Math.round(area.width),
    Math.round(area.height),
    0.92,
    {
      src: {
        srcX: Math.round(area.x),
        srcY: Math.round(area.y),
        srcW: Math.round(area.width),
        srcH: Math.round(area.height),
      },
    },
  )
  bitmap.close()

  if (!blob) return source
  // Keep the original filename (sans extension) so the final upload
  // names stay tied to what the user picked.
  const baseName = source.name.replace(/\.[^./]+$/, '')
  return new File([blob], `${baseName}.cropped.webp`, {
    type: 'image/webp', lastModified: Date.now(),
  })
}
