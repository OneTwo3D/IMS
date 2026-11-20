import assert from 'node:assert/strict'
import { cursorRaw } from './helpers/cursor-raw'
import { serveWcOrders, type StoreOrder } from './helpers/wc-order-store'
import test, { mock } from 'node:test'

import { MAX_WC_PAGE_WALK_PAGES, describeWcPageWalkCeilingStall } from '@/lib/connectors/woocommerce/api'

/**
 * THE ORDER SWEEP PAGES BY KEYSET ON MODIFICATION TIME, WITH EXPLICIT GMT FILTERS (o3d-hqvrp.87).
 *
 * The sweep used to filter on modification time, sort on CREATION date and page by offset: an order that left the status set mid-walk shifted every
 * later offset by one and one order was skipped, and an order modified mid-run after its page was read was never returned again. It now asks for
 * `orderby=modified`, sends `dates_are_gmt=true` with GMT values that carry no zone suffix (a Z-suffixed value is converted to site-local time before
 * the GMT comparison, which shifted the window by the BST offset), and moves its position by the last row's modified time, never by page number.
 *
 * REVERT EVIDENCE: on the offset walk "an order that leaves the status set mid-walk" fails (order 101 is never handled) and "an order modified after
 * its page was read" fails (it is handled once).
 */
type SettingRow = { key: string; value: string }

const settings = new Map<string, string>()
const fetchedPages: string[] = []
const requests: Array<Record<string, string>> = []
/** Every order the sweep handed to the import path, with the modified time of the version it handled. */
const handled: Array<{ id: number; modified: string }> = []
/** Called after every /orders read with the number of reads so far: lets a test change the store mid-run. */
let afterRead: ((reads: number) => void) | null = null
const settingUpserts: string[] = []
const activity: Array<Record<string, unknown>> = []

/** The orders the store holds; it honours `modified_after` / `modified_before` / `page` (the sweep pages by keyset on modification time). */
let storeOrders: StoreOrder[] = []
/** A store that never returns an empty page: every read answers with a fresh order (same modified second, so the keyset cannot advance). */

function settingRow(key: string): SettingRow | null {
  const value = settings.get(key)
  return value === undefined ? null : { key, value }
}

async function upsert({ where, create, update }: {
  where: { key: string }
  create: SettingRow
  update: { value: string }
}) {
  settingUpserts.push(where.key)
  settings.set(where.key, settings.has(where.key) ? update.value : create.value)
  return { key: where.key, value: settings.get(where.key) ?? '' }
}

const sweepDb: Record<string, unknown> = {}
mock.module('@/lib/db', {
  namedExports: {
    db: Object.assign(sweepDb, {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => settingRow(where.key),
        findMany: async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.map((key) => settingRow(key)).filter(Boolean),
        deleteMany: async ({ where }: { where: { key: string } }) => { settings.delete(where.key); return { count: 1 } },
        upsert,
      },
      salesOrder: { findFirst: async () => ({ id: 'so-1' }) },
      $queryRaw: async () => [],
      $executeRaw: cursorRaw((key, value) => upsert({ where: { key }, create: { key, value }, update: { value } })),
      // The cursor, its status fingerprint and the outage bookkeeping are written together, in one interactive transaction.
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => await run(sweepDb),
    }),
  },
})

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { activity.push(entry) } },
})

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (_path: string, params: Record<string, string>) => {
      // The cancellation backstop (o3d-hqvrp.82) reads cancelled/trash orders; it has its own test, so these sweep tests see no extra read.
      if (_path === '/orders' && (params?.status === 'cancelled' || params?.status === 'trash')) return { data: [], totalPages: 1, totalItems: 0 }
      const page = String(params.page ?? '1')
      fetchedPages.push(page)
      requests.push({ ...params })
      const rows = serveWcOrders(storeOrders, params)
      afterRead?.(requests.length)
      return { data: rows, totalPages: 1, totalItems: rows.length, error: null }
    },
    // The REAL describer, so the sentence the stall test reads is the shipped one.
    MAX_WC_PAGE_WALK_PAGES,
    describeWcPageWalkCeilingStall,
  },
})

/**
 * The per-ORDER import, stubbed at the boundary the sweep calls it through.
 *
 * `skipped-withdrawal` is the one outcome that makes the loop body a no-op with no error, so the
 * walk itself is what is under test rather than the order importer. A DIFFERENT outcome would push
 * into `result.errors` and hold the cursor for a reason this file is not about — which would make
 * every assertion below pass for the wrong reason.
 */
mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => ({ submitted: 'pending-wdraw', approved: 'withdrawn' }),
    importWcOrderGuarded: async (order: { id: number; date_modified_gmt: string }) => {
      handled.push({ id: order.id, modified: order.date_modified_gmt })
      return { outcome: 'skipped-withdrawal' }
    },
  },
})




