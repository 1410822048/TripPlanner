import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import ReceiptSection from './ReceiptSection'

function renderReceiptSection(overrides: Partial<ComponentProps<typeof ReceiptSection>> = {}) {
  const onPreview = vi.fn()
  render(
    <ReceiptSection
      error={undefined}
      sourceKey="fresh:1"
      reconcileWarning={null}
      hasAttachment
      attachmentName="receipt.webp"
      previewUrl={null}
      previewIsImage
      ocrLoading={false}
      ocrElapsedMs={0}
      canAnalyze={false}
      canReanalyze={false}
      canFallback={false}
      canPreview={false}
      onCameraPicked={() => {}}
      onUploadPicked={() => {}}
      onClear={() => {}}
      onAnalyze={() => {}}
      onFallback={() => {}}
      onPreview={onPreview}
      {...overrides}
    />,
  )
  return { onPreview }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReceiptSection receipt-row actions', () => {
  it('keeps an unavailable thumbnail inert while the name area replaces the receipt', () => {
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const { onPreview } = renderReceiptSection({ canPreview: false })
    const previewButton = screen.getByRole('button', { name: '放大顯示收據' }) as HTMLButtonElement

    expect(previewButton.disabled).toBe(true)
    fireEvent.click(previewButton)
    expect(onPreview).not.toHaveBeenCalled()
    expect(inputClick).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '更換收據' }))
    expect(inputClick).toHaveBeenCalledTimes(1)
  })

  it('opens preview from the thumbnail without replacing the receipt', () => {
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const { onPreview } = renderReceiptSection({ canPreview: true })

    fireEvent.click(screen.getByRole('button', { name: '放大顯示收據' }))

    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(inputClick).not.toHaveBeenCalled()
  })
})

describe('ReceiptSection model picker', () => {
  it('exposes the model picker with the 辨識模型 accessible name (real component)', () => {
    renderReceiptSection({ canReanalyze: true })

    // 真實 SingleSelectPicker 是 button(開 PickerDialog),accessible name
    // 由 ariaLabel 前綴組成 — 這裡驗證 ReceiptSection 確實傳了 ariaLabel,
    // 不讓 ExpenseFormModal.test 的 mock 自己補標籤變假綠燈。
    expect(screen.getByRole('button', { name: /^辨識模型/ })).toBeTruthy()
  })
})
