// src/components/ui/CurrencyPicker.tsx
// Compact dropdown-style currency picker. Matches the DatePicker visual
// language: an input-shaped trigger that opens a dialog with the
// options as a scrollable list. The grid version this replaced ate
// ~180px of vertical space (5 rows × 3 col); this trigger is the same
// same min-height + line-height contract as the date/text inputs around
// it, keeping the create / edit trip forms visually tight without
// clipping CJK fallback font metrics.

import SingleSelectPicker, { type SingleSelectOption } from './SingleSelectPicker'
import { CURRENCY_OPTIONS } from '@/utils/currency'

interface Props {
  value:    string
  onChange: (code: string) => void
}

const CURRENCY_PICKER_OPTIONS: readonly SingleSelectOption[] = CURRENCY_OPTIONS.map(currency => ({
  value: currency.code,
  prefix: currency.symbol,
  label: currency.label,
}))

export default function CurrencyPicker({ value, onChange }: Props) {
  return (
    <SingleSelectPicker
      value={value}
      options={CURRENCY_PICKER_OPTIONS}
      title="選擇幣別"
      placeholder="請選擇幣別"
      onChange={onChange}
    />
  )
}
