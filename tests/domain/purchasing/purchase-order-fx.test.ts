import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  PURCHASE_ORDER_FX_OVERRIDE_REJECT_THRESHOLD,
  PURCHASE_ORDER_FX_OVERRIDE_WARNING_THRESHOLD,
  evaluatePurchaseOrderFxRateOverride,
  resolvePurchaseOrderFxRateToBase,
  shouldResolvePurchaseOrderFxRate,
} from '@/lib/domain/purchasing/purchase-order-fx'

function fxClient(rate: number | null) {
  const calls: unknown[] = []
  return {
    calls,
    fxRate: {
      async findFirst(args: Prisma.FxRateFindFirstArgs) {
        calls.push(args)
        return rate == null ? null : { rate: new Prisma.Decimal(rate) }
      },
    },
  }
}

test('base-currency purchase orders always use rate 1', async () => {
  const client = fxClient(1.2)
  const result = await resolvePurchaseOrderFxRateToBase(client, {
    currency: 'gbp',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-07T10:00:00Z'),
    manualRateToBase: 1.4,
  })

  assert.equal(result.fxRateToBase, 1)
  assert.equal(result.source, 'base-currency')
  assert.equal(client.calls.length, 0)
})

test('defaults non-base purchase orders to the latest stored rate on or before the PO date', async () => {
  const client = fxClient(1.17)
  const asOf = new Date('2026-06-07T10:00:00Z')
  const result = await resolvePurchaseOrderFxRateToBase(client, {
    currency: 'eur',
    baseCurrency: 'gbp',
    asOf,
    manualRateToBase: null,
  })

  assert.equal(result.fxRateToBase, 1.17)
  assert.equal(result.source, 'stored-rate')
  assert.deepEqual(client.calls[0], {
    where: {
      fromCurrency: 'GBP',
      toCurrency: 'EUR',
      fetchedAt: { lte: asOf },
    },
    orderBy: { fetchedAt: 'desc' },
    select: { rate: true },
  })
})

test('allows manual overrides inside the warning band without an audit warning', async () => {
  const client = fxClient(1.2)
  const result = await resolvePurchaseOrderFxRateToBase(client, {
    currency: 'USD',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-07T10:00:00Z'),
    manualRateToBase: 1.21,
  })

  assert.equal(result.fxRateToBase, 1.21)
  assert.equal(result.source, 'manual-override')
  assert.equal(result.warning, null)
})

test('treats near-equivalent manual rates as stored-rate source', async () => {
  const client = fxClient(1.2)
  const result = await resolvePurchaseOrderFxRateToBase(client, {
    currency: 'USD',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-07T10:00:00Z'),
    manualRateToBase: 1.20000001,
  })

  assert.equal(result.fxRateToBase, 1.20000001)
  assert.equal(result.source, 'stored-rate')
  assert.equal(result.warning, null)
})

test('allows but warns on manual overrides above one percent', async () => {
  const client = fxClient(1.2)
  const result = await resolvePurchaseOrderFxRateToBase(client, {
    currency: 'USD',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-07T10:00:00Z'),
    manualRateToBase: 1.25,
  })

  assert.equal(result.fxRateToBase, 1.25)
  assert.equal(result.source, 'manual-override')
  assert.equal(result.warning?.code, 'purchase_order_fx_override_delta')
  assert.equal(result.warning?.warningThresholdPercent, PURCHASE_ORDER_FX_OVERRIDE_WARNING_THRESHOLD)
})

test('rejects manual overrides outside the sanity band', async () => {
  const client = fxClient(1.2)
  await assert.rejects(
    () => resolvePurchaseOrderFxRateToBase(client, {
      currency: 'USD',
      baseCurrency: 'GBP',
      asOf: new Date('2026-06-07T10:00:00Z'),
      manualRateToBase: 1.4,
      rejectThreshold: PURCHASE_ORDER_FX_OVERRIDE_REJECT_THRESHOLD,
    }),
    /as of 2026-06-07/,
  )
})

test('requires a stored rate before saving a non-base purchase order', async () => {
  const client = fxClient(null)
  await assert.rejects(
    () => resolvePurchaseOrderFxRateToBase(client, {
      currency: 'EUR',
      baseCurrency: 'GBP',
      asOf: new Date('2026-06-07T10:00:00Z'),
      manualRateToBase: 1.17,
    }),
    /Missing GBP FX rate for EUR/,
  )
})

test('shared evaluator returns the operator-facing reject message', () => {
  const result = evaluatePurchaseOrderFxRateOverride({
    currency: 'USD',
    baseCurrency: 'GBP',
    asOf: new Date('2026-06-07T10:00:00Z'),
    referenceRateToBase: 1.2,
    manualRateToBase: 1.4,
  })

  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.error, /FX rate 1\.4000/)
  assert.match(result.ok ? '' : result.error, /stored GBP->USD rate 1\.2000/)
  assert.match(result.ok ? '' : result.error, /as of 2026-06-07/)
  assert.match(result.ok ? '' : result.error, /within 5%/)
})

test('purchase-order edit FX resolution is skipped only when currency and rate are unchanged', () => {
  assert.equal(shouldResolvePurchaseOrderFxRate({
    existingCurrency: 'USD',
    existingRateToBase: 1.2,
    inputCurrency: 'USD',
    inputRateToBase: 1.2,
  }), false)
  assert.equal(shouldResolvePurchaseOrderFxRate({
    existingCurrency: 'USD',
    existingRateToBase: 1.2,
    inputCurrency: 'EUR',
    inputRateToBase: 1.2,
  }), true)
  assert.equal(shouldResolvePurchaseOrderFxRate({
    existingCurrency: 'USD',
    existingRateToBase: 1.2,
    inputCurrency: 'USD',
    inputRateToBase: 1.25,
  }), true)
})
