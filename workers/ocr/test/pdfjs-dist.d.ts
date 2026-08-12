// Ambient stubs for the two pdfjs-dist subpaths, scoped to the TEST
// program only. No imports in this file — it has to stay a global script,
// or these stop being ambient declarations (see cloudflare-test-env.d.ts).
//
// Adding the pool to tsconfig `types` brings workerd's module environment
// with it, and that breaks subpath resolution for
// `pdfjs-dist/build/pdf.mjs`. src/pdf-page-limit.ts then reports TS7016
// under test/tsconfig.json while compiling cleanly under the parent config.
// Verified by dropping the pool entry: the pdfjs errors vanish and the
// `cloudflare:test` ones come back in their place.
//
// src/ lands in this program transitively, via the specs that import it,
// so the errors surface even though nothing in test/ touches pdfjs.
// Declaring the modules costs nothing real — the parent config is what
// actually guards src/, it resolves the genuine types, and
// `npm run typecheck` runs it.
declare module 'pdfjs-dist/build/pdf.mjs'
declare module 'pdfjs-dist/build/pdf.worker.mjs'
