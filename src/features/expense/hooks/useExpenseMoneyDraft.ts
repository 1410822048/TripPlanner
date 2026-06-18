// src/features/expense/hooks/useExpenseMoneyDraft.ts
// Consolidates the CURRENCY-SENSITIVE money-draft state that used to be
// scattered across ExpenseFormModal as five separate state owners
// (FormState.amountText + .sourceCurrency, two adjustment useStates, and
// lastForeignCurrency). Bundling them under one reducer makes
// 「切換幣別」a SINGLE transition (`switchCurrency`) instead of seven
// imperative setState fan-outs, and pulls the intricate — and historically
// bug-prone — renormalization math out into a pure, unit-tested function.
//
// Out of scope (kept as their own hooks): `useExpenseItems` (the item rows)
// and `useSplitsState` (mode/included + custom-split text). They are also
// currency-sensitive, but `switchCurrency` renormalizes them THROUGH the
// same pure fn: the caller hands their current values in and applies the
// returned renormalized values via `items.reset` / `splits.resetCustom`.
// See the ExpenseFormModal roadmap (P3) for why a full absorb was deferred.
import { useReducer } from 'react'
import type {
  ExpenseAdjustment,
  ExpenseAdjustmentKind,
  ExpenseAdjustmentScope,
  Expense,
} from '@/types'
import { formatMinorForInput, parseMoneyToMinor } from '@/utils/money'
import { normalizeMoneyTextForCurrency, safeReparseMoney } from '../utils'
import type { FormItem } from './useExpenseItems'

/** Default code used when 「外貨で記録」 opens. USD by default; if the trip
 *  currency itself is USD, fall back to EUR so the toggle never expands
 *  into a degenerate (source === trip) state. (Moved verbatim from
 *  ExpenseFormModal — the only consumer is this hook's init + switch.) */
export function defaultForeignCurrencyFor(tripCurrency: string): string {
  return tripCurrency === 'USD' ? 'EUR' : 'USD'
}

/** Every currency-sensitive money-draft slice. `items` + `customSplits`
 *  live in sibling hooks, so they travel in/out of `switchCurrency` rather
 *  than being owned here. */
export interface MoneyDraftCurrencyRenorm {
  amountText:           string
  items:                FormItem[]
  adjustments:          ExpenseAdjustment[]
  adjustmentAmountText: Record<string, string>
  customSplits:         Record<string, string>
}

export interface MoneyDraftCurrencyRenormInput extends MoneyDraftCurrencyRenorm {
  oldCurrency:  string
  nextCurrency: string
}

/**
 * Pure renormalization of every currency-sensitive draft slice when the
 * source currency changes. Extracted verbatim from the old
 * `ExpenseFormModal.setSourceCurrency` body.
 *
 * Why this is load-bearing: the stored `amountMinor` on each slice was
 * computed at typing time using the OLD currency's fraction digits. After
 * a switch, the displayed text would still read e.g. "1200" but a USD
 * reparse is canonically 120000 minor — itemsDiff / FX preview / the
 * sourceSplits Worker payload would all silently use the stale value. So
 * every slice's text is renormalized for the new currency and its minor
 * value rederived in lock-step:
 *   - amountText / item.amountText: authoritative display text (preserved
 *     verbatim through typing) → renormalize text + rederive amountMinor.
 *   - adjustments: no display text on the persisted shape, so recover it
 *     from the inflight map (typed mid-edit) or by formatting the OLD
 *     amountMinor under the OLD currency before reparsing.
 *   - customSplits: user-typed split text; renormalize so "12.34" under USD
 *     doesn't collapse to 0 when switching to JPY (which rejects decimals).
 */
