import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { OUTBOUND_GRANT_ENV } from '@/lib/security/outbound-write-hold-constants'

/**
 * BACK-IN-STOCK DATE (o3d-taro), THROUGH THE DOMAIN RESOLVER AND pushStockToWc. No network: wcFetch / wcPost are mocked and every
 * database read is a fixture.
 *   - the date: earliest committed effective ETA, a late (past) source is excluded, an undated one is dropped, and an open ASN's eta
 *     wins over the PO date where it has one
 *   - clear on restock / supply gone / late
 *   - setting OFF (the default): the stock push is BYTE-IDENTICAL to the push without the feature and reads no supply
 *   - setting ON: the meta is written through the producer seam's product.meta operation (the hold), and a shadow there drops only the meta
 */

const ORIGIN = 'https://shop.example.com'
const DAY = 86_400_000
const NOW = new Date('2026-11-17T10:00:00.000Z')
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY)
const ymd = (offsetDays: number) => at(offsetDays).toISOString().slice(0, 10)
// The loader reads the wall clock, so the stock-push fixtures are dated relative to the real now.
const realAt = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY)
const realYmd = (offsetDays: number) => realAt(offsetDays).toISOString().slice(0, 10)

const settings = new Map<string, string>()
type Level = { productId: string; warehouseId: string; quantity: number; reservedQty: number }
let levels: Level[] = []
let candidates: Array<Record<string, unknown>> = []
let posts: Array<{ path: string; body: unknown }> = []
let upserts: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = []
let previousStates: Array<{ productId: string; lastPushedQty: number | null; lastPushedRemoteId: string | null; lastPushedEtaDate: string | null }> = []
let poLines: Array<Record<string, unknown>> = []
let asnLines: Array<Record<string, unknown>> = []
let poLineQueries: Array<Record<string, unknown>> = []
let seamOperations: string[] = []
let seamAnswer: (operation: string) => { proceed: true } | { proceed: false; shadowed: true } = () => ({ proceed: true })

function modelProxy(name: string) {
  return new Proxy({}, {
    get: (_t, method: string) => async (args?: Record<string, unknown> & { where?: { key?: string } }) => {
      if (name === 'setting' && method === 'findUnique') {
        const key = args?.where?.key ?? ''
        return settings.has(key) ? { key, value: settings.get(key) } : null
      }
      if (name === 'setting' && method === 'findMany') return [...settings].map(([key, value]) => ({ key, value }))
      if (name === 'warehouse' && method === 'findMany') return [{ id: 'w1' }]
      if (name === 'stockLevel' && method === 'findMany') return levels
      if (name === 'stockSyncState' && method === 'findMany') return previousStates
      if (name === 'stockSyncState' && method === 'upsert') {
        upserts.push({ create: args?.create as Record<string, unknown>, update: args?.update as Record<string, unknown> })
        return null
      }
      if (name === 'purchaseOrderLine' && method === 'findMany') {
        poLineQueries.push(args ?? {})
        const ids = (args as { where?: { productId?: { in?: string[] } } } | undefined)?.where?.productId?.in ?? []
        return poLines.filter((line) => ids.includes(line.productId as string))
      }
      if (name === 'wmsAsnLineMap' && method === 'findMany') return asnLines
      if (name === 'product' && method === 'findMany') {
        const ids = (args as { where?: { OR?: Array<{ id?: { in?: string[] } }> } } | undefined)?.where?.OR?.[0]?.id?.in
        return Array.isArray(ids) ? candidates.filter((c) => c.type === 'KIT' || ids.includes(c.id as string)) : candidates
      }
      if (name === 'product' && method === 'updateMany') return { count: 1 }
      if (name === 'product' && method === 'findUnique') {
        const found = candidates.find((p) => p.id === (args as { where?: { id?: string } } | undefined)?.where?.id)
        return found ? { externalProductId: found.externalProductId } : null
      }
      if (method === 'findMany') return []
      return null
    },
  })
}
const fakeDb: object = new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return undefined
    if (prop === '$executeRaw') return async () => 1
    if (prop === '$transaction') return async (fn: (tx: object) => unknown) => fn(fakeDb)
    return modelProxy(prop)
  },
})

mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined, logActivityPersisted: async () => true } })
mock.module('@/lib/connectors/woocommerce/producer-seam', {
  namedExports: {
    wooProducerSeam: async (input: { operation: string }) => {
      seamOperations.push(input.operation)
      const answer = seamAnswer(input.operation)
      return answer.proceed ? answer : { ...answer, notice: 'held', reason: 'test', recorded: true, occurrences: 1 }
    },
  },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (path: string, params: Record<string, string>) => {
      if (path === '/orders') return { data: [], totalItems: 0, totalItemsPresent: true }
      if (params.include) return { data: params.include.split(',').map((id) => ({ id: Number(id), sku: `S${id}` })) }
      return { data: [] }
    },
    wcPost: async (path: string, body: unknown) => {
      posts.push({ path, body })
      const update = (body as { update?: Array<{ id: number; stock_quantity: number }> }).update ?? []
      return { data: { update: update.map((u) => ({ id: u.id, stock_quantity: u.stock_quantity })) } }
    },
  },
})

const product = (id: string, sku: string, externalProductId: bigint, type = 'SIMPLE') => ({
  id, sku, type, lifecycleStatus: 'ACTIVE', externalProductId, parent: null, productComponents: [],
})
const L = (productId: string, quantity: number): Level => ({ productId, warehouseId: 'w1', quantity, reservedQty: 0 })
const poLine = (id: string, productId: string, lineEta: Date | null, headerEta: Date | null, qty = 10, received = 0) => ({
  id, productId, qty, qtyReceived: received, qtyReturned: 0, expectedDelivery: lineEta, po: { expectedDelivery: headerEta },
})

function reset(list: Level[]) {
  settings.clear()
  for (const [key, value] of Object.entries({ wc_url: ORIGIN, wc_consumer_key: 'ck_x', wc_consumer_secret: 'cs_x', wc_stock_sync_enabled: 'true', wc_back_in_stock_date_buffer_days: '0', last_wc_order_sync_at: '2026-11-15T00:00:00.000Z' })) settings.set(key, value)
  levels = list
  candidates = [product('a', 'S1', BigInt(1)), product('b', 'S2', BigInt(2))]
  posts = []
  upserts = []
  previousStates = []
  poLines = []
  asnLines = []
  poLineQueries = []
  seamOperations = []
  seamAnswer = () => ({ proceed: true })
}

async function run(options: { forceAll?: boolean } = { forceAll: true }) {
  const { pushStockToWc } = await import('@/lib/connectors/woocommerce/sync/stock-sync')
  const saved = process.env[OUTBOUND_GRANT_ENV.woocommerce]
  process.env[OUTBOUND_GRANT_ENV.woocommerce] = ORIGIN
  try {
    return await pushStockToWc(options)
  } finally {
    if (saved === undefined) delete process.env[OUTBOUND_GRANT_ENV.woocommerce]
    else process.env[OUTBOUND_GRANT_ENV.woocommerce] = saved
  }
}

const updates = () => posts.flatMap((p) => (p.body as { update?: Array<Record<string, unknown>> }).update ?? [])
const updateFor = (id: number) => updates().find((u) => u.id === id)

// ───────────────────────── 1. the date ─────────────────────────

test('resolver: the earliest committed effective ETA wins; the line date beats the header date', async () => {
  const { resolveBackInStockDates } = await import('@/lib/domain/inventory/back-in-stock-date')
  const result = resolveBackInStockDates([
    poLine('l1', 'a', at(20), at(5)),   // own date (+20) wins over the header (+5)
    poLine('l2', 'a', null, at(12)),    // inherits the header (+12)
    poLine('l3', 'b', null, at(30)),
  ], [], NOW)
  assert.equal(result.get('a'), ymd(12))
  assert.equal(result.get('b'), ymd(30))
})

