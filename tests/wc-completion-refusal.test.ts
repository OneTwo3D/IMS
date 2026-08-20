import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-xnwu: what the WooCommerce completion path does with a refusal.
 *
 * `processWcCompletion` ended with a bare `await applyExternalFulfillmentUpdate(...)`
 * and DISCARDED the result. So a WooCommerce order the store had marked completed
 * could fail to become an IMS shipment with the caller reporting nothing, the
 * webhook acknowledged, and no retry or dead letter anywhere. The pre-existing
 * "External fulfillment requires physical stock" refusal produced no activity row
 * either — literally no record that the order had not shipped.
 *
 * The WMS path, for the same underlying refusal, counts failures, dead-letters at
 * five and notifies admins. These tests pin the storefront equivalent: classify
 * the refusal, hand it back, and park the ones a retry cannot clear on
 * /sync/exceptions where an operator is already looking.
 */

type LoggedActivity = {
  action?: string
  level?: string
  entityId?: string | null
  description?: string
  metadata?: Record<string, unknown>
}

type SyncLogRow = Record<string, unknown>

const activityLog: LoggedActivity[] = []
const syncLogs: SyncLogRow[] = []
let fulfillmentResult: { success: boolean; error?: string; reason?: string } = { success: true }
const fulfillmentCalls: unknown[] = []
const notifications: Array<{ userId?: string | null; title?: string; message?: string; actionUrl?: string | null }> = []

/** Set to make the exception-row write fail, so the acknowledge decision can be tested. */
let syncLogWriteError: string | null = null

/**
 * Which admin ids `notify` REFUSES to write a row for (o3d-xnwu round 3).
 *
 * `notify` swallows its own errors and reports nothing, which is the whole
 * defect: the caller could not tell a delivered bell from a lost one. The double
 * therefore returns the same boolean the real one now returns, per admin, so a
 * partial failure is expressible — `Promise.all` would have hidden it behind one
 * rejection, and a double that always resolved would make "the bell was
 * delivered" unfalsifiable.
 */
let notifyFailsFor: Set<string> = new Set()
/** Active ADMIN users. An install can genuinely have none. */
let adminUsers: Array<{ id: string }> = [{ id: 'admin-1' }, { id: 'admin-2' }]
let nextSyncLogId = 1

let lockedOrder: { id: string; withdrawalApprovedAt: Date | null; status: string } | null = {
  id: 'so-1',
  withdrawalApprovedAt: null,
  status: 'PROCESSING',
}

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: LoggedActivity) => { activityLog.push(entry) },
  },
})

mock.module('@/lib/notifications', {
  namedExports: {
    notify: async (params: { userId?: string | null }) => {
      if (params.userId && notifyFailsFor.has(params.userId)) return false
      notifications.push(params)
      return true
    },
  },
})

mock.module('@/lib/fulfillment/external-fulfillment', {
  namedExports: {
    applyExternalFulfillmentUpdate: async (update: unknown) => {
      fulfillmentCalls.push(update)
      return fulfillmentResult
    },
  },
})

function matches(row: SyncLogRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value)
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (operations: unknown) => {
        // The array form: Prisma runs the promises it is handed. They have
        // already started here, which is exactly how the real client behaves for
        // the array form, so awaiting them is a faithful stand-in.
        if (Array.isArray(operations)) return Promise.all(operations)
        return (operations as (tx: unknown) => Promise<unknown>)({
          $queryRaw: async () => (lockedOrder ? [{ id: lockedOrder.id }] : []),
          salesOrder: { findUnique: async () => lockedOrder },
        })
      },
      user: { findMany: async () => adminUsers },
      shoppingSyncLog: {
        create: async ({ data }: { data: SyncLogRow }) => {
          if (syncLogWriteError) throw new Error(syncLogWriteError)
          // A REAL id, because the delivery mark is written back by id. A double
          // that returned the bare `data` would leave production updating
          // `where: { id: undefined }`, which the double would then have to
          // guess at — and the guess is what would be under test.
          const row = { ...data, id: `syncLog-${nextSyncLogId++}`, createdAt: new Date() }
          syncLogs.push(row)
          return row
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          syncLogs.find((row) => matches(row, where)) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: SyncLogRow }) => {
          const row = syncLogs.find((candidate) => candidate.id === where.id)
          if (!row) throw new Error(`no shopping_sync_logs row ${where.id}`)
          Object.assign(row, data)
          return row
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const kept = syncLogs.filter((row) => !matches(row, where))
          const removed = syncLogs.length - kept.length
          syncLogs.splice(0, syncLogs.length, ...kept)
          return { count: removed }
        },
      },
    },
  },
})

