/// <reference path="../../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

// Ambient declarations scoped to the TEST program only.
//
// 1. `cloudflare:test` — the pool's `types` entry does NOT pull in this
//    module declaration; it ships as a separate d.ts the package exposes
//    only under a subpath. `types` takes package names, and a
//    `reference types=` resolves against @types, so neither reaches it —
//    a `reference path=` is what actually puts the file in the program
//    (confirmed with `tsc --listFiles`).
//
// 2. pdfjs-dist subpaths — adding the pool to `types` brings workerd's
//    module environment with it, which breaks subpath resolution for
//    `pdfjs-dist/build/pdf.mjs`. src/pdf-page-limit.ts then reports TS7016
//    under test/tsconfig.json while compiling cleanly under the parent.
//    Verified by dropping the pool from `types`: the pdfjs errors vanish
//    and the `cloudflare:test` ones come back in their place.
//
//    src/ lands in this program transitively, via the specs that import
//    it, so the errors surface even though nothing in test/ touches pdfjs.
//    Declaring the modules costs nothing real — the parent config is what
//    actually guards src/, it resolves the genuine types, and
//    `npm run typecheck` runs it.
declare module 'pdfjs-dist/build/pdf.mjs'
declare module 'pdfjs-dist/build/pdf.worker.mjs'
