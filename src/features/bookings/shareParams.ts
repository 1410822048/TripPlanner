// src/features/bookings/shareParams.ts
// Dependency-free on purpose: App.tsx calls this on every boot to detect a
// PWA Share Target launch, and importing it from linkDraft.ts dragged the
// booking brand catalog into the entry chunk.
export function hasShareParams(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('url') || params.has('text') || params.has('title')
}
