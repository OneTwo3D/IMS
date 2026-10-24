import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  MissingStoredFxRateError,
  requireStoredFxRateToBase,
  resolveStoredFxRateToBase,
  usableStoredFxRate,
} from '@/lib/currencies/stored-document-rate'

const GBP = 'GBP'

test('a usable stored rate is the answer (a foreign document is converted at the rate it was booked at)', () => {
  assert.equal(requireStoredFxRateToBase({ currency: 'USD', baseCurrency: GBP, storedRate: new Prisma.Decimal('1.25'), document: 'Order SO-1' }).toString(), '1.25')
  assert.equal(requireStoredFxRateToBase({ currency: 'USD', baseCurrency: GBP, storedRate: 1.25, document: 'Order SO-1' }).toString(), '1.25')
  assert.equal(requireStoredFxRateToBase({ currency: 'USD', baseCurrency: GBP, storedRate: '1.25', document: 'Order SO-1' }).toString(), '1.25')
})

test('a FOREIGN document with a missing or unusable stored rate refuses by name - never 1', () => {
  for (const storedRate of [null, undefined, 0, -1, '0', 'abc', Number.NaN, Number.POSITIVE_INFINITY, new Prisma.Decimal(0), true as unknown as number]) {
    assert.throws(
      () => requireStoredFxRateToBase({ currency: 'USD', baseCurrency: GBP, storedRate, document: 'Order SO-7' }),
      (error: unknown) => error instanceof MissingStoredFxRateError
        && error.currency === 'USD' && error.baseCurrency === 'GBP' && error.document === 'Order SO-7'
        && /Order SO-7 is in USD but has no usable stored FX rate to GBP/.test(error.message)
        && /correct the document/.test(error.message),
      String(storedRate),
    )
  }
})

test('a BASE-currency document with no usable stored rate is 1 because currency === base (case and spaces ignored)', () => {
  for (const currency of ['GBP', 'gbp', ' GBP ']) {
    assert.equal(requireStoredFxRateToBase({ currency, baseCurrency: GBP, storedRate: null, document: 'Order SO-1' }).toString(), '1')
    assert.equal(requireStoredFxRateToBase({ currency, baseCurrency: GBP, storedRate: 0, document: 'Order SO-1' }).toString(), '1')
  }
})

test('an EMPTY or missing document currency is not the base currency: it refuses (even if the base is empty too)', () => {
  for (const currency of ['', '  ', null, undefined]) {
    assert.throws(() => requireStoredFxRateToBase({ currency, baseCurrency: GBP, storedRate: null, document: 'Order SO-1' }), MissingStoredFxRateError)
    assert.throws(() => requireStoredFxRateToBase({ currency, baseCurrency: '', storedRate: null, document: 'Order SO-1' }), MissingStoredFxRateError)
  }
})

test('usableStoredFxRate: only finite numbers greater than zero', () => {
  assert.equal(usableStoredFxRate('0.0001')?.toString(), '0.0001')
  for (const value of [null, undefined, 0, -0.5, 'x', Number.NaN]) assert.equal(usableStoredFxRate(value as never), null)
})

test('resolveStoredFxRateToBase reads the base currency only when the stored rate is unusable', async () => {
  let reads = 0
  const baseCurrency = async () => { reads++; return GBP }
  assert.equal((await resolveStoredFxRateToBase({ currency: 'USD', baseCurrency, storedRate: 1.25, document: 'Order SO-1' })).toString(), '1.25')
  assert.equal(reads, 0)
  assert.equal((await resolveStoredFxRateToBase({ currency: 'GBP', baseCurrency, storedRate: 0, document: 'Order SO-1' })).toString(), '1')
  assert.equal(reads, 1)
  await assert.rejects(resolveStoredFxRateToBase({ currency: 'USD', baseCurrency, storedRate: 0, document: 'Order SO-1' }), MissingStoredFxRateError)
  assert.equal(reads, 2)
})
