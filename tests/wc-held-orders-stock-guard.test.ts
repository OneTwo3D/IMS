import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateHeldUnits,
  completedOrdersModifiedAfter,
  unallocatedRemainder,
  loadWcHeldUnitsByProduct,
  WC_HELD_ORDERS_MAX_PAGES,
  WC_HELD_ORDERS_PAGE_SIZE,
  type HeldProductRef,
  type WcHeldUnitsDeps,
} from '@/lib/connectors/woocommerce/sync/stock-held-orders'
import { buildStockMaps } from '@/lib/connectors/woocommerce/sync/stock-sync'

const simple = (id: string, ext: number, sku = id): HeldProductRef => ({ id, sku, type: 'SIMPLE', externalProductId: ext, components: [] })
const order = (id: number, ...lines: [number, number, number][]) => ({
  id,
  line_items: lines.map(([product_id, variation_id, quantity]) => ({ product_id, variation_id, quantity, sku: '' })),
})

const CURSOR = '2026-11-14T00:00:00.000Z'
const load = (d: WcHeldUnitsDeps, cursor: string | null = CURSOR) => loadWcHeldUnitsByProduct(d, cursor)

// Pages are served for the open (on-hold,processing) walk; `completed` is empty unless `completedPages` is given.
function deps(over: Partial<WcHeldUnitsDeps> & { pages?: unknown[][]; completedPages?: unknown[][]; totalOverride?: (call: number) => number | null; probeTotal?: number }): WcHeldUnitsDeps {
  const pages = over.pages ?? [[]]
  const completedPages = over.completedPages ?? [[]]
  let counts = 0
  return {
    fetchOrdersPage: over.fetchOrdersPage ?? (async (params) => {
      if (params.orderby === 'modified') return { data: [], totalItems: over.probeTotal ?? 0 } // the changed-during-the-walk probe
      const list = params.status === 'completed' ? completedPages : pages
      const total = list.reduce((n, p) => n + p.length, 0)
      if (params.per_page === '1') { counts++; return { data: [], totalItems: over.totalOverride ? over.totalOverride(counts) : total } }
      return { data: list[Number(params.page) - 1] ?? [], totalItems: total }
    }),
    findImportedOrders: over.findImportedOrders ?? (async () => new Map<string, Map<string, number>>()),
    findProducts: over.findProducts ?? (async () => [simple('p1', 11)]),
    findVariationIdsByParentExternalId: over.findVariationIdsByParentExternalId ?? (async () => []),
  }
}

test('BACS on-hold order IMS never imported is held against the product (the audit scenario)', async () => {
  const r = await load(deps({ pages: [[order(1, [11, 0, 1])]] }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), 1)
  // 1 unit in stock, nothing reserved: the absolute push must be 0, not 1.
  const { stockByProduct } = buildStockMaps([{ productId: 'p1', warehouseId: 'w', quantity: 1, reservedQty: 0 }], r.heldByProduct)
  assert.equal(stockByProduct.get('p1'), 0)
})

test('a linked, FULLY allocated order is not charged', async () => {
  const r = await load(deps({
    pages: [[order(1, [11, 0, 2]), order(2, [11, 0, 3])]],
    findImportedOrders: async () => new Map([['1', new Map([['p1', 2]])]]),
  }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), 3)
  assert.equal(r.ordersConsidered, 1)
})

test('a linked, PARTIALLY allocated order is charged its unallocated remainder; an unallocated one in full', async () => {
  const r = await load(deps({
    pages: [[order(1, [11, 0, 5]), order(2, [11, 0, 4])]],
    findImportedOrders: async () => new Map([['1', new Map([['p1', 2]])], ['2', new Map<string, number>()]]),
  }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), 3 + 4)
  assert.equal(unallocatedRemainder(new Map([['a', 2]]), new Map([['a', 5]])).size, 0) // over-coverage never goes negative
})

test('variation id wins over parent product id; sku is the fallback', () => {
  const products = [simple('parent', 10), simple('var', 12), simple('bysku', 99, 'SKU-X')]
  const { held, unresolvedLines } = aggregateHeldUnits(
    [
      { productId: 10, variationId: 12, sku: '', quantity: 2 },
      { productId: 0, variationId: 0, sku: 'SKU-X', quantity: 1 },
      { productId: 777, variationId: 0, sku: '', quantity: 5 }, // unknown: ignored
    ],
    products,
  )
  assert.equal(unresolvedLines.length, 0)
  assert.equal(held.get('var'), 2)
  assert.equal(held.get('parent'), undefined)
  assert.equal(held.get('bysku'), 1)
})

