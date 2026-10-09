import assert from 'node:assert/strict'
import test from 'node:test'

import { runWmsOrderPushSweepCore, type WmsOrderPushPort, type WmsPushCandidate } from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderPushInput, WmsOrderPushResult } from '../lib/connectors/wms/types.ts'
import { buildPushPayload } from '../lib/connectors/mintsoft/api/order-push.ts'

/**
 * Store credit is a PAYMENT. The importer keeps it out of `SalesOrder.discountAmount`, so the warehouse is
 * pushed the FULL goods value (customs / IOSS) and no discount for it. This matches the production
 * woo-mintsoft sync plugin, which strips the credit coupon back out of `DiscountTotalExVat` and sends no
 * payment field at all (the credit settles the invoice; Mintsoft is told the full value).
 */

const NOW = () => new Date('2026-06-26T00:00:00.000Z')

function candidate(overrides: Partial<WmsPushCandidate> = {}): WmsPushCandidate {
  return {
    id: 'so-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    currency: 'GBP',
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    customerVatNumber: null,
    shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' },
    shippingService: 'Royal Mail',
    // Goods 100 + VAT 20 = 120 gross; the customer paid 90 in cash and 30 in store credit.
    subtotalForeign: 100,
    shippingForeign: 0,
    taxForeign: 20,
    taxRatePercent: 0.2,
    pricesIncludeVat: false,
    discountAmount: 0,
    storeCreditForeign: 30,
    totalForeign: 90,
    shipFromWarehouseId: 'wh-1',
    pushAttempts: 0,
    lines: [{ sku: 'A', qty: 1, taxForeign: 20, totalForeign: 100, description: 'Widget' }],
    ...overrides,
  }
}

async function pushOnce(order: WmsPushCandidate): Promise<{ input: WmsOrderPushInput; totalMismatchPence: unknown }> {
  const pushed: WmsOrderPushInput[] = []
  const upserts: Array<Record<string, unknown>> = []
  const never = async () => []
  const port = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: never,
    createCandidates: async () => [order],
    revalidatableLinks: async () => ({ links: [], total: 0 }),
    recordValidationFailure: async () => true,
    claimForCreate: async () => 'CLAIMED',
    verifiableLinks: never,
    updatableLinks: never,
    holdableLinks: never,
    cancellableLinks: never,
    upsertByOrder: async (_id: string, create: Record<string, unknown>) => { upserts.push(create) },
    updateLink: async () => {},
    updateLinkIfCreateClaimOwned: async () => true,
    updateLinkIfState: async () => true,
    recordEvent: async () => {},
  } as unknown as WmsOrderPushPort
  const connector = {
    pushOrder: async (input: WmsOrderPushInput): Promise<WmsOrderPushResult> => {
      pushed.push(input)
      return { externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' }
    },
    updateOrder: async () => ({ updated: true, status: 'NEW' }),
    cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
    addOrderComment: undefined,
  }
  await runWmsOrderPushSweepCore(connector as never, 'mintsoft', port, { now: NOW })
  assert.equal(pushed.length, 1, 'precondition: exactly one order was pushed, so the input below was actually examined')
  const created = upserts.find((u) => 'totalMismatchPence' in u)
  assert.ok(created, 'precondition: the link write that records the drift verdict happened')
  return { input: pushed[0], totalMismatchPence: created!.totalMismatchPence }
}

function precondition(name: string, facts: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`PRECONDITION ${name}: ${JSON.stringify(facts)}`)
}

test('a store-credit order is pushed with NO discount for the credit', async () => {
  const { input } = await pushOnce(candidate())
  precondition('credit order push', { discountAmount: 0, storeCreditForeign: 30, discountExVat: input.discountExVat })
  assert.equal(input.discountExVat, 0, 'DiscountTotalExVat must not carry the credit (the old import put 30 here)')
  assert.equal(input.discountVat, 0)
})

test('CONTROL: a genuine order-level discount still flows to discountExVat (the rig can see a discount)', async () => {
  const { input } = await pushOnce(candidate({ discountAmount: 12, storeCreditForeign: 0, totalForeign: 108 }))
  precondition('genuine discount push', { discountAmount: 12, discountExVat: input.discountExVat })
  assert.equal(input.discountExVat, 12)
})

test('the push-time total check expects the credit: an honest credit order is NOT flagged as a mismatch', async () => {
  const withCredit = await pushOnce(candidate())
  precondition('drift with credit', { expected: '100 + 20 - 30 = 90', recorded: withCredit.totalMismatchPence })
  assert.equal(withCredit.totalMismatchPence, null)
  // The same order with the credit unknown to the check reads as 30.00 of drift, which proves the
  // credit is what closes the gap (and that the check CAN fire on this fixture).
  const blind = await pushOnce(candidate({ storeCreditForeign: undefined }))
  precondition('drift without credit', { recorded: blind.totalMismatchPence })
  assert.equal(blind.totalMismatchPence, 3000)
})

test('the Mintsoft payload carries no credit/payment field: the credit settles the invoice, not the warehouse order', async () => {
  const { input } = await pushOnce(candidate())
  const payload = buildPushPayload(input, { kind: 'name' })
  const keys = Object.keys(payload)
  precondition('payload', { keys: keys.length, DiscountTotalExVat: payload.DiscountTotalExVat })
  assert.ok(keys.includes('DiscountTotalExVat'), 'precondition: the discount field exists to be checked')
  assert.equal(payload.DiscountTotalExVat, 0)
  assert.deepEqual(keys.filter((k) => /credit|paid|payment/i.test(k)), [])
})
