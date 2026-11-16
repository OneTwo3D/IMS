import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateHeldUnits,
  completedOrdersModifiedAfter,
  unallocatedRemainder,
  loadWcHeldUnitsByProduct,
  encodeCoveredHistoryBoundary,
  trustedCoveredHistoryBoundary,
  WC_ORDER_RESET_MARKER_KEY,
  WC_COMPLETED_HISTORY_COVERED_KEY,
  WC_DIRTY_MAX_FETCH_PER_RUN,
  type DirtyOrderInput,
  WC_HELD_ORDERS_MAX_PAGES,
  WC_HELD_ORDERS_PAGE_SIZE,
  type HeldProductRef,
  type WcHeldUnitsDeps,
} from '@/lib/connectors/woocommerce/sync/stock-held-orders'
import { buildStockMaps, persistCoveredHistoryBoundary } from '@/lib/connectors/woocommerce/sync/stock-sync'

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

// --- review round 2: a transaction reset (or a connection change) must void the covered-history boundary ---

function boundaryDb(rows: Record<string, string>) {
  return {
    rows,
    $transaction: async (fn: (tx: unknown) => Promise<boolean>) => fn({
      $executeRaw: async () => 0,
      setting: {
        findMany: async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.filter((k) => k in rows).map((key) => ({ key, value: rows[key] })),
        upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => { rows[where.key] = update.value; return {} },
      },
    }),
  }
}
const T0 = Date.parse('2026-11-10T00:00:00.000Z')

test('boundary trust: a reset after the boundary, a different connection generation, or garbage all distrust it', () => {
  const stored = encodeCoveredHistoryBoundary(T0, '3')
  assert.equal(trustedCoveredHistoryBoundary(stored, '3', null), new Date(T0).toISOString())
  assert.equal(trustedCoveredHistoryBoundary(stored, '3', new Date(T0 - 1000).toISOString()), new Date(T0).toISOString(), 'a reset BEFORE the proving walk is fine')
  assert.equal(trustedCoveredHistoryBoundary(stored, '3', new Date(T0 + 1000).toISOString()), null, 'a reset after it voids it')
  assert.equal(trustedCoveredHistoryBoundary(stored, '4', null), null, 'a rebind bumped the generation')
  assert.equal(trustedCoveredHistoryBoundary(stored, '3', 'garbage'), null)
  assert.equal(trustedCoveredHistoryBoundary('2026-11-10T00:00:00.000Z', '3', null), null, 'the old bare-timestamp form is not trusted')
  assert.equal(trustedCoveredHistoryBoundary(null, '3', null), null)
})

test('after a reset the next guard reads completed history EXHAUSTIVELY (the boundary no longer bounds the read)', async () => {
  const stored = encodeCoveredHistoryBoundary(T0, '1')
  const before = completedOrdersModifiedAfter(null, null, trustedCoveredHistoryBoundary(stored, '1', null))
  assert.ok(before !== null, 'bounded before the reset')
  const afterReset = completedOrdersModifiedAfter(null, null, trustedCoveredHistoryBoundary(stored, '1', new Date(T0 + 5000).toISOString()))
  assert.equal(afterReset, null)
  const asked: Array<Record<string, string>> = []
  const d = deps({ completedPages: [[order(9, [11, 0, 3])]] })
  const inner = d.fetchOrdersPage
  d.fetchOrdersPage = async (p) => { if (p.status === 'completed' && p.orderby !== 'modified') asked.push(p); return inner(p) }
  const r = await load(d, afterReset)
  assert.ok(r.ok)
  assert.ok(asked.length > 0 && asked.every((p) => !('modified_after' in p)))
  assert.equal(r.heldByProduct.get('p1'), 3, 'the old completed order, whose IMS allocation the reset deleted, is charged again')
})

test('a stale in-flight boundary write is refused after a reset or a rebind; a fresh one is accepted', async () => {
  const resetAt = new Date(T0 + 60_000).toISOString()
  const afterReset = boundaryDb({ wc_settings_version: '1', [WC_ORDER_RESET_MARKER_KEY]: resetAt })
  assert.equal(await persistCoveredHistoryBoundary(afterReset as never, T0, '1'), false, 'the walk began before the reset')
  assert.equal(WC_COMPLETED_HISTORY_COVERED_KEY in afterReset.rows, false)
  const rebound = boundaryDb({ wc_settings_version: '2' })
  assert.equal(await persistCoveredHistoryBoundary(rebound as never, T0, '1'), false, 'the connection changed since the run began')
  assert.equal(WC_COMPLETED_HISTORY_COVERED_KEY in rebound.rows, false)
  const fresh = boundaryDb({ wc_settings_version: '1', [WC_ORDER_RESET_MARKER_KEY]: new Date(T0 - 1000).toISOString() })
  assert.equal(await persistCoveredHistoryBoundary(fresh as never, T0, '1'), true)
  assert.equal(trustedCoveredHistoryBoundary(fresh.rows[WC_COMPLETED_HISTORY_COVERED_KEY], '1', fresh.rows[WC_ORDER_RESET_MARKER_KEY]), new Date(T0).toISOString())
  assert.equal(await persistCoveredHistoryBoundary(fresh as never, T0 - 5000, '1'), false, 'never moves backwards')
})

