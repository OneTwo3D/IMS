import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildLines, buildPushInput, runWmsOrderPushSweepCore, type WmsOrderPushPort, type WmsPushCandidate, type WmsPushRevalidateLink } from '@/lib/domain/wms/order-push-sweep'
import { SKU_RENAME_HOLD_REASON_PREFIX, skuRenameHoldReason, withSkuRenameHolds } from '@/lib/domain/wms/sku-rename-hold'
import type { WmsOrderPushInput, WmsOrderPushResult } from '@/lib/connectors/wms/types'

/**
 * o3d-zz37l (6): order push holds an order whose line carries a NEW IMS SKU the warehouse does not have yet (an OPEN PRODUCT_SKU_RENAMED discrepancy:
 * imsValue = new SKU, wmsValue = the SKU the warehouse holds). No database, no network.
 */
const line = (over: Record<string, unknown>) => ({ id: 'l1', sku: 'NEW-1', productId: 'p1', qty: 1, taxForeign: 0, totalForeign: 10, description: 'x', ...over }) as never

type Row = { productId: string; warehouseId: string; imsValue: string; wmsValue: string }
function discrepancies(rows: Row[]) {
  const queries: unknown[] = []
  const client = {
    wmsStockDiscrepancy: {
      findMany: async (args: { where: { category: string; status: string; productId: { in: string[] } } }) => {
        queries.push(args.where)
        assert.equal(args.where.category, 'PRODUCT_SKU_RENAMED')
        assert.equal(args.where.status, 'OPEN')
        return rows.filter((row) => args.where.productId.in.includes(row.productId))
      },
    },
  }
  return { client: client as never, queries, rows }
}
const open = (over: Partial<Row> = {}): Row => ({ productId: 'p1', warehouseId: 'wh-1', imsValue: 'NEW-1', wmsValue: 'OLD-1', ...over })

test('buildLines refuses a line carrying the NEW IMS SKU, naming it', () => {
  assert.throws(() => buildLines([line({})], undefined, ['NEW-1']), (error: Error) => error.message === skuRenameHoldReason(['NEW-1']) && error.message.startsWith(SKU_RENAME_HOLD_REASON_PREFIX))
})

test('an order placed BEFORE the rename (line still carries the old SKU the warehouse knows) is not held', () => {
  const lines = buildLines([line({ sku: 'OLD-1' })], undefined, ['NEW-1'])
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.sku, 'OLD-1')
})

test('no held SKU, or an unrelated one, builds as before', () => {
  assert.equal(buildLines([line({})]).length, 1)
  assert.equal(buildLines([line({})], undefined, []).length, 1)
  assert.equal(buildLines([line({})], undefined, ['OTHER']).length, 1)
})

test('one held line holds the whole order: nothing is sent partially', () => {
  assert.throws(() => buildLines([line({}), line({ id: 'l2', sku: 'OK', productId: 'p2' })], undefined, ['NEW-1']), /Order held/)
})

test('a fully refunded held line and a fee line do not hold the order', () => {
  const refunded = new Map([['l1', 1]])
  assert.equal(buildLines([line({}), line({ id: 'l2', sku: 'OK', productId: 'p2' })], refunded, ['NEW-1']).length, 1)
  assert.equal(buildLines([line({ wclcFeeKind: 'duty_flat' }), line({ id: 'l2', sku: 'OK', productId: 'p2' })], undefined, ['NEW-1']).length, 1)
})

test('the hold is read from the discrepancy once per batch, by IMS SKU, scoped to the order\'s ship-from warehouse', async () => {
  const { client, queries } = discrepancies([open(), open({ productId: 'p3', warehouseId: 'wh-2', imsValue: 'THREE' })])
  const orders = [
    { id: 'o1', shipFromWarehouseId: 'wh-1', lines: [line({})] },
    { id: 'o2', shipFromWarehouseId: 'wh-2', lines: [line({})] }, // same product, other warehouse: not held
    { id: 'o3', shipFromWarehouseId: null, lines: [line({})] }, // no warehouse recorded: matches any
    { id: 'o4', shipFromWarehouseId: 'wh-1', lines: [line({ productId: 'p2', sku: 'OK' })] },
    { id: 'o5', shipFromWarehouseId: 'wh-1', lines: [line({ productId: null })] },
  ]
  const marked = await withSkuRenameHolds(client, orders)
  assert.equal(queries.length, 1)
  assert.deepEqual(marked.map((o) => o.skuRenameHeldSkus), [['NEW-1'], [], ['NEW-1'], [], []])
  assert.equal('skuRenameHeldSkus' in orders[0]!, false, 'the input is not mutated')
})

test('no products: no query', async () => {
  const { client, queries } = discrepancies([open()])
  await withSkuRenameHolds(client, [{ lines: [] }])
  assert.equal(queries.length, 0)
})

