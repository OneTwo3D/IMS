import assert from 'node:assert/strict'
import test from 'node:test'

import { payloadTotalMismatchPence, totalGuardExclusion, runWmsOrderPushSweepCore, type WmsOrderPushPort, type WmsPushCandidate } from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderPushInput, WmsOrderPushResult } from '../lib/connectors/wms/types.ts'

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
    // Written only by the credit-aware import's creating write: the discount is proven credit-free.
    storeCreditAssessment: 'ASSESSED',
    totalForeign: 90,
    shipFromWarehouseId: 'wh-1',
    pushAttempts: 0,
    lines: [{ sku: 'A', qty: 1, taxForeign: 20, totalForeign: 100, description: 'Widget' }],
    ...overrides,
  }
}

async function sweep(order: WmsPushCandidate): Promise<{ pushed: WmsOrderPushInput[]; upserts: Array<Record<string, unknown>>; validationFailures: Array<{ orderId: string; error: string }> }> {
  const validationFailures: Array<{ orderId: string; error: string }> = []
  const pushed: WmsOrderPushInput[] = []
  const upserts: Array<Record<string, unknown>> = []
  const never = async () => []
  const port = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: never,
    createCandidates: async () => [order],
    revalidatableLinks: async () => ({ links: [], total: 0 }),
    recordValidationFailure: async (orderId: string, _c: string, error: string) => { validationFailures.push({ orderId, error }); return true },
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
  return { pushed, upserts, validationFailures }
}

async function pushOnce(order: WmsPushCandidate): Promise<{ input: WmsOrderPushInput; totalMismatchPence: unknown }> {
  const { pushed, upserts } = await sweep(order)
  assert.equal(pushed.length, 1, 'precondition: exactly one order was pushed, so the input below was actually examined')
  const created = upserts.find((u) => 'totalMismatchPence' in u)
  assert.ok(created, 'precondition: the link write that records the drift verdict happened')
  return { input: pushed[0], totalMismatchPence: created!.totalMismatchPence }
}



// A clean order: 100 + 20 VAT = 120 paid, no credit, no discount.
const clean = (o: Partial<WmsPushCandidate> = {}) => candidate({ storeCreditForeign: 0, storeCreditAssessment: undefined, totalForeign: 120, ...o })
const withExtra = (o: Record<string, unknown>) => clean(o as Partial<WmsPushCandidate>)

test('exact match raises no row', async () => {
  assert.equal((await pushOnce(clean())).totalMismatchPence, null)
})

test('a real divergence raises one row (control: the rig can fire)', async () => {
  assert.equal((await pushOnce(clean({ totalForeign: 150 }))).totalMismatchPence, 3000)
})

test('a line-edited order (wcLineBaseline set) skips the component check but its payload check still runs', async () => {
  // Total 150 vs payload 120: the payload check still records the 30.00 gap; the component check stays silent.
  const r = await pushOnce(withExtra({ totalForeign: 150, wcLineBaseline: { totalForeign: 120, lines: [] } }))
  assert.equal(r.totalMismatchPence, 3000)
})

test('an address-only edit (editedInImsAt set, no line baseline) still records a 2.00 payload discrepancy', async () => {
  const r = await pushOnce(withExtra({ totalForeign: 122, editedInImsAt: new Date('2026-11-01T00:00:00Z'), wcLineBaseline: null }))
  assert.equal(r.totalMismatchPence, 200)
})

test('a line edit whose recomputed total matches the payload raises nothing', async () => {
  const r = await pushOnce(withExtra({ totalForeign: 120, wcLineBaseline: { totalForeign: 99, lines: [] } }))
  assert.equal(r.totalMismatchPence, null)
})

test('a discount model other than LINE_ALLOCATED raises no false mismatch', async () => {
  const r = await pushOnce(withExtra({ totalForeign: 150, discountModel: 'ORDER_LEVEL' }))
  assert.equal(r.totalMismatchPence, null)
})

test('LINE_ALLOCATED and unrecorded models are still checked', async () => {
  assert.equal((await pushOnce(withExtra({ totalForeign: 150, discountModel: 'LINE_ALLOCATED' }))).totalMismatchPence, 3000)
  assert.equal(totalGuardExclusion({ discountModel: null, wcLineBaseline: null }, 'component'), null)
})

test('the push payload is byte-identical whether or not the order is excluded', async () => {
  const a = await pushOnce(clean({ totalForeign: 150 }))
  const b = await pushOnce(withExtra({ totalForeign: 150, wcLineBaseline: { totalForeign: 99, lines: [] } }))
  assert.equal(JSON.stringify(a.input), JSON.stringify(b.input))
})

test('exclusion reasons per check', () => {
  assert.equal(totalGuardExclusion({ wcLineBaseline: {} }, 'component'), 'LINES_EDITED_IN_IMS')
  assert.equal(totalGuardExclusion({ wcLineBaseline: {} }, 'payload'), null)
  assert.equal(totalGuardExclusion({ discountModel: 'X' }, 'payload'), 'DISCOUNT_MODEL_NOT_LINE_ALLOCATED')
  assert.equal(typeof payloadTotalMismatchPence, 'function')
})
