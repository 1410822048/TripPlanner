// Unit tests for settlement-fx-write.ts — the foreign-currency domain of
// settlement-create. Two halves, matching the network/pure split the
// orchestrator relies on:
//   - resolveForeignRate (NETWORK): same-currency reject, null-rate
//     fail-closed, and the resolved rate + fraction-digit context. Tested
//     with resolveFxRate mocked (the same seam settlement-write.spec uses).
//   - deriveForeignArtifacts (PURE-CPU) + encodeFxSnapshot: at-most-target
//     source derivation (convertedAmountMinor ≤ remaining, NEVER overshoots)
//     and the persisted fxSnapshot map shape. Run against the REAL fx-core
//     math so a rounding-direction regression is caught here, not only in
//     the heavier settlement-write integration suite.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { defaultResolveFxRateImpl } = vi.hoisted(() => ({
  defaultResolveFxRateImpl: async (input: import('../src/fx-rate').ResolveFxRateInput) => ({
    rateDate:    input.requestedDate,
    rateDecimal: '150',
    fetchedAtMs: 1_700_000_000_000,
  }),
}))

vi.mock('../src/fx-rate', async () => {
  const actual = await vi.importActual<typeof import('../src/fx-rate')>('../src/fx-rate')
  return { ...actual, resolveFxRate: vi.fn(defaultResolveFxRateImpl) }
})

import {
  resolveForeignRate,
  deriveForeignArtifacts,
  encodeFxSnapshot,
  type ForeignRate,
} from '../src/settlement-fx-write'
import { SettlementValidationError } from '../src/settlement-write-shared'
import type { SettlementCreateForeignRequest } from '../src/settlement-write-shared'
import { CascadeError } from '../src/cascade'
import * as fxRate from '../src/fx-rate'
import type { FxSnapshot } from '../src/fx-rate'

const SA_JSON = 'service-account-json'

// A full FOREIGN_CURRENCY request; resolveForeignRate / deriveForeignArtifacts
// only read sourceCurrency + settledOn, but typing it fully keeps the
// fixtures honest against the real schema-inferred shape.
function foreignReq(over: { sourceCurrency: string; settledOn: string }): SettlementCreateForeignRequest {
  return {
    mode:                   'FOREIGN_CURRENCY',
    tripId:                 'trip-1',
    settlementId:           'settle-1',
    fromUid:                'from-uid',
    toUid:                  'to-uid',
    expectedRemainingMinor: 15000,
    sourceCurrency:         over.sourceCurrency,
    settledOn:              over.settledOn,
  }
}

beforeEach(() => {
  vi.mocked(fxRate.resolveFxRate).mockReset()
  vi.mocked(fxRate.resolveFxRate).mockImplementation(defaultResolveFxRateImpl)
})

// ─── resolveForeignRate (NETWORK half) ────────────────────────────

describe('resolveForeignRate', () => {
  it('rejects same-currency BEFORE touching the FX provider', async () => {
    await expect(
      resolveForeignRate(foreignReq({ sourceCurrency: 'JPY', settledOn: '2026-06-01' }), { currency: 'JPY' }, SA_JSON),
    ).rejects.toBeInstanceOf(SettlementValidationError)
    await expect(
      resolveForeignRate(foreignReq({ sourceCurrency: 'JPY', settledOn: '2026-06-01' }), { currency: 'JPY' }, SA_JSON),
    ).rejects.toMatchObject({ field: 'sourceCurrency' })
    expect(fxRate.resolveFxRate).not.toHaveBeenCalled()
  })

  it('resolves the rate + fraction digits and forwards the exact FX query', async () => {
    const fr = await resolveForeignRate(
      foreignReq({ sourceCurrency: 'USD', settledOn: '2026-06-01' }),
      { currency: 'JPY' },
      SA_JSON,
    )
    expect(fr.rate).toEqual({ rateDate: '2026-06-01', rateDecimal: '150', fetchedAtMs: 1_700_000_000_000 })
    expect(fr.sourceFractionDigits).toBe(2)   // USD
    expect(fr.targetFractionDigits).toBe(0)   // JPY
    expect(fxRate.resolveFxRate).toHaveBeenCalledWith(
      { requestedDate: '2026-06-01', sourceCurrency: 'USD', tripCurrency: 'JPY' },
      SA_JSON,
    )
  })

  it('fails closed with CascadeError 500 when resolveFxRate returns null for a cross-currency pair', async () => {
    vi.mocked(fxRate.resolveFxRate).mockResolvedValueOnce(null)
    await expect(
      resolveForeignRate(foreignReq({ sourceCurrency: 'USD', settledOn: '2026-06-01' }), { currency: 'JPY' }, SA_JSON),
    ).rejects.toMatchObject({ status: 500 })
  })
})

