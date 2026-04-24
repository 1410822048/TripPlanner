// src/components/ui/inputStyle.ts
// 標準 input className — 給 text/number/time input 與 textarea 共用。
// font-size 固定 16px：iOS Safari 在 focus 時若 font-size < 16px 會自動放大
// 頁面。16px 是 Apple 原生表單輸入的標準尺寸，desktop 下也不會過大。
export function inputClass(hasError?: boolean): string {
  return [
    'w-full min-w-0 h-[42px] rounded-input px-3',
    'bg-app text-[16px] text-ink font-[inherit] outline-none',
    'border-[1.5px] transition-colors',
    'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20',
    hasError ? 'border-danger' : 'border-border',
  ].join(' ')
}