export function renormalizeMoneyDraftForCurrency(
  input: MoneyDraftCurrencyRenormInput,
): MoneyDraftCurrencyRenorm {
  const {
    oldCurrency, nextCurrency,
    amountText, items, adjustments, adjustmentAmountText, customSplits,
  } = input

  const nextAmountText = normalizeMoneyTextForCurrency(amountText, nextCurrency)

  const nextItems: FormItem[] = items.map(it => {
    const text = normalizeMoneyTextForCurrency(it.amountText, nextCurrency)
    return { ...it, amountText: text, amountMinor: safeReparseMoney(text, nextCurrency) }
  })

  // Full-replace the inflight text map with only the (non-empty) entries
  // for the current adjustments — matches the old setSourceCurrency, which
  // deleted every current adjustment id from prev and merged the new map.
  const nextAdjustmentAmountText: Record<string, string> = {}
  const nextAdjustments = adjustments.map(adj => {
    const inflight = adjustmentAmountText[adj.id]
    const rawText = inflight !== undefined
      ? inflight
      : adj.amountMinor > 0 ? formatMinorForInput(adj.amountMinor, oldCurrency) : ''
    const text = normalizeMoneyTextForCurrency(rawText, nextCurrency)
    if (text !== '') nextAdjustmentAmountText[adj.id] = text
    return { ...adj, amountMinor: safeReparseMoney(text, nextCurrency) }
  })

  const nextCustom: Record<string, string> = {}
  for (const [id, text] of Object.entries(customSplits)) {
    nextCustom[id] = normalizeMoneyTextForCurrency(text, nextCurrency)
  }

  return {
    amountText:           nextAmountText,
    items:                nextItems,
    adjustments:          nextAdjustments,
    adjustmentAmountText: nextAdjustmentAmountText,
    customSplits:         nextCustom,
  }
}

// ─── Reducer state + actions ──────────────────────────────────────

interface MoneyDraftState {
  sourceCurrency:       string
  amountText:           string
  adjustments:          ExpenseAdjustment[]
  adjustmentAmountText: Record<string, string>
  lastForeignCurrency:  string
}

type Action =
  | { kind: 'setAmountText';     text: string }
  | {
      kind:        'switchCurrency'
      next:        string
      tripCurrency: string
      renorm:      Pick<MoneyDraftCurrencyRenorm, 'amountText' | 'adjustments' | 'adjustmentAmountText'>
    }
  | { kind: 'addAdjustment';     id: string }
  | { kind: 'removeAdjustment';  id: string }
  | { kind: 'dropAdjustmentsForItem'; itemId: string }
  | { kind: 'setAdjustmentKind';  id: string; value: ExpenseAdjustmentKind }
  | { kind: 'setAdjustmentLabel'; id: string; value: string }
  | { kind: 'setAdjustmentAmount'; id: string; value: string; minor: number }
  | { kind: 'setAdjustmentScope';  id: string; scope: ExpenseAdjustmentScope; itemIds: string[] }
  | { kind: 'setAdjustmentTarget'; id: string; targetItemId: string }
  | { kind: 'resetAdjustments'; adjustments: ExpenseAdjustment[]; adjustmentAmountText: Record<string, string> }
  | { kind: 'clearAdjustments' }

function mapAdjustment(
  state:  MoneyDraftState,
  id:     string,
  mapper: (adj: ExpenseAdjustment) => ExpenseAdjustment,
): ExpenseAdjustment[] {
  return state.adjustments.map(adj => (adj.id === id ? mapper(adj) : adj))
}

function reducer(state: MoneyDraftState, action: Action): MoneyDraftState {
  switch (action.kind) {
    case 'setAmountText':
      return { ...state, amountText: action.text }

    case 'switchCurrency':
      // Single atomic transition: source currency + every owned
      // currency-sensitive slice, plus the remembered foreign code.
      return {
        ...state,
        sourceCurrency:       action.next,
        amountText:           action.renorm.amountText,
        adjustments:          action.renorm.adjustments,
        adjustmentAmountText: action.renorm.adjustmentAmountText,
        lastForeignCurrency:  action.next !== action.tripCurrency ? action.next : state.lastForeignCurrency,
      }

    case 'addAdjustment':
      // Defaults: DISCOUNT (most common manual case — subtractive), EXPENSE
      // scope. Label / amount blank so the validation gate forces input.
      return {
        ...state,
        adjustments: [
          ...state.adjustments,
          { id: action.id, label: '', kind: 'DISCOUNT', scope: 'EXPENSE', amountMinor: 0 },
        ],
      }

    case 'removeAdjustment': {
      const adjustmentAmountText = { ...state.adjustmentAmountText }
      delete adjustmentAmountText[action.id]
      return {
        ...state,
        adjustments: state.adjustments.filter(adj => adj.id !== action.id),
        adjustmentAmountText,
      }
    }

    case 'dropAdjustmentsForItem':
      // removeItemRow cascade: an ITEM-scope adjustment targeting a removed
      // item is now dangling — drop it (inflight text follows on next render
      // via removeAdjustment paths; here we only need the doc shape gone).
      return {
        ...state,
        adjustments: state.adjustments.filter(adj => adj.targetItemId !== action.itemId),
      }

    case 'setAdjustmentKind':
      return { ...state, adjustments: mapAdjustment(state, action.id, adj => ({ ...adj, kind: action.value })) }

    case 'setAdjustmentLabel':
      return { ...state, adjustments: mapAdjustment(state, action.id, adj => ({ ...adj, label: action.value })) }

    case 'setAdjustmentAmount':
      return {
        ...state,
        adjustmentAmountText: { ...state.adjustmentAmountText, [action.id]: action.value },
        adjustments:          mapAdjustment(state, action.id, adj => ({ ...adj, amountMinor: action.minor })),
      }

    case 'setAdjustmentScope':
      return {
        ...state,
        adjustments: mapAdjustment(state, action.id, adj => {
          if (action.scope === 'EXPENSE') {
            return { id: adj.id, label: adj.label, kind: adj.kind, scope: 'EXPENSE', amountMinor: adj.amountMinor }
          }
          const existingTarget =
            adj.targetItemId && action.itemIds.includes(adj.targetItemId) ? adj.targetItemId : undefined
          const targetItemId = existingTarget ?? action.itemIds[0]
          return targetItemId ? { ...adj, scope: 'ITEM', targetItemId } : adj
        }),
      }

    case 'setAdjustmentTarget':
      return {
        ...state,
        adjustments: mapAdjustment(state, action.id, adj => ({ ...adj, scope: 'ITEM', targetItemId: action.targetItemId })),
      }

    case 'resetAdjustments':
      return { ...state, adjustments: action.adjustments, adjustmentAmountText: action.adjustmentAmountText }

    case 'clearAdjustments':
      return { ...state, adjustments: [], adjustmentAmountText: {} }
  }
}

