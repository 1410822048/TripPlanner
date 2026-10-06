#!/usr/bin/env node
// Cloud Functions are deployed from firebase-functions/ using ITS OWN
// package-lock.json (Cloud Build runs `npm ci` there), while local dev, CI
// tests and the root `npm audit` gate all use the ROOT lockfile (npm
// ignores a nested lock inside a workspace). This guard fails CI when the
// two disagree on any runtime dependency, so a root-only upgrade (e.g. a
// CVE fix) can't silently leave production Functions on the old version.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

const fnPkg   = read('firebase-functions/package.json')
const fnLock  = read('firebase-functions/package-lock.json').packages ?? {}
const rootLock = read('package-lock.json').packages ?? {}

/** Resolve a package the way Node would from firebase-functions/: a copy
 *  nested under the workspace wins over the hoisted root copy. */
function rootVersion(name) {
  return rootLock[`firebase-functions/node_modules/${name}`]?.version
    ?? rootLock[`node_modules/${name}`]?.version
}

const problems = []
for (const name of Object.keys(fnPkg.dependencies ?? {})) {
  const nested = fnLock[`node_modules/${name}`]?.version
  const hoisted = rootVersion(name)
  if (!nested)  problems.push(`${name}: missing from firebase-functions/package-lock.json`)
  else if (!hoisted) problems.push(`${name}: missing from root package-lock.json`)
  else if (nested !== hoisted) {
    problems.push(`${name}: firebase-functions lock ${nested} != root lock ${hoisted}`)
  }
}

if (problems.length > 0) {
  console.error('[check-functions-lock] runtime dependency drift between lockfiles:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('Fix: run `npm install` inside firebase-functions/ (outside the workspace) or align versions.')
  process.exit(1)
}
console.log('[check-functions-lock] firebase-functions runtime deps match the root lockfile.')
