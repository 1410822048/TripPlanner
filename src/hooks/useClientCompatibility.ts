import { useSyncExternalStore } from 'react'
import {
  getClientCompatibilitySnapshot,
  subscribeClientCompatibility,
} from '@/services/clientCompatibility'

export function useClientCompatibility() {
  return useSyncExternalStore(
    subscribeClientCompatibility,
    getClientCompatibilitySnapshot,
    getClientCompatibilitySnapshot,
  )
}
