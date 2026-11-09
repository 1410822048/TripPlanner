// Runs inside workerd before any test file loads.
import { AsyncLocalStorage } from 'node:async_hooks'

// shortcut: workerd's AsyncLocalStorage#disable throws "not implemented"; vitest >=5.1 calls it after
// vi.mock factories only as a Node perf hint, so a no-op is behaviour-neutral. Drop once workerd implements it.
AsyncLocalStorage.prototype.disable = function () {}
