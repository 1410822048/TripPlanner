import { colorWithAlpha, isLightHex, type BookingPassTheme } from './bookingPassTheme'

interface Props {
  theme: BookingPassTheme
  variant: 'soft' | 'light'
}

export default function BookingBrandPill({ theme, variant }: Props) {
  if (!theme.brand) return null

  const label = theme.brand.label || theme.brand.name
  const light = variant === 'light'

  return (
    <span
      className={[
        'inline-flex max-w-[112px] items-center rounded-full border px-2 py-0.5 text-[10px] font-black leading-4 truncate',
        light ? 'shadow-[0_4px_12px_rgba(0,0,0,0.12)]' : '',
      ].join(' ')}
      style={{
        backgroundColor: light ? theme.accent : colorWithAlpha(theme.accent, '18'),
        borderColor: light ? colorWithAlpha(theme.accent, '88') : colorWithAlpha(theme.accent, '34'),
        // soft 是 pale-accent 底:亮色 accent 當字會糊,改用深色 ink。
        color: light ? theme.accentInk : isLightHex(theme.accent) ? '#2E2B27' : theme.accent,
      }}
      title={theme.brand.name}
    >
      {label}
    </span>
  )
}
