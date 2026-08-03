// src/features/bookings/hooks/useBookingPdfAutofill.ts
// The "read a booking PDF and fill the form" flow: source tracking, the
// extraction request, and the multi-candidate picker.
//
// Two sequence counters do the work here. `seq` discards a slow response
// whose request has since been superseded, alongside the AbortController.
// `sourceKey` identifies WHICH file the current analysis belongs to, so
// swapping the attachment invalidates the previous result without any
// content comparison.
import { useEffect, useRef, useState } from 'react'
import { ATTACHMENT_SIZE_ERROR } from '@/hooks/useAttachment'
import type { BookingFormDraft, BookingFormState } from '../hooks/useBookingFormState'
import type { CreateBookingInput } from '@/types/booking'
import {
  BookingPdfExtractError,
  bookingPdfCandidateToCreateInput,
  bookingPdfExtractToDraftPatch,
  extractBookingPdfAutofill,
  type BookingPdfExtractCandidate,
} from '../services/bookingPdfExtractService'
import { isPdfFile } from '../services/bookingPdfText'

type PdfAutofillStatus = 'idle' | 'loading' | 'applied' | 'empty' | 'error'
type SourceKey = number

export interface CreateablePdfCandidate {
  candidate: BookingPdfExtractCandidate
  index:     number
  input:     CreateBookingInput
}

export interface BookingPdfAutofill {
  status:  PdfAutofillStatus
  message: string | undefined
  /** Status line is hidden while loading (the button label carries it)
   *  and in edit mode, where autofill isn't offered. */
  showStatus:  boolean
  buttonLabel: string
  isLoading:   boolean
  /** The current attachment, when it is a PDF we could read. */
  sourceFile:  File | null
  /** True once the CURRENT source has been analysed — swapping the file
   *  invalidates it without comparing contents. */
  hasAnalyzed: boolean
  /** Opens the dedicated PDF picker. */
  pickAnother: () => void
  /** Clearing the attachment also discards whatever it was analysed into. */
  reset: () => void
  candidates:  CreateablePdfCandidate[]
  selectedIndexes: number[]
  hasSelectedCandidate: boolean
  candidateRoleLabel: (candidate: BookingPdfExtractCandidate, index: number) => string
  toggleCandidate:    (index: number) => void
  createSelected:     () => void
  /** The dedicated "read a PDF" picker. */
  onPdfPicked:      (e: React.ChangeEvent<HTMLInputElement>) => void
  /** The attachment row's picker, which doubles as an autofill source. */
  onDocumentPicked: (e: React.ChangeEvent<HTMLInputElement>) => void
  onCardClick:  () => void
  onRerunClick: () => void
}