test('a KIT line is charged to its components (nested kits included), never to the kit', () => {
  const inner: HeldProductRef = { id: 'inner', sku: 'inner', type: 'KIT', externalProductId: null, components: [{ componentId: 'c2', qty: 3 }] }
  const kit: HeldProductRef = { id: 'kit', sku: 'kit', type: 'KIT', externalProductId: 50, components: [{ componentId: 'c1', qty: 2 }, { componentId: 'inner', qty: 1 }] }
  const { held } = aggregateHeldUnits([{ productId: 50, variationId: 0, sku: '', quantity: 2 }], [kit, inner, simple('c1', 1), simple('c2', 2)])
  assert.equal(held.get('c1'), 4)
  assert.equal(held.get('c2'), 6)
  assert.equal(held.get('kit'), undefined)
})

test('a kit cycle does not loop', () => {
  const a: HeldProductRef = { id: 'a', sku: 'a', type: 'KIT', externalProductId: 1, components: [{ componentId: 'b', qty: 1 }] }
  const b: HeldProductRef = { id: 'b', sku: 'b', type: 'KIT', externalProductId: null, components: [{ componentId: 'a', qty: 1 }] }
  assert.equal(aggregateHeldUnits([{ productId: 1, variationId: 0, sku: '', quantity: 1 }], [a, b]).held.size, 0)
})

test('held units come out of warehouse rows in turn and never below zero', () => {
  const { stockByProduct, stockByProductWarehouse } = buildStockMaps(
    [
      { productId: 'p', warehouseId: 'a', quantity: 2, reservedQty: 0 },
      { productId: 'p', warehouseId: 'b', quantity: 5, reservedQty: 1 },
    ],
    new Map([['p', 3]]),
  )
  assert.equal(stockByProduct.get('p'), 3) // 2 + 4 - 3
  assert.equal(stockByProductWarehouse.get('p')?.get('a'), 0)
  assert.equal(stockByProductWarehouse.get('p')?.get('b'), 3)
  assert.equal(buildStockMaps([{ productId: 'p', warehouseId: 'a', quantity: 1, reservedQty: 0 }], new Map([['p', 9]])).stockByProduct.get('p'), 0)
  // no held map: unchanged behaviour
  assert.equal(buildStockMaps([{ productId: 'p', warehouseId: 'a', quantity: 4, reservedQty: 1 }]).stockByProduct.get('p'), 3)
})

test('fails closed when the order read errors, throws, is not a list, or is truncated', async () => {
  const bad = async (d: Partial<WcHeldUnitsDeps> & { pages?: unknown[][] }) => (await load(deps(d))).ok
  assert.equal(await bad({ fetchOrdersPage: async () => ({ data: null, error: 'WC API error: 500' }) }), false)
  assert.equal(await bad({ fetchOrdersPage: async () => { throw new Error('boom') } }), false)
  assert.equal(await bad({ fetchOrdersPage: async () => ({ data: { not: 'a list' } }) }), false)
  assert.equal(await bad({ pages: [[{ id: 5, line_items: 'nope' }]] }), false)
})

test('walks multiple pages until a short one', async () => {
  const p1 = Array.from({ length: WC_HELD_ORDERS_PAGE_SIZE }, (_, i) => order(i + 1, [11, 0, 1]))
  const r = await load(deps({ pages: [p1, [order(999, [11, 0, 2])]] }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), WC_HELD_ORDERS_PAGE_SIZE + 2)
})

test('an unmapped variation is NEVER charged to its VARIABLE parent: its variations are blocked instead', async () => {
  const parent: HeldProductRef = { id: 'parent', sku: 'P', type: 'VARIABLE', externalProductId: 10, components: [] }
  const r = await load(deps({
    pages: [[order(1, [10, 555, 2])]],
    findProducts: async () => [parent],
    findVariationIdsByParentExternalId: async (ids) => (ids.includes(10) ? ['var-a', 'var-b'] : []),
  }))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.size, 0)
  assert.deepEqual([...r.blockedProductIds].sort(), ['var-a', 'var-b'])
})

test('a variation matches by its id, then by SKU', () => {
  const v = simple('v', 12, 'V-SKU')
  const viaSku = aggregateHeldUnits([{ productId: 10, variationId: 999, sku: 'V-SKU', quantity: 1 }], [v])
  assert.equal(viaSku.held.get('v'), 1)
  const none = aggregateHeldUnits([{ productId: 10, variationId: 999, sku: '', quantity: 1 }], [v])
  assert.equal(none.unresolvedLines.length, 1)
})

