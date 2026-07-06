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
  | { kind: 'fresh'; file: File; revision: number }
  | {
      kind:            'existing'
      tripId:          string
      expenseId:       string
      receiptPath:     string
      updatedAtMillis?: number
    }

export type ExistingReceiptOcrSource = Extract<ReceiptOcrSource, { kind: 'existing' }>
export type ReceiptOcrSourceKey = string

type ReceiptOcrReadyLocalState =
  | { kind: 'existing-seed' }
  | { kind: 'none' }
  | { kind: 'fresh'; file: File; revision: number }

type ReceiptOcrLocalState =
  | ReceiptOcrReadyLocalState
  | { kind: 'preparing'; requestId: number; previous: ReceiptOcrReadyLocalState }

export interface ReceiptOcrCapabilities {
  canAnalyze:   boolean
  canReanalyze: boolean
  canFallback:  boolean
}

export interface ReceiptOcrCapabilityInput {
  source:            ReceiptOcrSource
  sourceKey:         ReceiptOcrSourceKey | null
  analyzedSourceKey: ReceiptOcrSourceKey | null
  hasAttachment:     boolean
  previewIsImage:    boolean
  ocrLoading:        boolean
  hasItems:          boolean
  ocrError:          string | null
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
      return { kind: 'fresh', file: state.file, revision: state.revision }
    case 'preparing':
      return { kind: 'preparing', requestId: state.requestId }
    case 'none':
      return { kind: 'none' }
  }
}

function readyStateFrom(state: ReceiptOcrLocalState): ReceiptOcrReadyLocalState {
  return state.kind === 'preparing' ? state.previous : state
}

export function receiptOcrSourceKey(source: ReceiptOcrSource): ReceiptOcrSourceKey | null {
  switch (source.kind) {
    case 'fresh':
      return `fresh:${source.revision}`
    case 'existing':
      return [
        'existing',
        source.tripId,
        source.expenseId,
        source.receiptPath,
        source.updatedAtMillis ?? '',
      ].join(':')
    case 'none':
    case 'preparing':
      return null
  }
}

export function deriveReceiptOcrCapabilities(input: ReceiptOcrCapabilityInput): ReceiptOcrCapabilities {
  const hasReadableAttachment = input.hasAttachment && input.previewIsImage
  const hasOcrSource = input.source.kind === 'fresh' || input.source.kind === 'existing'
  const canRunAction = input.source.kind !== 'preparing' && !input.ocrLoading
  const sourceAlreadyAnalyzed =
    input.sourceKey !== null && input.sourceKey === input.analyzedSourceKey
  const currentItemsBelongToSource =
    input.hasItems && (input.source.kind === 'existing' || sourceAlreadyAnalyzed)

  return {
    canAnalyze:   canRunAction && hasReadableAttachment && hasOcrSource && !currentItemsBelongToSource,
    canReanalyze: canRunAction && hasReadableAttachment && hasOcrSource && currentItemsBelongToSource,
    canFallback:  canRunAction && hasReadableAttachment && hasOcrSource && (currentItemsBelongToSource || !!input.ocrError),
  }
}

export function useReceiptOcrSource(seed: ExistingReceiptOcrSeed) {
  const [localState, setLocalState] = useState<ReceiptOcrLocalState>({ kind: 'existing-seed' })
  const [analyzedSourceKey, setAnalyzedSourceKey] = useState<ReceiptOcrSourceKey | null>(null)
  const requestSeqRef = useRef(0)
  const freshRevisionRef = useRef(0)

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

    const revision = freshRevisionRef.current + 1
    const next: ReceiptOcrLocalState = isOcrSupportedImageFile(file)
      ? { kind: 'fresh', file, revision }
      : { kind: 'none' }
    if (next.kind === 'fresh') freshRevisionRef.current = revision
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
    setAnalyzedSourceKey(null)
    setLocalState({ kind: 'none' })
  }

  const source = sourceFromLocalState(localState, seed)
  const sourceKey = receiptOcrSourceKey(source)

  return {
    source,
    sourceKey,
    analyzedSourceKey,
    beginPreparing,
    commitPreparedFile,
    rejectPreparedFile,
    clear,
    isCurrent,
    markAnalyzed: (key: ReceiptOcrSourceKey | null): void => {
      if (key !== null) setAnalyzedSourceKey(key)
    },
  }
}