// ─── Init from edit target ────────────────────────────────────────

function initMoneyDraft(editTarget: Expense | null, tripCurrency: string): MoneyDraftState {
  // Foreign-edit branch: the persisted shape carries sourceCurrency +
  // sourceAmountMinor, so the amount input shows the SOURCE-side value the
  // user originally typed rather than the materialized trip-currency one.
  const isForeignEdit = editTarget?.sourceCurrency !== undefined
  const amountText = editTarget
    ? (isForeignEdit
        ? formatMinorForInput(editTarget.sourceAmountMinor!, editTarget.sourceCurrency!)
        : formatMinorForInput(editTarget.amountMinor, editTarget.currency))
    : ''

  // Foreign edits seed adjustments from the source-domain mirror; others
  // from the trip-currency adjustments.
  const adjustments: ExpenseAdjustment[] = editTarget?.sourceAdjustments !== undefined
    ? editTarget.sourceAdjustments.map(sa =>
        sa.scope === 'ITEM'
          ? {
              id:           sa.id,
              label:        sa.label,
              kind:         sa.kind,
              scope:        'ITEM' as const,
              amountMinor:  sa.sourceAmountMinor,
              targetItemId: sa.targetItemId!,
            }
          : {
              id:          sa.id,
              label:       sa.label,
              kind:        sa.kind,
              scope:       'EXPENSE' as const,
              amountMinor: sa.sourceAmountMinor,
            },
      )
    : (editTarget?.adjustments ?? [])

  const sourceCurrency = editTarget?.sourceCurrency ?? tripCurrency
  const effectiveCurrency = sourceCurrency

  const adjustmentAmountText = Object.fromEntries(
    adjustments.map(adj => [
      adj.id,
      adj.amountMinor > 0 ? formatMinorForInput(adj.amountMinor, effectiveCurrency) : '',
    ]),
  )

  const lastForeignCurrency =
    editTarget?.sourceCurrency && editTarget.sourceCurrency !== tripCurrency
      ? editTarget.sourceCurrency
      : defaultForeignCurrencyFor(tripCurrency)

  return { sourceCurrency, amountText, adjustments, adjustmentAmountText, lastForeignCurrency }
}

// ─── Hook ─────────────────────────────────────────────────────────

