// src/components/ui/PlaceholderPage.tsx
import type { ReactNode } from 'react'

interface Props {
  icon:        ReactNode
  title:       string
  description: string
  color?:      string
  bg?:         string
}

export default function PlaceholderPage({ icon, title, description, color = '#4A6670', bg = '#E8EEF0' }: Props) {
  return (
    <div
      className="flex flex-col items-center justify-center text-center px-6 py-8 bg-app"
      style={{ minHeight: 'calc(100dvh - 52px - 64px)' }}
    >
      <div
        className="w-[72px] h-[72px] rounded-card flex items-center justify-center mb-4.5 border border-black/5"
        style={{ background: bg, color }}
      >
        {icon}
      </div>

      <h2 className="m-0 mb-2 text-[18px] font-bold text-ink tracking-[0.04em] font-[Georgia,_'Noto_Serif_JP',_serif]">
        {title}
      </h2>
      <p className="m-0 mb-[22px] text-[13px] text-muted leading-[1.7] max-w-[220px] tracking-[0.04em]">
        {description}
      </p>

      <div className="inline-flex items-center gap-[5px] bg-[#F0EBE3] text-[#907060] text-[11px] font-medium px-3.5 py-[5px] rounded-card tracking-[0.08em]">
        準備中
      </div>
    </div>
  )
}
