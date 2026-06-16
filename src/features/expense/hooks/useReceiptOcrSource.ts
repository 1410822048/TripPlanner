import { useEffect, useRef, useState } from 'react'
import {
  isOcrSupportedImageFile,
  isOcrSupportedImageMimeType,
} from '../services/ocrService'

export interface ExistingReceiptOcrSeed {
  tripId?:          string | null
  expenseId?:       string | null
  receiptPath?:     string | null
  receiptType?:     string | null
  updatedAtMillis?: number
}

export type ReceiptOcrSource =
  | { kind: 'none' }
  | { kind: 'preparing'; requestId: number }
  | { kind: 'fresh'; file: File }
  | {
      kind:            'existing'
      tripId:          string
      expenseId:       string
      receiptPath:     string
      updatedAtMillis?: number
    }

export type ExistingReceiptOcrSource = Extract<ReceiptOcrSource, { kind: 'existing' }>

type ReceiptOcrReadyLocalState =
  | { kind: 'existing-seed' }
  | { kind: 'none' }
  | { kind: 'fresh'; file: File }

type ReceiptOcrLocalState =
  | ReceiptOcrReadyLocalState
  | { kind: 'preparing'; requestId: number; previous: ReceiptOcrReadyLocalState }

export interface ReceiptOcrCapabilities {
  canAnalyze:   boolean
  canReanalyze: boolean
  canFallback:  boolean
  canCompare:   boolean
}

export interface ReceiptOcrCapabilityInput {
  source:          ReceiptOcrSource
  hasAttachment:   boolean
  previewIsImage:  boolean
  ocrLoading:      boolean
  hasItems:        boolean
  ocrError:        string | null
  fallbackEnabled: boolean
  compareEnabled:  boolean
}

export function deriveExistingReceiptOcrSource(seed: ExistingReceiptOcrSeed): ExistingReceiptOcrSource | null {
  if (
    !seed.tripId ||
    !seed.expenseId ||
    !seed.receiptPath ||
    !isOcrSupportedImageMimeType(seed.receiptType ?? undefined)
  ) {
    return null
  }

  return {
    kind:            'existing',
    tripId:          seed.tripId,
    expenseId:       seed.expenseId,
    receiptPath:     seed.receiptPath,
    updatedAtMillis: seed.updatedAtMillis,
  }
}

function sourceFromLocalState(
  state: ReceiptOcrLocalState,
  seed: ExistingReceiptOcrSeed,
): ReceiptOcrSource {
  switch (state.kind) {
    case 'existing-seed':
      return deriveExistingReceiptOcrSource(seed) ?? { kind: 'none' }
    case 'fresh':
      return { kind: 'fresh', file: state.file }
    case 'preparing':
      return { kind: 'preparing', requestId: state.requestId }
    case 'none':
      return { kind: 'none' }
  }
}

function readyStateFrom(state: ReceiptOcrLocalState): ReceiptOcrReadyLocalState {
  return state.kind === 'preparing' ? state.previous : state
}

export function deriveReceiptOcrCapabilities(input: ReceiptOcrCapabilityInput): ReceiptOcrCapabilities {
  const hasReadableAttachment = input.hasAttachment && input.previewIsImage
  const hasOcrSource = input.source.kind === 'fresh' || input.source.kind === 'existing'
  const canRunAction = input.source.kind !== 'preparing' && !input.ocrLoading

  return {
    canAnalyze:   canRunAction && hasReadableAttachment && !input.hasItems && hasOcrSource,
    canReanalyze: canRunAction && hasReadableAttachment && input.hasItems && hasOcrSource,
    canFallback:  canRunAction && input.fallbackEnabled && hasReadableAttachment && hasOcrSource && (input.hasItems || !!input.ocrError),
    canCompare:   canRunAction && input.compareEnabled && hasReadableAttachment && input.source.kind === 'fresh',
  }
}

export function useReceiptOcrSource(seed: ExistingReceiptOcrSeed) {
  const [localState, setLocalState] = useState<ReceiptOcrLocalState>({ kind: 'existing-seed' })
  const requestSeqRef = useRef(0)

  useEffect(() => () => {
    requestSeqRef.current++
  }, [])

  const beginPreparing = (): number => {
    const requestId = ++requestSeqRef.current
    setLocalState(prev => ({ kind: 'preparing', requestId, previous: readyStateFrom(prev) }))
    return requestId
  }

  const isCurrent = (requestId: number): boolean => requestId === requestSeqRef.current

  const commitPreparedFile = (requestId: number, file: File): ReceiptOcrSource | null => {
    if (!isCurrent(requestId)) return null

    const next: ReceiptOcrLocalState = isOcrSupportedImageFile(file)
      ? { kind: 'fresh', file }
      : { kind: 'none' }
    setLocalState(next)
    return sourceFromLocalState(next, seed)
  }

  const rejectPreparedFile = (requestId: number): void => {
    setLocalState(prev => {
      if (prev.kind !== 'preparing' || prev.requestId !== requestId) return prev
      return prev.previous
    })
  }

  const clear = (): void => {
    requestSeqRef.current++
    setLocalState({ kind: 'none' })
  }

  return {
    source: sourceFromLocalState(localState, seed),
    beginPreparing,
    commitPreparedFile,
    rejectPreparedFile,
    clear,
    isCurrent,
  }
}
