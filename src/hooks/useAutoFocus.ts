import { useEffect, type RefObject } from 'react'

/**
 * Focus the given input ref after `delay` ms whenever `trigger` becomes true.
 * Matches the BottomSheet open animation (~280ms) with a small buffer.
 */
export function useAutoFocus(
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  trigger: boolean,
  delay = 320,
) {
  useEffect(() => {
    if (!trigger) return
    const id = window.setTimeout(() => ref.current?.focus(), delay)
    return () => window.clearTimeout(id)
  }, [trigger, delay, ref])
}
