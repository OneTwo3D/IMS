import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { MAX_WC_PAGE_WALK_PAGES, describeUnendedWcPageWalk, describeUnreadWcPage } from '@/lib/connectors/woocommerce/api'

/**
 * o3d-batch-wcsync ROUND 3 (Codex HIGH + MEDIUM) — THE HISTORICAL BACKFILL.
 *
 * Two findings meet in this job, and the second is why the first went unnoticed for so long.
 *
 *   1. THE CEILING TURNED A STORE OUTAGE INTO A MULTI-DAY RETRY STORM. The bound became the
 *      1000-page ceiling while the page-error branch kept `page++; continue`. An unreachable store
 *      used to exit after one page (the header said one page); it then walked all 1000, each one
 *      three attempts at a 120-second timeout plus backoff, writing a progress row per page and
 *      re-serialising a growing error array into one settings row each time.
 *
 *   2. AND IT STILL ANNOUNCED SUCCESS. The completion notification rebuilt its own sentence from
 *      `ordersProcessed`/`movementsCreated`, so the "N page errors." clause `progress.message`
 *      carries — the ONLY place either incompleteness surfaced — never reached it, and neither did
 *      the activity-log line. A backfill that read a fifth of its window reported "Historical Import
 *      Complete — Imported 100 orders", and the demand forecasting this feeds then treats a partial
 *      window as the real history.
 *
 * These drive the real `runImport` (through `startHistoricalImport`) and assert on the notification
 * an operator actually receives and on the pages the store was actually asked for.
 *
 * REVERT EVIDENCE (each verified by making that one change and re-running this file):
 *   * putting `page++; continue` back fails "an unreachable store costs ONE page, not the ceiling".
 *   * reverting the notification to `type: 'success'` with its own sentence fails "a window that was
 *     not fully read does not announce success".
 */

type SettingRow = { key: string; value: string }

const settings = new Map<string, string>()
const fetchedPages: string[] = []
const notifications: Array<{ type: string; title: string; message: string }> = []
const activity: Array<Record<string, unknown>> = []
const createdMovements: Array<Record<string, unknown>> = []

let pages: Record<string, { rows: Array<Record<string, unknown>> } | { error: string }> = {}

function settingRow(key: string): SettingRow | null {
  const value = settings.get(key)
  return value === undefined ? null : { key, value }
}

const deferred: Array<Promise<unknown>> = []
mock.module('next/server', {
  namedExports: {
    after: (fn: () => Promise<void> | void) => { deferred.push(Promise.resolve(fn())) },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => settingRow(where.key),
        upsert: async ({ where, create, update }: {
          where: { key: string }
          create: SettingRow
          update: { value: string }
        }) => {
          settings.set(where.key, settings.has(where.key) ? update.value : create.value)
          return { key: where.key, value: settings.get(where.key) ?? '' }
        },
      },
      product: { findMany: async () => [{ id: 'ims-1', sku: 'SKU-1' }] },
      stockMovement: {
        findMany: async () => [],
        createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
          createdMovements.push(...data)
          return { count: data.length }
        },
      },
    },
  },
})

mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { activity.push(entry) } },
})
mock.module('@/lib/notifications', {
  namedExports: {
    notify: (payload: { type: string; title: string; message: string }) => { notifications.push(payload) },
  },
})

// Only `wcFetch` is replaced; the describers are the shipped ones, so the sentence an operator gets
// is the real one rather than a stand-in this file wrote for itself.
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (_path: string, params: Record<string, string>) => {
      const page = String(params.page ?? '1')
      fetchedPages.push(page)
      const behaviour = pages[page] ?? { rows: [] }
      if ('error' in behaviour) return { data: null, totalPages: 0, totalItems: 0, error: behaviour.error }
      return { data: behaviour.rows, totalPages: 1, totalItems: behaviour.rows.length, error: null }
    },
    MAX_WC_PAGE_WALK_PAGES,
    describeUnendedWcPageWalk,
    describeUnreadWcPage,
  },
})

