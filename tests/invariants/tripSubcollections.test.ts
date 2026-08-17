// Repo invariant: the trip cascade must drain EVERY trip-scoped
// subcollection the codebase writes to.
//
// trip-cascade.ts keeps a Worker-local hardcoded roster (the bundle stays
// standalone, no client-types import), and the Worker's own spec can only
// assert that roster against another hand-written copy — which catches an
// entry being deleted or reordered, but not the failure that actually
// happened: `uploadIntents` was added to the codebase and never added to
// the roster, so intent docs outlived their trips. Both hand-written lists
// would have stayed green.
//
// This test derives the expectation from the SOURCE instead. It lives in
// the root suite rather than workers/ocr/test because the Worker pool runs
// in a workerd isolate with no filesystem, and it scans source text rather
// than importing the module so it stays out of the Worker's module graph
// and tsconfig.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = process.cwd()

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      out.push(...collectSourceFiles(full))
      continue
    }
    if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** The roster as it appears in trip-cascade.ts. */
function cascadeRoster(): string[] {
  const source = readFileSync(
    join(REPO_ROOT, 'workers/ocr/src/trip-cascade.ts'), 'utf8',
  )
  const block = /const TRIP_SUBCOLLECTIONS = \[([\s\S]*?)\] as const/.exec(source)
  expect(block, 'TRIP_SUBCOLLECTIONS literal not found — did it get renamed?').not.toBeNull()
  return [...block![1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!)
}

/** Every `trips/{id}/<collection>` the sources actually name.
 *
 *  Two shapes, because the two surfaces build paths differently:
 *    - Worker + client string templates: `trips/${tripId}/expenses/...`
 *    - the client's typed path tuples in services/paths.ts:
 *      `['trips', string, 'expenses']`
 *
 *  Known blind spot: a path whose collection segment is a variable rather
 *  than a literal. Nothing in-tree does that today, and the alternative —
 *  no derivation at all — is what let uploadIntents through. */
function referencedSubcollections(): Set<string> {
  const files = [
    ...collectSourceFiles(join(REPO_ROOT, 'src')),
    ...collectSourceFiles(join(REPO_ROOT, 'workers/ocr/src')),
  ]
  const found = new Set<string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/trips\/\$\{[^}]+\}\/([A-Za-z_][A-Za-z0-9_]*)/g)) {
      found.add(m[1]!)
    }
    for (const m of text.matchAll(/'trips',\s*string,\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
      found.add(m[1]!)
    }
  }
  return found
}

describe('trip cascade covers every trip-scoped subcollection', () => {
  it('drains every subcollection named anywhere in the sources', () => {
    const roster = new Set(cascadeRoster())
    const missing = [...referencedSubcollections()].filter(c => !roster.has(c)).sort()

    // If this fails, a subcollection is written somewhere but never reaped
    // when its trip is deleted. Add it to TRIP_SUBCOLLECTIONS (before
    // 'members', which stays last) rather than deleting it here.
    expect(missing).toEqual([])
  })

  it('actually found the paths it claims to scan (guards a silent regex break)', () => {
    // Without this, a regex that stopped matching would make the test above
    // pass by scanning nothing at all.
    const referenced = referencedSubcollections()
    expect(referenced.size).toBeGreaterThan(8)
    for (const known of ['expenses', 'members', 'uploadIntents', 'planning']) {
      expect(referenced, `expected the scan to see ${known}`).toContain(known)
    }
  })
})