test('a huge queue is walked to its end (no 2,000-order freeze) and a short page ends it', async () => {
  const full = Array.from({ length: WC_HELD_ORDERS_PAGE_SIZE }, (_, i) => order(i + 1, [11, 0, 1]))
  let seq = 0
  const pages = [...Array.from({ length: 30 }, () => full.map((o) => ({ ...o, id: ++seq }))), [order(++seq, [11, 0, 1])]]
  const r = await load(deps({ pages }))
  assert.ok(r.ok)
  assert.equal(r.incomplete, false)
  assert.equal(r.heldByProduct.get('p1'), 30 * WC_HELD_ORDERS_PAGE_SIZE + 1)
})

test('hitting the safety ceiling reports truncated (the caller then pushes only forced zeros)', async () => {
  const full = Array.from({ length: WC_HELD_ORDERS_PAGE_SIZE }, (_, i) => order(i + 1))
  const r = await load(deps({ fetchOrdersPage: async () => ({ data: full, totalItems: 99999 }) }))
  assert.ok(r.ok)
  assert.equal(r.incomplete, true)
  assert.ok(WC_HELD_ORDERS_MAX_PAGES >= 100)
})

test('an unimported completed order inside the window is charged like any other', async () => {
  let asked = ''
  const d = deps({ completedPages: [[order(70, [11, 0, 2])]] })
  const inner = d.fetchOrdersPage
  d.fetchOrdersPage = async (p) => { if (p.status === 'completed' && p.orderby !== 'modified') asked = p.modified_after ?? ''; return inner(p) }
  const r = await load(d)
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), 2)
  assert.equal(asked, CURSOR)
})

test('completed window: cursor minus overlap; the older cursor wins; none = unbounded', () => {
  assert.equal(completedOrdersModifiedAfter('2026-11-15T00:00:00.000Z', null), null, 'a missing reconcile cursor cannot be bounded by the poll cursor')
  assert.equal(completedOrdersModifiedAfter('2026-11-15T00:00:00.000Z', '2026-11-10T00:00:00.000Z'), '2026-11-09T00:00:00.000Z')
  assert.equal(completedOrdersModifiedAfter(null, '2026-11-10T00:00:00.000Z'), null)
  assert.equal(completedOrdersModifiedAfter('garbage', null), null)
})

test('no cursor: completed orders are read EXHAUSTIVELY (no modified_after); a provable read is complete and charged', async () => {
  const asked: Array<Record<string, string>> = []
  const d = deps({ pages: [[order(1, [11, 0, 1])]], completedPages: [[order(2, [11, 0, 1])]] })
  const inner = d.fetchOrdersPage
  d.fetchOrdersPage = async (p) => { if (p.status === 'completed' && p.orderby !== 'modified') asked.push(p); return inner(p) }
  const r = await load(d, null)
  assert.ok(r.ok)
  assert.ok(asked.length > 0 && asked.every((p) => !('modified_after' in p)), 'unbounded read of completed orders')
  assert.equal(r.incomplete, false)
  assert.equal(r.heldByProduct.get('p1'), 2, 'the completed order is charged as well as the open one')
})

test('no cursor and the exhaustive read cannot be proven: incomplete (forced-zero only) with a reason naming the missing cursor', async () => {
  const d = deps({ pages: [[order(1, [11, 0, 1])]], completedPages: [[order(2, [11, 0, 1])]] })
  const inner = d.fetchOrdersPage
  d.fetchOrdersPage = async (p) => { const r = await inner(p); return p.status === 'completed' ? { ...r, totalItems: null } : r }
  const r = await load(d, null)
  assert.ok(r.ok)
  assert.equal(r.incomplete, true)
  assert.ok(r.incompleteReasons.some((x) => /sweep cursor is missing/.test(x)))
})

test('completeness proof: a changed total, a shifted (repeated) id, a missing header or a short count each mark it incomplete', async () => {
  const changed = await load(deps({ pages: [[order(1, [11, 0, 1])]], totalOverride: () => 2 }))
  assert.ok(changed.ok && changed.incomplete)
  const repeated = await load(deps({ pages: [[order(1, [11, 0, 1]), order(1, [11, 0, 1])]] }))
  assert.ok(repeated.ok && repeated.incomplete)
  const noHeader = await load(deps({ fetchOrdersPage: async () => ({ data: [order(1)], totalItems: null }) }))
  assert.ok(noHeader.ok && noHeader.incomplete)
  const short = await load(deps({ fetchOrdersPage: async (p) => (p.per_page === '1' ? { data: [], totalItems: 3 } : { data: [order(1)], totalItems: 3 }) }))
  assert.ok(short.ok && short.incomplete)
  const clean = await load(deps({ pages: [[order(1), order(2)]] }))
  assert.ok(clean.ok && !clean.incomplete)
})

// --- review findings: same-count churn, and the covered-history boundary for poll mode ---

