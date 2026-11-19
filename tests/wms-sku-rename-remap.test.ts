import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

import { buildLines, runWmsOrderPushSweepCore, type WmsOrderPushPort, type WmsPushCandidate, type WmsPushRevalidateLink, type WmsPushUpdateLink } from '@/lib/domain/wms/order-push-sweep'
import { sentSkuForLine, withSkuRenameHolds } from '@/lib/domain/wms/sku-rename-hold'
import { planMintsoftItemAmendments } from '@/lib/connectors/mintsoft/api/order-push'
import type { WmsOrderPushInput, WmsOrderPushResult } from '@/lib/connectors/wms/types'

/**
 * o3d-k6x6m R1 (HIGH): the SKU remap (setting wms_sku_rename_remap_enabled) is ONE rule for create and amendment, restricted to KNOWN earlier SKUs of the
 * product. In-memory doubles only: no database, no network.
 */
type Row = { productId: string; warehouseId: string; status: string; category?: string; imsValue: string | null; wmsValue: string | null; resolvedAt?: Date | null }
const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => Object.entries(where).every(([key, want]) => {
  const have = row[key]
  if (want && typeof want === 'object' && 'in' in (want as object)) return ((want as { in: unknown[] }).in).includes(have)
  if (want && typeof want === 'object' && 'gte' in (want as object)) return have instanceof Date && have >= (want as { gte: Date }).gte
  return have === want
})
function client(rows: Row[], opts: { linkSku?: string | null; productSku?: string } = {}) {
  const productSku = opts.productSku ?? 'B'
  const withCategory = () => rows.map((row) => ({ category: 'PRODUCT_SKU_RENAMED', ...row }))
  return {
    wmsStockDiscrepancy: { findMany: async (args: { where: Record<string, unknown> }) => withCategory().filter((row) => matches(row, args.where)) },
    wmsProductLink: { findMany: async () => (opts.linkSku === null ? [] : [{ productId: 'p1', metadata: { SKU: opts.linkSku ?? productSku } }]) },
    product: { findMany: async () => [{ id: 'p1', sku: productSku }] },
  } as never
}
const history = (over: Partial<Row> = {}): Row => ({ productId: 'p1', warehouseId: 'wh-1', status: 'RESOLVED', imsValue: 'B', wmsValue: 'A', ...over })
const line = (over: Record<string, unknown> = {}) => ({ id: 'l1', sku: 'A', productId: 'p1', qty: 2, taxForeign: 0, totalForeign: 20, description: 'Widget', ...over }) as never
const ON = { remapForConnector: 'mintsoft' }

test('sentSkuForLine: only a KNOWN earlier SKU of the product is remapped; case variants, wc-<id> lines and unknown SKUs are not; no remap means identity', () => {
  const remap = { p1: { sku: 'B', earlier: ['A'] } }
  assert.equal(sentSkuForLine({ sku: 'A', productId: 'p1' }, remap), 'B')
  assert.equal(sentSkuForLine({ sku: ' A ', productId: 'p1' }, remap), 'B')
  for (const sku of ['a', 'b', 'wc-77', 'ZZZ', '']) assert.equal(sentSkuForLine({ sku, productId: 'p1' }, remap), sku, sku)
  assert.equal(sentSkuForLine({ sku: 'A', productId: 'p2' }, remap), 'A', 'another product')
  assert.equal(sentSkuForLine({ sku: 'A', productId: null }, remap), 'A', 'unbound line')
  assert.equal(sentSkuForLine({ sku: 'A', productId: 'p1' }, undefined), 'A', 'setting off')
})

test('withSkuRenameHolds: the history of ANY status (resolved, ignored, open) names the earlier SKUs, per warehouse; setting off attaches nothing', async () => {
  const rows = [history(), history({ status: 'IGNORED', imsValue: 'X', wmsValue: 'A' }), history({ warehouseId: 'wh-2', imsValue: 'OTHER-WH', wmsValue: 'OTHER-WH2' })]
  const order = { id: 'o1', shipFromWarehouseId: 'wh-1', lines: [line()] }
  const [on] = await withSkuRenameHolds(client(rows), [order], undefined, ON)
  assert.deepEqual(on!.skuRemap!.p1!.sku, 'B')
  assert.deepEqual([...on!.skuRemap!.p1!.earlier].sort(), ['A', 'X'])
  const [off] = await withSkuRenameHolds(client(rows), [order])
  assert.equal('skuRemap' in off!, false)
  const [unconfirmed] = await withSkuRenameHolds(client(rows, { linkSku: 'A' }), [order], undefined, ON)
  assert.deepEqual(unconfirmed!.skuRemap, {}, 'the warehouse is not confirmed on the current SKU')
})