// --- o3d-hqvrp.385: an order whose allocation was released or deleted is re-checked by id; the boundary stays ---

const fresh = (...ids: string[]): DirtyOrderInput[] => ids.map((wcOrderId) => ({ wcOrderId, snapshot: null }))
const heldOrder = (id: number, status: string, ...lines: [number, number, number][]) => ({ ...order(id, ...lines), status })

/** Serves the bounded/unbounded completed walks and `include=` fetches; records what was asked. */
function dirtyDeps(opts: { dirty?: Record<string, unknown>; includeError?: string; completedBounded?: unknown[]; imported?: Map<string, Map<string, number>>; ceiling?: boolean }) {
  const asked: Array<Record<string, string>> = []
  const d = deps({
    findImportedOrders: async (ids) => new Map([...(opts.imported ?? new Map())].filter(([k]) => ids.includes(k))),
    fetchOrdersPage: async (params) => {
      asked.push(params)
      if ('include' in params) {
        if (opts.includeError) return { data: null, error: opts.includeError }
        return { data: params.include.split(',').map((id) => opts.dirty?.[id]).filter(Boolean), totalItems: null }
      }
      if (params.orderby === 'modified') return { data: [], totalItems: 0 }
      if (params.status === 'completed') {
        if (!('modified_after' in params) && opts.ceiling) {
          // an unbounded walk over a >10,000-order store: full pages for ever (the ceiling is reached, the picture is incomplete)
          return { data: Array.from({ length: WC_HELD_ORDERS_PAGE_SIZE }, (_, i) => order(1_000_000 + (Number(params.page) - 1) * 1000 + i, [11, 0, 1])), totalItems: 20_000 }
        }
        const list = opts.completedBounded ?? []
        if (params.per_page === '1') return { data: [], totalItems: list.length }
        return { data: Number(params.page) === 1 ? list : [], totalItems: list.length }
      }
      return { data: [], totalItems: 0 }
    },
  })
  return { d, asked }
}
const BOUND = completedOrdersModifiedAfter(null, null, trustedCoveredHistoryBoundary(encodeCoveredHistoryBoundary(T0, '1'), '1', null))

test('after a release the guard still uses the boundary AND fetches the released order by id; positives are not held and the order is charged', async () => {
  assert.ok(BOUND !== null)
  const { d, asked } = dirtyDeps({ dirty: { '9': heldOrder(9, 'completed', [11, 0, 3]) } })
  const r = await loadWcHeldUnitsByProduct(d, BOUND, fresh('9'))
  assert.ok(r.ok)
  assert.equal(r.incomplete, false, 'positive pushes stay enabled')
  assert.equal(r.heldByProduct.get('p1'), 3, 'the released, still-completed order is charged like an unimported completed order')
  assert.ok(asked.some((p) => p.include === '9'), 'fetched by id')
  assert.ok(asked.filter((p) => p.status === 'completed' && p.orderby !== 'modified').every((p) => p.modified_after === BOUND), 'the bulk completed read stays bounded by the boundary')
  assert.deepEqual(r.settledDirtyWcOrderIds, [], 'still held and uncovered: the entry stays, so it is charged on every run')
})

test('a released order IMS accounts for again, or one WooCommerce no longer holds, is settled; a charged one is not', async () => {
  const dirty = { '1': heldOrder(1, 'completed', [11, 0, 2]), '2': heldOrder(2, 'cancelled', [11, 0, 2]), '3': heldOrder(3, 'refunded', [11, 0, 2]), '4': heldOrder(4, 'processing', [11, 0, 5]) }
  const { d } = dirtyDeps({ dirty, imported: new Map([['1', new Map([['p1', 2]])]]) })
  const r = await loadWcHeldUnitsByProduct(d, BOUND, fresh('1', '2', '3', '4'))
  assert.ok(r.ok)
  assert.deepEqual([...r.settledDirtyWcOrderIds].sort(), ['1', '2', '3'])
  assert.equal(r.heldByProduct.get('p1'), 5, 'only order 4 is charged')
})