const WC_ORDER = {
  id: 4242,
  number: '4242',
  status: 'completed',
  line_items: [],
  meta_data: [],
  shipping_lines: [],
} as unknown as import('../lib/connectors/woocommerce/sync/types.ts').WcFullOrder

async function runCompletion() {
  const { processWcCompletion } = await import('@/lib/connectors/woocommerce/sync/completion-flow')
  return processWcCompletion('so-1', WC_ORDER)
}

function reset() {
  activityLog.length = 0
  syncLogs.length = 0
  fulfillmentCalls.length = 0
  notifications.length = 0
  syncLogWriteError = null
  notifyFailsFor = new Set()
  adminUsers = [{ id: 'admin-1' }, { id: 'admin-2' }]
  fulfillmentResult = { success: true }
  lockedOrder = { id: 'so-1', withdrawalApprovedAt: null, status: 'PROCESSING' }
}

/** What the open refusal row says about whether an admin was actually told. */
function belled(): unknown {
  const row = openRefusals()[0]
  return (row?.payload as { adminNotified?: unknown } | undefined)?.adminNotified
}

function openRefusals() {
  return syncLogs.filter((row) => row.entityType === 'SalesOrderFulfillment')
}

// ---------------------------------------------------------------------------

test('a stock refusal is REPORTED to the caller as permanent, not swallowed (o3d-xnwu)', async () => {
  reset()
  fulfillmentResult = {
    success: false,
    reason: 'insufficient-stock',
    error: 'External fulfillment requires physical stock — order has 3 unit(s) on backorder',
  }

  const result = await runCompletion()

  assert.equal(result.success, false, 'the completion did NOT happen, and must not report that it did')
  assert.equal(result.error, 'External fulfillment requires physical stock — order has 3 unit(s) on backorder')
  assert.equal(
    result.permanent,
    true,
    'redelivering the identical webhook re-hits the identical stock position, so it must be acknowledged rather than retried into a dead letter',
  )
})

test('a permanent refusal is parked on /sync/exceptions, where an operator is already looking (o3d-xnwu)', async () => {
  reset()
  fulfillmentResult = {
    success: false,
    reason: 'insufficient-stock',
    error: 'External fulfillment requires physical stock — order has 3 unit(s) on backorder',
  }

  await runCompletion()

  const refusals = openRefusals()
  assert.equal(refusals.length, 1, 'the refusal leaves a durable, operator-visible row')
  assert.deepEqual(
    {
      connector: refusals[0].connector,
      direction: refusals[0].direction,
      status: refusals[0].status,
      entityId: refusals[0].entityId,
      externalId: refusals[0].externalId,
    },
    {
      connector: 'woocommerce',
      direction: 'FROM_CONNECTOR',
      status: 'QUARANTINED',
      entityId: 'so-1',
      externalId: '4242',
    },
  )
  assert.match(String(refusals[0].errorMessage), /requires physical stock/, 'and it names the reason, not just "failed"')
  // NOT filed as entityType 'SalesOrder': the refund-park query selects
  // FROM_CONNECTOR/SalesOrder rows by status, so a fulfilment refusal filed there
  // would appear in the inbox as a parked refund with a "retry refund sync" button.
  assert.equal(refusals[0].entityType, 'SalesOrderFulfillment')
})

test('a recurring refusal keeps ONE open row, re-stamped (o3d-xnwu)', async () => {
  reset()
  fulfillmentResult = { success: false, reason: 'insufficient-stock', error: 'no stock: 3 unit(s) on backorder' }

  await runCompletion()
  fulfillmentResult = { success: false, reason: 'insufficient-stock', error: 'no stock: 1 unit(s) on backorder' }
  await runCompletion()

  const refusals = openRefusals()
  assert.equal(refusals.length, 1, 'one unfulfillable order is one exception, not one per delivery')
  assert.equal(refusals[0].errorMessage, 'no stock: 1 unit(s) on backorder', 'and it carries the LATEST reason')

  assert.equal(
    notifications.length,
    2,
    'the two admins are belled ONCE, on the first refusal — a bell per redelivery trains them to ignore it',
  )
})

