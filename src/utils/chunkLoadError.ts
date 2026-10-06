// src/utils/chunkLoadError.ts
/** A stale-deploy lazy chunk 404 / offline fetch failure. Messages differ
 *  per engine (Chromium / WebKit / Gecko). */
export function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [\w-]+ failed/i.test(msg)
}
