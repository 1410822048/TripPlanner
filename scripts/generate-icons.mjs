// scripts/generate-icons.mjs
// One-shot icon generator. Reads `assets/tripplanner.png` (≥512px source)
// and emits every size the manifest, Apple Touch metadata, and favicon
// links reference. Runs via `node scripts/generate-icons.mjs` (or
// `npm run icons` via the package script).
//
// `assets/` is gitignored — the 1.3 MB source PNG lives locally only.
// The generated PNGs in `public/` ARE committed so contributors don't
// need to run this script just to build the project. Re-run this only
// when the source artwork changes.
//
// Why a script (not a build-time plugin): icons rarely change. Running
// this manually when the artwork is updated keeps the build fast and the
// dependency graph clean — sharp is heavy.
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = resolve(__dirname, '..')
const SOURCE    = resolve(ROOT, 'assets/tripplanner.png')
const OUT_DIR   = resolve(ROOT, 'public')

if (!existsSync(SOURCE)) {
  console.error(`Source not found: ${SOURCE}`)
  console.error('Drop the ≥512px master PNG at assets/tripplanner.png and re-run.')
  process.exit(1)
}

// Manifest's background_color — used as the maskable padding so Android's
// adaptive-icon mask clips on a soft cream tone instead of transparent.
const MASKABLE_BG = '#FAF7F2'

async function emit(size, name, opts = {}) {
  const { maskablePadding = 0 } = opts
  const out = resolve(OUT_DIR, name)

  if (maskablePadding > 0) {
    // Maskable: shrink the icon to (size * (1 - 2*pad)) and centre it on a
    // solid-color square. Android's adaptive-icon mask removes up to ~10% on
    // each side — the safe zone is the inner ~80%. We use 12% to be conservative.
    const inner = Math.round(size * (1 - 2 * maskablePadding))
    const padPx = Math.round((size - inner) / 2)
    const resized = await sharp(SOURCE).resize(inner, inner, { fit: 'contain' }).toBuffer()
    await sharp({
      create: { width: size, height: size, channels: 4, background: MASKABLE_BG },
    })
      .composite([{ input: resized, top: padPx, left: padPx }])
      .png()
      .toFile(out)
  } else {
    await sharp(SOURCE).resize(size, size, { fit: 'contain' }).png().toFile(out)
  }
  console.log(`  ✓ ${name}  (${size}×${size})`)
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  console.log(`Source: ${SOURCE}`)
  console.log(`Output: ${OUT_DIR}`)

  // Manifest icons: a "any" pair (full-bleed, no clipping) plus a
  // dedicated maskable so Android adaptive launchers get a clean look.
  await emit(192, 'pwa-192x192.png')
  await emit(512, 'pwa-512x512.png')
  await emit(512, 'pwa-maskable-512x512.png', { maskablePadding: 0.12 })

  // iOS home-screen icon: no mask, fixed superellipse — direct resize is fine.
  await emit(180, 'apple-touch-icon.png')

  // Classic favicons: optional but kills the "no 32×32 icon" warning some
  // browsers throw, and gives older browsers a fallback when the SVG one
  // fails to render.
  await emit(32, 'favicon-32x32.png')
  await emit(16, 'favicon-16x16.png')

  console.log('Done.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
