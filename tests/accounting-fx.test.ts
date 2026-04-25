import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRealisedFxJournal, computeRealisedFx } from '../lib/accounting-fx.ts'

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