test('a dirty order the bulk walk already read is charged once, not twice', async () => {
  const o = heldOrder(9, 'completed', [11, 0, 3])
  const { d } = dirtyDeps({ dirty: { '9': o }, completedBounded: [o] })
  const r = await loadWcHeldUnitsByProduct(d, BOUND, fresh('9'))
  assert.ok(r.ok)
  assert.equal(r.heldByProduct.get('p1'), 3)
})

test('a failed fetch of a dirty order holds positives (incomplete) and settles nothing, so the entry is kept', async () => {
  const failed = await loadWcHeldUnitsByProduct(dirtyDeps({ includeError: 'WC API error: 503' }).d, BOUND, fresh('9'))
  assert.ok(failed.ok)
  assert.equal(failed.incomplete, true)
  assert.match(failed.incompleteReasons.join(';'), /could not be read from WooCommerce.*re-check read failed/)
  assert.deepEqual(failed.settledDirtyWcOrderIds, [])
  assert.equal(failed.completedHistoryCoveredAtMs, null)
  const missing = await loadWcHeldUnitsByProduct(dirtyDeps({ dirty: {} }).d, BOUND, fresh('9'))
  assert.ok(missing.ok)
  assert.equal(missing.incomplete, true, 'WooCommerce did not return it: not provable, never dropped')
  assert.deepEqual(missing.settledDirtyWcOrderIds, [])
})

test('a store past the 10,000-order walk ceiling keeps pushing positives after a release (the boundary still bounds the read)', async () => {
  const { d, asked } = dirtyDeps({ ceiling: true, dirty: { '9': heldOrder(9, 'completed', [11, 0, 3]) } })
  const r = await loadWcHeldUnitsByProduct(d, BOUND, fresh('9'))
  assert.ok(r.ok)
  assert.equal(r.incomplete, false)
  assert.equal(r.heldByProduct.get('p1'), 3)
  assert.ok(asked.filter((p) => p.status === 'completed' && p.orderby !== 'modified').every((p) => 'modified_after' in p), 'never an exhaustive completed read')
  // the contrast: with no boundary the same store cannot be proven (the ceiling), which is what rotating the boundary would have caused
  const exhaustive = await loadWcHeldUnitsByProduct(dirtyDeps({ ceiling: true }).d, null, [])
  assert.ok(exhaustive.ok)
  assert.equal(exhaustive.incomplete, true)
})

test('dirty orders are fetched in batches of 100 by id, within the per-run fetch budget', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => String(5000 + i))
  const { d, asked } = dirtyDeps({ dirty: Object.fromEntries(ids.map((id) => [id, heldOrder(Number(id), 'cancelled', [11, 0, 1])])) })
  const r = await loadWcHeldUnitsByProduct(d, BOUND, fresh(...ids))
  assert.ok(r.ok)
  assert.equal(asked.filter((p) => 'include' in p).length, 3)
  assert.equal(r.settledDirtyWcOrderIds.length, 250)
})

test('a failed refresh keeps charging the earlier snapshot (not incomplete); a never-read order that cannot be read is incomplete', async () => {
  const snap = { status: 'completed', lines: [{ productId: 11, variationId: 0, sku: '', quantity: 4 }] }
  const withSnapshot = await loadWcHeldUnitsByProduct(dirtyDeps({ includeError: 'WC API error: 503' }).d, BOUND, [{ wcOrderId: '9', snapshot: snap }])
  assert.ok(withSnapshot.ok)
  assert.equal(withSnapshot.heldByProduct.get('p1'), 4, 'never less than the last proven picture')
  assert.equal(withSnapshot.incomplete, false)
  assert.deepEqual(withSnapshot.settledDirtyWcOrderIds, [])
  const neverRead = await loadWcHeldUnitsByProduct(dirtyDeps({ includeError: 'WC API error: 503' }).d, BOUND, fresh('9'))
  assert.ok(neverRead.ok)
  assert.equal(neverRead.incomplete, true)
})

