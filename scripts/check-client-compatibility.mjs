import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const DIST_MODE = process.argv.includes('--dist')

function isEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function parseManifest(raw, source) {
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source} is not valid JSON`, { cause: error })
  }
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : []
  if (keys.length !== 2 || keys[0] !== 'minimumWriteEpoch' || keys[1] !== 'revision') {
    throw new Error(`${source} must contain only revision and minimumWriteEpoch`)
  }
  if (!isEpoch(value.revision) || !isEpoch(value.minimumWriteEpoch)) {
    throw new Error(`${source} epochs must be non-negative safe integers`)
  }
  return value
}

const publicPath = path.join(root, 'public', 'compatibility.json')
const sourcePath = path.join(root, 'src', 'services', 'clientCompatibility.ts')
const headersPath = path.join(root, 'public', '_headers')

const [publicRaw, sourceRaw, headersRaw] = await Promise.all([
  readFile(publicPath, 'utf8'),
  readFile(sourcePath, 'utf8'),
  readFile(headersPath, 'utf8'),
])

const manifest = parseManifest(publicRaw, 'public/compatibility.json')
const epochMatch = sourceRaw.match(/export const CLIENT_SCHEMA_EPOCH = (\d+) as const/)
if (!epochMatch) throw new Error('CLIENT_SCHEMA_EPOCH must be a literal non-negative integer')
const clientEpoch = Number(epochMatch[1])
if (!isEpoch(clientEpoch)) throw new Error('CLIENT_SCHEMA_EPOCH is invalid')
if (manifest.minimumWriteEpoch > clientEpoch) {
  throw new Error(`minimumWriteEpoch ${manifest.minimumWriteEpoch} exceeds client epoch ${clientEpoch}`)
}
if (!/^\/compatibility\.json\r?\n[ \t]+Cache-Control:[ \t]*no-store, max-age=0, must-revalidate[ \t]*$/m.test(headersRaw)) {
  throw new Error('public/_headers is missing the no-store compatibility rule')
}

if (DIST_MODE) {
  const [distRaw, swRaw] = await Promise.all([
    readFile(path.join(root, 'dist', 'compatibility.json'), 'utf8'),
    readFile(path.join(root, 'dist', 'sw.js'), 'utf8'),
  ])
  const distManifest = parseManifest(distRaw, 'dist/compatibility.json')
  if (JSON.stringify(distManifest) !== JSON.stringify(manifest)) {
    throw new Error('dist/compatibility.json differs from the public contract')
  }
  if (swRaw.includes('compatibility.json')) {
    throw new Error('compatibility.json must not appear in the service-worker precache')
  }
}