test('the first permanent refusal bells the admins, individually, at the inbox (o3d-xnwu)', async () => {
  reset()
  fulfillmentResult = {
    success: false,
    reason: 'insufficient-stock',
    error: 'External fulfillment requires physical stock — order has 3 unit(s) on backorder',
  }

  await runCompletion()

  // The WMS path already does this for the same underlying cause (no IMS stock to
  // consume) and points at the same page; the storefront path did nothing at all.
  assert.deepEqual(notifications.map((row) => row.userId), ['admin-1', 'admin-2'])
  assert.ok(
    notifications.every((row) => row.userId),
    'never a broadcast — the message names a customer order, which READONLY/SUPPLIER users must not see',
  )
  assert.equal(notifications[0].actionUrl, '/sync/exceptions')
  assert.match(String(notifications[0].message), /4242/)
  assert.match(String(notifications[0].message), /requires physical stock/)
})

test('a permanent refusal that could NOT be filed is not acknowledged (o3d-xnwu)', async () => {
  reset()
  syncLogWriteError = 'deadlock detected'
  fulfillmentResult = { success: false, reason: 'insufficient-stock', error: 'no stock: 3 unit(s) on backorder' }

  const result = await runCompletion()

  assert.equal(result.success, false)
  assert.equal(
    result.permanent,
    false,
    'acknowledging is only safe because the refusal was filed — with no row and no bell, closing the delivery would lose it entirely',
  )
  assert.equal(result.error, 'no stock: 3 unit(s) on backorder', 'and the refusal itself is still reported, not replaced by the write error')
  assert.ok(
    activityLog.some((entry) => entry.action === 'wc_completion_refusal_unrecorded' && entry.level === 'ERROR'),
    'the failure to record is itself recorded',
  )
})

test('a transient refusal bells nobody', async () => {
  reset()
  fulfillmentResult = { success: false, reason: 'order-not-found', error: 'Order not found for external fulfillment update' }

  await runCompletion()

  assert.deepEqual(notifications, [], 'it is about to be retried; there is nothing for an admin to do')
})

test('a TRANSIENT refusal is retryable and files no exception row (o3d-xnwu / o3d-i0y)', async () => {
  reset()
  // A lost transaction or an order the importer has not committed yet: the next
  // attempt genuinely may differ, and only a genuinely retryable failure may
  // become a 5xx. Parking it would ask an operator to fix something that is
  // about to fix itself.
  fulfillmentResult = { success: false, reason: 'shipment-transition-failed', error: 'Failed to update shipment to SHIPPED' }

  const result = await runCompletion()

  assert.equal(result.success, false)
  assert.equal(result.permanent, false, 'a redelivery may well succeed, so it must not be acknowledged')
  assert.deepEqual(openRefusals(), [], 'and it is not parked for an operator')
})

test('a completion that succeeds clears the open refusal (o3d-xnwu)', async () => {
  reset()
  fulfillmentResult = { success: false, reason: 'insufficient-stock', error: 'no stock: 3 unit(s) on backorder' }
  await runCompletion()
  assert.equal(openRefusals().length, 1)

  fulfillmentResult = { success: true }
  const result = await runCompletion()

  assert.equal(result.success, true)
  assert.deepEqual(openRefusals(), [], 'the row is a live state, not a log — the fulfilment answered it')
})

test('an approved withdrawal still refuses the completion, and reports it as resolved (o3d-e1yb)', async () => {
  reset()
  lockedOrder = { id: 'so-1', withdrawalApprovedAt: new Date('2026-08-01T00:00:00Z'), status: 'PROCESSING' }

  const result = await runCompletion()

  assert.equal(fulfillmentCalls.length, 0, 'nothing is allocated or shipped for a withdrawn order')
  assert.equal(
    result.success,
    true,
    'this refusal is the INTENDED end state — nothing should ship, and there is nothing for an operator to unblock',
  )
  assert.deepEqual(openRefusals(), [], 'so it is not an exception-inbox row either')
  assert.ok(
    activityLog.some((entry) => entry.action === 'wc_completion_refused_withdrawn' && entry.level === 'WARNING'),
    'it keeps its own loud record',
  )
})

// ---------------------------------------------------------------------------
// o3d-xnwu round 3, Codex finding 4 — a failed bell is not a delivered bell.
//
// `notify` swallows its errors by design, and the dedupe keyed on the ROW
// EXISTING. So the first refusal wrote the row, lost the notification, and every
// later refusal of that order took the "they have already been told" branch. The
// admin bell was never retried and its failure was never reported anywhere: a
// notification silently treated as delivered, for ever.
//
// Same shape as the rule one layer up (a refusal that cannot be FILED is not
// reported as permanent, so the delivery retries) applied to the bell: what was
// not delivered is not recorded as delivered.
// ---------------------------------------------------------------------------

