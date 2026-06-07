import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRealisedFxJournal, computeRealisedFx, resolveSettlementFxRateToBase, reverseJournalLines } from '../lib/accounting-fx.ts'

test('computes realised FX loss on customer payment when settlement base is below booked AR', () => {
  const result = computeRealisedFx({
    side: 'receivable',
    amountForeign: 100,
    bookedRateToBase: 1.25,
    settlementRateToBase: 1.5,
  })

  assert.deepEqual(result, {
    bookedBase: 80,
    settlementBase: 66.67,
    gainLossBase: -13.33,
    outcome: 'loss',
  })
})

test('computes realised FX gain on supplier payment when settlement base is below booked AP', () => {
  const result = computeRealisedFx({
    side: 'payable',
    amountForeign: 100,
    bookedRateToBase: 1.25,
    settlementRateToBase: 1.5,
  })

  assert.deepEqual(result, {
    bookedBase: 80,
    settlementBase: 66.67,
    gainLossBase: 13.33,
    outcome: 'gain',
  })
})

test('computes realised FX outcomes for receivable and payable worked examples', () => {
  const cases = [
    {
      name: 'AR gain',
      side: 'receivable' as const,
      bookedRateToBase: 1.5,
      settlementRateToBase: 1.25,
      expected: { bookedBase: 66.67, settlementBase: 80, gainLossBase: 13.33, outcome: 'gain' },
    },
    {
      name: 'AR loss',
      side: 'receivable' as const,
      bookedRateToBase: 1.25,
      settlementRateToBase: 1.5,
      expected: { bookedBase: 80, settlementBase: 66.67, gainLossBase: -13.33, outcome: 'loss' },
    },
    {
      name: 'AP gain',
      side: 'payable' as const,
      bookedRateToBase: 1.25,
      settlementRateToBase: 1.5,
      expected: { bookedBase: 80, settlementBase: 66.67, gainLossBase: 13.33, outcome: 'gain' },
    },
    {
      name: 'AP loss',
      side: 'payable' as const,
      bookedRateToBase: 1.5,
      settlementRateToBase: 1.25,
      expected: { bookedBase: 66.67, settlementBase: 80, gainLossBase: -13.33, outcome: 'loss' },
    },
  ]

  for (const entry of cases) {
    assert.deepEqual(
      computeRealisedFx({
        side: entry.side,
        amountForeign: 100,
        bookedRateToBase: entry.bookedRateToBase,
        settlementRateToBase: entry.settlementRateToBase,
      }),
      entry.expected,
      entry.name,
    )
  }
})

test('builds a balanced control-account journal for realised FX gains', () => {
  const lines = buildRealisedFxJournal({
    side: 'payable',
    gainLossBase: 13.33,
    controlAccount: '800',
    fxGainLossAccount: '498',
    description: 'Realised FX gain',
  })

  assert.deepEqual(lines, [
    { accountCode: '800', description: 'Realised FX gain', debit: 13.33, credit: 0 },
    { accountCode: '498', description: 'Realised FX gain', debit: 0, credit: 13.33 },
  ])
})

test('builds a balanced FX-expense journal for realised FX losses', () => {
  const lines = buildRealisedFxJournal({
    side: 'receivable',
    gainLossBase: -13.33,
    controlAccount: '610',
    fxGainLossAccount: '498',
    description: 'Realised FX loss',
  })

  assert.deepEqual(lines, [
    { accountCode: '610', description: 'Realised FX loss', debit: 0, credit: 13.33 },
    { accountCode: '498', description: 'Realised FX loss', debit: 13.33, credit: 0 },
  ])
})

test('reverses prior unrealised FX journal lines by swapping debits and credits', () => {
  const reversed = reverseJournalLines([
    { accountCode: '610', description: 'Unrealised FX gain on INV-1', debit: 12.34, credit: 0 },
    { accountCode: '498', description: 'Unrealised FX gain on INV-1', debit: 0, credit: 12.34 },
  ], '(reversal for 2026-04-30)')

  assert.deepEqual(reversed, [
    { accountCode: '610', description: 'Unrealised FX gain on INV-1 (reversal for 2026-04-30)', debit: 0, credit: 12.34, taxType: undefined },
    { accountCode: '498', description: 'Unrealised FX gain on INV-1 (reversal for 2026-04-30)', debit: 12.34, credit: 0, taxType: undefined },
  ])
})

test('settlement FX resolver logs when falling back to the booked rate', async () => {
  const activityLogs: unknown[] = []
  const tx = {
    fxRate: {
      findFirst: async () => null,
    },
    activityLog: {
      create: async (args: unknown) => {
        activityLogs.push(args)
      },
    },
  }

  const rate = await resolveSettlementFxRateToBase(tx as never, {
    currency: 'USD',
    baseCurrency: 'GBP',
    asOf: new Date('2026-01-15T12:00:00.000Z'),
    fallbackRateToBase: 1.25,
    referenceType: 'Payment',
    referenceId: 'payment-1',
  })

  assert.equal(rate, 1.25)
  assert.equal(activityLogs.length, 1)
  assert.deepEqual(activityLogs[0], {
    data: {
      entityType: 'SYSTEM',
      entityId: 'payment-1',
      action: 'fx_rate_fallback_used',
      tag: 'accounting',
      level: 'WARNING',
      description: 'Used fallback FX rate for USD settlement on 2026-01-15',
      metadata: {
        currency: 'USD',
        baseCurrency: 'GBP',
        settlementDate: '2026-01-15',
        fallbackRateToBase: 1.25,
        referenceType: 'Payment',
        referenceId: 'payment-1',
      },
    },
  })
})
