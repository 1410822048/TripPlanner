// scripts/analyze-bundle.mjs
// Parse rollup-plugin-visualizer's stats.html to print a per-module size
// table for the main bundle. Run after `ANALYZE=1 npm run build`.
//
// The visualizer's tree uses path-segment-per-node nesting (e.g.
// `node_modules` → `firebase` → `firestore` → `dist` → `index.esm.js`),
// not full paths in each node, so we walk recursively and bucket by the
// first node-modules child we see.
import { readFileSync } from 'node:fs'

const html = readFileSync('dist/stats.html', 'utf8')
const idx = html.indexOf('const data = ')
const end = html.indexOf('};', idx)
const data = JSON.parse(html.slice(idx + 'const data = '.length, end + 1))
const parts = data.nodeParts

const mainChunk = data.tree.children.find(c => c.name.startsWith('assets/index-'))

const buckets = {}

function walk(n, currentBucket) {
  // If we descend into node_modules, the *next* level is the package name
  // (or @scope, then we need one more level to get the package).
  let bucket = currentBucket
  if (!bucket && n.name === 'node_modules') {
    // Special: handle @scoped packages on the next pass via children
    for (const c of n.children ?? []) {
      const pkgName = c.name.startsWith('@')
        ? c.children?.[0] ? `${c.name}/${c.children[0].name}` : c.name
        : c.name
      // Sum the entire subtree
      let bytes = 0
      function sum(x) {
        if (x.uid && parts[x.uid]) bytes += parts[x.uid].renderedLength || 0
        if (x.children) x.children.forEach(sum)
      }
      if (c.name.startsWith('@')) {
        // For scoped packages, attribute sub-packages individually
        for (const sub of c.children ?? []) {
          let subBytes = 0
          function sumSub(x) {
            if (x.uid && parts[x.uid]) subBytes += parts[x.uid].renderedLength || 0
            if (x.children) x.children.forEach(sumSub)
          }
          sumSub(sub)
          buckets[`${c.name}/${sub.name}`] = (buckets[`${c.name}/${sub.name}`] || 0) + subBytes
        }
      } else {
        sum(c)
        buckets[pkgName] = (buckets[pkgName] || 0) + bytes
      }
    }
    return
  }
  if (n.uid && parts[n.uid]) {
    buckets['app'] = (buckets['app'] || 0) + (parts[n.uid].renderedLength || 0)
  }
  if (n.children) {
    for (const c of n.children) walk(c, bucket)
  }
}

walk(mainChunk)

const total = Object.values(buckets).reduce((a, b) => a + b, 0)
console.log(`Main bundle total: ${(total / 1024).toFixed(1)} KB raw\n`)
console.log('By package (sorted by size):')
Object.entries(buckets)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => {
    const pct = ((v / total) * 100).toFixed(1)
    const bar = '█'.repeat(Math.round(v / total * 40))
    console.log(`  ${k.padEnd(38)} ${(v / 1024).toFixed(1).padStart(7)} KB  (${pct.padStart(4)}%)  ${bar}`)
  })
