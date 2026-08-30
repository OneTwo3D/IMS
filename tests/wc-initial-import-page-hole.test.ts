import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-batch-wcsync ROUND 3 (Codex CRITICAL + HIGH) — A SKIPPED PAGE PASSED THE IMPORT AS COMPLETE.
 *
 * The initial import is the run that GATES live order sync. On a page fetch error it did
 * `errors.push(...); page++; continue` — it SKIPPED the page. It then reached an empty page
 * perfectly normally, so `endedOnEmptyPage` was true and the truncation input read FALSE; the
 * outcome function is "errors and no progress -> failed, else complete", so with any orders imported
 * it returned COMPLETE. That wrote `wc_initial_import_completed`, unlocked live order sync and
 * stamped `last_wc_order_sync_at` — and the orders on the skipped page are permanently behind it,
 * because the live sweeps are cursor-based and the backfill is the only thing that reads history.
 * Truncation was detected at the TAIL; a hole in the MIDDLE — the likelier transient 500 or timeout
 * — walked straight through.
 *
 * EVERY TEST HERE DRIVES THE REAL `runInitialImport` (through `startInitialImport`) and asserts on
 * the SETTINGS IT WROTE. None of them reads the source. The round that introduced the tail check
 * shipped four source-text greps in its place, and wrapping the very push they asserted in
 * `if (false && …)` left the whole suite green — so the assertions here are the two settings rows
 * that decide whether live sync unlocks.
 *
 * REVERT EVIDENCE (each verified by making that one change and re-running this file):
 *   * putting `page++; continue` back in place of the `break` in initial-import.ts fails
 *     "a page that could not be read does NOT pass the import as complete".
 *   * dropping `unreadPages` from the `decideInitialImportOutcome` call fails the same test.
 *   * `if (false && …)` around the `unreadPages++` push fails it too.
 */

type SettingRow = { key: string; value: string }

const settings = new Map<string, string>()
const fetchedPages: string[] = []
const notifications: Array<{ type: string; title: string; message: string }> = []
const importedOrderIds: number[] = []

/**
 * What the store does with each page: rows to return, or an error.
 *
 * PAGE-AWARE and ERROR-AWARE, because both are what is under test. A double that served the same
 * page for every request would be a store ignoring `page`, and one that could not fail a single page
 * could not produce the hole this file exists for.
 */
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
        findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
          where.key.in.map(settingRow).filter((row): row is SettingRow => row !== null),
        upsert: async ({ where, create, update }: {
          where: { key: string }
          create: SettingRow
          update: { value: string }
        }) => {
          settings.set(where.key, settings.has(where.key) ? update.value : create.value)
          return { key: where.key, value: settings.get(where.key) ?? '' }
        },
      },
      shoppingOrderLink: { findMany: async () => [] },
    },
  },
})

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/notifications', {
  namedExports: {
    notify: (payload: { type: string; title: string; message: string }) => { notifications.push(payload) },
  },
})

// The REAL describers, so the operator-facing sentence this run produces is the shipped one and not
// a stand-in this file wrote for itself. Only `wcFetch` is replaced.
import {
  MAX_WC_PAGE_WALK_PAGES,
  describeUnendedWcPageWalk,
  describeUnreadWcPage,
} from '@/lib/connectors/woocommerce/api'

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

/**
 * The per-ORDER import, stubbed at the boundary the walk calls it through.
 *
 * DELIBERATELY does not invoke `run()`. What is under test is the WALK — which pages were read and
 * what the pass concluded about the collection — and dragging the real `importWcOrder` in would put
 * a hundred unrelated database expectations between the store double and the assertion. Each order
 * is reported as imported, so the walk makes real progress and `decideInitialImportOutcome` sees the
 * "made progress" it needs to be tempted into COMPLETE.
 */
mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => ({ submitted: 'pending-wdraw', approved: 'withdrawn' }),
    importWcOrderGuarded: async (order: { id: number }) => {
      importedOrderIds.push(order.id)
      return { outcome: 'imported', result: { success: true, orderId: `ims-${order.id}` }, compensationFailed: false }
    },
  },
})

