// Repo invariant: the Worker's local emulator mode (workers/ocr/src/emulator.ts)
// can only ever be switched on by the dedicated local config. The production
// config must not carry any emulator variable or a demo- project, and the
// emulator config must stay local-only while mirroring the bindings the
// Worker code expects (a missing rate limiter would 500 every request).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

interface WranglerConfig {
  name:          string
  main:          string
  workers_dev?:  boolean
  vars:          Record<string, string>
  routes?:       unknown
  triggers?:     { crons?: string[] }
  r2_buckets:    Array<{ binding: string; bucket_name: string }>
  ratelimits:    unknown
  durable_objects: unknown
  migrations:    unknown
}

function load(file: string): WranglerConfig {
  const path = join(process.cwd(), 'workers/ocr', file)
  const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
  if (error) throw new Error(`${file}: ${String(error.messageText)}`)
  return config as WranglerConfig
}

const EMULATOR_VARS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']

describe('Worker emulator mode is fenced to the local config', () => {
  const prod = load('wrangler.jsonc')
  const emulator = load('wrangler.emulator.jsonc')

  it('production sets no emulator variable and a real project', () => {
    for (const key of EMULATOR_VARS) expect(prod.vars).not.toHaveProperty(key)
    expect(prod.vars.FIREBASE_PROJECT_ID).toMatch(/^(?!demo-)/)
    // Secrets never live in vars.
    expect(prod.vars).not.toHaveProperty('FIREBASE_SERVICE_ACCOUNT')
  })

  it('the emulator config is a separate, local-only, demo Worker', () => {
    expect(emulator.name).not.toBe(prod.name)
    expect(emulator.main).toBe(prod.main)
    expect(emulator.workers_dev).toBe(false)
    expect(emulator.routes).toBeUndefined()
    expect(emulator.triggers).toBeUndefined()
    expect(emulator.vars.FIREBASE_PROJECT_ID).toMatch(/^demo-/)
    for (const key of EMULATOR_VARS) expect(emulator.vars[key]).toMatch(/^(127\.0\.0\.1|localhost):\d+$/)
    expect(JSON.parse(emulator.vars.FIREBASE_SERVICE_ACCOUNT!).project_id).toBe(emulator.vars.FIREBASE_PROJECT_ID)
    for (const bucket of emulator.r2_buckets) {
      expect(prod.r2_buckets.map(b => b.bucket_name)).not.toContain(bucket.bucket_name)
    }
  })

  it('the emulator config mirrors the bindings the Worker code uses', () => {
    expect(emulator.ratelimits).toEqual(prod.ratelimits)
    expect(emulator.durable_objects).toEqual(prod.durable_objects)
    expect(emulator.migrations).toEqual(prod.migrations)
    expect(emulator.r2_buckets.map(b => b.binding)).toEqual(prod.r2_buckets.map(b => b.binding))
  })
})