export interface UseExpenseMoneyDraftResult {
  sourceCurrency:      string
  amountText:          string
  adjustments:         ExpenseAdjustment[]
  lastForeignCurrency: string
  setAmountText:       (text: string) => void
  /** SINGLE 「切換幣別」 transition. Renormalizes the owned slices in one
   *  dispatch and returns the renormalized `items` + `customSplits` for the
   *  caller to apply to the sibling hooks. No-op (returns external verbatim)
   *  when `next` equals the current source currency. */
  switchCurrency: (
    next:     string,
    external: { items: FormItem[]; customSplits: Record<string, string> },
  ) => { items: FormItem[]; customSplits: Record<string, string> }
  addAdjustment:        () => void
  removeAdjustment:     (id: string) => void
  /** Drop ITEM-scope adjustments whose target item was just removed. */
  dropAdjustmentsForItem: (itemId: string) => void
  setAdjustmentKind:    (id: string, kind: ExpenseAdjustmentKind) => void
  setAdjustmentLabel:   (id: string, label: string) => void
  setAdjustmentAmount:  (id: string, value: string) => void
  setAdjustmentScope:   (id: string, scope: ExpenseAdjustmentScope, itemIds: string[]) => void
  setAdjustmentTarget:  (id: string, targetItemId: string) => void
  /** Inflight text for an adjustment row (typed value, else the formatted
   *  minor amount under the effective currency). */
  adjustmentAmountValue: (adj: ExpenseAdjustment) => string
  /** Replace adjustments wholesale (OCR result lands). */
  resetAdjustments:     (adjustments: ExpenseAdjustment[], adjustmentAmountText: Record<string, string>) => void
  /** Empty adjustments (receipt removed). */
  clearAdjustments:     () => void
}

export function useExpenseMoneyDraft(
  editTarget:   Expense | null,
  tripCurrency: string,
): UseExpenseMoneyDraftResult {
  const [state, dispatch] = useReducer(reducer, undefined, () => initMoneyDraft(editTarget, tripCurrency))

  // `currency` alias: foreign-open ⇔ sourceCurrency !== tripCurrency; when
  // closed they're equal, so this is just sourceCurrency. Adjustment money
  // parse / format routes through it (matches the modal's old `currency`).
  const effectiveCurrency = state.sourceCurrency

  function switchCurrency(
    next:     string,
    external: { items: FormItem[]; customSplits: Record<string, string> },
  ): { items: FormItem[]; customSplits: Record<string, string> } {
    if (next === state.sourceCurrency) return external
    const renorm = renormalizeMoneyDraftForCurrency({
      oldCurrency:          state.sourceCurrency,
      nextCurrency:         next,
      amountText:           state.amountText,
      items:                external.items,
      adjustments:          state.adjustments,
      adjustmentAmountText: state.adjustmentAmountText,
      customSplits:         external.customSplits,
    })
    dispatch({
      kind:         'switchCurrency',
      next,
      tripCurrency,
      renorm: {
        amountText:           renorm.amountText,
        adjustments:          renorm.adjustments,
        adjustmentAmountText: renorm.adjustmentAmountText,
      },
    })
    return { items: renorm.items, customSplits: renorm.customSplits }
  }

  function adjustmentAmountValue(adj: ExpenseAdjustment): string {
    const inFlight = state.adjustmentAmountText[adj.id]
    if (inFlight !== undefined) return inFlight
    return adj.amountMinor > 0 ? formatMinorForInput(adj.amountMinor, effectiveCurrency) : ''
  }

  function setAdjustmentAmount(id: string, value: string): void {
    let minor = 0
    if (value.trim() !== '') {
      try { minor = Math.max(0, parseMoneyToMinor(value, effectiveCurrency)) }
      catch { minor = 0 }
    }
    dispatch({ kind: 'setAdjustmentAmount', id, value, minor })
  }

  return {
    sourceCurrency:      state.sourceCurrency,
    amountText:          state.amountText,
    adjustments:         state.adjustments,
    lastForeignCurrency: state.lastForeignCurrency,
    setAmountText:       text => dispatch({ kind: 'setAmountText', text }),
    switchCurrency,
    addAdjustment:       () => dispatch({ kind: 'addAdjustment', id: crypto.randomUUID() }),
    removeAdjustment:    id => dispatch({ kind: 'removeAdjustment', id }),
    dropAdjustmentsForItem: itemId => dispatch({ kind: 'dropAdjustmentsForItem', itemId }),
    setAdjustmentKind:   (id, kind)  => dispatch({ kind: 'setAdjustmentKind', id, value: kind }),
    setAdjustmentLabel:  (id, label) => dispatch({ kind: 'setAdjustmentLabel', id, value: label }),
    setAdjustmentAmount,
    setAdjustmentScope:  (id, scope, itemIds) => dispatch({ kind: 'setAdjustmentScope', id, scope, itemIds }),
    setAdjustmentTarget: (id, targetItemId)   => dispatch({ kind: 'setAdjustmentTarget', id, targetItemId }),
    adjustmentAmountValue,
    resetAdjustments:    (adjustments, adjustmentAmountText) => dispatch({ kind: 'resetAdjustments', adjustments, adjustmentAmountText }),
    clearAdjustments:    () => dispatch({ kind: 'clearAdjustments' }),
  }
}
