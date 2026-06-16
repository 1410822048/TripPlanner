// src/utils/image.ts
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
const THUMB_LONG_EDGE = 192
const FULL_QUALITY    = 0.8
const THUMB_QUALITY   = 0.7
const RECEIPT_STANDARD_LONG_EDGE    = 1568
const RECEIPT_TALL_ASPECT_RATIO     = 2.4
const RECEIPT_TALL_MIN_SHORT_EDGE   = 768
const RECEIPT_TALL_MAX_LONG_EDGE    = 3840
const RECEIPT_MAX_UPSCALE_FACTOR    = 2
const RECEIPT_FULL_MAX_BYTES        = 5 * 1024 * 1024
const RECEIPT_FULL_ENCODE_CANDIDATES = [
  { quality: 0.90 },
  { quality: 0.82 },
  { quality: 0.74 },
  { quality: 0.62 },
] as const
const RECEIPT_FULL_DOWNSCALE_STEP = 0.86
const RECEIPT_FULL_MAX_ENCODE_PASSES = 12
const RECEIPT_LEVEL_LOW_PERCENTILE  = 0.01
const RECEIPT_LEVEL_HIGH_PERCENTILE = 0.99
const RECEIPT_MIN_LEVEL_RANGE       = 48
// Until this pipeline moves to a Web Worker, keep per-pixel work inside a
// conservative main-thread budget for low-end mobile devices.
const RECEIPT_PREPROCESS_MAX_PIXELS = 3_200_000
const RECEIPT_SHARPEN_MAX_PIXELS    = 1_800_000
const RECEIPT_SHARPEN_AMOUNT        = 0.16

/** Files we don't even try to compress; they go through as-is. */
const PASSTHROUGH_TYPES = new Set([
  'image/heic',         // iOS native, canvas can't decode
  'image/heif',
  'application/pdf',    // attachment may be PDF (boarding pass / receipt)
])

export interface CompressedImage {
  full:  File
  /** Only present for re-encoded image inputs. PDFs / HEIC originals omit this. */
  thumb?: File
}

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
  if (!file.type.startsWith('image/')) return { full: file }
  if (PASSTHROUGH_TYPES.has(file.type)) return { full: file }

  const alreadyReceiptFull = file.type === 'image/webp' && file.name.endsWith('.receipt.webp')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { full: file }
  }

  const { width: srcW, height: srcH } = bitmap
  const baseName = file.name.replace(/\.[^./]+$/, '')
  const thumbDims = scaleToLongEdge(srcW, srcH, THUMB_LONG_EDGE)

  if (alreadyReceiptFull) {
    const thumbBlob = await drawToBlob(bitmap, thumbDims.w, thumbDims.h, THUMB_QUALITY)
    bitmap.close()
    if (!thumbBlob) return { full: file }
    const thumb = new File([thumbBlob], `${baseName}.thumb.webp`, {
      type: 'image/webp', lastModified: Date.now(),
    })
    return { full: file, thumb }
  }

  const [fullBlob, thumbBlob] = await Promise.all([
    drawReceiptFullBlob(bitmap, srcW, srcH),
    drawToBlob(bitmap, thumbDims.w, thumbDims.h, THUMB_QUALITY),
  ])
  bitmap.close()

  if (!fullBlob) return { full: file }
  const full = new File([fullBlob], `${baseName}.receipt.webp`, {
    type: 'image/webp', lastModified: Date.now(),
  })
  if (!thumbBlob) return { full }
  const thumb = new File([thumbBlob], `${baseName}.thumb.webp`, {
    type: 'image/webp', lastModified: Date.now(),
  })
  return { full, thumb }
}

function scaleToLongEdge(srcW: number, srcH: number, target: number) {
  const longEdge = Math.max(srcW, srcH)
  const scale = longEdge > target ? target / longEdge : 1
  return { w: Math.round(srcW * scale), h: Math.round(srcH * scale) }
}

function scaleReceiptFull(srcW: number, srcH: number) {
  const longEdge = Math.max(srcW, srcH)
  const shortEdge = Math.min(srcW, srcH)
  const aspect = longEdge / shortEdge

  let scale: number
  if (aspect >= RECEIPT_TALL_ASPECT_RATIO) {
    const shortEdgeScale = RECEIPT_TALL_MIN_SHORT_EDGE / shortEdge
    const longEdgeScale  = RECEIPT_TALL_MAX_LONG_EDGE / longEdge
    scale = Math.min(RECEIPT_MAX_UPSCALE_FACTOR, shortEdgeScale, longEdgeScale)
    if (shortEdge >= RECEIPT_TALL_MIN_SHORT_EDGE && longEdge <= RECEIPT_TALL_MAX_LONG_EDGE) {
      scale = 1
    }
  } else {
    scale = Math.min(RECEIPT_MAX_UPSCALE_FACTOR, RECEIPT_STANDARD_LONG_EDGE / longEdge)
  }

  return { w: Math.round(srcW * scale), h: Math.round(srcH * scale) }
}

