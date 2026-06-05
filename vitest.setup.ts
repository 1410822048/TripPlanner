// Shared vitest setup for the client + packages suites (jsdom env).
// Registers @testing-library/react's DOM cleanup after every test. Without
// it — and we do NOT set `globals: true` — RTL's auto-cleanup never fires, so
// each render()'s output accumulates in document.body and queries start
// matching stale nodes from prior tests ("multiple elements found"). A no-op
// for non-component (node-only) suites, which never render.
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})
