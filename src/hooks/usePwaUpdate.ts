import { createContext, useContext } from 'react'

export interface PwaUpdateContextValue {
  needRefresh: boolean
  checkingForUpdate: boolean
  dismissUpdate: () => void
  activateUpdate: () => void
  requestUpdate: () => void
}

export const PwaUpdateContext = createContext<PwaUpdateContextValue | null>(null)

export function usePwaUpdate(): PwaUpdateContextValue {
  const value = useContext(PwaUpdateContext)
  if (!value) throw new Error('usePwaUpdate must be used inside PwaUpdateProvider')
  return value
}
