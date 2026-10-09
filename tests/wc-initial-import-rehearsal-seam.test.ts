import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE REHEARSAL SEAM IN THE INITIAL IMPORT (WooCommerce initial-import rehearsal).
 *
 * `runInitialImport(progress, { stampCompletion })` is the one place the one-shot, irreversible stamp is
 * written. A rehearsal passes `stampCompletion: false` and must leave both stamp keys unwritten whatever
 * the pass concluded; a real pass (the default, and what `startInitialImport` uses) must write both.
 *
 * Every test drives the REAL `runInitialImport` and asserts on the SETTINGS ROWS it wrote, never on the
 * source text.
 *
 * REVERT EVIDENCE (named mutations, each verified by making that one change and re-running this file):
 *   * STAMP ON A REHEARSAL: change `if (stampCompletion) {` to `if (true) {` in initial-import.ts and
 *     "a rehearsal pass writes neither stamp key" fails.
 *   * NO STAMP ON A REAL RUN: change it to `if (false) {` and "a real pass writes both stamp keys" fails.
 */

const settings = new Map<string, string>()
const notifications: Array<{ type: string }> = []
const importedOrderIds: number[] = []
let pages: Record<string, { rows: Array<Record<string, unknown>> } | { error: string }> = {}

const deferred: Array<Promise<unknown>> = []
mock.module('next/server', { namedExports: { after: (fn: () => Promise<void> | void) => { deferred.push(Promise.resolve(fn())) } } })

mock.module('@/lib/db', {
  namedExports: {
    db: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
        findMany: async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! })),
        upsert: async ({ where, create, update }: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => {
          settings.set(where.key, settings.has(where.key) ? update.value : create.value)
          return { key: where.key, value: settings.get(where.key) ?? '' }
        },
      },
      shoppingOrderLink: { findMany: async () => [] },
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: (payload: { type: string }) => { notifications.push(payload) } } })

import { MAX_WC_PAGE_WALK_PAGES, describeUnendedWcPageWalk, describeUnreadWcPage } from '@/lib/connectors/woocommerce/api'

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async (_path: string, params: Record<string, string>) => {
      const behaviour = pages[String(params.page ?? '1')] ?? { rows: [] }
      if ('error' in behaviour) return { data: null, totalPages: 0, totalItems: 0, error: behaviour.error }
      return { data: behaviour.rows, totalPages: 1, totalItems: behaviour.rows.length, error: null }
    },
    MAX_WC_PAGE_WALK_PAGES,
    describeUnendedWcPageWalk,
    describeUnreadWcPage,
  },
})
mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => ({ submitted: 'pending-wdraw', approved: 'withdrawn' }),
    importWcOrderGuarded: async (order: { id: number }) => {
      importedOrderIds.push(order.id)
      return { outcome: 'imported', result: { success: true, orderId: `ims-${order.id}` }, compensationFailed: false }
    },
  },
})

const order = (id: number) => ({ id, number: String(id), line_items: [], status: 'processing' })
const freshProgress = () => ({ status: 'running' as const, message: '', activeOrdersImported: 0, activeOrdersSkipped: 0, totalOrders: 0, currentPage: 0, totalPages: 0, errors: [] as string[] })

async function run(options?: { stampCompletion?: boolean }) {
  settings.clear()
  settings.set('wc_sync_order_statuses', '["processing"]')
  notifications.length = 0
  importedOrderIds.length = 0
  const { runInitialImport } = await import('@/lib/connectors/woocommerce/sync/initial-import')
  return runInitialImport(freshProgress(), options)
}

test('a rehearsal pass writes neither stamp key, and still imports and judges the pass complete', async () => {
  pages = { '1': { rows: [order(1), order(2)] }, '2': { rows: [] } }

  const result = await run({ stampCompletion: false })

  // PRECONDITION, printed: the pass really imported and really judged itself complete, so "no stamp"
  // is not the by-product of a pass that did nothing.
  console.log(`precondition: outcome=${result.outcome} imported=${result.progress.activeOrdersImported} orders=[${importedOrderIds}]`)
  assert.equal(result.outcome, 'complete')
  assert.deepEqual(importedOrderIds, [1, 2])
  assert.equal(result.progress.activeOrdersImported, 2)

  assert.equal(result.stamped, false)
  assert.equal(settings.has('wc_initial_import_completed'), false, 'the one-shot completion stamp is not written')
  assert.equal(settings.has('last_wc_order_sync_at'), false, 'the order-sync cursor is not moved')
  assert.match(result.progress.message, /REHEARSAL: not stamped/)
})

test('a real pass writes both stamp keys', async () => {
  pages = { '1': { rows: [order(1), order(2)] }, '2': { rows: [] } }

  const result = await run()

  console.log(`precondition: outcome=${result.outcome} imported=${result.progress.activeOrdersImported}`)
  assert.equal(result.outcome, 'complete')
  assert.equal(result.stamped, true)
  assert.equal(settings.get('wc_initial_import_completed'), 'true')
  assert.ok(Number.isFinite(Date.parse(settings.get('last_wc_order_sync_at') ?? '')), 'the cursor is a timestamp')
})

test('the default is a real pass: omitting the option, or passing undefined, stamps', async () => {
  pages = { '1': { rows: [order(1)] }, '2': { rows: [] } }
  assert.equal((await run({})).stamped, true)
  assert.equal((await run({ stampCompletion: undefined })).stamped, true)
})

test('a rehearsal pass over an unreadable page fails as a real one does (see wc-initial-import-page-hole) and stamps nothing', async () => {
  pages = { '1': { rows: [order(1)] }, '2': { error: 'HTTP 500' }, '3': { rows: [] } }

  const rehearsal = await run({ stampCompletion: false })

  console.log(`precondition: outcome=${rehearsal.outcome} unread page error recorded=${rehearsal.progress.errors.some((e) => e.includes('could not read page 2'))}`)
  assert.equal(rehearsal.outcome, 'failed')
  assert.equal(rehearsal.progress.errors.some((e) => e.includes('could not read page 2')), true)
  assert.equal(settings.has('wc_initial_import_completed'), false)
})

test('the pass reports the status list it resolved', async () => {
  pages = { '1': { rows: [] } }
  const result = await run({ stampCompletion: false })
  console.log(`resolved statuses: [${result.statuses}]`)
  assert.ok(result.statuses.includes('processing'))
})

test('startInitialImport declines once the stamp is set, and runs the pass otherwise', async () => {
  pages = { '1': { rows: [order(1)] }, '2': { rows: [] } }
  const { startInitialImport } = await import('@/lib/connectors/woocommerce/sync/initial-import')

  settings.clear()
  settings.set('wc_sync_order_statuses', '["processing"]')
  settings.set('wc_initial_import_completed', 'true')
  deferred.length = 0
  importedOrderIds.length = 0
  await startInitialImport()
  await Promise.all(deferred)
  assert.equal(deferred.length, 0, 'nothing was scheduled')
  assert.deepEqual(importedOrderIds, [])

  settings.delete('wc_initial_import_completed')
  await startInitialImport()
  await Promise.all(deferred)
  console.log(`precondition: scheduled ${deferred.length} pass, imported [${importedOrderIds}]`)
  assert.equal(deferred.length, 1)
  assert.deepEqual(importedOrderIds, [1])
  assert.equal(settings.get('wc_initial_import_completed'), 'true', 'the button\'s own path stamps')
})