// ---- create then amend through the real sweep and the real item-reconcile planner --------------------------------------------------------------------
const NOW = () => new Date('2026-11-19T00:00:00.000Z')
const candidate = (lines: unknown[]): WmsPushCandidate => ({
  id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'j@example.com', customerVatNumber: null,
  shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'Royal Mail', subtotalForeign: 20, shippingForeign: 0, taxForeign: 0,
  taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 20, shipFromWarehouseId: 'wh-1', pushAttempts: 0, lines: lines as never,
})
const base = (): Partial<WmsOrderPushPort> => ({
  activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }], releasableHeldOrders: async () => [], createCandidates: async () => [],
  revalidatableLinks: async () => ({ links: [], total: 0 }), verifiableLinks: async () => [], updatableLinks: async () => [], holdableLinks: async () => [], cancellableLinks: async () => [],
  recordValidationFailure: async () => true, claimForCreate: async () => 'CLAIMED', upsertByOrder: async () => {}, updateLink: async () => {}, updateLinkIfCreateClaimOwned: async () => true,
  updateLinkIfState: async () => true, recordEvent: async () => {}, resolveRefusedActions: async () => {}, recordRefusedAction: async () => {}, openAmendmentRefusals: async () => [],
})
async function createThenAmend(rows: Row[], snapshot: string, options: { remapForConnector?: string }, opts: { linkSku?: string | null; productSku?: string; extra?: Record<string, unknown> } = {}) {
  const db = client(rows, opts)
  const order = () => candidate([line({ sku: snapshot, ...(opts.extra ?? {}) })])
  let created: WmsOrderPushInput | null = null
  let amended: WmsOrderPushInput | null = null
  const connector = (kind: 'create' | 'amend') => ({
    pushOrder: async (input: WmsOrderPushInput): Promise<WmsOrderPushResult> => { created = input; return { externalOrderId: 'wms-1', externalOrderNumber: 'WN-1', status: 'NEW' } },
    updateOrder: async (_id: string, input: WmsOrderPushInput) => { amended = input; return { updated: true, status: 'NEW' } },
    cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
    kind,
  })
  const createPort: Partial<WmsOrderPushPort> = {
    ...base(),
    createCandidates: async () => withSkuRenameHolds(db, [order()], undefined, options),
    reloadOrderForPush: async () => (await withSkuRenameHolds(db, [order()], undefined, options))[0] as never,
  }
  await runWmsOrderPushSweepCore(connector('create') as never, 'mintsoft', createPort as WmsOrderPushPort, { now: NOW })
  const [withHolds] = await withSkuRenameHolds(db, [{ ...order(), updatedAt: new Date('2026-11-19T00:00:00Z') }], undefined, options)
  const link: WmsPushUpdateLink = { id: 'link-1', externalOrderId: 'wms-1', order: withHolds as never }
  const amendPort: Partial<WmsOrderPushPort> = {
    ...base(),
    updatableLinks: async () => [link],
    reloadOrderForPush: async () => (await withSkuRenameHolds(db, [order()], undefined, options))[0] as never,
  }
  await runWmsOrderPushSweepCore(connector('amend') as never, 'mintsoft', amendPort as WmsOrderPushPort, { now: NOW })
  return { created: created as WmsOrderPushInput | null, amended: amended as WmsOrderPushInput | null }
}
const itemsOf = (input: WmsOrderPushInput) => input.lines.map((l, i) => ({ ID: i + 1, SKU: l.sku, Quantity: l.quantity }))

test('FLAG ON: an order created as B (snapshot A) is amended as B: the real item-reconcile planner plans no delete or add for the unchanged line', async () => {
  const { created, amended } = await createThenAmend([history()], 'A', ON)
  assert.deepEqual(created!.lines.map((l) => l.sku), ['B'])
  assert.deepEqual(amended!.lines.map((l) => l.sku), ['B'], 'the amendment sends the SKU the order was created with')
  assert.deepEqual(planMintsoftItemAmendments(itemsOf(created!) as never, amended!.lines), [])
})

