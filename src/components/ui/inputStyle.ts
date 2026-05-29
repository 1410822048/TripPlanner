// src/components/ui/inputStyle.ts
// 標準 input className — 給 text/number/time input 與 textarea 共用。
// font-size 固定 16px：iOS Safari 在 focus 時若 font-size < 16px 會自動放大
// 頁面。16px 是 Apple 原生表單輸入的標準尺寸，desktop 下也不會過大。
// min-height 48px + explicit line-height/padding：不要只靠固定 height。
// 單行 native input 的 baseline 由瀏覽器與字體 metrics 共同決定；LINE Seed JP /
// fallback CJK fonts 在 Windows/Chrome 下容易把 q/g/p/y 等 descender 壓到
// control box 邊界。用 min-height 讓縮放時可長高，py + leading-6 則提供穩定
// content box，避免再用 46/48/50px 這類 magic number 追瀏覽器差異。
export function inputClass(hasError?: boolean): string {
  return [
    'w-full min-w-0 min-h-12 rounded-input px-3 py-2.5',
    'bg-app text-[16px] leading-6 text-ink font-[inherit] outline-none',
    'border-[1.5px] transition-colors',
    'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20',
    hasError ? 'border-danger' : 'border-border',
  ].join(' ')
}

// Dense row controls for receipt items / adjustments. Keep the same
// descender-safe text box as inputClass, but use tighter block padding so
// table-like rows stay compact without reintroducing fixed-height clipping.
export function compactInputClass(hasError?: boolean): string {
  return [
    'w-full min-w-0 min-h-10 rounded-[8px] px-2.5 py-1.5',
    'bg-app text-[16px] leading-6 text-ink font-[inherit] outline-none',
    'border-[1.5px] transition-colors',
    'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20',
    hasError ? 'border-danger' : 'border-border',
  ].join(' ')
}
