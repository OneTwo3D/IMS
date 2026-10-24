import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import * as realDiscount from '@/lib/domain/accounting/posted-document-discount'

/**
 * o3d-q0x56.8 - the chargeback's order-discount line is converted at the ORDER'S BOOKED RATE.
 * A foreign order with no usable stored rate is not charged back automatically (it used to divide by 1); an operator
 * is told why, and no refund is created. A base-currency order, and a foreign order with a rate, still go through.
 */

type Row = Record<string, unknown>
const state = {
  order: null as Row | null,
  activity: [] as Array<{ action: string; description?: string; metadata?: Record<string, unknown> }>,
  createRefundCalls: 0,
  refundLines: [] as unknown[],
}

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requirePermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    requireInternalUser: async () => ({ user: { id: 'user-1', email: 'ops@example.com' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string }) => { state.activity.push(entry) },
    redactActivityLogText: (value: string) => value,
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/domain/accounting/posted-document-discount', {
  namedExports: { ...realDiscount, decideChargebackDiscountLine: () => ({ action: 'mirror-discount' }) },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      salesOrderRefund: { findFirst: async () => null },
      salesOrder: { findUnique: async () => state.order },
      accountingEvent: { findFirst: async () => null },
      setting: { findUnique: async () => null, findMany: async () => [] },
    },
  },
})

function order(extra: Row = {}): Row {
  return {
    shippingBase: 0, totalBase: 80, taxBase: 0, discountAmount: 10, currency: 'USD', discountRestatement: null,
    accountingInvoiceId: null, fxRateToBase: 1.25, pricesIncludeVat: false, taxRatePercent: 0,
    orderNumber: 'SO-9', externalOrderNumber: null,
    lines: [{ id: 'l1', productId: 'p1', description: 'Widget', qty: 1, totalBase: 80 }],
    shipments: [], refunds: [],
    ...extra,
  }
}

async function chargeback() {
  const { raiseChargebackForReversedOrder } = await import('@/app/actions/sales')
  const { INTERNAL_ACTION_BYPASS } = await import('@/lib/internal-action-bypass')
  return raiseChargebackForReversedOrder('so-9', { internalBypassToken: INTERNAL_ACTION_BYPASS })
}

test.beforeEach(() => {
  state.activity = []
  state.createRefundCalls = 0
})

test('[q0x56.8] a FOREIGN order with no usable stored rate is not charged back: named manual-handling warning, nothing created', async () => {
  for (const fxRateToBase of [0, -3]) {
    state.order = order({ fxRateToBase })
    state.activity = []
    const result = await chargeback()
    assert.equal(result.raised, false, String(fxRateToBase))
    assert.match(String(result.reason), /no usable stored FX rate .* manual chargeback required/)
    const warning = state.activity.find((a) => a.action === 'chargeback_requires_manual_handling')
    assert.ok(warning, 'the operator is told')
    assert.equal(warning?.metadata?.reason, 'MISSING_STORED_FX_RATE')
    assert.match(String(warning?.description), /Order SO-9 is in USD but has no usable stored FX rate to GBP/)
  }
})

test('[q0x56.8] the same order WITH a stored rate gets past the rate guard (the control: the guard, not something else, refused)', async () => {
  state.order = order({ fxRateToBase: 1.25 })
  const result = await chargeback()
  const warning = state.activity.find((a) => a.action === 'chargeback_requires_manual_handling' && a.metadata?.reason === 'MISSING_STORED_FX_RATE')
  assert.equal(warning, undefined)
  // it went on into the refund transaction, which this double does not model - that is the control
  assert.match(String(result.error), /executeRaw/)
  assert.doesNotMatch(String(result.reason ?? ''), /stored FX rate/)
})

test('[q0x56.8] a BASE-currency order with no usable stored rate gets past the guard (1 by currency)', async () => {
  state.order = order({ currency: 'GBP', fxRateToBase: 0 })
  const result = await chargeback()
  const warning = state.activity.find((a) => a.metadata?.reason === 'MISSING_STORED_FX_RATE')
  assert.equal(warning, undefined)
  // it went on into the refund transaction, which this double does not model - that is the control
  assert.match(String(result.error), /executeRaw/)
  assert.doesNotMatch(String(result.reason ?? ''), /stored FX rate/)
})