test('resolver: a LATE (past-dated) source is excluded and never shown; today is not late', async () => {
  const { resolveBackInStockDates } = await import('@/lib/domain/inventory/back-in-stock-date')
  const result = resolveBackInStockDates([
    poLine('l1', 'a', null, at(-3)),               // late: dropped
    poLine('l2', 'b', null, at(-1)),               // late only: no date at all
    poLine('l3', 'c', null, NOW),                  // due today: kept
  ], [], NOW)
  assert.equal(result.has('b'), false, 'only a late source: no date is better than a past promise')
  assert.equal(result.get('c'), ymd(0))
  // a late source next to a future one: the future one is the only date shown, the late one is never rolled forward
  const mixed = resolveBackInStockDates([poLine('l1', 'a', null, at(-3)), poLine('l2', 'a', null, at(9))], [], NOW)
  assert.equal(mixed.get('a'), ymd(9))
})

test('resolver: undated, fully received and zero-outstanding lines produce no date', async () => {
  const { resolveBackInStockDates } = await import('@/lib/domain/inventory/back-in-stock-date')
  const result = resolveBackInStockDates([
    poLine('l1', 'a', null, null),
    poLine('l2', 'b', null, at(5), 10, 10),
  ], [], NOW)
  assert.equal(result.size, 0)
})

test('resolver: an open ASN eta WINS over the PO date; an ASN with no eta falls through to the PO date', async () => {
  const { resolveBackInStockDates } = await import('@/lib/domain/inventory/back-in-stock-date')
  const asn = (sourceLineId: string, eta: Date | null, expectedQty = 10) => ({ sourceLineId, expectedQty, qtyAccountedViaSnapshot: 0, qtyAccountedViaReceipt: 0, asn: { eta, status: 'OPEN' } })
  const result = resolveBackInStockDates([
    poLine('l1', 'a', null, at(6)),
    poLine('l2', 'b', null, at(6)),
  ], [asn('l1', at(15)), asn('l2', null)], NOW)
  assert.equal(result.get('a'), ymd(15), 'the ASN covers the whole line, so its (later, truer) eta is the date')
  assert.equal(result.get('b'), ymd(6), 'an ASN with no eta does not suppress or replace the PO date')
})

test('resolver: a half-covered line keeps both sources and takes the earliest resolved date; a late ASN eta is dropped', async () => {
  const { resolveBackInStockDates } = await import('@/lib/domain/inventory/back-in-stock-date')
  const asn = (sourceLineId: string, eta: Date | null, expectedQty: number) => ({ sourceLineId, expectedQty, qtyAccountedViaSnapshot: 0, qtyAccountedViaReceipt: 0, asn: { eta, status: 'OPEN' } })
  const half = resolveBackInStockDates([poLine('l1', 'a', null, at(8), 10)], [asn('l1', at(20), 4)], NOW)
  assert.equal(half.get('a'), ymd(8), 'the 6 uncovered units are dated by the PO, the 4 covered ones by the ASN: the earliest is shown')
  const lateAsn = resolveBackInStockDates([poLine('l1', 'a', null, at(8), 10)], [asn('l1', at(-2), 10)], NOW)
  assert.equal(lateAsn.has('a'), false, 'a late ASN covering the whole line leaves nothing dated: no date')
})

test('loader: only committed GOODS purchase orders are read, with every ASN row so landed units are counted', async () => {
  reset([])
  poLines = [poLine('l1', 'a', null, realAt(4))]
  const { loadBackInStockDates } = await import('@/lib/domain/inventory/back-in-stock-date')
  const { INCOMING_PO_STATUSES } = await import('@/lib/domain/inventory/po-status-sets')
  const result = await loadBackInStockDates(['a'])
  assert.equal(result.get('a'), realYmd(4))
  const where = poLineQueries[0].where as { po: { type: string; status: { in: string[] } } }
  assert.equal(where.po.type, 'GOODS')
  assert.deepEqual(where.po.status.in, INCOMING_PO_STATUSES)
  assert.deepEqual((await loadBackInStockDates([])).size, 0)
})

