// src/features/account/components/FeatureCard.tsx
// Square card with optional tap target — used by マイページ's 2-column
// feature grid. Has a body slot (children) + bottom label / sublabel block.
// When `onClick` is omitted (or `disabled` is set), renders as a plain div
// to avoid semantically misleading "button" roles on informational cards.
import type { ReactNode } from 'react'

interface Props {
  label:     string
  sublabel?: string
  disabled?: boolean
  onClick?:  () => void
  children:  ReactNode
}

export default function FeatureCard({ label, sublabel, disabled, onClick, children }: Props) {
  const clickable = !!onClick && !disabled
  const Tag: 'button' | 'div' = clickable ? 'button' : 'div'
  return (
    <Tag
      onClick={clickable ? onClick : undefined}
      disabled={clickable ? disabled : undefined}
      className={[
        'aspect-square bg-surface border border-border rounded-[22px] p-4 flex flex-col',
        'shadow-[0_2px_12px_rgba(0,0,0,0.05)] transition-all text-left',
        clickable
          ? 'cursor-pointer hover:-translate-y-px hover:shadow-[0_4px_18px_rgba(0,0,0,0.08)]'
          : 'cursor-default',
        disabled ? 'opacity-60 cursor-not-allowed' : '',
      ].join(' ')}
    >
      <div className="flex-1 min-h-0">
        {children}
      </div>
      <div className="mt-2.5">
        <div className="text-[13px] font-bold text-ink -tracking-[0.1px]">
          {label}
        </div>
        {sublabel && (
          <div className="text-[10.5px] text-muted mt-0.5 tracking-[0.04em]">
            {sublabel}
          </div>
        )}
      </div>
    </Tag>
  )
}
