import type { Dispatch, SetStateAction } from 'react'
import type { RegisterSWOptions } from 'vite-plugin-pwa/types'

const noopDispatch: Dispatch<SetStateAction<boolean>> = () => undefined

/** Vitest-only resolution target. Production receives this virtual module
 * from vite-plugin-pwa; a test that exercises registration must mock it. */
export function useRegisterSW(_options?: RegisterSWOptions) {
  return {
    needRefresh: [false, noopDispatch] as [boolean, Dispatch<SetStateAction<boolean>>],
    offlineReady: [false, noopDispatch] as [boolean, Dispatch<SetStateAction<boolean>>],
    updateServiceWorker: async () => undefined,
  }
}