test('a completed order leaving while another enters (total unchanged) shifts a page: the walk is NOT proven complete', async () => {
  // 101 completed orders. After page 1 is read, order 1 leaves `completed` and order 500 enters: the count stays 101, ids stay ascending,
  // order 101 slides onto the page already read and is never seen. The entering order was modified just now, which the probe reports.
  let ids = Array.from({ length: 101 }, (_, i) => i + 1)
  let pageReads = 0
  const d = deps({
    probeTotal: 1,
    fetchOrdersPage: async (params) => {
      if (params.orderby === 'modified') return { data: [], totalItems: 1 }
      if (params.status !== 'completed') return { data: [], totalItems: 0 }
      if (params.per_page === '1') return { data: [], totalItems: ids.length }
      const per = Number(params.per_page)
      const out = ids.slice((Number(params.page) - 1) * per, Number(params.page) * per).map((id) => order(id, [11, 0, 1]))
      if (++pageReads === 1) ids = [...ids.filter((id) => id !== 1), 500]
      return { data: out, totalItems: 101 }
    },
    findImportedOrders: async (xs) => new Map(xs.map((x) => [x, new Map([['p1', 1]])])),
  })
  const r = await load(d, null)
  assert.ok(r.ok)
  assert.equal(r.incomplete, true)
  assert.ok(r.incompleteReasons.some((x) => /changed while the walk was running/.test(x)))
  assert.equal(r.completedHistoryCoveredAtMs, null)
})

test('the churn probe asks for completed orders modified since just before the walk began; a failed probe is incomplete', async () => {
  const asked: Record<string, string>[] = []
  const before = Date.now()
  const d = deps({
    fetchOrdersPage: async (params) => {
      asked.push(params)
      if (params.orderby === 'modified') return { data: [], error: 'boom' }
      return { data: [], totalItems: 0 }
    },
  })
  const r = await load(d)
  assert.ok(r.ok)
  assert.equal(r.incomplete, true)
  const probe = asked.find((p) => p.orderby === 'modified')!
  assert.equal(probe.status, 'completed')
  assert.ok(Date.parse(probe.modified_after) <= before && Date.parse(probe.modified_after) >= before - 120_000)
})

test('a clean exhaustive read where every completed order is accounted for returns a covered-history boundary', async () => {
  const before = Date.now()
  const r = await load(deps({
    completedPages: [[order(1, [11, 0, 2]), order(2, [11, 0, 1])]],
    findImportedOrders: async (ids) => new Map(ids.map((id) => [id, new Map([['p1', 5]])])),
  }), null)
  assert.ok(r.ok)
  assert.equal(r.incomplete, false)
  assert.ok(r.completedHistoryCoveredAtMs !== null && r.completedHistoryCoveredAtMs >= before && r.completedHistoryCoveredAtMs <= Date.now())
})

test('no boundary when a completed order IMS does not hold, a bounded read, or an incomplete read', async () => {
  const unimported = await load(deps({ completedPages: [[order(1, [11, 0, 2])]] }), null)
  assert.ok(unimported.ok)
  assert.equal(unimported.completedHistoryCoveredAtMs, null, 'an unimported completed order is not settled')
  assert.equal(unimported.heldByProduct.get('p1'), 2)
  const bounded = await load(deps({
    completedPages: [[order(1, [11, 0, 2])]],
    findImportedOrders: async (ids) => new Map(ids.map((id) => [id, new Map([['p1', 5]])])),
  }), CURSOR)
  assert.ok(bounded.ok)
  assert.equal(bounded.completedHistoryCoveredAtMs, null, 'a bounded read proves nothing about older history')
  const incomplete = await load(deps({
    completedPages: [[order(1, [11, 0, 2])]], probeTotal: 3,
    findImportedOrders: async (ids) => new Map(ids.map((id) => [id, new Map([['p1', 5]])])),
  }), null)
  assert.ok(incomplete.ok)
  assert.equal(incomplete.completedHistoryCoveredAtMs, null)
})

test('completedOrdersModifiedAfter uses the covered-history boundary only when a sweep cursor is missing', () => {
  assert.equal(completedOrdersModifiedAfter('2026-11-15T00:00:00.000Z', null, '2026-11-12T00:00:00.000Z'), '2026-11-11T00:00:00.000Z')
  assert.equal(completedOrdersModifiedAfter(null, null, '2026-11-12T00:00:00.000Z'), '2026-11-11T00:00:00.000Z')
  assert.equal(completedOrdersModifiedAfter(null, null, 'garbage'), null)
  assert.equal(completedOrdersModifiedAfter(null, null, null), null)
  assert.equal(completedOrdersModifiedAfter('2026-11-15T00:00:00.000Z', '2026-11-10T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), '2026-11-09T00:00:00.000Z', 'both cursors present: they win')
})
