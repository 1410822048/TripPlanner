export const THUMB_LONG_EDGE = 192
export const THUMB_QUALITY   = 0.7

/** Files we don't even try to compress; they go through as-is. */
export const PASSTHROUGH_TYPES = new Set([
  'image/heic',         // iOS native, canvas can't decode
  'image/heif',
  'application/pdf',    // attachment may be PDF (boarding pass / receipt)
])

export interface CompressedImage {
  full:  File
  /** Only present for re-encoded image inputs. PDFs / HEIC originals omit this. */
  thumb?: File
}

export function scaleToLongEdge(srcW: number, srcH: number, target: number) {
  const longEdge = Math.max(srcW, srcH)
  const scale = longEdge > target ? target / longEdge : 1
  return { w: Math.round(srcW * scale), h: Math.round(srcH * scale) }
}

interface DrawToBlobOptions {
  src?: {
    srcX: number
    srcY: number
    srcW: number
    srcH: number
  }
  preprocess?: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number) => void
}

export async function drawToBlob(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  quality: number,
  opts?: DrawToBlobOptions,
): Promise<Blob | null> {
  // When `src` is provided, draw a sub-rectangle of the bitmap instead
  // of the whole thing. Without it, this is a full-frame resize.
  function paint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
    const src = opts?.src
    if (src) ctx.drawImage(bitmap, src.srcX, src.srcY, src.srcW, src.srcH, 0, 0, w, h)
    else     ctx.drawImage(bitmap, 0, 0, w, h)

    if (opts?.preprocess) {
      try {
        opts.preprocess(ctx, w, h)
      } catch {
        // Keep upload/OCR usable if a browser rejects getImageData()
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

  if (typeof document === 'undefined') return null
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
