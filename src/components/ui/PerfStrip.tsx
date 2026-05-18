// src/components/ui/PerfStrip.tsx
// Diagnostic overlay for cold-start timing. Off by default. Enable via
// `localStorage.setItem('tripmate.perf', '1')` from any browser console
// (or from a future debug menu). When enabled, renders a fixed strip
// at the bottom-right of the screen listing each markPerf() event +
// its ms-since-page-load timestamp. Subscribes via subscribePerf so
// new marks appear in real time.
//
// Pure debug — pin the localStorage key and ship to production so you
// can ask a real user to flip it on without re-deploying.
import { useEffect, useState } from 'react'
import { getPerfMarks, subscribePerf } from '@/utils/perf'

function isEnabled(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('tripmate.perf') === '1' }
  catch { return false }
}

export default function PerfStrip() {
  const [, tick] = useState(0)
  // Lazy init: localStorage flip happens at most once per page load (and
  // requires a manual console command), so reading it on every render is
  // wasted work. Passing the function reference defers the call to the
  // initial render only.
  const [enabled] = useState(isEnabled)

  useEffect(() => {
    if (!enabled) return
    return subscribePerf(() => tick(n => n + 1))
  }, [enabled])

  if (!enabled) return null
  const marks = getPerfMarks()
  return (
    <div
      className="fixed bottom-2 right-2 z-[500] max-w-[260px] rounded-md p-2 text-[10px] leading-[1.4] font-mono"
      style={{ background: 'rgba(0,0,0,0.78)', color: '#fff' }}
    >
      {marks.map((m, i) => {
        const prev = i > 0 ? marks[i - 1]!.t : 0
        return (
          <div key={i} className="flex justify-between gap-3">
            <span className="truncate">{m.label}</span>
            <span className="tabular-nums shrink-0">
              {m.t}ms <span className="opacity-60">(+{m.t - prev})</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