test('FLAG OFF: no remap anywhere (create and amendment both send the snapshot SKU, exactly as development)', async () => {
  const { created, amended } = await createThenAmend([history()], 'A', {})
  assert.deepEqual(created!.lines.map((l) => l.sku), ['A'])
  assert.deepEqual(amended!.lines.map((l) => l.sku), ['A'])
  assert.deepEqual(planMintsoftItemAmendments(itemsOf(created!) as never, amended!.lines), [])
  assert.deepEqual(buildLines([line()], undefined, undefined, undefined).map((l) => l.sku), ['A'])
})

test('FLAG ON: a case variant and a wc-<id> fallback line on a product with NO rename history are never remapped (create and amend alike)', async () => {
  for (const [snapshot, extra] of [['b', {}], ['wc-77', { externalLineItemId: 77 }]] as const) {
    const { created, amended } = await createThenAmend([], snapshot, ON, { extra: extra as Record<string, unknown> })
    assert.deepEqual(created!.lines.map((l) => l.sku), [snapshot])
    assert.deepEqual(amended!.lines.map((l) => l.sku), [snapshot])
  }
})

test('FLAG ON: a refused amendment of a remapped order compares the SKU that was sent, so an unchanged line is LOW, not a false SKU difference', async () => {
  const db = client([history()])
  const [held] = await withSkuRenameHolds(db, [{ ...candidate([line()]), updatedAt: new Date() }], undefined, ON)
  const recorded: Array<Record<string, unknown>> = []
  const port: Partial<WmsOrderPushPort> = {
    ...base(), updatableLinks: async () => [{ id: 'link-1', externalOrderId: 'wms-1', order: held as never }],
    readOrderItems: async () => [{ externalItemId: 'x1', sku: 'B', quantity: 2 }],
    recordRefusedAction: async (input) => { recorded.push(input as unknown as Record<string, unknown>) },
  }
  const connector = { pushOrder: async () => { throw new Error('no') }, updateOrder: async () => ({ updated: false, status: 'NOT_NEW' }), cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }) }
  await runWmsOrderPushSweepCore(connector as never, 'mintsoft', port as WmsOrderPushPort, { now: NOW })
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.severity, 'LOW')
  assert.equal((recorded[0]!.intent as { lineChange: string }).lineChange, 'UNCHANGED')
})

test('FLAG ON: the revalidation path re-queues a parked order and the create pass sends the remapped SKU', async () => {
  const db = client([history()])
  const state = { link: 'VALIDATION_FAILED' as string }
  const pushed: string[][] = []
  const port: Partial<WmsOrderPushPort> = {
    ...base(),
    createCandidates: async () => (state.link === 'PENDING_CREATE' ? withSkuRenameHolds(db, [candidate([line()])], undefined, ON) : []),
    revalidatableLinks: async () => {
      if (state.link !== 'VALIDATION_FAILED') return { links: [], total: 0 }
      const [order] = await withSkuRenameHolds(db, [candidate([line()])], undefined, ON)
      const link: WmsPushRevalidateLink = { id: 'link-1', orderId: 'so-1', lastError: 'x', attempts: 0, pushedAt: null, externalOrderId: null, order: order! as never }
      return { links: [link], total: 1 }
    },
    updateLinkIfState: async (_id, _from, data) => { if (data.state === 'PENDING_CREATE') state.link = 'PENDING_CREATE'; return true },
    reloadOrderForPush: async () => (await withSkuRenameHolds(db, [candidate([line()])], undefined, ON))[0] as never,
  }
  const connector = { pushOrder: async (input: WmsOrderPushInput): Promise<WmsOrderPushResult> => { pushed.push(input.lines.map((l) => l.sku)); return { externalOrderId: 'w', externalOrderNumber: 'N', status: 'NEW' } }, updateOrder: async () => ({ updated: true, status: 'NEW' }), cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }) }
  const result = await runWmsOrderPushSweepCore(connector as never, 'mintsoft', port as WmsOrderPushPort, { now: NOW })
  assert.equal(result.revalidated, 1)
  assert.deepEqual(pushed, [['B']])
})

