// src/utils/devFailures.ts
// Dev-only single-shot failure injector for testing modal saveError
// banner / global toast paths. Production builds tree-shake away:
// `import.meta.env.DEV` is statically `false` in prod, Vite eliminates
// the if-branches + the window.dev side-effect block.
//
// Usage from DevTools console:
//   window.dev.failNextSave()              // next save throws default error
//   window.dev.failNextSave('custom msg')  // next save throws with msg
//   window.dev.clearFailNextSave()         // cancel pending fail
//
// Why sessionStorage(not module-local state): the call sites run inside
// page handleSave functions, and a global module variable would be
// shared across tabs / lost on hot-reload. sessionStorage persists for
// the tab session and survives Vite HMR refreshes during testing.

const DEV = import.meta.env.DEV
const FLAG = '__tripmate_force_save_fail'
const DEFAULT_MSG = 'テスト用エラー(手動觸發)'

interface DevHelpers {
  failNextSave:      (message?: string) => void
  clearFailNextSave: () => void
}

declare global {
  interface Window {
    dev?: DevHelpers
  }
}

if (DEV && typeof window !== 'undefined') {
  window.dev = {
    failNextSave: (message = DEFAULT_MSG) => {
      sessionStorage.setItem(FLAG, message)
      console.log('[dev] Next save will fail with:', message)
    },
    clearFailNextSave: () => {
      sessionStorage.removeItem(FLAG)
      console.log('[dev] Force-fail flag cleared')
    },
  }
}

/** Throws once if `window.dev.failNextSave()` was just called. Production
 *  build dead-code-eliminates the entire body. */
export async function simulateFailureMaybe(): Promise<void> {
  if (!DEV) return
  if (typeof sessionStorage === 'undefined') return
  const msg = sessionStorage.getItem(FLAG)
  if (msg) {
    sessionStorage.removeItem(FLAG)
    throw new Error(msg)
  }
}