test('resolver: units WMS alignment already landed are NOT outstanding supply (o3d-taro Codex r1)', async () => {
  const { resolveBackInStockDates } = await import('@/lib/domain/inventory/back-in-stock-date')
  const asn = (sourceLineId: string, eta: Date | null, expectedQty: number, snapshot: number, receipt: number, status = 'OPEN') => (
    { sourceLineId, expectedQty, qtyAccountedViaSnapshot: snapshot, qtyAccountedViaReceipt: receipt, asn: { eta, status } })
  // 10-unit line, 5 landed by alignment (qtyReceived stays 0), PO ETA +2, open ASN for the 10 with ETA +10: the 5 remaining units are
  // covered by the ASN, so the date is +10, never the earlier PO date.
  const partial = resolveBackInStockDates([poLine('l1', 'a', null, at(2), 10, 0)], [asn('l1', at(10), 10, 5, 0)], NOW)
  assert.equal(partial.get('a'), ymd(10), 'landed units do not leave an uncovered remainder dated by the PO')
  // fully landed by alignment: nothing outstanding, no date from the PO or the ASN
  const full = resolveBackInStockDates([poLine('l1', 'a', null, at(2), 10, 0)], [asn('l1', at(10), 10, 10, 0)], NOW)
  assert.equal(full.has('a'), false)
  // receipt absorbed the same snapshot units: qtyReceived 5 + snapshot 5 / receipt 5 is 5 landed, not 10
  const absorbed = resolveBackInStockDates([poLine('l1', 'a', null, at(2), 10, 5)], [asn('l1', at(10), 10, 5, 5)], NOW)
  assert.equal(absorbed.get('a'), ymd(10), '5 units are still to come, all covered by the ASN: its date, and nothing double-counted')
  // landed units on a CLOSED ASN row still count as landed stock
  const closed = resolveBackInStockDates([poLine('l1', 'a', null, at(2), 10, 0)], [asn('l1', at(10), 10, 10, 0, 'CLOSED')], NOW)
  assert.equal(closed.has('a'), false, 'a closed row cannot date supply, and its landed units are not outstanding')
  // a closed ASN row does not cover the remainder of a part-landed line: the PO dates it
  const closedPartial = resolveBackInStockDates([poLine('l1', 'a', null, at(2), 10, 0)], [asn('l1', at(10), 10, 4, 0, 'CLOSED')], NOW)
  assert.equal(closedPartial.get('a'), ymd(2))
})

test('resolver: a closed-short ASN (closedAt set, status still PARTIALLY_BOOKED_IN) cannot date supply; its landed units still count (o3d-taro Codex r2)', async () => {
  const { resolveBackInStockDates } = await import('@/lib/domain/inventory/back-in-stock-date')
  const closedShort = { sourceLineId: 'l1', expectedQty: 10, qtyAccountedViaSnapshot: 0, qtyAccountedViaReceipt: 4, asn: { eta: at(3), status: 'PARTIALLY_BOOKED_IN', closedAt: at(-1) } }
  // 10-unit line, 4 received, the closed ASN's ETA (+3) must not date the 6 short units: the later PO date (+12) does
  const withPo = resolveBackInStockDates([poLine('l1', 'a', null, at(12), 10, 4)], [closedShort], NOW)
  assert.equal(withPo.get('a'), ymd(12))
  // no PO date: no date at all, never the closed ASN's
  const noPo = resolveBackInStockDates([poLine('l1', 'a', null, null, 10, 4)], [closedShort], NOW)
  assert.equal(noPo.has('a'), false)
  // the same ASN not closed still dates
  const open = resolveBackInStockDates([poLine('l1', 'a', null, at(12), 10, 4)], [{ ...closedShort, asn: { ...closedShort.asn, closedAt: null } }], NOW)
  assert.equal(open.get('a'), ymd(3))
})

// ───────────────────────── 2. setting OFF: byte-identical ─────────────────────────