test('wiring: every Prisma port load (create, amend, revalidate, ambiguous-create, reload) takes the remap option from the setting', () => {
  const source = readFileSync(new URL('../lib/domain/wms/order-push-sweep.ts', import.meta.url), 'utf8')
  const port = source.slice(source.indexOf('async createCandidates('))
  assert.equal((port.match(/await remapOptions\(/g) ?? []).length, 6, 'createCandidates x2, updatableLinks, revalidatableLinks, ambiguousCreateLinks, reloadOrderForPush')
  assert.match(source, /isSkuRenameRemapEnabled\(\)/)
  assert.match(source, /port\.reloadOrderForPush\(link\.order\.id, sentToWarehouseId \?\? null, connectorId\)/)
  const flag = readFileSync(new URL('../lib/domain/wms/sku-rename-remap-flag.ts', import.meta.url), 'utf8')
  assert.match(flag, /=== 'true'/)
})

// ---- MED 1, driven through the product-sync pass and the push hold; the ignore race; history on a re-rename ------------------------------------------
type Disc = Record<string, unknown> & { id: string; status: string }
function memoryDb(rows: Disc[], onCreate?: (row: Disc) => void) {
  let seq = 0
  return {
    wmsStockDiscrepancy: {
      findFirst: async (args: { where: Record<string, unknown> }) => rows.find((row) => matches(row, args.where)) ?? null,
      findMany: async (args: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, args.where)),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((row) => matches(row, args.where))
        for (const row of hit) Object.assign(row, args.data)
        return { count: hit.length }
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `d${++seq}`, ...args.data } as Disc
        rows.push(row)
        onCreate?.(row)
        return row
      },
    },
  }
}
mock.module('@/lib/db', { namedExports: { db: {} } })

async function upsert(db: unknown, ims: string, wms: string) {
  const mod = await import('../lib/connectors/mintsoft/sync/product-sync.ts')
  const sync = ('default' in mod ? mod.default : mod) as typeof import('../lib/connectors/mintsoft/sync/product-sync.ts')
  const { db: shared } = await import('@/lib/db') as unknown as { db: Record<string, unknown> }
  Object.assign(shared, db)
  await sync.upsertProductDiscrepancy({ scopes: [{ warehouseId: 'wh-1' }] as never, productId: 'p1', sku: ims, category: 'PRODUCT_SKU_RENAMED', imsValue: ims, wmsValue: wms, message: 'm' })
}
const ignored = (): Disc => ({ id: 'ig', connector: 'mintsoft', warehouseId: 'wh-1', productId: 'p1', category: 'PRODUCT_SKU_RENAMED', status: 'IGNORED', imsValue: 'B', wmsValue: 'A', resolvedAt: new Date('2026-11-18T00:00:00Z') })

test('MED 1 (sweep level): ignore A->B, B->C opens (C,A), C->B: the (C,A) row stays OPEN and a C-snapshot order is still HELD by the push', async () => {
  const rows: Disc[] = [ignored()]
  const db = memoryDb(rows)
  await upsert(db, 'C', 'A')
  await upsert(db, 'B', 'A')
  const open = rows.filter((row) => row.status === 'OPEN')
  assert.deepEqual(open.map((row) => [row.imsValue, row.wmsValue]), [['C', 'A']], 'returning to the ignored pair closed nothing')
  const [order] = await withSkuRenameHolds(db as never, [{ shipFromWarehouseId: 'wh-1', lines: [line({ sku: 'C' })] }])
  assert.throws(() => buildLines(order!.lines as never, undefined, order!.skuRenameHolds), /Order held: SKU C/)
})

test('a re-rename (B then C while the warehouse is still on A) keeps B as a RESOLVED history row, so B stays a known earlier SKU', async () => {
  const rows: Disc[] = []
  const db = memoryDb(rows)
  await upsert(db, 'B', 'A')
  await upsert(db, 'C', 'A')
  assert.deepEqual(rows.map((row) => [row.status, row.imsValue, row.wmsValue]).sort(), [['OPEN', 'C', 'A'], ['RESOLVED', 'B', 'A']])
  const [order] = await withSkuRenameHolds(client(rows.map((r) => ({ ...r })) as never, { productSku: 'C' }), [{ shipFromWarehouseId: 'wh-1', lines: [line({ sku: 'B' })] }], undefined, ON)
  assert.deepEqual([...order!.skuRemap!.p1!.earlier].sort(), ['A', 'B'])
})

test('ignore race: an ignore of the same pair made while the pass creates the row closes only the row just created', async () => {
  const rows: Disc[] = []
  const db = memoryDb(rows, (row) => { rows.push({ ...ignored(), id: 'late', resolvedAt: new Date(Date.now() + 50), imsValue: row.imsValue, wmsValue: row.wmsValue }) })
  await upsert(db, 'B', 'A')
  const created = rows.find((row) => row.id === 'd1')!
  assert.equal(created.status, 'RESOLVED', 'the hold does not come straight back')
})
