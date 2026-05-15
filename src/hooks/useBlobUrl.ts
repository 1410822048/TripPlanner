// src/hooks/useBlobUrl.ts
// Wraps URL.createObjectURL + URL.revokeObjectURL into a single hook so
// callers get a preview URL for a picked File without managing the
// resource lifecycle themselves.
//
// Why useEffect + useState (and NOT useMemo):
//   - URL.createObjectURL is a side effect — it allocates a slot in the
//     browser's blob registry. React docs explicitly say useMemo
//     calculations must be pure; side effects in render are forbidden.
//   - StrictMode double-invokes render in dev. A useMemo'd
//     createObjectURL would produce two URLs on the first render — one
//     is dropped (no cleanup) → memory leak. useEffect runs once per
//     commit (with paired cleanup on the discarded one), so it stays
//     leak-free.
//   - useEffect is React's canonical lifecycle primitive for external
//     resources (timers, subscriptions, blob URLs). useMemo is for
//     derived-value optimisation — different concern.
//
// Trade-off: the first render returns null (effect hasn't run yet);
// the URL appears on the next commit. For the preview-image use cases
// in this app (form modals that just mounted with a freshly-picked
// file), the one-frame delay is imperceptible — the <img src> simply
// renders empty for a single frame before swapping in the blob URL.
import { useEffect, useState } from 'react'

/**
 * Stable preview URL for a File. Returns null when input is null OR
 * during the brief window between file selection and the effect
 * commit. Auto-revokes on file change / unmount.
 */
export function useBlobUrl(file: File | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  // set-state-in-effect lint is the ONLY known exception in this
  // codebase. The rule's goal is "don't sync derived state via effect"
  // — but blob URLs aren't derived, they're allocated browser resources
  // that must be created + freed in lockstep. React docs use this exact
  // pattern for createObjectURL / setInterval / WebSocket etc.
  // There's no `cascading renders` risk here: the effect only depends
  // on `file`, and setUrl never changes that.
  useEffect(() => {
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return url
}
