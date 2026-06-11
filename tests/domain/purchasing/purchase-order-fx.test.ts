import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE,
  resolvePurchaseOrderFxRateToBase,
} from '@/lib/domain/purchasing/purchase-order-fx'

function createClient(rate: number | null) {
  return {
    fxRate: {
      findFirst: async () => rate == null
        ? null
        : { rate, fetchedAt: new Date('2026-06-10T00:00:00.000Z') },
    },
  }
}

test('purchase-order FX resolver defaults to the latest stored rate when input is missing', async () => {
  const resolved = await resolvePurchaseOrderFxRateToBase(createClient(1.18) as never, {
    currency: 'EUR',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-11T00:00:00.000Z'),
    inputRateToBase: undefined,
  })

  assert.equal(resolved, 1.18)
})

test('purchase-order FX resolver accepts manual overrides inside the tolerance band', async () => {
  const resolved = await resolvePurchaseOrderFxRateToBase(createClient(1.18) as never, {
    currency: 'EUR',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-11T00:00:00.000Z'),
    inputRateToBase: 1.18 * (1 + PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE - 0.0001),
  })

  assert.equal(resolved, 1.18 * (1 + PURCHASE_ORDER_FX_OVERRIDE_TOLERANCE - 0.0001))
})

test('purchase-order FX resolver rejects stale or mistyped manual overrides outside the tolerance band', async () => {
  await assert.rejects(
    () => resolvePurchaseOrderFxRateToBase(createClient(1.18) as never, {
      currency: 'EUR',
      baseCurrency: 'GBP',
      asOf: new Date('2026-06-11T00:00:00.000Z'),
      inputRateToBase: 1.40,
    }),
    /differs by 18\.64% from the latest GBP rate 1\.18/,
  )
})

test('purchase-order FX resolver requires a stored non-base-currency rate', async () => {
  await assert.rejects(
    () => resolvePurchaseOrderFxRateToBase(createClient(null) as never, {
      currency: 'EUR',
      baseCurrency: 'GBP',
      asOf: new Date('2026-06-11T00:00:00.000Z'),
    }),
    /Missing GBP FX rate for EUR on or before 2026-06-11/,
  )
})

test('purchase-order FX resolver forces base-currency purchase orders to rate 1', async () => {
  const resolved = await resolvePurchaseOrderFxRateToBase(createClient(1.18) as never, {
    currency: 'GBP',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-11T00:00:00.000Z'),
    inputRateToBase: 1.40,
  })

  assert.equal(resolved, 1)
})