/** An order the guarded import reports as imported, so the walk makes real progress. */
function wcOrder(id: number) {
  return { id, number: String(id), line_items: [], status: 'processing' }
}

async function runImport() {
  settings.clear()
  settings.set('wc_sync_order_statuses', '["processing"]')
  deferred.length = 0
  fetchedPages.length = 0
  notifications.length = 0
  importedOrderIds.length = 0

  const { startInitialImport, getInitialImportProgress } = await import(
    '@/lib/connectors/woocommerce/sync/initial-import'
  )
  await startInitialImport()
  await Promise.all(deferred)
  return getInitialImportProgress()
}

// ---------------------------------------------------------------------------
// The control: this is what a genuinely complete read looks like.
// ---------------------------------------------------------------------------

test('a clean walk that reaches an empty page unlocks live order sync', async () => {
  pages = { '1': { rows: [wcOrder(1), wcOrder(2)] }, '2': { rows: [] } }

  const progress = await runImport()

  assert.equal(progress.status, 'done')
  assert.equal(settings.get('wc_initial_import_completed'), 'true')
  assert.ok(settings.get('last_wc_order_sync_at'), 'and the live-sync cursor is stamped')
  assert.deepEqual(importedOrderIds, [1, 2])
  assert.equal(notifications[0]?.type, 'success')
})

// ---------------------------------------------------------------------------
// THE CRITICAL: a hole in the middle.
// ---------------------------------------------------------------------------

test('a page that could not be read does NOT pass the import as complete', async () => {
  // Page 2 fails; page 3 would have been fine, and page 4 is the empty page that used to make the
  // whole read look finished. This is the transient-500 shape, not an exotic one.
  pages = {
    '1': { rows: [wcOrder(1)] },
    '2': { error: 'HTTP 500 from WooCommerce' },
    '3': { rows: [wcOrder(3)] },
    '4': { rows: [] },
  }

  const progress = await runImport()

  // The two writes that matter. Either one alone lets orders be lost for ever.
  assert.equal(
    settings.has('wc_initial_import_completed'),
    false,
    'live order sync must stay gated: the orders on page 2 were never read, and nothing else reads history',
  )
  assert.equal(
    settings.has('last_wc_order_sync_at'),
    false,
    'and the cursor must not advance past orders that were never imported',
  )
  assert.equal(progress.status, 'error')
  assert.equal(notifications[0]?.type, 'error')

  // Orders that DID import are still imported — refusing the pass is not refusing the work.
  assert.deepEqual(importedOrderIds, [1])
})

test('and it says a PAGE is missing, not that the store never ended', async () => {
  pages = { '1': { rows: [wcOrder(1)] }, '2': { error: 'socket hang up' }, '3': { rows: [] } }

  const progress = await runImport()

  // The two incomplete reads need different sentences: "we never saw the end" sends an operator to
  // look at x-wp-totalpages, which is fine here.
  assert.match(progress.message, /page 2 could not be read/)
  assert.doesNotMatch(progress.message, /never returned an empty page/)
  assert.equal(
    progress.errors.some((line) => line.includes('could not read page 2') && line.includes('socket hang up')),
    true,
    'the store’s own error text reaches the operator',
  )
  assert.equal(
    progress.errors.some((line) => line.includes('did not reach an empty page')),
    false,
    'our own break must not be reported as the store failing to end',
  )
})

// ---------------------------------------------------------------------------
// THE HIGH: the walk stops on the unread page instead of grinding to the ceiling.
// ---------------------------------------------------------------------------

test('an unreachable store costs ONE page, not the whole ceiling', async () => {
  // Every page fails. Skipping meant walking all 1000 — 1000 x (3 attempts x a 120s timeout +
  // backoff) — writing a progress row each time and re-serialising a growing error array into one
  // settings row. The pass has already failed on page 1, so the rest cannot change the outcome.
  pages = {}
  for (let page = 1; page <= 20; page++) pages[String(page)] = { error: 'connect ETIMEDOUT' }

  await runImport()

  // Three attempts at page 1 and then nothing — asserted as a COUNT of distinct pages, so a walk
  // that carried on would fail here however many times it retried each one.
  assert.deepEqual([...new Set(fetchedPages)], ['1'], 'the walk must not ask for page 2 at all')
  assert.equal(settings.has('wc_initial_import_completed'), false)
})