test('buildPushInput refuses an order carrying a held SKU', () => {
  const order = {
    id: 'o1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'A', customerEmail: null, customerVatNumber: null,
    shippingAddress: { address1: '1 Road', city: 'X', postcode: 'AB1', country: 'GB' }, subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: 0,
    pricesIncludeVat: false, discountAmount: 0, totalForeign: 10, lines: [line({})], skuRenameHeldSkus: ['NEW-1'],
  }
  assert.throws(() => buildPushInput(order as never, '1'), /Order held: SKU NEW-1 was renamed/)
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// The real sweep core, over a small stateful port that attaches holds the way the Prisma port does (withSkuRenameHolds on every order it loads).
// ---------------------------------------------------------------------------------------------------------------------------------------
const NOW = () => new Date('2026-11-19T00:00:00.000Z')
const baseOrder = (sku: string): WmsPushCandidate => ({
  id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'j@example.com', customerVatNumber: null,
  shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'Royal Mail', subtotalForeign: 10, shippingForeign: 0, taxForeign: 0,
  taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 10, shipFromWarehouseId: 'wh-1', pushAttempts: 0,
  lines: [{ id: 'l1', productId: 'p1', sku, qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget' }],
})

function harness(sku: string) {
  const rows: Row[] = [open()]
  const { client } = discrepancies(rows)
  const state = { link: 'NONE' as 'NONE' | 'VALIDATION_FAILED' | 'PENDING_CREATE' | 'SYNCED', lastError: null as string | null }
  const pushed: string[][] = []
  const port: Partial<WmsOrderPushPort> = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: async () => [],
    createCandidates: async () => (state.link === 'NONE' || state.link === 'PENDING_CREATE' ? withSkuRenameHolds(client, [baseOrder(sku)]) : []),
    revalidatableLinks: async () => {
      if (state.link !== 'VALIDATION_FAILED') return { links: [], total: 0 }
      const [order] = await withSkuRenameHolds(client, [baseOrder(sku)])
      const link: WmsPushRevalidateLink = { id: 'link-1', orderId: 'so-1', lastError: state.lastError, attempts: 0, pushedAt: null, externalOrderId: null, order: order! as never }
      return { links: [link], total: 1 }
    },
    reloadOrderForPush: async () => (await withSkuRenameHolds(client, [baseOrder(sku)]))[0] as never,
    recordValidationFailure: async (_orderId, _connector, error) => { state.link = 'VALIDATION_FAILED'; state.lastError = error; return true },
    claimForCreate: async () => 'CLAIMED',
    verifiableLinks: async () => [],
    updatableLinks: async () => [],
    holdableLinks: async () => [],
    cancellableLinks: async () => [],
    upsertByOrder: async () => { state.link = 'SYNCED' },
    updateLink: async () => {},
    updateLinkIfCreateClaimOwned: async () => true,
    updateLinkIfState: async (_id, from, data) => {
      assert.equal(state.link, from)
      if (data.state === 'PENDING_CREATE') { state.link = 'PENDING_CREATE'; state.lastError = null }
      else if (typeof data.lastError === 'string') state.lastError = data.lastError
      return true
    },
    recordEvent: async () => {},
  }
  const connector = {
    pushOrder: async (input: WmsOrderPushInput): Promise<WmsOrderPushResult> => { pushed.push(input.lines.map((l) => l.sku)); return { externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' } },
    updateOrder: async () => ({ updated: true, status: 'NEW' }),
    cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
  }
  const sweep = () => runWmsOrderPushSweepCore(connector as never, 'mintsoft', port as WmsOrderPushPort, { now: NOW })
  return { rows, state, pushed, sweep }
}

test('sweep: a held create is parked VALIDATION_FAILED with no push; revalidation keeps it parked while held, then re-queues and pushes it once the discrepancy closes', async () => {
  const h = harness('NEW-1')
  const first = await h.sweep()
  assert.equal(first.validationFailed, 1)
  assert.equal(first.created, 0)
  assert.deepEqual(h.pushed, [], 'nothing reached the warehouse')
  assert.equal(h.state.link, 'VALIDATION_FAILED')
  assert.match(h.state.lastError ?? '', /Order held: SKU NEW-1 was renamed/)

  const second = await h.sweep()
  assert.equal(second.revalidated, 0)
  assert.equal(h.state.link, 'VALIDATION_FAILED', 'still held: still parked')
  assert.deepEqual(h.pushed, [])

  h.rows.length = 0 // the discrepancy closes (the warehouse product was renamed, or the operator ignored it)
  const third = await h.sweep()
  assert.equal(third.revalidated, 1, 'the real revalidation pass re-queued it')
  assert.equal(third.created, 1)
  assert.deepEqual(h.pushed, [['NEW-1']])
})

test('sweep: an order placed before the rename (old SKU snapshot) is pushed as before, even while the discrepancy is open', async () => {
  const h = harness('OLD-1')
  const result = await h.sweep()
  assert.equal(result.created, 1)
  assert.deepEqual(h.pushed, [['OLD-1']])
})

test('port wiring: every Prisma port method that loads an order to push attaches the rename holds', () => {
  const source = readFileSync(new URL('../lib/domain/wms/order-push-sweep.ts', import.meta.url), 'utf8')
  const port = source.slice(source.indexOf('async createCandidates('))
  for (const method of ['async createCandidates(', 'async updatableLinks(', 'async revalidatableLinks(', 'async ambiguousCreateLinks(', 'async reloadOrderForPush(']) {
    const start = port.indexOf(method)
    assert.ok(start >= 0, `${method} exists`)
    const next = port.slice(start + method.length).search(/\n    (async )?[a-zA-Z]+\(|\n    [a-zA-Z]+: /)
    const body = port.slice(start, next < 0 ? undefined : start + method.length + next)
    assert.match(body, /withSkuRenameHolds\(/, `${method} must attach the SKU-rename holds`)
  }
  assert.equal((port.match(/withSkuRenameHolds\(/g) ?? []).length >= 6, true, 'createCandidates has two return paths')
})