function wcOrder(id: number, modified: string): StoreOrder {
  return { id, number: String(id), status: 'processing', line_items: [], date_modified_gmt: modified }
}

/** `n` orders, one modified second apart from 2026-08-01T10:00:00. */
function spread(n: number): StoreOrder[] {
  return Array.from({ length: n }, (_, i) => wcOrder(i + 1, new Date(Date.UTC(2026, 7, 1, 10, 0, i)).toISOString().replace(/\.\d{3}Z$/, '')))
}

async function runSweep(cursor?: string) {
  settings.clear()
  settings.set('wc_initial_import_completed', 'true')
  settings.set('wc_sync_order_statuses', '["processing"]')
  if (cursor) settings.set('last_wc_order_sync_at', cursor)
  fetchedPages.length = 0
  requests.length = 0
  handled.length = 0
  settingUpserts.length = 0
  activity.length = 0
  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return syncNewWcOrders({ mode: 'poll' })
}

const handledIds = () => handled.map((h) => h.id).sort((a, b) => a - b)

test('the request is ordered by modification time with explicit GMT filters (no zone suffix, second precision)', async () => {
  afterRead = null
  storeOrders = spread(3)
  const result = await runSweep('2026-08-01T09:00:00.123Z')
  assert.deepEqual(result.errors, [])
  const first = requests[0]!
  assert.equal(first.orderby, 'modified')
  assert.equal(first.order, 'asc')
  assert.equal(first.dates_are_gmt, 'true')
  assert.equal(first.modified_after, '2026-08-01T09:00:00', 'GMT, no Z, no milliseconds: WooCommerce would otherwise convert a Z value to site-local time first')
  assert.ok(requests.every((r) => !/[Zz]|\.\d{3}/.test(r.modified_after ?? '')), 'every date filter the sweep sends is the suffix-less GMT form')
  assert.ok(requests.every((r) => r.dates_are_gmt === 'true'))
  assert.deepEqual(handledIds(), [1, 2, 3])
})

test('an order that leaves the status set mid-walk does not make a later order skipped', async () => {
  storeOrders = spread(250)
  // After the FIRST page is read, order 5 (already read) is cancelled out of the selected statuses. With offset paging, page 2 would start one order late.
  afterRead = (reads) => { if (reads === 1) storeOrders = storeOrders.filter((o) => o.id !== 5) }
  const result = await runSweep()
  afterRead = null
  assert.deepEqual(result.errors, [])
  const expected = Array.from({ length: 250 }, (_, i) => i + 1)
  assert.deepEqual(handledIds(), expected, 'every order was handled, including 101 (the first one a shifted offset would skip)')
  assert.ok(settingUpserts.includes('last_wc_order_sync_at'), 'a clean walk earns the cursor')
})

test('an order modified after its page was read is read again at its newer time', async () => {
  storeOrders = spread(250)
  afterRead = (reads) => {
    if (reads === 1) storeOrders = storeOrders.map((o) => (o.id === 3 ? { ...o, date_modified_gmt: '2026-08-01T10:30:00' } : o))
  }
  const result = await runSweep()
  afterRead = null
  assert.deepEqual(result.errors, [])
  const three = handled.filter((h) => h.id === 3)
  assert.equal(three.length, 2, 'the first version, then the version modified mid-run')
  assert.equal(three[1]!.modified, '2026-08-01T10:30:00')
})

test('re-reading the overlap is idempotent: an order already handled at the same modified time is not handled twice', async () => {
  storeOrders = spread(250)
  afterRead = null
  await runSweep()
  const counts = new Map<number, number>()
  for (const h of handled) counts.set(h.id, (counts.get(h.id) ?? 0) + 1)
  assert.ok([...counts.values()].every((n) => n === 1), 'each of the 250 orders handled exactly once')
  assert.equal(counts.size, 250)
})

test('a block of orders sharing one modified second that fills a page is still read in full', async () => {
  storeOrders = Array.from({ length: 230 }, (_, i) => wcOrder(i + 1, '2026-08-01T10:00:00'))
  afterRead = null
  const result = await runSweep()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(handledIds(), Array.from({ length: 230 }, (_, i) => i + 1))
  assert.ok(settingUpserts.includes('last_wc_order_sync_at'))
})

test('a clean walk ends only on an empty page (a short page is not proof of an ending)', async () => {
  storeOrders = spread(3)
  afterRead = null
  await runSweep()
  const last = requests.at(-1)!
  assert.ok(fetchedPages.length >= 2)
  assert.equal(serveWcOrders(storeOrders, last).length, 0, 'the final read came back empty')
})
