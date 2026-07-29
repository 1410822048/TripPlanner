import type { ReactNode } from 'react'

interface ListEmptyCardProps {
  icon: ReactNode
  title: ReactNode
  description: ReactNode
  actions?: ReactNode
  className?: string
}

export default function ListEmptyCard({
  icon,
  title,
  description,
  actions,
  className = '',
}: ListEmptyCardProps) {
  return (
    <div className={`text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border ${className}`.trim()}>
      {icon}
      <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
        {title}
      </p>
      <div className={`text-[11.5px] text-muted tracking-[0.04em] ${actions ? 'mb-[18px]' : ''}`.trim()}>
        {description}
      </div>
      {actions}
    </div>
  )
}
