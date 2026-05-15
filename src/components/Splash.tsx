// src/components/Splash.tsx
import { useEffect, useState } from 'react'

interface Props {
  onDone: () => void
}

export default function Splash({ onDone }: Props) {
  const [entered, setEntered] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    // Brand moment kept to ~500ms total so it doesn't pile on top of
    // the real boot (auth + Firestore handshake) which already takes
    // its own 2–5s on cold mobile launches. Previous 1.6s baseline
    // stacked, making cold launches feel >7s. Splash is now a quick
    // wipe rather than a held card.
    const rafId      = requestAnimationFrame(() => setEntered(true))
    const leaveTimer = setTimeout(() => setLeaving(true), 300)
    const doneTimer  = setTimeout(() => onDone(),         500)
    return () => {
      cancelAnimationFrame(rafId)
      clearTimeout(leaveTimer)
      clearTimeout(doneTimer)
    }
  }, [onDone])

  return (
    <div
      aria-hidden={leaving}
      className={[
        'fixed inset-0 z-[9999] flex items-center justify-center bg-app',
        'transition-opacity duration-[400ms] ease-out',
        leaving ? 'opacity-0 pointer-events-none' : 'opacity-100',
      ].join(' ')}
    >
      <div
        className={[
          'flex flex-col items-center',
          'transition-all duration-[600ms] ease-out',
          entered ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-1 scale-[0.94]',
        ].join(' ')}
      >
        <div
          className="w-[88px] h-[88px] rounded-[26px] bg-teal flex items-center justify-center text-[44px] mb-5"
          style={{ boxShadow: '0 12px 32px rgba(61,139,122,0.32)' }}
        >
          ✈️
        </div>
        <h1 className="m-0 text-[30px] font-black text-teal -tracking-[0.5px]">
          TripMate
        </h1>
        <p className="m-0 mt-1.5 text-[11.5px] text-muted tracking-[0.06em]">
          旅行を、仲間と一緒に
        </p>
      </div>
    </div>
  )
}