function wcOrder(id: number) {
  return {
    id,
    number: String(id),
    status: 'completed',
    date_created: '2026-01-05T00:00:00',
    currency: 'GBP',
    total: '10.00',
    line_items: [{ id: id * 10, sku: 'SKU-1', name: 'Widget', quantity: 1, total: '10.00' }],
  }
}

async function runHistoricalImport() {
  settings.clear()
  deferred.length = 0
  fetchedPages.length = 0
  notifications.length = 0
  activity.length = 0
  createdMovements.length = 0

  const { startHistoricalImport, getImportProgress } = await import('@/lib/connectors/woocommerce/orders')
  await startHistoricalImport('2026-01-01', '2026-01-31')
  await Promise.all(deferred)
  return getImportProgress()
}

test('the control: a window read to its empty page announces success', async () => {
  pages = { '1': { rows: [wcOrder(1), wcOrder(2)] }, '2': { rows: [] } }

  const progress = await runHistoricalImport()

  assert.equal(progress.status, 'done')
  assert.equal(createdMovements.length, 2)
  assert.equal(notifications[0]?.type, 'success')
  assert.equal(notifications[0]?.title, 'Historical Import Complete')
  assert.equal(activity[0]?.level, undefined, 'a clean run is not a warning')
})

test('an unreachable store costs ONE page, not the ceiling', async () => {
  // Page 1 fails and page 2 would be the (empty) end. With `page++; continue` the walk moves on to
  // page 2 — and against a store that is DOWN rather than one page short, it moved on to all 1000,
  // each three attempts at a 120-second timeout plus 2s+4s backoff, writing a progress row per
  // page. Asserting the DISTINCT pages asked for keeps this test fast whether or not the walk
  // stops: a walk that carries on fails on page 2 rather than after four days.
  pages = { '1': { error: 'connect ETIMEDOUT' }, '2': { rows: [] } }

  await runHistoricalImport()

  assert.deepEqual(
    [...new Set(fetchedPages)],
    ['1'],
    'the walk must stop on the first unread page rather than walking on towards the ceiling',
  )
  assert.equal(fetchedPages.length, 3, 'and the three attempts on that one page are still made')
})

test('a page that could not be read leaves a hole, and the job says so rather than announcing success', async () => {
  pages = {
    '1': { rows: [wcOrder(1)] },
    '2': { error: 'HTTP 502 from WooCommerce' },
    '3': { rows: [wcOrder(3)] },
    '4': { rows: [] },
  }

  const progress = await runHistoricalImport()

  // The notification is the only thing most operators see. It used to rebuild its own sentence from
  // the counts and drop every trace of the incompleteness.
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0]?.type, 'warning', 'a partial backfill is not a success')
  assert.equal(notifications[0]?.title, 'Historical Import Incomplete')
  assert.match(notifications[0]?.message ?? '', /NOT fully read/)
  assert.match(notifications[0]?.message ?? '', /page errors/, 'and it carries the count the summary line built')

  // The activity log is the durable record, and it was silent about it too.
  assert.equal(activity[0]?.level, 'WARNING')
  assert.match(String(activity[0]?.description), /INCOMPLETE/)

  assert.equal(
    progress.errors.some((line) => line.includes('could not read page 2') && line.includes('HTTP 502')),
    true,
  )
  // Page 3 was never asked for: the walk stops on the hole.
  assert.deepEqual([...new Set(fetchedPages)], ['1', '2'])
})

test('a walk that never reaches an empty page also refuses to announce success', async () => {
  // The other cause of an incomplete read — a store that ignores `page` — reaching the operator
  // through the same notification. This job has no cursor to hold, so the notification IS the
  // whole remedy: it is what tells someone to re-run the same dates.
  pages = new Proxy({}, { get: () => ({ rows: [wcOrder(1)] }) }) as typeof pages

  const progress = await runHistoricalImport()

  assert.equal(notifications[0]?.type, 'warning')
  assert.equal(notifications[0]?.title, 'Historical Import Incomplete')
  assert.match(notifications[0]?.message ?? '', /re-run this import for the same dates/)
  assert.equal(
    progress.errors.some((line) => line.includes('did not reach an empty page')),
    true,
    'and the incomplete read is RECORDED, not merely implied',
  )
})