export function useBookingPdfAutofill(opts: {
  isEdit:     boolean
  /** `docAtt.newFile` when it is a PDF — the attachment doubles as the
   *  autofill source, so there is only ever one file to reason about. */
  sourceFile: File | null
  /** `docAtt.pickFile`: returns false when the file breaks the size cap,
   *  leaving the previous attachment in place. */
  pickFile:   (file: File) => boolean
  /** Read at apply time, not render time — the user may keep typing while
   *  the extraction is in flight. */
  getState:   () => BookingFormState
  applyPatch: (patch: BookingFormDraft) => void
  /** Opens the hidden PDF input. The input itself stays with the form,
   *  alongside the other hidden pickers, so no ref crosses this boundary. */
  openFilePicker: () => void
  onCreateMany?: (data: { inputs: CreateBookingInput[]; document: File }) => void
}): BookingPdfAutofill {
  const { isEdit, sourceFile, pickFile, getState, applyPatch, openFilePicker, onCreateMany } = opts

  const [status,  setStatus]  = useState<PdfAutofillStatus>('idle')
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<CreateablePdfCandidate[]>([])
  const [selectedIndexes, setSelectedIndexes] = useState<number[]>([])
  const [sourceKey,   setSourceKey]   = useState<SourceKey | null>(null)
  const [analyzedKey, setAnalyzedKey] = useState<SourceKey | null>(null)

  const seqRef        = useRef(0)
  const sourceSeqRef  = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  const hasAnalyzedCurrent =
    sourceFile !== null && sourceKey !== null && analyzedKey === sourceKey

  useEffect(() => () => {
    controllerRef.current?.abort()
  }, [])

  function set(next: PdfAutofillStatus, msg?: string) {
    setStatus(next)
    setMessage(msg)
  }

  function abort() {
    seqRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
  }

  function clearCandidates() {
    setCandidates([])
    setSelectedIndexes([])
  }

  function reset() {
    abort()
    setSourceKey(null)
    setAnalyzedKey(null)
    clearCandidates()
    set('idle')
  }

  function commitSource(): SourceKey {
    const nextKey = sourceSeqRef.current + 1
    sourceSeqRef.current = nextKey
    setSourceKey(nextKey)
    return nextKey
  }

  function errorMessage(e: unknown): string {
    if (e instanceof BookingPdfExtractError) {
      switch (e.kind) {
        case 'auth':        return '請登入後再試一次'
        case 'rate-limit':  return '請稍後再試一次'
        case 'network':
        case 'unavailable': return '無法連線至讀取服務'
        case 'parse':       return e.message || '無法讀取 PDF，請手動輸入'
        case 'unknown':     return '讀取 PDF 失敗'
      }
    }
    return '讀取 PDF 失敗'
  }

  function applyCandidate(candidate: BookingPdfExtractCandidate) {
    const { patch, appliedCount } = bookingPdfExtractToDraftPatch(getState(), candidate, { isEdit })
    applyPatch(patch)
    if (appliedCount > 0) set('applied', '已套用 PDF 的候選資料')
    else                  set('empty',   '找不到可填入的項目')
  }

  async function run(file: File, key: SourceKey) {
    const seq = seqRef.current + 1
    seqRef.current = seq
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    set('loading', '正在從 PDF 讀取訂單資料…')
    clearCandidates()

    try {
      const result = await extractBookingPdfAutofill(file, controller.signal)
      if (controller.signal.aborted || seqRef.current !== seq) return
      setAnalyzedKey(key)
      if (result.bookings.length > 1) {
        const createable = result.bookings.flatMap((candidate, index) => {
          const input = bookingPdfCandidateToCreateInput(candidate)
          return input ? [{ candidate, index, input }] : []
        })
        setCandidates(createable)
        setSelectedIndexes(createable.map(({ index }) => index))
        // Candidates missing a required field are dropped silently
        // otherwise, so a flight whose IATA code fell below the confidence
        // gate would just never appear and the count would look wrong.
        const dropped = result.bookings.length - createable.length
        const droppedNote = dropped > 0 ? `，另有 ${dropped} 筆資料不完整需手動輸入` : ''
        if (createable.length > 0) {
          set('applied', `找到 ${createable.length} 筆訂單候選資料${droppedNote}`)
        } else {
          set('empty', `找不到可新增的候選資料${droppedNote}`)
        }
        return
      }
      const [only] = result.bookings
      if (!only) {
        set('empty', '找不到可填入的項目')
        return
      }
      applyCandidate(only)
    } catch (e) {
      if (controller.signal.aborted || seqRef.current !== seq) return
      set('error', errorMessage(e))
    } finally {
      if (seqRef.current === seq) controllerRef.current = null
    }
  }

  function onPdfPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file
    if (!f) return
    if (!isPdfFile(f)) {
      reset()
      set('error', '請選擇 PDF 檔案')
      return
    }
    if (!pickFile(f)) {
      reset()
      set('error', ATTACHMENT_SIZE_ERROR)
      return
    }
    void run(f, commitSource())
  }

  function onDocumentPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file
    if (!f) return
    // Pick first: a rejected file (over the size cap) leaves the previous
    // attachment in place, so the analysis of that attachment — finished or
    // still running — has to stay too. Aborting before the pick would
    // strand an in-flight run at 'loading', since run()'s abort path
    // deliberately leaves the status alone.
    if (!pickFile(f)) return
    abort()
    if (isPdfFile(f)) commitSource()
    else setSourceKey(null)
    clearCandidates()
    set('idle')
  }

  return {
    status,
    message,
    showStatus: !isEdit && status !== 'idle' && status !== 'loading',
    isLoading:  status === 'loading',
    sourceFile,
    hasAnalyzed: hasAnalyzedCurrent,
    pickAnother: () => openFilePicker(),
    reset,
    buttonLabel: status === 'loading'
      ? '正在讀取 PDF…'
      : sourceFile
        ? hasAnalyzedCurrent ? '從 PDF 自動填入' : '讀取 PDF'
        : '從 PDF 自動填入',
    candidates,
    selectedIndexes,
    hasSelectedCandidate: candidates.some(({ index }) => selectedIndexes.includes(index)),
    candidateRoleLabel: (candidate, index) =>
      candidate.segmentRole === 'outbound' ? '去程'
        : candidate.segmentRole === 'return' ? '回程'
          : candidate.segmentRole === 'connection' ? '轉乘'
            : `候選 ${index + 1}`,
    toggleCandidate: (index: number) =>
      setSelectedIndexes(prev =>
        prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]),
    createSelected: () => {
      if (!sourceFile || !onCreateMany) return
      const selected = candidates
        .filter(({ index }) => selectedIndexes.includes(index))
        .map(({ input }) => input)
      if (selected.length === 0) {
        set('empty', '請選擇要新增的候選資料')
        return
      }
      onCreateMany({ inputs: selected, document: sourceFile })
    },
    onPdfPicked,
    onDocumentPicked,
    onCardClick: () => {
      if (!sourceFile || sourceKey === null || hasAnalyzedCurrent) {
        openFilePicker()
        return
      }
      void run(sourceFile, sourceKey)
    },
    onRerunClick: () => {
      if (!sourceFile || sourceKey === null) return
      void run(sourceFile, sourceKey)
    },
  }
}
