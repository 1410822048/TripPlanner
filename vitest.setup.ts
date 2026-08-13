// Shared vitest setup for the client + packages suites (jsdom env).
// Registers @testing-library/react's DOM cleanup after every test. Without
// it — and we do NOT set `globals: true` — RTL's auto-cleanup never fires, so
// each render()'s output accumulates in document.body and queries start
// matching stale nodes from prior tests ("multiple elements found"). A no-op
// for non-component (node-only) suites, which never render.
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

// Node 26 exposes an experimental localStorage getter that warns and returns
// undefined unless the process receives --localstorage-file. Install the
// browser contract explicitly for jsdom instead: deterministic, no disk I/O,
// and isolated between tests. Individual suites can still vi.stubGlobal it.
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: createMemoryStorage(),
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})