test('setting OFF (absent, and "false"): the posted payloads are byte-identical and no supply is read', async () => {
  const levelsA = [L('a', 0), L('b', 5)]
  reset(levelsA.map((l) => ({ ...l })))
  poLines = [poLine('l1', 'a', null, realAt(6))]   // a committed future PO exists: it must make no difference
  await run()
  const absent = JSON.stringify(posts)
  assert.equal(absent, JSON.stringify([{ path: '/products/batch', body: { update: [{ id: 1, stock_quantity: 0, manage_stock: true }, { id: 2, stock_quantity: 5, manage_stock: true }] } }]), 'exactly the legacy body')
  assert.ok(!absent.includes('meta_data') && !absent.includes('_oti_eta_date'))
  assert.equal(poLineQueries.length, 0, 'no supply read')
  assert.deepEqual(seamOperations, ['stock'], 'the hold is asked for the stock write only')
  assert.ok(upserts.every((u) => !('lastPushedEtaDate' in u.create) && !('lastPushedEtaDate' in u.update)), 'no eta state is persisted')

  reset(levelsA.map((l) => ({ ...l })))
  poLines = [poLine('l1', 'a', null, realAt(6))]
  settings.set('wc_back_in_stock_date_enabled', 'false')
  await run()
  assert.equal(JSON.stringify(posts), absent)
})

test('setting OFF: a stored eta state does not change the dedupe either', async () => {
  reset([L('a', 0)])
  previousStates = [{ productId: 'a', lastPushedQty: 0, lastPushedRemoteId: '1', lastPushedEtaDate: '2026-12-01' }]
  await run({ forceAll: false })
  assert.equal(posts.length, 0, 'unchanged stock is skipped exactly as before')
})

// ───────────────────────── 3. setting ON ─────────────────────────

test('setting ON: a zero-stock product with committed future supply gets the date meta, asked through the product.meta seam', async () => {
  reset([L('a', 0), L('b', 5)])
  settings.set('wc_back_in_stock_date_enabled', 'true')
  poLines = [poLine('l1', 'a', null, realAt(9)), poLine('l2', 'b', null, realAt(9))]
  await run()
  assert.deepEqual(seamOperations, ['stock', 'product.meta'])
  assert.deepEqual(updateFor(1), { id: 1, stock_quantity: 0, manage_stock: true, meta_data: [{ key: '_oti_eta_date', value: realYmd(9) }] })
  assert.deepEqual(updateFor(2), { id: 2, stock_quantity: 5, manage_stock: true }, 'a product with stock gets no date, and no clear when it never had one')
  assert.equal(upserts.find((u) => u.create.productId === 'a')?.create.lastPushedEtaDate, realYmd(9))
})

test('setting ON, product.meta HELD: the stock push still goes, with no meta and no eta state', async () => {
  reset([L('a', 0)])
  settings.set('wc_back_in_stock_date_enabled', 'true')
  poLines = [poLine('l1', 'a', null, realAt(9))]
  seamAnswer = (operation) => (operation === 'product.meta' ? { proceed: false, shadowed: true } : { proceed: true })
  await run()
  assert.deepEqual(updateFor(1), { id: 1, stock_quantity: 0, manage_stock: true })
  assert.equal(poLineQueries.length, 0)
  assert.ok(upserts.every((u) => !('lastPushedEtaDate' in u.create)))
})

test('setting ON: a late or undated supply writes nothing; if a date had been pushed it is cleared', async () => {
  reset([L('a', 0), L('b', 0)])
  settings.set('wc_back_in_stock_date_enabled', 'true')
  poLines = [poLine('l1', 'a', null, realAt(-4)), poLine('l2', 'b', null, null)]
  previousStates = [{ productId: 'b', lastPushedQty: 0, lastPushedRemoteId: '2', lastPushedEtaDate: realYmd(-8) }]
  await run()
  assert.deepEqual(updateFor(1), { id: 1, stock_quantity: 0, manage_stock: true }, 'late and never pushed: nothing')
  assert.deepEqual(updateFor(2), { id: 2, stock_quantity: 0, manage_stock: true, meta_data: [{ key: '_oti_eta_date', value: '' }] }, 'undated now: the stale date is cleared')
  assert.equal(upserts.find((u) => u.create.productId === 'b')?.update.lastPushedEtaDate, '')
})

