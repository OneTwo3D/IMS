import './scratch-database-setup' // FIRST: refuses to load unless the scratch database was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import * as fixtures from './po-landed-fixtures'

/**
 * PER-LINE ETA over a real PostgreSQL: a part receipt must not clear or overwrite a line's own delivery date, and an amend of a
 * received line may change it. Drives the REAL createPurchaseOrder / receivePurchaseOrder / updatePurchaseOrder / getPurchaseOrder.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/fulfillment/backorder-allocator', { namedExports: { allocateBackordersForProducts: async () => ({}) } })
mock.module('@/lib/fulfillment/overallocation-rebalancer', { namedExports: { releaseOverallocations: async () => ({}) } })

const { loadEnv, enableStockReceiptPosting, seedPo, receive } = fixtures

test.before(async () => {
  if (!RUN) return
  loadEnv()
  await enableStockReceiptPosting()
})

test('a part receipt keeps the line date; an amend can change it; blank goes back to the header date', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { updatePurchaseOrder, getPurchaseOrder } = await import('@/app/actions/purchase-orders')
  const po = await seedPo('eta', [10, 10])
  const header = new Date('2026-12-01T00:00:00.000Z')
  const own = new Date('2026-12-20T00:00:00.000Z')
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { expectedDelivery: header } })
  await db.purchaseOrderLine.update({ where: { id: po.lines[0]!.poLineId }, data: { expectedDelivery: own } })

  const received = await receive(po, po.lines[0]!, 4)
  assert.equal(received.success, true, String(received.error))

  const stored = await db.purchaseOrderLine.findMany({ where: { poId: po.poId }, orderBy: { sortOrder: 'asc' }, select: { expectedDelivery: true, qtyReceived: true } })
  assert.equal(Number(stored[0]!.qtyReceived), 4)
  assert.equal(stored[0]!.expectedDelivery?.toISOString(), own.toISOString(), 'the part receipt did not touch the line date')
  assert.equal(stored[1]!.expectedDelivery, null, 'a line with no date stays blank')

  const detail = await getPurchaseOrder(po.poId)
  assert.equal(detail!.lines[0]!.effectiveDelivery, own.toISOString())
  assert.equal(detail!.lines[1]!.effectiveDelivery, header.toISOString(), 'a blank line shows the header date')

  const edit = (dates: Array<string | null>) => ({
    currency: 'GBP',
    pricesIncludeVat: false,
    taxRateValue: 0,
    lines: po.lines.map((l, i) => ({
      poLineId: l.poLineId, productId: l.productId, sku: l.sku, productName: `p${i}`, qty: 10,
      unitCostForeign: fixtures.UNIT_COST, expectedDelivery: dates[i],
    })),
  }) as Parameters<typeof updatePurchaseOrder>[1]

  const moved = await updatePurchaseOrder(po.poId, edit(['2026-12-30', '2026-12-10']))
  assert.equal(moved.success, true, String(moved.error))
  const after = await db.purchaseOrderLine.findMany({ where: { poId: po.poId }, orderBy: { sortOrder: 'asc' }, select: { expectedDelivery: true, qtyReceived: true } })
  assert.equal(after[0]!.expectedDelivery?.toISOString().slice(0, 10), '2026-12-30', 'the received line date can be amended')
  assert.equal(Number(after[0]!.qtyReceived), 4)
  assert.equal(after[1]!.expectedDelivery?.toISOString().slice(0, 10), '2026-12-10')

  const cleared = await updatePurchaseOrder(po.poId, edit([null, null]))
  assert.equal(cleared.success, true, String(cleared.error))
  const blank = await db.purchaseOrderLine.findMany({ where: { poId: po.poId }, select: { expectedDelivery: true } })
  assert.ok(blank.every((l) => l.expectedDelivery === null), 'a blank date clears the line back to inheriting the header')
})

test('an amend or full edit that OMITS expectedDelivery keeps the stored line dates; explicit null clears', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const dates = ['2026-12-20', '2026-12-22']
  const seed = async (label: string, receiveFirst: boolean) => {
    const po = await seedPo(label, [10, 10])
    for (const [i, l] of po.lines.entries()) {
      await db.purchaseOrderLine.update({ where: { id: l.poLineId }, data: { expectedDelivery: new Date(dates[i]!) } })
    }
    if (receiveFirst) assert.equal((await receive(po, po.lines[0]!, 3)).success, true)
    return po
  }
  const read = async (poId: string) => (await db.purchaseOrderLine.findMany({ where: { poId }, orderBy: { sortOrder: 'asc' }, select: { expectedDelivery: true } }))
    .map((l) => l.expectedDelivery?.toISOString().slice(0, 10) ?? null)
  const edit = (po: Awaited<ReturnType<typeof seedPo>>, qty: number, eta?: null) => ({
    currency: 'GBP', pricesIncludeVat: false, taxRateValue: 0,
    lines: po.lines.map((l, i) => ({
      poLineId: l.poLineId, productId: l.productId, sku: l.sku, productName: `p${i}`, qty, unitCostForeign: fixtures.UNIT_COST,
      ...(eta === null ? { expectedDelivery: null } : {}),
    })),
  }) as Parameters<typeof updatePurchaseOrder>[1]

  // AMEND path (goods received): field omitted -> kept; explicit null -> cleared.
  const amend = await seed('eta-amend', true)
  assert.equal((await updatePurchaseOrder(amend.poId, edit(amend, 12))).success, true)
  assert.deepEqual(await read(amend.poId), dates, 'amend with the field omitted keeps both dates')
  assert.equal((await updatePurchaseOrder(amend.poId, edit(amend, 12, null))).success, true)
  assert.deepEqual(await read(amend.poId), [null, null], 'explicit null clears')

  // FULL edit path (nothing received: lines are deleted and recreated).
  const full = await seed('eta-full', false)
  assert.equal((await updatePurchaseOrder(full.poId, edit(full, 12))).success, true)
  assert.deepEqual(await read(full.poId), dates, 'full edit with the field omitted keeps both dates')
  assert.equal((await updatePurchaseOrder(full.poId, edit(full, 12, null))).success, true)
  assert.deepEqual(await read(full.poId), [null, null], 'explicit null clears')
})

test('CSV round trip: export then import preserves line dates', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { NextRequest } = await import('next/server')
  const { GET } = await import('@/app/api/export/purchase-orders/route')
  const { importPurchaseOrdersCsv } = await import('@/app/actions/import')
  const { parseCsv, toCsv } = await import('@/lib/csv')
  const po = await seedPo('eta-rt', [10, 10, 10])
  await db.purchaseOrder.update({ where: { id: po.poId }, data: { expectedDelivery: new Date('2026-12-01') } })
  const own = ['2026-12-20', null, '2026-12-05']
  for (const [i, l] of po.lines.entries()) {
    await db.purchaseOrderLine.update({ where: { id: l.poLineId }, data: { expectedDelivery: own[i] ? new Date(own[i]!) : null } })
  }
  const res = await GET(new NextRequest('http://localhost/api/export/purchase-orders'))
  const rows = parseCsv(await res.text()).filter((r) => r.orderKey === po.tag)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.lineExpectedDelivery), ['2026-12-20', '', '2026-12-05'])
  const newKey = `${po.tag}-RT`
  const headers = Object.keys(rows[0]!)
  const csv = toCsv(rows.map((r) => ({ ...r, orderKey: newKey })), headers)
  const f = new FormData(); f.set('file', new File([csv], 'rt.csv'))
  const result = await importPurchaseOrdersCsv(f) as { created?: number; errors?: string[] }
  assert.equal(result.created, 3, (result.errors ?? []).join('; '))
  const imported = await db.purchaseOrder.findFirstOrThrow({ where: { reference: newKey }, select: { expectedDelivery: true, lines: { select: { productId: true, expectedDelivery: true } } } })
  assert.equal(imported.expectedDelivery?.toISOString().slice(0, 10), '2026-12-01')
  const byProduct = new Map(imported.lines.map((l) => [l.productId, l.expectedDelivery?.toISOString().slice(0, 10) ?? null]))
  assert.deepEqual(po.lines.map((l) => byProduct.get(l.productId)), own, 'line dates survive the round trip; blank stays blank')
})
