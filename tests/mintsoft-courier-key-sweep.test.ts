import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { WmsOrderPushPort, WmsPushUpdateLink } from '../lib/domain/wms/order-push-sweep.ts'
import type { WmsOrderPushInput, WmsOrderUpdateResult } from '../lib/connectors/wms/types.ts'

/**
 * The amendment pass of the real sweep and the courier form of a link: what is handed to the connector, and what is written
 * back to the link when the amendment ended on the default courier. The connector and the port are doubles; nothing here can
 * reach Mintsoft.
 */

const KEY = 'calcurates:6384_7418(VAT & duty paid)'
const NOW = () => new Date('2026-06-26T00:00:00.000Z')

mock.module('@/lib/db', { namedExports: { db: { $queryRaw: async () => [], $executeRaw: async () => 1 } } })

function updateLinkFor(over: Partial<WmsPushUpdateLink>): WmsPushUpdateLink {
  return {
    id: 'link-u',
    externalOrderId: 'wms-u',
    order: {
      id: 'so-u', orderNumber: 'SO-U', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'jane@example.com', customerVatNumber: null,
      shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'RM Tracked', shippingMethodId: 'calcurates', courierKey: KEY,
      subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 10,
      shipFromWarehouseId: 'wh-1',
      lines: [{ id: 'l1', sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget', productId: 'p1', externalLineItemId: 1, wclcFeeKind: null }],
      refunds: [],
    } as never,
    ...over,
  }
}

async function sweep(link: WmsPushUpdateLink, result: WmsOrderUpdateResult, opts: { commentFails?: boolean } = {}) {
  const { runWmsOrderPushSweepCore } = await import('../lib/domain/wms/order-push-sweep.ts')
  const linkWrites: Array<Record<string, unknown>> = []
  const inputs: WmsOrderPushInput[] = []
  const comments: Array<{ id: string; text: string }> = []
  const port = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: async () => [],
    createCandidates: async () => [],
    revalidatableLinks: async () => ({ links: [], total: 0 }),
    ambiguousCreateLinks: async () => ({ links: [], total: 0 }),
    verifiableLinks: async () => [],
    holdableLinks: async () => [],
    cancellableLinks: async () => [],
    updatableLinks: async () => [link],
    updateLink: async (_id: string, data: Record<string, unknown>) => { linkWrites.push(data) },
    updateLinkByOrder: async () => undefined,
    updateLinkIfState: async () => true,
    upsertByOrder: async () => undefined,
    screenLiveWithdrawals: async () => new Set<string>(),
    verifyWithdrawalFence: async () => true,
    recordEvent: async () => undefined,
  } as unknown as WmsOrderPushPort
  const connector = {
    pushOrder: async () => { throw new Error('unexpected create') },
    updateOrder: async (_id: string, input: WmsOrderPushInput) => { inputs.push(input); return result },
    addOrderComment: async (id: string, text: string) => {
      comments.push({ id, text })
      if (opts.commentFails) throw new Error('comment endpoint down')
    },
  }
  await runWmsOrderPushSweepCore(connector as never, 'mintsoft', port, { now: NOW })
  return { linkWrites, inputs, comments }
}

test('a link with no recorded form, amended down to the placeholder, ends with courierPending true and the form recorded', async () => {
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), {
    updated: true, status: 'NEW', courierForm: 'PLACEHOLDER', courierFormName: KEY, courierFallback: true,
  })
  assert.equal(run.inputs[0]!.courierFormUnknown, true)
  assert.equal(run.linkWrites[0]!.courierPending, true)
  assert.equal(run.linkWrites[0]!.courierForm, 'PLACEHOLDER')
  assert.equal(run.linkWrites[0]!.courierFormName, KEY)
})

test('an amendment that did not end on the default courier does not raise the review flag', async () => {
  const run = await sweep(updateLinkFor({ courierForm: 'NAME', courierFormName: KEY }), { updated: true, status: 'NEW' })
  assert.equal('courierPending' in run.linkWrites[0]!, false)
  assert.equal(run.inputs[0]!.courierFormUnknown, undefined)
})

test('a recorded form whose first courier name has changed is handed over as a fresh selection', async () => {
  const run = await sweep(updateLinkFor({ courierForm: 'LEGACY', courierFormName: 'calcurates:OLD_KEY' }), { updated: true, status: 'NEW' })
  assert.equal(run.inputs[0]!.courierService, KEY)
  assert.equal(run.inputs[0]!.courierFormUnknown, true)
})

const PLACEHOLDER_RESULT: WmsOrderUpdateResult = { updated: true, status: 'NEW', courierForm: 'PLACEHOLDER', courierFormName: KEY, courierFallback: true }

test('an amendment that newly falls back to the default courier posts the same warehouse-visible courier warning a create does', async () => {
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), PLACEHOLDER_RESULT)
  assert.deepEqual(run.comments, [{
    id: 'wms-u',
    text: "IMS: shipping method 'RM Tracked' did not map to a WMS courier, so a default courier was used. Please verify the courier before despatch.",
  }])
  assert.ok(run.linkWrites[0]!.pushedAt, 'the amendment is marked pushed once the warning is posted')
  assert.equal(run.linkWrites[0]!.courierForm, 'PLACEHOLDER')
})

test('a failed courier warning keeps the link retryable: not marked pushed, form not recorded, flag still raised', async () => {
  const run = await sweep(updateLinkFor({ courierForm: null, courierFormName: null }), PLACEHOLDER_RESULT, { commentFails: true })
  assert.equal(run.comments.length, 1)
  assert.equal('pushedAt' in run.linkWrites[0]!, false, 'the order stays due, so the next pass amends and posts the warning again')
  assert.equal('courierForm' in run.linkWrites[0]!, false, 'the next pass finds the fallback again')
  assert.equal(run.linkWrites[0]!.courierPending, true)
  assert.match(String(run.linkWrites[0]!.lastError), /warning not posted/)
})

test('an amendment that did not fall back posts no courier warning', async () => {
  const run = await sweep(updateLinkFor({ courierForm: 'NAME', courierFormName: KEY }), { updated: true, status: 'NEW' })
  assert.deepEqual(run.comments, [])
})
