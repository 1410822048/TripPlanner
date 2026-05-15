// src/hooks/useTripCurrency.ts
// Read the active trip's currency code without threading it through
// props. Wraps useTripContext so callers (ExpensePage, SettlementSummary,
// TimelineCard, etc.) can format amounts via formatAmount(n, code)
// without each one re-deriving the source.
//
// Status fallbacks:
//   - cloud: ctx.trip.currency (always set per schema default 'TWD')
//   - demo:  ctx.trip.currency (TripItem carries it from mocks)
//   - loading / no-trip: DEFAULT_CURRENCY ('JPY') — the value is only
//     read when something is actually being rendered, and rendering
//     pre-trip means we have nothing meaningful to format anyway.
import { useTripContext } from './useTripContext'
import { DEFAULT_CURRENCY } from '@/utils/currency'

export function useTripCurrency(): string {
  const ctx = useTripContext()
  if (ctx.status === 'cloud') return ctx.trip.currency || DEFAULT_CURRENCY
  if (ctx.status === 'demo')  return ctx.trip.currency || DEFAULT_CURRENCY
  return DEFAULT_CURRENCY
}
