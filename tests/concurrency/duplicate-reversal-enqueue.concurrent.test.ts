import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-d0pd — A RETRY IN THE WINDOW CANNOT POST A SECOND REVERSAL.
 *
 * The enqueue's already-present check asked `status IN ('PENDING','PROCESSING','SYNCED')`, and so
 * does the partial unique index `accounting_sync_logs_idempotency_key_uq`. Neither could see a prior
 * attempt that had reached FAILED, so an operator running `retryRefundAccounting` on a refund whose
 * reversal had failed enqueued the same posting a SECOND time and both rows could post.
 *
 * WHY THIS RUNS AGAINST A REAL DATABASE AND NOT A DOUBLE. The claim is not "the classifier returns
 * the right verdict" — that is a unit test. It is "no interleaving of concurrent retries leaves two
 * rows for one key", and both halves of the mechanism that decides it are PostgreSQL properties: the
 * partial unique index and its status predicate, and the JSON path match the read is expressed with.
 * A hand-written double will happily accept two rows with one key, so it cannot fail this test in
 * the way that matters.
 *
 * CONCURRENT, NOT SEQUENTIAL. Four retries are started together and every one of them races the
 * others' reads and writes. The control case at the end runs the same four against an EMPTY history,
 * where exactly one row must appear — so a fix that simply refused everything could not pass both.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const CONCURRENT_RETRIES = 4

function loadEnv() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-d0pd concurrency test requires a Postgres DATABASE_URL')
  }
}

/** Unique per run so a crashed run cannot collide with the next one. */
const probeId = (label: string) => `D0PD-${label}-${process.pid}-${randomUUID()}`

type Db = Awaited<ReturnType<typeof loadDeps>>['db']

async function loadDeps() {
  loadEnv()
  const [{ db }, { queueXeroSync }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/connectors/xero/queue'),
  ])
  return { db, queueXeroSync }
}

/**
 * Switch the Xero connector and COGS_REVERSAL posting on, so the enqueue reaches its already-present
 * check instead of returning `not-configured` before it. Without this every assertion below would
 * pass for the wrong reason.
 */
async function enableXeroCogsReversal(db: Db): Promise<void> {
  const settings: Array<[string, string]> = [
    ['integration_plugin_xero_enabled', 'true'],
    ['xero_sync_enabled', 'true'],
    ['xero_sync_cogs_reversal', 'submitted'],
  ]
  for (const [key, value] of settings) {
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  }
}

function reversalPayload(idempotencyKey: string) {
  return {
    _idempotencyKey: idempotencyKey,
    narration: 'COGS reversal probe',
    lines: [
      { description: 'COGS', accountCode: '310', lineAmount: -12.5 },
      { description: 'Inventory', accountCode: '630', lineAmount: 12.5 },
    ],
  }
}

test(
  '[o3d-d0pd] concurrent retries behind a FAILED attempt raise NO second reversal row',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, queueXeroSync } = await loadDeps()
    await enableXeroCogsReversal(db)

    const refundId = probeId('refund')
    const key = `sales-order-refund:${refundId}:cogs-reversal`
    t.after(async () => {
      await db.accountingEvent.deleteMany({ where: { sourceEntityId: refundId } }).catch(() => undefined)
      await db.accountingSyncLog.deleteMany({ where: { referenceId: refundId } })
    })

    // THE STATE THE ISSUE DESCRIBES: a reversal that was queued and has since failed. It carries no
    // document id, so nothing here can say whether its attempt reached Xero — which is exactly why a
    // second row must not be raised beside it.
    const failed = await db.accountingSyncLog.create({
      data: {
        connector: 'xero',
        type: 'COGS_REVERSAL',
        status: 'FAILED',
        referenceType: 'SalesOrderRefund',
        referenceId: refundId,
        payload: reversalPayload(key),
        errorMessage: 'Xero returned 500',
        attemptStampingCustodyAt: new Date(),
      },
      select: { id: true },
    })

    // Four operator retries at once. Each is the real enqueue, against the real database.
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_RETRIES }, () => queueXeroSync({
        type: 'COGS_REVERSAL',
        referenceType: 'SalesOrderRefund',
        referenceId: refundId,
        payload: reversalPayload(key),
        idempotencyKey: key,
      })),
    )

    const rows = await db.accountingSyncLog.findMany({
      where: { referenceId: refundId },
      select: { id: true, status: true },
    })

    // THE LOAD-BEARING ASSERTION, and it was MEASURED at 2 with the old predicate restored, not
    // predicted. The FAILED row is invisible to a three-status check, so all four retries proceed to
    // insert; they are PENDING, so the partial unique index then lets exactly ONE of them through and
    // rejects the rest. The index is why the damage is one duplicate rather than four — and one
    // duplicate COGS reversal is the whole of this issue.
    assert.equal(rows.length, 1, 'exactly the FAILED row that was already there, and nothing new')
    assert.equal(rows[0]?.id, failed.id)

    for (const outcome of outcomes) {
      assert.equal(outcome.queued, false, 'nothing was written, so nothing may be reported as queued')
      assert.equal(outcome.reason, 'refused',
        'refused, not not-configured: the reversal is STILL OWED and the caller must not settle on it')
    }
  },
)

