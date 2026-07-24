import SingleSelectPicker, { type SingleSelectOption } from './SingleSelectPicker'
import { COUNTRY_OPTIONS } from '@/utils/country'

const COUNTRY_PICKER_OPTIONS: readonly SingleSelectOption[] = COUNTRY_OPTIONS.map(country => ({
  value: country.code,
  prefix: country.code,
  label: country.label,
}))

interface Props {
  value: string
  onChange: (code: string) => void
  error?: boolean
}

export default function CountryPicker({ value, onChange, error = false }: Props) {
  return (
    <SingleSelectPicker
      value={value}
      options={COUNTRY_PICKER_OPTIONS}
      title="選擇旅程國家"
      placeholder="請選擇國家"
      onChange={onChange}
      error={error}
      required
    />
  )
}