test('a live read still held is returned for the caller to remember; the snapshot of an order IMS now covers is settled', async () => {
  const { d } = dirtyDeps({ dirty: { '9': heldOrder(9, 'completed', [11, 0, 3]) } })
  const r = await loadWcHeldUnitsByProduct(d, BOUND, fresh('9'))
  assert.ok(r.ok)
  assert.deepEqual(r.refreshedDirty, [{ wcOrderId: '9', status: 'completed', lines: [{ productId: 11, variationId: 0, sku: '', quantity: 3 }] }])
  const snap = { status: 'completed', lines: [{ productId: 11, variationId: 0, sku: '', quantity: 3 }] }
  const covered = await loadWcHeldUnitsByProduct(dirtyDeps({ includeError: 'down', imported: new Map([['9', new Map([['p1', 3]])]]) }).d, BOUND, [{ wcOrderId: '9', snapshot: snap }])
  assert.ok(covered.ok)
  assert.deepEqual(covered.settledDirtyWcOrderIds, ['9'])
  assert.equal(covered.heldByProduct.get('p1'), undefined)
})

test('a persistent set far above the fetch budget never blocks for ever: positives go out within a few runs and every held order stays charged', async () => {
  const N = WC_DIRTY_MAX_FETCH_PER_RUN * 2 + 200
  const ids = Array.from({ length: N }, (_, i) => String(20_000 + i))
  const live = Object.fromEntries(ids.map((id) => [id, heldOrder(Number(id), 'completed', [11, 0, 1])]))
  const state = new Map<string, { snapshot: DirtyOrderInput['snapshot']; checkedAt: number }>(ids.map((id) => [id, { snapshot: null, checkedAt: 0 }]))
  const outcomes: Array<{ incomplete: boolean; held: number | undefined; fetched: number }> = []
  for (let run = 1; run <= 8; run++) {
    const entries = [...state.entries()]
      .sort(([, a], [, b]) => (a.snapshot === null ? 0 : 1) - (b.snapshot === null ? 0 : 1) || a.checkedAt - b.checkedAt)
      .map(([wcOrderId, e]) => ({ wcOrderId, snapshot: e.snapshot }))
    const { d, asked } = dirtyDeps({ dirty: live })
    const r = await loadWcHeldUnitsByProduct(d, BOUND, entries)
    assert.ok(r.ok)
    for (const x of r.refreshedDirty) state.set(x.wcOrderId, { snapshot: { status: x.status, lines: x.lines }, checkedAt: run })
    outcomes.push({ incomplete: r.incomplete, held: r.heldByProduct.get('p1'), fetched: asked.filter((p) => 'include' in p).length })
  }
  assert.ok(outcomes.every((o) => o.fetched <= WC_DIRTY_MAX_FETCH_PER_RUN / 100), 'the fetch budget bounds every run')
  assert.equal(outcomes[0]!.incomplete, true, 'unknown orders hold positives while they have never been read')
  const firstOk = outcomes.findIndex((o) => !o.incomplete)
  assert.ok(firstOk > 0 && firstOk <= 3, `positives go out by run ${firstOk + 1}`)
  for (const o of outcomes.slice(firstOk)) {
    assert.equal(o.incomplete, false)
    assert.equal(o.held, N, 'every held order is charged on every run, from its snapshot or a live read')
  }
})

test('a save to another store deletes the dirty entries; a same-store key rotation and a product-id cache reset re-bind them, in the bump transaction', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../app/actions/wc-sync.ts', import.meta.url), 'utf8')
  const rebind = 'await tx.wcStockDirtyOrder.updateMany({ data: { syncVersion: nextVersion } })'
  const save = src.slice(src.indexOf('export async function saveWcCredentials'), src.indexOf('export async function resetWcProductIdCache'))
  assert.ok(save.includes(`if (storeUrlChanging) await tx.wcStockDirtyOrder.deleteMany({})\n    else ${rebind}`), 'saveWcCredentials: delete only when the store URL changed from a known one, else re-bind')
  assert.ok(save.indexOf('wcStockDirtyOrder') > save.indexOf('WC_SETTINGS_VERSION_KEY, value: nextVersion'), 'after the bump, in its transaction')
  assert.doesNotMatch(save, /last_wc_order_(sync|reconcile)_at/, 'the save does not reset the order cursors, which is why a same-store save must keep the entries')
  const reset = src.slice(src.indexOf('export async function resetWcProductIdCache'))
  assert.ok(reset.includes(rebind) && !reset.includes('wcStockDirtyOrder.deleteMany'))
  assert.equal([...src.matchAll(/WC_SETTINGS_VERSION_KEY, value: nextVersion/g)].length, 2, 'and there is no third bump this misses')
  assert.ok(src.indexOf('async function resetWcProductIdCache') < src.lastIndexOf('updateMany({ data: { syncVersion: nextVersion } })'))
})