async function drawReceiptFullBlob(
  bitmap: ImageBitmap,
  srcW: number,
  srcH: number,
): Promise<Blob | null> {
  let dims = scaleReceiptFull(srcW, srcH)
  for (let pass = 0; pass < RECEIPT_FULL_MAX_ENCODE_PASSES; pass++) {
    for (const candidate of RECEIPT_FULL_ENCODE_CANDIDATES) {
      const blob = await drawToBlob(bitmap, dims.w, dims.h, candidate.quality, undefined, {
        preprocessReceipt: true,
      })
      if (blob && blob.size <= RECEIPT_FULL_MAX_BYTES) return blob
    }
    dims = {
      w: Math.max(1, Math.round(dims.w * RECEIPT_FULL_DOWNSCALE_STEP)),
      h: Math.max(1, Math.round(dims.h * RECEIPT_FULL_DOWNSCALE_STEP)),
    }
  }
  return null
}

/**
 * Draw an ImageBitmap into a canvas at the target size and encode to WebP.
 * Prefers OffscreenCanvas (lets the encode happen off the main thread on
 * browsers that support it); falls back to a regular DOM canvas otherwise.
 */
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
      srcX: Math.round(area.x),
      srcY: Math.round(area.y),
      srcW: Math.round(area.width),
      srcH: Math.round(area.height),
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

async function drawToBlob(
  bitmap: ImageBitmap, w: number, h: number, quality: number,
  src?: { srcX: number; srcY: number; srcW: number; srcH: number },
  opts?: { preprocessReceipt?: boolean },
): Promise<Blob | null> {
  // When `src` is provided, draw a sub-rectangle of the bitmap instead
  // of the whole thing — this is the crop path. Without `src`, the call
  // collapses to the original full-frame downscale used by compressImage.
  function paint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
    if (src) ctx.drawImage(bitmap, src.srcX, src.srcY, src.srcW, src.srcH, 0, 0, w, h)
    else     ctx.drawImage(bitmap, 0, 0, w, h)
    if (opts?.preprocessReceipt) {
      try {
        applyReceiptPreprocess(ctx, w, h)
      } catch {
        // Keep receipt upload/OCR usable if a browser rejects getImageData()
        // or runs out of memory on a large image.
      }
    }
  }

  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(w, h)
    const ctx = off.getContext('2d')
    if (!ctx) return null
    paint(ctx)
    try {
      return await off.convertToBlob({ type: 'image/webp', quality })
    } catch {
      return null
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  paint(ctx)
  return new Promise<Blob | null>(resolve => {
    canvas.toBlob(b => resolve(b), 'image/webp', quality)
  })
}

function applyReceiptPreprocess(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  const pixels = w * h
  if (pixels <= 0 || pixels > RECEIPT_PREPROCESS_MAX_PIXELS) return

  const image = ctx.getImageData(0, 0, w, h)
  const data = image.data
  const hist = new Uint32Array(256)
  let opaquePixels = 0

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    const y = luma8(data[i]!, data[i + 1]!, data[i + 2]!)
    hist[y] = (hist[y] ?? 0) + 1
    opaquePixels++
  }
  if (opaquePixels === 0) return

  const low  = histogramPercentile(hist, Math.floor(opaquePixels * RECEIPT_LEVEL_LOW_PERCENTILE))
  const high = histogramPercentile(hist, Math.floor(opaquePixels * RECEIPT_LEVEL_HIGH_PERCENTILE))
  if (high - low >= RECEIPT_MIN_LEVEL_RANGE) {
    const scale = 255 / (high - low)
    for (let i = 0; i < data.length; i += 4) {
      data[i]     = clampByte((data[i]!     - low) * scale)
      data[i + 1] = clampByte((data[i + 1]! - low) * scale)
      data[i + 2] = clampByte((data[i + 2]! - low) * scale)
    }
  }

  if (pixels <= RECEIPT_SHARPEN_MAX_PIXELS) {
    applyMildSharpen(data, w, h)
  }
  ctx.putImageData(image, 0, 0)
}

function applyMildSharpen(data: Uint8ClampedArray, w: number, h: number): void {
  if (w < 3 || h < 3) return
  const src = new Uint8ClampedArray(data)
  const row = w * 4

  for (let y = 1; y < h - 1; y++) {
    const rowOffset = y * row
    for (let x = 1; x < w - 1; x++) {
      const i = rowOffset + x * 4
      for (let c = 0; c < 3; c++) {
        const center = src[i + c]!
        const edge =
          4 * center -
          src[i - 4 + c]! -
          src[i + 4 + c]! -
          src[i - row + c]! -
          src[i + row + c]!
        data[i + c] = clampByte(center + RECEIPT_SHARPEN_AMOUNT * edge)
      }
    }
  }
}

function histogramPercentile(hist: Uint32Array, target: number): number {
  let seen = 0
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i]!
    if (seen >= target) return i
  }
  return 255
}

function luma8(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b) >> 8
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}
