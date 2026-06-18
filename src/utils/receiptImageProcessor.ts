import {
  drawToBlob,
  PASSTHROUGH_TYPES,
  scaleToLongEdge,
  THUMB_LONG_EDGE,
  THUMB_QUALITY,
  type CompressedImage,
} from './imageEncoding'

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
// Keep per-pixel work bounded even in a Worker: it stops UI jank, but memory,
// CPU and battery are still paid by the user's device.
const RECEIPT_PREPROCESS_MAX_PIXELS = 3_200_000
const RECEIPT_SHARPEN_MAX_PIXELS    = 1_800_000
const RECEIPT_SHARPEN_AMOUNT        = 0.16

export async function compressReceiptImageLocally(file: File): Promise<CompressedImage> {
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
      const blob = await drawToBlob(bitmap, dims.w, dims.h, candidate.quality, {
        preprocess: applyReceiptPreprocess,
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
