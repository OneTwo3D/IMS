import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * A MIXED-SUCCESS INITIAL IMPORT MUST NOT COMPLETE OVER AN UNRECORDED REFUSAL
 * (o3d-batch-ret r15, Codex HIGH).
 *
 * Round 14 made an admission refusal whose durable by-id queue row could not be confirmed come
 * back as an ordinary `success: false`, and wired the WEBHOOK to redeliver instead of ACKing. The
 * initial import is the SECOND caller of `importWcOrder` and it was left as it was: it pushed the
 * error onto `progress.errors` and carried on, and `decideInitialImportOutcome` returned
 * `complete` because other orders had imported. That stamps two settings — the completion flag,
 * so this backfill never runs again, and `last_wc_order_sync_at`, the cursor the ongoing
 * `?modified_after=` sweep starts from — and a historical order behind that cursor is reachable by
 * nothing at all: no webhook redelivers it, and there is no refusal row for the by-id drain.
 *
 * These drive the REAL `runInitialImport` (through `startInitialImport`) over a settings double,
 * so what is pinned is the production wiring and not a restatement of the decision function. The
 * three cases are asserted TOGETHER on purpose: the refusal case must withhold both writes, the
 * clean case must make both, and the RECORDED-refusal case must still complete — a guard that
 * blocked on any refusal at all would pass the first assertion and break the ordinary
 * "the operator excluded this status" path that the whole admission design rests on.
 */

type SettingRow = { key: string; value: string }

const settings = new Map<string, string>()
const attempted: number[] = []
/** WooCommerce order id -> what the importer double returns for it. */
const importOutcomes = new Map<number, Record<string, unknown>>()
const wcOrders = { current: [] as Array<Record<string, unknown>> }

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
mock.module('@/lib/notifications', { namedExports: { notify: () => {} } })

mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: {
    wcFetch: async () => ({ data: wcOrders.current, totalPages: 1, totalItems: wcOrders.current.length }),
  },
})

/**
 * The importer double returns EXACTLY the shapes `importWcOrder` returns, and refuses any order
 * the test did not describe — so a run that reached an order this file did not think about fails
 * loudly instead of being silently counted as an import.
 */
mock.module('@/lib/connectors/woocommerce/sync/order-import', {
  namedExports: {
    getWcPullStatuses: async () => ['processing'],
    importWcOrder: async (order: { id: number }) => {
      attempted.push(order.id)
      const outcome = importOutcomes.get(order.id)
      if (!outcome) throw new Error(`the importer double has no outcome for order ${order.id}`)
      return outcome
    },
  },
})

mock.module('@/lib/connectors/woocommerce/sync/withdrawal', {
  namedExports: {
    getWithdrawalStatuses: async () => ({ submitted: 'pending-wdraw', approved: 'withdrawn' }),
    importWcOrderGuarded: async (_order: { id: number }, run: () => Promise<unknown>) => ({
      outcome: 'imported' as const,
      suppressionHandled: false,
      compensationFailed: false,
      result: await run(),
    }),
  },
})

/** Run the real backfill over three orders, with the middle one's outcome supplied by the test. */
async function runImport(middleOutcome: Record<string, unknown>) {
  settings.clear()
  deferred.length = 0
  attempted.length = 0
  importOutcomes.clear()
  importOutcomes.set(9001, { success: true, orderId: 'so-9001' })
  importOutcomes.set(9002, middleOutcome)
  importOutcomes.set(9003, { success: true, orderId: 'so-9003' })
  wcOrders.current = [
    { id: 9001, number: '9001', status: 'processing' },
    { id: 9002, number: '9002', status: 'processing' },
    { id: 9003, number: '9003', status: 'processing' },
  ]

  const { startInitialImport, getInitialImportProgress } = await import(
    '@/lib/connectors/woocommerce/sync/initial-import'
  )
  await startInitialImport()
  await Promise.all(deferred)
  return getInitialImportProgress()
}

// --- the decision function --------------------------------------------------------------------

test('an unrecorded refusal blocks completion however well the rest of the pass went', async () => {
  const { decideInitialImportOutcome } = await import(
    '@/lib/connectors/woocommerce/sync/initial-import'
  )

  // The exact shape round 14 left behind: nine imports, one refusal that could not be written.
  assert.equal(
    decideInitialImportOutcome({ imported: 9, skipped: 0, errorCount: 1, unrecordedRefusals: 1 }),
    'failed',
  )
  // And it is the REFUSAL doing it, not the error count — the same error count without one
  // completes, which is the behaviour every other per-order failure still has.
  assert.equal(
    decideInitialImportOutcome({ imported: 9, skipped: 0, errorCount: 1, unrecordedRefusals: 0 }),
    'complete',
  )
})

// --- the wiring, through the real loop ---------------------------------------------------------

test('a mixed-success pass with an unrecorded refusal writes NEITHER the completion flag NOR the cursor', async () => {
  const progress = await runImport({
    success: false,
    unrecordedRefusal: 'status_not_admitted',
    error: 'the durable by-id refusal row could not be confirmed',
  })

  // PRECONDITION, asserted rather than assumed: this really is a mixed-success run. Without it the
  // test would pass against a build that failed the whole pass for any reason at all.
  assert.deepEqual(attempted, [9001, 9002, 9003], 'every order was attempted')
  assert.equal(progress.activeOrdersImported, 2, 'two orders really did import')

  assert.equal(progress.status, 'error')
  assert.equal(
    settings.get('wc_initial_import_completed'),
    undefined,
    'the backfill must stay runnable — it is the only route back to the refused order',
  )
  assert.equal(
    settings.get('last_wc_order_sync_at'),
    undefined,
    'the cursor must NOT advance past an order that has no refusal row and no redelivery',
  )
  assert.match(progress.message, /stranded behind the sync cursor/)
})

test('a RECORDED refusal is still an ordinary acknowledged skip — the pass completes and the cursor advances', async () => {
  // The control that stops the guard above from being written as "any refusal blocks". A refusal
  // WITH its durable row is the designed outcome for an excluded status, and blocking on it would
  // mean no store with an unticked status could ever finish its initial import.
  const progress = await runImport({ success: true, skipped: 'status_not_admitted', configured: ['processing'] })

  assert.equal(progress.status, 'done')
  assert.equal(settings.get('wc_initial_import_completed'), 'true')
  assert.ok(settings.get('last_wc_order_sync_at'), 'the cursor advances on a resolved decision')
})

test('a clean pass completes and advances, so the assertions above are about the refusal', async () => {
  // Proves the two settings are written by this harness AT ALL. Without this, "not set" above
  // could mean the doubles never let the completion branch run.
  const progress = await runImport({ success: true, orderId: 'so-9002' })

  assert.equal(progress.activeOrdersImported, 3)
  assert.equal(progress.status, 'done')
  assert.equal(settings.get('wc_initial_import_completed'), 'true')
  assert.ok(settings.get('last_wc_order_sync_at'))
})
