import type { ReactNode } from 'react'

interface PageHeaderProps {
  eyebrow: string
  title: string
  right?: ReactNode
  align?: 'center' | 'end'
  className?: string
  truncateTitle?: boolean
}

export default function PageHeader({
  eyebrow,
  title,
  right,
  align = 'end',
  className = '',
  truncateTitle = false,
}: PageHeaderProps) {
  return (
    <div className={`px-5 pt-4 pb-2 flex justify-between gap-3 ${align === 'center' ? 'items-center' : 'items-end'} ${className}`.trim()}>
      <div className="min-w-0">
        <p className="m-0 mb-1 text-[10.5px] font-semibold text-muted tracking-[0.12em] uppercase">
          {eyebrow}
        </p>
        <h1 className={`m-0 text-[22px] font-black text-ink -tracking-[0.5px] ${truncateTitle ? 'truncate' : ''}`.trim()}>
          {title}
        </h1>
      </div>
      {right}
    </div>
  )
}
