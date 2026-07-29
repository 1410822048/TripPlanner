import type { LucideIcon } from 'lucide-react'

interface ReadonlyDetailRowProps {
  icon: LucideIcon
  label: string
  value: string
  accent: string
  mono?: boolean
}

function colorWithAlpha(color: string, alpha: string): string {
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    const [, r, g, b] = color
    return `#${r}${r}${g}${g}${b}${b}${alpha}`
  }
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${alpha}` : color
}

export default function ReadonlyDetailRow({
  icon: Icon,
  label,
  value,
  accent,
  mono = false,
}: ReadonlyDetailRowProps) {
  return (
    <div className="flex items-start gap-3 border-b border-border last:border-b-0 px-4 py-3">
      <div
        className="mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0"
        style={{ backgroundColor: colorWithAlpha(accent, '14'), color: accent }}
      >
        <Icon size={15} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-black text-muted">
          {label}
        </div>
        <div className={[
          'mt-1 text-[13px] font-bold text-ink break-words',
          mono ? 'font-mono tabular-nums' : '',
        ].join(' ')}>
          {value}
        </div>
      </div>
    </div>
  )
}
