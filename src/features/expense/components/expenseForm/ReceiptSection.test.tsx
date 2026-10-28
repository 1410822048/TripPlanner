import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import ReceiptSection from './ReceiptSection'

function renderReceiptSection(overrides: Partial<ComponentProps<typeof ReceiptSection>> = {}) {
  const onPreview = vi.fn()
  render(
    <ReceiptSection
      error={undefined}
      reconcileWarning={null}
      hasAttachment
      attachmentName="receipt.webp"
      previewUrl={null}
      previewIsImage
      ocrLoading={false}
      ocrElapsedMs={0}
      canAnalyze={false}
      canReanalyze={false}
      canRetry={false}
      canPreview={false}
      onCameraPicked={() => {}}
      onUploadPicked={() => {}}
      onClear={() => {}}
      onAnalyze={() => {}}
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

describe('ReceiptSection retry', () => {
  it('re-runs OCR from 再次讀取 (single model, no picker)', () => {
    const onAnalyze = vi.fn()
    renderReceiptSection({ canReanalyze: true, canRetry: true, onAnalyze })

    expect(screen.queryByRole('button', { name: /^辨識模型/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^再次讀取$/ }))
    expect(onAnalyze).toHaveBeenCalledTimes(1)
  })

  it('offers a retry after a failed OCR even before any items exist', () => {
    renderReceiptSection({ canAnalyze: true, canRetry: true })

    expect(screen.getByRole('button', { name: /^再次讀取$/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /讀取明細/ })).toBeNull()
  })
})