test('setting ON: CLEAR ON RESTOCK, even though the stock number alone would not change the dedupe', async () => {
  reset([L('a', 7)])
  settings.set('wc_back_in_stock_date_enabled', 'true')
  poLines = [poLine('l1', 'a', null, realAt(9))]                      // supply still exists; stock is back: no date
  previousStates = [{ productId: 'a', lastPushedQty: 7, lastPushedRemoteId: '1', lastPushedEtaDate: realYmd(9) }]
  await run({ forceAll: false })
  assert.deepEqual(updateFor(1), { id: 1, stock_quantity: 7, manage_stock: true, meta_data: [{ key: '_oti_eta_date', value: '' }] })
  assert.equal(poLineQueries.length, 0, 'a product with stock never has its supply read')
})

test('setting ON: an unchanged qty AND an unchanged date is skipped; a changed date alone is pushed', async () => {
  reset([L('a', 0)])
  settings.set('wc_back_in_stock_date_enabled', 'true')
  poLines = [poLine('l1', 'a', null, realAt(9))]
  previousStates = [{ productId: 'a', lastPushedQty: 0, lastPushedRemoteId: '1', lastPushedEtaDate: realYmd(9) }]
  await run({ forceAll: false })
  assert.equal(posts.length, 0)
  previousStates = [{ productId: 'a', lastPushedQty: 0, lastPushedRemoteId: '1', lastPushedEtaDate: realYmd(3) }]
  await run({ forceAll: false })
  assert.equal(updateFor(1)?.meta_data && (updateFor(1)!.meta_data as Array<{ value: string }>)[0].value, realYmd(9))
})

test('setting ON: a KIT never gets a date (its ETA is the latest component, out of scope)', async () => {
  reset([L('a', 0)])
  settings.set('wc_back_in_stock_date_enabled', 'true')
  candidates = [product('k', 'S3', BigInt(3), 'KIT')]
  poLines = [poLine('l1', 'k', null, realAt(9))]
  await run()
  assert.ok(!JSON.stringify(posts).includes('_oti_eta_date'))
  assert.equal(poLineQueries.length, 0)
})

// ───────────────────────── 4. the producer census ─────────────────────────

test('producer census: the stock writer is listed as governing product.meta as well, and the ownership map has the operation', async () => {
  const { WOO_SEAM_FUNCTIONS } = await import('@/scripts/producer-census-woocommerce')
  const { WRITER_OWNERSHIP_MAP } = await import('@/lib/security/writer-ownership-map')
  const stock = WOO_SEAM_FUNCTIONS.find((f) => f.decl === 'pushStockToWc')
  assert.ok(stock)
  assert.deepEqual([...stock.operations].sort(), ['product.meta', 'stock'])
  assert.ok(WRITER_OWNERSHIP_MAP.some((row) => row.destination === 'woocommerce' && row.operation === 'product.meta'))
})

test('buffer: the shown date is the supplier ETA + 3 days by default (owner decision 2026-11-18); lateness is judged on the supplier date', async () => {
  reset([])
  settings.delete('wc_back_in_stock_date_buffer_days')
  poLines = [poLine('l1', 'a', null, realAt(4)), poLine('l2', 'b', null, realAt(-1))]
  const { loadBackInStockDates } = await import('@/lib/domain/inventory/back-in-stock-date')
  const result = await loadBackInStockDates(['a', 'b'])
  assert.equal(result.get('a'), realYmd(7))
  assert.equal(result.has('b'), false, 'a late supplier date is still dropped, not rescued by the buffer')
})

test('buffer: configurable, 0 means the raw ETA, garbage falls back to 3', async () => {
  const { loadBackInStockDates, addDaysToDateOnly, parseBackInStockBufferDays } = await import('@/lib/domain/inventory/back-in-stock-date')
  reset([])
  poLines = [poLine('l1', 'a', null, realAt(4))]
  settings.set('wc_back_in_stock_date_buffer_days', '10')
  assert.equal((await loadBackInStockDates(['a'])).get('a'), realYmd(14))
  settings.set('wc_back_in_stock_date_buffer_days', '0')
  assert.equal((await loadBackInStockDates(['a'])).get('a'), realYmd(4))
  assert.equal(parseBackInStockBufferDays('abc'), 3)
  assert.equal(parseBackInStockBufferDays(undefined), 3)
  assert.equal(addDaysToDateOnly('2026-12-30', 3), '2027-01-02')
})
