import { useEffect } from 'react'

interface ScrollLock {
  count: number
  overflow: string
  touchAction: string
  scrollTop: number
}

const locks = new WeakMap<HTMLElement, ScrollLock>()

/** 疊層 dialog 可任意順序關閉；最後一個解除才還原原始捲動狀態。 */
export function useMainScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const main = document.querySelector<HTMLElement>('main')
    if (!main) return
    let lock = locks.get(main)
    if (!lock) {
      lock = { count: 0, overflow: main.style.overflow, touchAction: main.style.touchAction, scrollTop: main.scrollTop }
      locks.set(main, lock)
      main.style.overflow = 'hidden'
      main.style.touchAction = 'none'
    }
    lock.count += 1
    return () => {
      lock.count -= 1
      if (lock.count > 0) return
      main.style.overflow = lock.overflow
      main.style.touchAction = lock.touchAction
      main.scrollTop = lock.scrollTop
      locks.delete(main)
    }
  }, [active])
}
