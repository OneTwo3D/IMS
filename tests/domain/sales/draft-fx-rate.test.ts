import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveFxRateToBase } from '@/lib/domain/sales/draft-fx-rate'
import { fakeFxClient } from '@/tests/helpers/fx-fake-client'

const rows = [
  { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.10', fetchedAt: new Date('2026-06-01T00:00:00Z') },
  { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.20', fetchedAt: new Date('2026-06-10T00:00:00Z') },
]

test('draft-order FX: the base currency (any case/padding) and an empty currency are 1 without a lookup', async () => {
  const c = fakeFxClient(rows)
  assert.equal(await resolveFxRateToBase(c as never, ' gbp ', 'GBP', new Date()), 1)
  assert.equal(await resolveFxRateToBase(c as never, '', 'GBP', new Date()), 1)
  assert.equal(c.calls.length, 0)
})

test('draft-order FX: the latest stored rate on or before asOf, as a number', async () => {
  const c = fakeFxClient(rows)
  assert.equal(await resolveFxRateToBase(c as never, 'eur', 'gbp', new Date('2026-06-05T00:00:00Z')), 1.1)
  assert.equal(await resolveFxRateToBase(c as never, 'EUR', 'GBP', new Date('2026-06-10T00:00:00Z')), 1.2)
})

test('draft-order FX: a missing rate still throws, with the historic message', async () => {
  await assert.rejects(
    resolveFxRateToBase(fakeFxClient(rows) as never, 'USD', 'GBP', new Date('2026-06-05T00:00:00Z')),
    { message: 'Missing GBP FX rate for USD on or before 2026-06-05' },
  )
  await assert.rejects(
    resolveFxRateToBase(fakeFxClient(rows) as never, 'EUR', 'GBP', new Date('2026-05-05T00:00:00Z')),
    { message: 'Missing GBP FX rate for EUR on or before 2026-05-05' },
  )
})

test('draft-order FX: a non-GBP base reads that base\'s rows', async () => {
  const c = fakeFxClient([{ fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.08', fetchedAt: new Date('2026-06-01T00:00:00Z') }], 'EUR')
  assert.equal(await resolveFxRateToBase(c as never, 'USD', 'EUR', new Date('2026-06-05T00:00:00Z')), 1.08)
})
