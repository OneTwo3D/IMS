import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { MAX_WC_PAGE_WALK_PAGES, describeWcPageWalkCeilingStall } from '@/lib/connectors/woocommerce/api'

/**
 * o3d-batch-wcsync ROUND 3 (Codex HIGH + MEDIUM) — THE ORDER SWEEP'S CURSOR, ASSERTED BY BEHAVIOUR.
 *
 * `syncNewWcOrders` reads `?modified_after=<cursor>` and advances that cursor only on a fully clean
 * run. Everything downstream of an initial import depends on it: an order older than the cursor is
 * simply never fetched again, and no sweep reaches back past it.
 *
 * The round that made this walk end on an empty page pinned that rule with WHITESPACE-NORMALISED
 * SOURCE GREPS — `text.includes('if (orders.length === 0) { endedOnEmptyPage = true break }')` and
 * `assert.match(text, /describeUnendedWcPageWalk\(/)`. Neither can see whether the branch is
 * REACHED, whether its value is USED, or whether the cursor moves. Wrapping the push in
 * `if (false && …)` left every one of them green.
 *
 * These drive the real `syncNewWcOrders` and assert on the settings rows it upserted.
 *
 * REVERT EVIDENCE (each verified by making that one change and re-running this file):
 *   * `if (false && ranOutOfCeiling)` in order-import.ts fails "an unended sweep does NOT advance
 *     the cursor" and "running out of ceiling is escalated as a STALL".
 *   * deleting the `orders.length === 0` break fails the same two, from the other direction.
 */

type SettingRow = { key: string; value: string }

const settings = new Map<string, string>()
const fetchedPages: string[] = []
const settingUpserts: string[] = []
const activity: Array<Record<string, unknown>> = []

/** Pages the store serves for GET /orders. A Proxy models a store that never returns an empty one. */
let pages: Record<string, Array<Record<string, unknown>>> = {}

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

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: { findUnique: async ({ where }: { where: { key: string } }) => settingRow(where.key), upsert },
      salesOrder: { findFirst: async () => ({ id: 'so-1' }) },
      // The cursor and its status fingerprint are written together, as an array of upserts.
      $transaction: async (ops: Array<Promise<unknown>>) => await Promise.all(ops),
    },
  },
})

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { activity.push(entry) } },
})

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (_path: string, params: Record<string, string>) => {
      const page = String(params.page ?? '1')
      fetchedPages.push(page)
      const rows = pages[page] ?? []
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
    importWcOrderGuarded: async () => ({ outcome: 'skipped-withdrawal' }),
  },
})

function wcOrder(id: number) {
  return { id, number: String(id), status: 'processing', line_items: [] }
}

async function runSweep() {
  settings.clear()
  settings.set('wc_initial_import_completed', 'true')
  settings.set('wc_sync_order_statuses', '["processing"]')
  fetchedPages.length = 0
  settingUpserts.length = 0
  activity.length = 0

  const { syncNewWcOrders } = await import('@/lib/connectors/woocommerce/sync/order-import')
  return syncNewWcOrders({ mode: 'poll' })
}

test('[round 3] the control: a sweep that reaches an empty page advances the cursor', async () => {
  pages = { '1': [wcOrder(1), wcOrder(2)], '2': [] }

  const result = await runSweep()

  assert.deepEqual(result.errors, [])
  assert.equal(result.skipped, 2)
  assert.ok(settingUpserts.includes('last_wc_order_sync_at'), 'a complete read is what earns the cursor')
  assert.deepEqual(activity.filter((entry) => entry.action === 'wc_order_sync_ceiling_stall'), [])
})

test('[round 3] an unended sweep does NOT advance the cursor', async () => {
  // A store that ignores `page`: every page comes back full, so the walk runs to the ceiling
  // without ever being told the collection ended.
  let id = 1
  pages = new Proxy({}, { get: () => [wcOrder(id++)] }) as typeof pages

  const result = await runSweep()

  assert.equal(
    settingUpserts.includes('last_wc_order_sync_at'),
    false,
    'advancing here puts every order past the truncation permanently behind the cursor',
  )
  assert.equal(
    settingUpserts.includes('last_wc_order_sync_at_statuses'),
    false,
    'and the fingerprint must not move without the cursor it belongs to',
  )
  assert.equal(result.errors.length, 1, 'the incomplete read is RECORDED, not merely implied by the held cursor')
})

test('[round 3] running out of ceiling is escalated as a STALL, not left as one sync error line', async () => {
  // The MEDIUM, on this walk. The error above holds `last_wc_order_sync_at`, so the next sweep
  // rebuilds the identical `modified_after` window and stops in the identical place — for ever.
  // "It will be retried" was the wrong sentence: the retry IS the failure.
  let id = 1
  pages = new Proxy({}, { get: () => [wcOrder(id++)] }) as typeof pages

  const result = await runSweep()

  const stall = activity.filter((entry) => entry.action === 'wc_order_sync_ceiling_stall')
  assert.equal(stall.length, 1)
  assert.equal(stall[0].level, 'ERROR')
  assert.match(String(stall[0].description), /RETRYING CANNOT CLEAR IT/)
  assert.match(String(stall[0].description), /last_wc_order_sync_at/, 'and it names the cursor that is stuck')
  assert.equal(result.errors[0], stall[0].description, 'one sentence, in both places')
})

test('[round 3] the walk is bounded — a store that never ends does not run for ever', async () => {
  // The ceiling is the only thing between "keep asking until it is empty" and a loop that never
  // terminates. Asserted as the number of DISTINCT pages asked for, against the shared constant.
  let id = 1
  pages = new Proxy({}, { get: () => [wcOrder(id++)] }) as typeof pages

  await runSweep()

  assert.equal(new Set(fetchedPages).size, MAX_WC_PAGE_WALK_PAGES)
  assert.equal(fetchedPages.at(-1), String(MAX_WC_PAGE_WALK_PAGES))
})