// ─── deriveForeignArtifacts (PURE-CPU half) ───────────────────────

describe('deriveForeignArtifacts', () => {
  const ctx = { currency: 'JPY' }
  // USD (2 digits) → JPY (0 digits) at 1 USD = 150 JPY.
  const fr: ForeignRate = {
    rate:                 { rateDate: '2026-06-01', rateDecimal: '150', fetchedAtMs: 1_700_000_000_000 },
    sourceFractionDigits: 2,
    targetFractionDigits: 0,
  }

  it('derives the at-most-target source amount + forward-converted audit + full snapshot', () => {
    const art = deriveForeignArtifacts(
      foreignReq({ sourceCurrency: 'USD', settledOn: '2026-06-01' }), ctx, 15_000, fr,
    )
    expect(art.sourceAmountMinor).toBe(10_000)             // $100.00 → ¥15000 exactly
    expect(art.sourceCurrency).toBe('USD')
    expect(art.settledOn).toBe('2026-06-01')
    expect(art.fxSnapshot).toEqual({
      provider:             'frankfurter-v2',
      baseCurrency:         'USD',
      quoteCurrency:        'JPY',
      requestedDate:        '2026-06-01',
      rateDate:             '2026-06-01',
      rateDecimal:          '150',
      sourceAmountMinor:    10_000,
      convertedAmountMinor: 15_000,
      fetchedAtMs:          1_700_000_000_000,
    })
  })

  it('NEVER overshoots: on a rounding-plateau remaining the converted amount stays ≤ remaining', () => {
    // remaining 15001: $100.00→¥15000 (≤), $100.01→¥15001.5→half-even 15002 (>).
    // So the source stays at 10000 and the forward stays at 15000 ≤ 15001.
    const art = deriveForeignArtifacts(
      foreignReq({ sourceCurrency: 'USD', settledOn: '2026-06-01' }), ctx, 15_001, fr,
    )
    expect(art.sourceAmountMinor).toBe(10_000)
    expect(art.fxSnapshot.convertedAmountMinor).toBe(15_000)
    expect(art.fxSnapshot.convertedAmountMinor).toBeLessThanOrEqual(15_001)
  })

  it('returns sourceAmountMinor 0 when remaining is too small for one source unit (caller rejects)', () => {
    const art = deriveForeignArtifacts(
      foreignReq({ sourceCurrency: 'USD', settledOn: '2026-06-01' }), ctx, 1, fr,
    )
    expect(art.sourceAmountMinor).toBe(0)
    expect(art.fxSnapshot.convertedAmountMinor).toBe(0)
  })
})

// ─── encodeFxSnapshot ─────────────────────────────────────────────

describe('encodeFxSnapshot', () => {
  it('encodes all nine fields, integers as strings, fetchedAt as null (REQUEST_TIME stamped by caller)', () => {
    const fx: FxSnapshot = {
      provider:             'frankfurter-v2',
      baseCurrency:         'USD',
      quoteCurrency:        'JPY',
      requestedDate:        '2026-06-01',
      rateDate:             '2026-06-01',
      rateDecimal:          '150',
      sourceAmountMinor:    10_000,
      convertedAmountMinor: 15_000,
      fetchedAtMs:          1_700_000_000_000,
    }
    expect(encodeFxSnapshot(fx)).toEqual({
      mapValue: {
        fields: {
          provider:             { stringValue:  'frankfurter-v2' },
          baseCurrency:         { stringValue:  'USD' },
          quoteCurrency:        { stringValue:  'JPY' },
          requestedDate:        { stringValue:  '2026-06-01' },
          rateDate:             { stringValue:  '2026-06-01' },
          rateDecimal:          { stringValue:  '150' },
          sourceAmountMinor:    { integerValue: '10000' },
          convertedAmountMinor: { integerValue: '15000' },
          fetchedAt:            { nullValue:    null },
        },
      },
    })
  })
})