test(
  '[o3d-d0pd] with no prior attempt, the same four concurrent retries still produce exactly one row',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // THE CONTROL, and it is not decoration. "Refuse everything" would satisfy the test above and
    // break the product: the ordinary path has to still queue the reversal, once, under contention.
    const { db, queueXeroSync } = await loadDeps()
    await enableXeroCogsReversal(db)

    const refundId = probeId('refund-clean')
    const key = `sales-order-refund:${refundId}:cogs-reversal`
    t.after(async () => {
      await db.accountingEvent.deleteMany({ where: { sourceEntityId: refundId } }).catch(() => undefined)
      await db.accountingSyncLog.deleteMany({ where: { referenceId: refundId } })
    })

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_RETRIES }, () => queueXeroSync({
        type: 'COGS_REVERSAL',
        referenceType: 'SalesOrderRefund',
        referenceId: refundId,
        payload: reversalPayload(key),
        idempotencyKey: key,
      })),
    )

    const rows = await db.accountingSyncLog.findMany({
      where: { referenceId: refundId },
      select: { id: true, status: true, payload: true },
    })
    assert.equal(rows.length, 1, 'one reversal, however many retries raced for it')
    assert.equal(rows[0]?.status, 'PENDING')
    for (const outcome of outcomes) {
      assert.equal(outcome.queued, true, 'and every racer is truthfully told the work is on the queue')
    }
  },
)

test(
  '[o3d-d0pd] a CANCELLED attempt does not block: cancel-and-re-queue still works under contention',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    // `describeCreateDispatchRemedy` prescribes "cancel this row and re-queue the work from the
    // source document". If the fix had blocked on any terminal row, that remedy would be gone — and
    // for a DAILY_BATCH-adjacent row it is the only exit there is.
    const { db, queueXeroSync } = await loadDeps()
    await enableXeroCogsReversal(db)

    const refundId = probeId('refund-cancelled')
    const key = `sales-order-refund:${refundId}:cogs-reversal`
    t.after(async () => {
      await db.accountingEvent.deleteMany({ where: { sourceEntityId: refundId } }).catch(() => undefined)
      await db.accountingSyncLog.deleteMany({ where: { referenceId: refundId } })
    })

    await db.accountingSyncLog.create({
      data: {
        connector: 'xero',
        type: 'COGS_REVERSAL',
        status: 'CANCELLED',
        referenceType: 'SalesOrderRefund',
        referenceId: refundId,
        payload: reversalPayload(key),
        attemptStampingCustodyAt: new Date(),
      },
    })

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_RETRIES }, () => queueXeroSync({
        type: 'COGS_REVERSAL',
        referenceType: 'SalesOrderRefund',
        referenceId: refundId,
        payload: reversalPayload(key),
        idempotencyKey: key,
      })),
    )

    const live = await db.accountingSyncLog.findMany({
      where: { referenceId: refundId, status: 'PENDING' },
      select: { id: true },
    })
    assert.equal(live.length, 1, 'the retired row let exactly one replacement through, not none and not four')
    assert.equal(outcomes.every((o) => o.queued), true)
  },
)
