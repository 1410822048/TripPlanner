// src/theme.ts
// 和紙・大地配色 — JS 端存取（單一 source of truth 為 index.css 的 @theme block，此處為 mirror）
// 動態樣式（alpha 組合、rgba()）仍需 hex 值，所以保留原始色票字串
export const theme = {
  app:        '#F4EFE6',
  surface:    '#FDFAF5',
  border:     '#E2DDD4',
  ink:        '#2E2B27',
  muted:      '#9C9890',
  dot:        '#C5BDB0',
  teal:       '#3D8B7A',
  tealPale:   '#E4F0ED',
  accent:     '#4A6670',
  accentPale: '#E8EFF1',
  pick:       '#6B7A94',
  pickPale:   '#EAEDF3',
  danger:     '#A05050',
  dangerPale: '#FDF0F0',
  dangerSoft: '#EDD0D0',
  warn:       '#B8874A',
  warnBg:     '#F7EEDC',
  tile:       '#F0EDE8',
} as const

export type Theme = typeof theme
