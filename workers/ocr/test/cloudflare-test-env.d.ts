// Loads the pool's `cloudflare:test` module declaration.
//
// Its tsconfig `types` entry does NOT include it — the declaration ships
// as a separate d.ts the package exposes under the public `./types`
// subpath, and tsconfig `types` takes package names only. This import is
// what puts the file in the program (confirmed with `tsc --listFiles`);
// referencing a path into node_modules would work too but pins us to the
// package's internal layout.
//
// Kept apart from pdfjs-dist.d.ts on purpose: an `import` makes a file a
// MODULE, and `declare module` inside a module augments rather than
// declares globally — which silently un-declares the pdfjs shims.
import '@cloudflare/vitest-pool-workers/types'
