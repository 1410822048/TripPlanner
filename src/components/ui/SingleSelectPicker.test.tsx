import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import CurrencyPicker from './CurrencyPicker'
import CountryPicker from './CountryPicker'

describe('shared single-select picker', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  test('country and currency use the exact same trigger styling', () => {
    render(
      <>
        <CurrencyPicker value="JPY" onChange={() => undefined} />
        <CountryPicker value="JP" onChange={() => undefined} />
      </>,
    )

    const currency = screen.getByRole('button', { name: '¥ 日圓 (JPY)' })
    const country = screen.getByRole('button', { name: 'JP 日本' })
    expect(country.getAttribute('class')).toBe(currency.getAttribute('class'))
  })

  test('country selection uses the same dialog interaction and closes after choosing', () => {
    const onChange = vi.fn()
    render(<CountryPicker value="JP" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'JP 日本' }))
    expect(screen.getByRole('dialog', { name: '選擇旅程國家' })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: 'TW 台灣' }))

    expect(onChange).toHaveBeenCalledWith('TW')
    expect(screen.queryByRole('dialog', { name: '選擇旅程國家' })).toBeNull()
  })
})