test('a page that recovers on a later attempt is not a hole — the retry is still there', async () => {
  // The 3-attempt retry is what makes "could not read" mean something. Losing it would turn every
  // blip into a failed pass, which is the opposite over-correction.
  let attempts = 0
  pages = {} as typeof pages
  // A getter rather than a spread: spreading would evaluate it once and freeze the first answer,
  // which is a store that always fails — the opposite of the flakiness under test.
  Object.defineProperty(pages, '1', {
    enumerable: true,
    get: () => {
      attempts++
      return attempts < 3 ? { error: 'temporary blip' } : { rows: [wcOrder(1)] }
    },
  })
  Object.defineProperty(pages, '2', { enumerable: true, value: { rows: [] } })

  const progress = await runImport()

  assert.ok(attempts >= 3, 'the page was retried rather than failed on the first error')
  assert.equal(settings.get('wc_initial_import_completed'), 'true', 'a recovered page is a read page')
  assert.equal(progress.status, 'done')
})

// ---------------------------------------------------------------------------
// The tail check the CRITICAL sat beside — still enforced, and now behaviourally.
// ---------------------------------------------------------------------------

test('a walk that never reaches an empty page still cannot pass, and says the OTHER thing', async () => {
  // A store that ignores `page`: every page comes back full, so the walk runs to the ceiling. This
  // is the case the round-2 tail check was written for, asserted here through the settings rather
  // than through a grep for the push that produces it.
  pages = new Proxy({}, { get: () => ({ rows: [wcOrder(1)] }) }) as typeof pages

  const progress = await runImport()

  assert.equal(settings.has('wc_initial_import_completed'), false, 'nothing about the store was established')
  assert.equal(settings.has('last_wc_order_sync_at'), false)
  assert.match(progress.message, /never returned an empty page/)
  assert.doesNotMatch(progress.message, /could not be read/, 'the store answered every page — this is the other cause')
  // The error line itself, not just the summary: it is the record an operator reads on the Sync
  // page, and the round-2 grep that stood in for this assertion could not see whether it was ever
  // pushed. It names the shared ceiling, so a walk that stops early for another reason is distinct.
  assert.equal(
    progress.errors.some((line) => line.includes('did not reach an empty page') && line.includes('ceiling 1000')),
    true,
    'the incomplete read is RECORDED, not merely implied by the failed outcome',
  )
})

test('the truncation flag is what fails the pass — a full walk with per-order errors still completes', async () => {
  // The counterweight, and the mutation that matters. If `truncatedRead` is ever passed a constant
  // false, the test above still fails (nothing else would gate the pass) — but this one pins the
  // OTHER half of the rule, so the flag cannot be replaced by "any error fails the pass" either.
  // Per-ORDER errors are deliberately outvoted by progress: live sync can carry the rest.
  pages = { '1': { rows: [wcOrder(1), wcOrder(2)] }, '2': { rows: [] } }
  const { decideInitialImportOutcome } = await import('@/lib/connectors/woocommerce/sync/initial-import')

  await runImport()
  assert.equal(settings.get('wc_initial_import_completed'), 'true')

  // And the rule those settings came from, stated directly on the pure function.
  assert.equal(decideInitialImportOutcome({ imported: 5, skipped: 0, errorCount: 3, unrecordedRefusals: 0 }), 'complete')
  assert.equal(decideInitialImportOutcome({ imported: 5, skipped: 0, errorCount: 3, truncatedRead: true, unrecordedRefusals: 0 }), 'failed')
  assert.equal(decideInitialImportOutcome({ imported: 5, skipped: 0, errorCount: 3, unreadPages: 1, unrecordedRefusals: 0 }), 'failed')
  assert.equal(
    decideInitialImportOutcome({ imported: 500, skipped: 500, errorCount: 0, unreadPages: 1, unrecordedRefusals: 0 }),
    'failed',
    'no amount of progress outvotes a page that was never read',
  )
})
