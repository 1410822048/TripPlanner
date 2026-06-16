function envFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      return fallback
  }
}

export const OCR_COMPARE_UI_ENABLED =
  envFlag(import.meta.env.VITE_OCR_COMPARE_ENABLED, false)

export const OCR_FALLBACK_UI_ENABLED =
  envFlag(import.meta.env.VITE_OCR_FALLBACK_ENABLED, true)
