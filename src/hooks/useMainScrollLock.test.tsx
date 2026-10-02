import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useMainScrollLock } from './useMainScrollLock'

afterEach(() => document.querySelector('main')?.remove())

describe('nested main scroll locks', () => {
  it.each([true, false])('restores original styles and position regardless of release order: %s', parentFirst => {
    const main = document.createElement('main')
    main.style.overflow = 'auto'
    main.style.touchAction = 'pan-y'
    main.scrollTop = 120
    document.body.append(main)
    const parent = renderHook(() => useMainScrollLock(true))
    const child = renderHook(() => useMainScrollLock(true))
    const first = parentFirst ? parent : child
    const last = parentFirst ? child : parent
    act(() => first.unmount())
    expect(main.style.overflow).toBe('hidden')
    expect(main.style.touchAction).toBe('none')
    act(() => last.unmount())
    expect(main.style.overflow).toBe('auto')
    expect(main.style.touchAction).toBe('pan-y')
    expect(main.scrollTop).toBe(120)
  })
})