test('a failed admin bell is REPORTED, not silently treated as delivered (o3d-xnwu r3)', async () => {
  reset()
  notifyFailsFor = new Set(['admin-1', 'admin-2'])
  fulfillmentResult = { success: false, reason: 'insufficient-stock', error: 'no stock: 3 unit(s) on backorder' }

  const result = await runCompletion()

  assert.deepEqual(notifications, [], 'nobody was told')
  const unnotified = activityLog.find((entry) => entry.action === 'wc_completion_refusal_unnotified')
  assert.ok(unnotified, `the lost bell must be reported, saw: ${JSON.stringify(activityLog.map((e) => e.action))}`)
  assert.equal(unnotified.level, 'ERROR')
  assert.equal(unnotified.entityId, 'so-1')
  assert.match(String(unnotified.description), /0 of 2 notification\(s\) were written/)
  assert.match(String(unnotified.description), /no stock: 3 unit\(s\) on backorder/, 'including the refusal it was about')

  assert.equal(openRefusals().length, 1, 'the durable row still stands — the inbox is the record, the bell is the alert')
  assert.equal(belled(), false, 'and the row says the bell has NOT landed')
  assert.equal(
    result.permanent,
    true,
    'the refusal WAS filed where an operator can see it, so the delivery is still acknowledged — '
    + 'the lost bell is retried on its own terms, not by replaying the webhook into a dead letter',
  )
})

test('a bell that failed is RETRIED on the next refusal of the same order (o3d-xnwu r3)', async () => {
  reset()
  notifyFailsFor = new Set(['admin-1', 'admin-2'])
  fulfillmentResult = { success: false, reason: 'insufficient-stock', error: 'no stock: 3 unit(s) on backorder' }
  await runCompletion()
  assert.equal(notifications.length, 0, 'the first bell is lost')

  // The reconcile comes round again, or the store re-fires the webhook. Under the
  // old dedupe this branch was unreachable for ever, because the row existed.
  notifyFailsFor = new Set()
  await runCompletion()

  assert.deepEqual(notifications.map((row) => row.userId), ['admin-1', 'admin-2'], 'they are told this time')
  assert.equal(belled(), true)
  assert.equal(openRefusals().length, 1, 'and it is still one row, not one per attempt')
})

test('a bell that LANDED is still rung only once (o3d-xnwu r3)', async () => {
  reset()
  fulfillmentResult = { success: false, reason: 'insufficient-stock', error: 'no stock: 3 unit(s) on backorder' }
  await runCompletion()
  assert.equal(notifications.length, 2)
  assert.equal(belled(), true, 'delivery is recorded ON the row, so it survives the row being re-stamped')

  await runCompletion()
  await runCompletion()

  assert.equal(
    notifications.length,
    2,
    'the retry is keyed on delivery, not on the attempt — a bell per redelivery would train admins to ignore it',
  )
})

test('a PARTIAL delivery is retried rather than counted as done (o3d-xnwu r3)', async () => {
  reset()
  notifyFailsFor = new Set(['admin-2'])
  fulfillmentResult = { success: false, reason: 'insufficient-stock', error: 'no stock: 3 unit(s) on backorder' }

  await runCompletion()

  assert.deepEqual(notifications.map((row) => row.userId), ['admin-1'], 'one landed, one did not')
  assert.match(
    String(activityLog.find((entry) => entry.action === 'wc_completion_refusal_unnotified')?.description),
    /1 of 2 notification\(s\) were written/,
    'Promise.all would have collapsed this to one rejection and lost the admin who WAS reached',
  )
  assert.equal(belled(), false)

  notifyFailsFor = new Set()
  await runCompletion()
  assert.deepEqual(
    notifications.map((row) => row.userId),
    ['admin-1', 'admin-1', 'admin-2'],
    'admin-1 gets a second copy, deliberately: one duplicate bell is a far better failure than an admin never told',
  )
})

test('an install with NO active admin is a failed bell, not a satisfied one (o3d-xnwu r3)', async () => {
  reset()
  adminUsers = []
  fulfillmentResult = { success: false, reason: 'insufficient-stock', error: 'no stock: 3 unit(s) on backorder' }

  await runCompletion()

  // Promise.all([]) resolves, which is not the same as somebody having been told.
  const unnotified = activityLog.find((entry) => entry.action === 'wc_completion_refusal_unnotified')
  assert.ok(unnotified, 'an unfulfilled order with nobody to tell is exactly where this goes unnoticed')
  assert.match(String(unnotified.description), /no active ADMIN user to notify/)
  assert.equal(belled(), false, 'so when an admin does exist, the next refusal tells them')
})
