import assert from 'node:assert/strict'
import test from 'node:test'
import { fakeFxClient } from './helpers/fx-fake-client.ts'
import { buildRealisedFxJournal, computeRealisedFx, describeFxRefusal, resolveSettlementFxRateToBase, explicitSettlementInstant, reverseJournalLines, settlementAsOfFromInput, settlementAsOfFromStored } from '../lib/accounting-fx.ts'

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

test('uses the explicit booked base (stored carrying value) instead of recomputing it (scjz.55)', () => {
  // Stored AR base was 80.0000; recomputing 100/1.25 also gives 80 here, but pass an
  // explicit booked base that differs (e.g. 4dp carrying value 79.99) to prove it is
  // used as the booked leg rather than the freshly-derived figure.
  const result = computeRealisedFx({
    side: 'receivable',
    amountForeign: 100,
    bookedRateToBase: 1.25,
    settlementRateToBase: 1.25,
    bookedBase: 79.99,
  })
  // Settlement leg = 100/1.25 = 80.00; gain vs the real carrying value 79.99 = +0.01.
  assert.equal(result.bookedBase, 79.99)
  assert.equal(result.settlementBase, 80)
  assert.equal(result.gainLossBase, 0.01)
  assert.equal(result.outcome, 'gain')
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

test('settlement FX resolver: a MISSING rate refuses (no fallback to the booked rate, no 1, nothing logged)', async () => {
  const tx = {
    fxRate: fakeFxClient([]).fxRate,
    setting: fakeFxClient([]).setting,
    activityLog: { create: async () => { assert.fail('no fallback may be logged: there is no fallback') } },
  }
  await assert.rejects(
    resolveSettlementFxRateToBase(tx as never, { currency: 'USD', baseCurrency: 'GBP', asOf: new Date('2026-01-15T12:00:00.000Z') }),
    (e: Error & { reason?: string }) => e.name === 'MissingFxRateError' && e.reason === 'no_rate',
  )
})

test('settlement FX resolver: an empty or malformed currency refuses (it is not the base currency, so it is not 1)', async () => {
  for (const currency of ['', '  ', 'US', 'U$D']) {
    await assert.rejects(
      resolveSettlementFxRateToBase(fakeFxClient([]) as never, { currency, baseCurrency: 'GBP', asOf: new Date('2026-01-15T12:00:00.000Z') }),
      (e: Error & { reason?: string }) => e.name === 'MissingFxRateError' && e.reason === 'invalid_currency',
      JSON.stringify(currency),
    )
  }
})

test('settlement FX resolver uses the stored rate on or before the settlement instant', async () => {
  const tx = fakeFxClient([
    { fromCurrency: 'GBP', toCurrency: 'USD', rate: '1.30', fetchedAt: new Date('2026-01-14T00:00:00Z') },
    { fromCurrency: 'GBP', toCurrency: 'USD', rate: '1.40', fetchedAt: new Date('2026-01-16T00:00:00Z') },
  ])
  const rate = await resolveSettlementFxRateToBase(tx as never, {
    currency: ' usd ', baseCurrency: 'gbp', asOf: new Date('2026-01-15T12:00:00.000Z'),
  })
  assert.equal(rate, 1.3)
})

test('settlement FX resolver: base currency is 1 and never reads the table', async () => {
  const c = fakeFxClient([])
  assert.equal(await resolveSettlementFxRateToBase(c as never, { currency: 'GBP', baseCurrency: 'GBP', asOf: new Date() }), 1)
  assert.equal(c.calls.length, 0)
})

test('settlement FX resolver: a tied or non-positive stored rate refuses', async () => {
  for (const rows of [
    [{ rate: '1.30' }, { rate: '1.31' }],
    [{ rate: '0' }],
  ]) {
    const tx = fakeFxClient(rows.map((r) => ({ fromCurrency: 'GBP', toCurrency: 'USD', rate: r.rate, fetchedAt: new Date('2026-01-14T00:00:00Z') })))
    await assert.rejects(resolveSettlementFxRateToBase(tx as never, {
      currency: 'USD', baseCurrency: 'GBP', asOf: new Date('2026-01-15T12:00:00.000Z'),
    }), (e: Error) => e.name === 'MissingFxRateError')
  }
})

test('settlementAsOfFromInput: a date-only string is the END of that UTC day; a timestamp stays an instant', () => {
  const now = new Date('2030-01-01T00:00:00.000Z')
  assert.equal(settlementAsOfFromInput('2026-06-10', now).toISOString(), '2026-06-10T23:59:59.999Z')
  assert.equal(settlementAsOfFromInput('2026-06-10T08:30:00.000Z', now).toISOString(), '2026-06-10T08:30:00.000Z')
  assert.equal(settlementAsOfFromInput(new Date('2026-06-10T00:00:00.000Z'), now).toISOString(), '2026-06-10T00:00:00.000Z')
  assert.equal(settlementAsOfFromInput(undefined, now).toISOString(), now.toISOString())
  assert.equal(settlementAsOfFromInput('', now).toISOString(), now.toISOString())
})

test('settlementAsOfFromStored: exactly-midnight is the stored form of a date-only input; anything else is an instant', () => {
  assert.equal(settlementAsOfFromStored(new Date('2026-06-10T00:00:00.000Z')).toISOString(), '2026-06-10T23:59:59.999Z')
  assert.equal(settlementAsOfFromStored(new Date('2026-06-10T00:00:00.001Z')).toISOString(), '2026-06-10T00:00:00.001Z')
  assert.equal(settlementAsOfFromStored(new Date('2026-06-10T09:00:00.000Z')).toISOString(), '2026-06-10T09:00:00.000Z')
})

test('explicitSettlementInstant: a YYYY-MM-DD input is date-only (null); an explicit instant, midnight included, is kept', () => {
  const midnight = new Date('2026-06-10T00:00:00.000Z')
  assert.equal(explicitSettlementInstant('2026-06-10', midnight), null)
  assert.equal(explicitSettlementInstant('2026-06-10T00:00:00.000Z', midnight)?.getTime(), midnight.getTime())
  assert.equal(explicitSettlementInstant('2026-06-10T00:00:00Z', midnight)?.getTime(), midnight.getTime())
  assert.equal(explicitSettlementInstant(midnight, midnight)?.getTime(), midnight.getTime())
  const now = new Date('2026-06-10T09:30:00.000Z')
  assert.equal(explicitSettlementInstant(undefined, now)?.getTime(), now.getTime(), 'no input means now, an instant')
})

test('settlementAsOfFromStored: an explicit instant at exactly midnight is the instant; stale or absent provenance keeps the date-only reading', () => {
  const midnight = new Date('2026-06-10T00:00:00.000Z')
  assert.equal(settlementAsOfFromStored(midnight, midnight).toISOString(), '2026-06-10T00:00:00.000Z', 'explicit instant: not the end of day')
  assert.equal(settlementAsOfFromStored(midnight, null).toISOString(), '2026-06-10T23:59:59.999Z')
  assert.equal(settlementAsOfFromStored(midnight, undefined).toISOString(), '2026-06-10T23:59:59.999Z')
  assert.equal(settlementAsOfFromStored(midnight, new Date('2026-06-09T00:00:00.000Z')).toISOString(), '2026-06-10T23:59:59.999Z', 'provenance of another instant is no evidence (paidAt changed since)')
  const nine = new Date('2026-06-10T09:00:00.000Z')
  assert.equal(settlementAsOfFromStored(nine, nine).toISOString(), '2026-06-10T09:00:00.000Z')
})

test('describeFxRefusal tells the operator what to do for each kind of refusal', async () => {
  const { MissingFxRateError } = await import('../lib/currencies/fx-lookup.ts')
  const noRate = describeFxRefusal(new MissingFxRateError('Missing GBP FX rate for USD on or before 2026-06-10', 'USD', undefined, 'no_rate', 'GBP'))
  assert.match(noRate, /Settings -> Currencies/)
  assert.match(describeFxRefusal(new MissingFxRateError('Invalid stored GBP FX rate for USD', 'USD', undefined, 'non_positive_rate', 'GBP')), /not a positive number/)
  assert.match(describeFxRefusal(new MissingFxRateError('Ambiguous', 'USD', undefined, 'ambiguous_rate', 'GBP')), /two different rates/)
  assert.match(describeFxRefusal(new MissingFxRateError('Invalid currency code', 'U', undefined, 'invalid_currency', 'GBP')), /currency/)
})
