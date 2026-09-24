import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * o3d-j625 r9 (Codex round 8, HIGH) — RECORDING A REFUSAL CANNOT RESURRECT WORK SOMEBODY ALREADY DID.
 *
 * `recordAccountingPostingRefusal` read `suppressedAt` and then upserted, with no lock between the two.
 * Two real interleavings follow from that, and BOTH are reproduced here against a real PostgreSQL
 * database with real transactions — no doubles, and no modelled window either:
 *
 *   1. MARK-HANDLED RACE. An operator marks a refused posting handled ("I posted this by hand"). A sweep
 *      refuses the same posting at the same moment. The refusal reads the row before the mark commits,
 *      the mark commits, the upsert clears `resolvedAt` and leaves `suppressedAt` — and the exception
 *      inbox (which lists `resolvedAt: null`) shows the posting as OUTSTANDING again, under a remedy that
 *      asks the operator to post it in the ledger. They already did. That is a second ledger post.
 *
 *   2. QUEUED RACE. A posting is successfully queued — `createAccountingSyncLogRow` clears the refusal
 *      row inside the enqueue's transaction — while a refusal of the same posting is in flight. The
 *      refusal reads the row before that clear commits and reopens it afterwards: a debt nobody owes,
 *      against a posting that is sitting in the accounting sync log.
 *
 * NOTHING IN EITHER TEST GATES THE SUBJECT. The interleaving is the one PostgreSQL itself produces: the
 * marking and the clearing transactions hold the refusal row's ROW LOCK until they commit, so a
 * concurrent writer's read lands early and its write lands late without any help. That is why these are
 * reproductions rather than illustrations, and it is why the fix has to be a lock rather than a re-read.
 *
 * THE CONTROL IS LOAD-BEARING (test 3). A blanket "never reopen a resolved row" or "never record while a
 * live sync row exists" would pass tests 1 and 2 and would be WRONG: several posting types share one key
 * across successive postings by design (SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, BILL_PAYMENT), so
 * a refusal AFTER an earlier success is a real debt — the ledger holds a stale document. Test 3 refuses
 * the posting after a completed, uncontended clear and requires the row to reopen.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
/** How long the marking / enqueueing transaction stays open after its write. */
const HOLD_MS = 500
/** Slack for scheduler jitter when asserting that the other side really was parked. */
const SLACK_MS = 100
const TX = { timeout: 30_000, maxWait: 20_000 }

function loadEnv(): void {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-j625 r9 concurrency test requires a Postgres DATABASE_URL')
  }
}

async function loadDeps() {
  loadEnv()
  const [{ db }, inbox, mark, row] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/domain/accounting/posting-refusal-inbox.ts'),
    import('../../lib/domain/accounting/posting-mark-handled.ts'),
    import('../../lib/domain/accounting/sync-log-row.ts'),
  ])
  return {
    db,
    recordAccountingPostingRefusal: inbox.recordAccountingPostingRefusal,
    clearAccountingPostingRefusal: inbox.clearAccountingPostingRefusal,
    markPostingHandled: mark.markPostingHandled,
    createAccountingSyncLogRow: row.createAccountingSyncLogRow,
  }
}

type Db = Awaited<ReturnType<typeof loadDeps>>['db']

/**
 * MANUFACTURING_JOURNAL / ProductionOrder — a DOCUMENT-scoped posting whose refusal kind
 * (`manufacturing_journal`) is MARKABLE, which is what makes the mark-handled race reachable at all.
 */
const TYPE = 'MANUFACTURING_JOURNAL'
const REFERENCE_TYPE = 'ProductionOrder'
const KIND = 'manufacturing_journal'

const probeId = (label: string) => `J625R9-${label}-${process.pid}-${randomUUID()}`

const keyFor = (referenceId: string) => ({ type: TYPE, referenceType: REFERENCE_TYPE, referenceId, scope: '' })

/** The refusal exactly as the manufacturing completion site records it, remedy included. */
const refusalRecord = (reason: string) => ({
  kind: KIND as never,
  chartConnector: 'xero',
  activeConnector: 'quickbooks',
  reason,
  committed: 'the production order is completed in IMS and its stock movements are posted',
  remedy:
    'Post the manufacturing journal by hand in the ledger it belongs to and mark this row handled — that '
    + 'cancels IMS\'s retry, so it is not posted twice.',
})

async function seedOutstandingRefusal(db: Db, referenceId: string): Promise<string> {
  const row = await db.accountingPostingRefusal.create({
    data: {
      ...keyFor(referenceId),
      kind: KIND,
      chartConnector: 'xero',
      activeConnector: 'quickbooks',
      reason: 'retired_chart',
      committed: 'the production order is completed in IMS and its stock movements are posted',
      remedy: 'Post it by hand in the ledger it belongs to and mark this row handled.',
    },
    select: { id: true },
  })
  return row.id
}

/** Exactly what the exception inbox selects (app/actions/sync-exceptions.ts: `resolvedAt: null`). */
async function inboxView(db: Db, referenceId: string) {
  return db.accountingPostingRefusal.findMany({
    where: { ...keyFor(referenceId), resolvedAt: null },
    select: { id: true, reason: true, remedy: true, suppressedAt: true, refusedCount: true },
  })
}

function describe(rows: Awaited<ReturnType<typeof inboxView>>): string {
  if (rows.length === 0) return '(the inbox lists nothing for this posting)'
  return rows.map((row) => `OUTSTANDING: ${row.reason}; suppressedAt=${row.suppressedAt?.toISOString() ?? 'null'}; remedy="${row.remedy}"`).join(' | ')
}

function cleanup(db: Db, referenceId: string): () => Promise<void> {
  return async () => {
    await db.accountingSyncLog.deleteMany({ where: { referenceId } }).catch(() => undefined)
    await db.accountingPostingRefusal.deleteMany({ where: { referenceId } }).catch(() => undefined)
    await db.activityLog.deleteMany({ where: { description: { contains: referenceId } } }).catch(() => undefined)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  '[o3d-j625 r9] a refusal racing MARK-HANDLED cannot reopen the row an operator posted by hand',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, markPostingHandled } = await loadDeps()
    const referenceId = probeId('mark')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedOutstandingRefusal(db, referenceId)

    let marked: unknown = null
    const signal: { fire?: () => void } = {}
    const markHasWritten = new Promise<void>((resolve) => { signal.fire = resolve })

    // The mark, in its own transaction, held open after it has written the suppression. It takes the
    // posting key's lock itself (posting-mark-handled.ts) and holds the refusal row's row lock.
    const mark = db.$transaction(async (tx) => {
      marked = await markPostingHandled(tx as never, {
        id: refusalId,
        userId: 'j625r9-operator',
        note: 'posted by hand as journal MJ-4411',
      })
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)

    await markHasWritten
    const startedAt = Date.now()
    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'))
    const recordMs = Date.now() - startedAt
    await mark

    // PRECONDITIONS. Without these every assertion below would hold over a mark that never happened.
    assert.deepEqual(marked, { ok: true, cancelledSyncRows: [], kind: KIND }, 'the operator marked the posting handled')
    assert.ok(recordMs >= HOLD_MS - SLACK_MS,
      `the refusal completed in ${recordMs}ms, so it did NOT overlap the ${HOLD_MS}ms the mark held its `
      + 'transaction open — the interleaving under test was never reached')

    const rows = await inboxView(db, referenceId)
    const row = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusalId },
      select: { resolvedAt: true, resolution: true, resolvedBy: true, suppressedAt: true },
    })
    assert.ok(row.suppressedAt, 'the suppression survives (it is not in any refusal write)')
    assert.equal(row.resolution, 'handled_manually',
      `the refusal reopened a posting the operator had already posted by hand. ${describe(rows)}`)
    assert.ok(row.resolvedAt,
      `the refusal reopened a posting the operator had already posted by hand, so the exception inbox asks `
      + `them to post it a second time. ${describe(rows)}`)
    assert.equal(rows.length, 0, `nothing is owed, so the inbox must list nothing. ${describe(rows)}`)
    // And it is a NOTE, not an error: the refusal was recognised as owed-to-nobody under the key, rather
    // than merely bouncing off the write predicate. Those are different operator-visible outcomes, and
    // only the first one says why nothing is outstanding.
    assert.equal(
      await db.activityLog.count({ where: { action: 'accounting_posting_refused_after_handled_by_hand', description: { contains: referenceId } } }),
      1, 'the refusal is reported as "already posted by hand"')
    assert.equal(
      await db.activityLog.count({ where: { action: 'accounting_posting_refusal_not_recorded', description: { contains: referenceId } } }),
      0, 'and NOT as a row that could not be written')
  },
)

test(
  '[o3d-j625 r9] a refusal racing a SUCCESSFUL ENQUEUE cannot reopen the row the enqueue cleared',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, createAccountingSyncLogRow } = await loadDeps()
    const referenceId = probeId('queued')
    t.after(cleanup(db, referenceId))
    await seedOutstandingRefusal(db, referenceId)

    let created: { id: string } | null = null
    const signal: { fire?: () => void } = {}
    const enqueueHasWritten = new Promise<void>((resolve) => { signal.fire = resolve })

    // A real enqueue: the row-creating primitive takes the posting key's lock, writes the sync row and
    // clears the refusal, all inside one transaction that is then held open.
    const enqueue = db.$transaction(async (tx) => {
      created = await createAccountingSyncLogRow<{ id: string }>(tx, {
        connector: 'xero',
        type: TYPE,
        status: 'PENDING',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: { narration: `o3d-j625 r9 probe ${referenceId}` },
      })
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)

    await enqueueHasWritten
    const startedAt = Date.now()
    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'))
    const recordMs = Date.now() - startedAt
    await enqueue

    assert.ok(created, 'the enqueue wrote its accounting sync row')
    assert.ok(recordMs >= HOLD_MS - SLACK_MS,
      `the refusal completed in ${recordMs}ms and did not overlap the enqueue's ${HOLD_MS}ms — the `
      + 'interleaving under test was never reached')
    const live = await db.accountingSyncLog.count({ where: { referenceId, status: { not: 'CANCELLED' } } })
    assert.equal(live, 1, 'the posting IS queued: one live accounting sync row')

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 0,
      `the posting is queued in the accounting sync log, so nothing is owed — but the inbox lists it as `
      + `outstanding work. ${describe(rows)}`)
    assert.equal(
      await db.activityLog.count({ where: { action: 'accounting_posting_refused_after_queued', description: { contains: referenceId } } }),
      1, 'and the refusal that was not recorded is reported, naming when the posting was queued')
  },
)

test(
  '[o3d-j625 r9] THE CONTROL — a refusal AFTER a settled, uncontended clear is a new debt and IS recorded',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, clearAccountingPostingRefusal } = await loadDeps()
    const referenceId = probeId('control')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedOutstandingRefusal(db, referenceId)

    // The posting was queued once and the row was cleared. That transaction is finished: no lock is held
    // and nothing is in flight.
    await clearAccountingPostingRefusal(db as never, keyFor(referenceId))
    const cleared = await db.accountingPostingRefusal.findUniqueOrThrow({ where: { id: refusalId }, select: { resolvedAt: true, resolution: true } })
    assert.equal(cleared.resolution, 'queued', 'precondition: the row was cleared by a successful enqueue')
    await sleep(20)

    // Now a NEW refusal of the same posting — the next edit, refused. This is a real debt: the ledger
    // holds the earlier document and nothing will correct it.
    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'))

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 1,
      'a refusal decided AFTER a completed clear is a new episode and must reopen the row — a guard that '
      + 'swallows it loses exactly the debt this table exists to show')
    assert.equal(rows[0]!.refusedCount, 1, 'reopened as a NEW episode (review M-13)')
  },
)

test(
  '[o3d-j625 r9] and a refusal decided BEFORE that clear does not reopen it',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, clearAccountingPostingRefusal } = await loadDeps()
    const referenceId = probeId('decided-before')
    t.after(cleanup(db, referenceId))
    await seedOutstandingRefusal(db, referenceId)

    // The refusal is decided HERE, and lands after the posting has been queued and the row cleared. The
    // only difference from the control above is which side of the clear the decision falls on.
    const decidedAt = new Date()
    await sleep(20)
    await clearAccountingPostingRefusal(db as never, keyFor(referenceId))
    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'), { decidedAt })

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 0,
      `a refusal decided before the posting was queued is stale and must not reopen the row. ${describe(rows)}`)
  },
)

test(
  '[o3d-j625 r9] a suppressed row is not updated even when the read says it is not suppressed',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, markPostingHandled } = await loadDeps()
    const referenceId = probeId('write-fence')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedOutstandingRefusal(db, referenceId)
    const marked = await db.$transaction(async (tx) => markPostingHandled(tx as never, {
      id: refusalId, userId: 'j625r9-operator', note: 'posted by hand',
    }), TX)
    assert.equal((marked as { ok: boolean }).ok, true, 'precondition: the posting is marked handled')
    const before = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusalId },
      select: { resolvedAt: true, resolution: true, resolvedBy: true, suppressedAt: true, refusedCount: true, reason: true },
    })

    /**
     * THE READ LIES, THE WRITES ARE REAL. Every statement below reaches the real database; only the
     * suppression lookup is replaced, with the answer the r7 code would have got in the race. So this
     * asks the question the lock alone cannot: if the decision is wrong, does the WRITE still refuse?
     */
    const lying = (tx: never) => {
      const real = tx as unknown as Db
      return {
        $queryRaw: (...args: unknown[]) => (real.$queryRaw as unknown as (...a: unknown[]) => unknown)(...args),
        $executeRaw: (...args: unknown[]) => (real.$executeRaw as unknown as (...a: unknown[]) => unknown)(...args),
        $executeRawUnsafe: (sql: string) => real.$executeRawUnsafe(sql),
        accountingPostingRefusal: {
          findUnique: async () => ({ suppressedAt: null, resolvedBy: null, resolvedAt: null, resolution: null }),
          updateMany: (args: never) => real.accountingPostingRefusal.updateMany(args),
          upsert: (args: never) => real.accountingPostingRefusal.upsert(args),
        },
      }
    }
    const client = {
      $executeRawUnsafe: (sql: string) => db.$executeRawUnsafe(sql),
      $transaction: (fn: (tx: never) => Promise<unknown>, options?: unknown) =>
        db.$transaction((tx) => fn(lying(tx as never) as never), options as never),
      accountingPostingRefusal: { updateMany: async () => ({ count: 0 }), upsert: async () => ({}) },
    }
    await recordAccountingPostingRefusal(client as never, keyFor(referenceId), refusalRecord('retired_chart'))

    const after = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusalId },
      select: { resolvedAt: true, resolution: true, resolvedBy: true, suppressedAt: true, refusedCount: true, reason: true },
    })
    assert.deepEqual(after, before, 'a suppressed row must be untouched by a refusal, whatever the read said')
    const reported = await db.activityLog.count({
      where: { action: 'accounting_posting_refusal_not_recorded', description: { contains: referenceId } },
    })
    assert.equal(reported, 1, 'and the row that could not be written is reported, never silent')
  },
)

test(
  '[o3d-j625 r9] inside a CALLER transaction a key another transaction holds records nothing, and does not abort the caller',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const [{ lockPostingKey }, { withSavepoint }] = await Promise.all([
      import('../../lib/domain/accounting/posting-suppression.ts'),
      import('../../lib/db/savepoint.ts'),
    ])
    const referenceId = probeId('contended')
    t.after(cleanup(db, referenceId))

    // Someone else is settling this exact posting and holds its key.
    const signal: { fire?: () => void } = {}
    const keyIsHeld = new Promise<void>((resolve) => { signal.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, keyFor(referenceId))
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await keyIsHeld

    // A site reporting its refusal from INSIDE its own transaction. It must not WAIT for the key (that
    // transaction can hold anything, so waiting is where a deadlock would come from), so it records
    // nothing — and, review M-14, the caller's own work still commits.
    const startedAt = Date.now()
    const settingKey = `j625r9-committed-${referenceId}`
    await db.$transaction(async (tx) => {
      await recordAccountingPostingRefusal(tx as never, keyFor(referenceId), refusalRecord('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt: new Date(),
      })
      await tx.setting.create({ data: { key: settingKey, value: 'the caller\'s transaction committed' } })
    }, TX)
    const recordMs = Date.now() - startedAt
    await holder
    t.after(async () => { await db.setting.deleteMany({ where: { key: settingKey } }).catch(() => undefined) })

    assert.ok(recordMs < HOLD_MS - SLACK_MS,
      `the refusal waited ${recordMs}ms for a key another transaction held. Inside a caller's transaction `
      + 'it must not wait at all — that wait is where a deadlock against the caller\'s own locks comes from')
    assert.equal(await db.setting.count({ where: { key: settingKey } }), 1,
      'the caller\'s transaction committed: a refusal that cannot be recorded must not abort it (review M-14)')
    const rows = await db.accountingPostingRefusal.findMany({ where: keyFor(referenceId) })
    assert.equal(rows.length, 0,
      `nothing may be written from a state that could not be read under the key. ${describe(await inboxView(db, referenceId))}`)
    assert.equal(
      await db.activityLog.count({ where: { action: 'accounting_posting_refusal_not_recorded_contended', description: { contains: referenceId } } }),
      1, 'and it is reported, never silent')
  },
)

test(
  '[o3d-j625 r9] the POOLED clear takes the posting key — it is not only the primitive that holds it',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, clearAccountingPostingRefusal } = await loadDeps()
    const { lockPostingKey } = await import('../../lib/domain/accounting/posting-suppression.ts')
    const referenceId = probeId('pooled-clear')
    t.after(cleanup(db, referenceId))
    await seedOutstandingRefusal(db, referenceId)

    // The facade clears through the POOL after the connector queue's own transaction has closed
    // (lib/accounting.ts), so that clear holds no key unless it takes one itself. Measured by making
    // another transaction hold the key: an unlocked clear sails past, a locked one waits.
    const signal: { fire?: () => void } = {}
    const keyIsHeld = new Promise<void>((resolve) => { signal.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, keyFor(referenceId))
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await keyIsHeld

    const startedAt = Date.now()
    await clearAccountingPostingRefusal(db as never, keyFor(referenceId))
    const clearMs = Date.now() - startedAt
    await holder

    assert.ok(clearMs >= HOLD_MS - SLACK_MS,
      `the pooled clear finished in ${clearMs}ms while another transaction held this posting's key for `
      + `${HOLD_MS}ms, so it took no key — and a refusal recorded in that window cannot see that the `
      + 'posting was queued')
    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 0, `and it still cleared the row. ${describe(rows)}`)
  },
)

test(
  '[o3d-j625 r9] a FIRST refusal racing the FIRST successful enqueue records no debt — there is no row to learn from',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, createAccountingSyncLogRow } = await loadDeps()
    const referenceId = probeId('first-refusal')
    t.after(cleanup(db, referenceId))
    // NO refusal row: this posting has never been refused, so the enqueue's clear matches nothing and
    // leaves no `resolvedAt` for a concurrent refusal to read. The evidence that the posting is queued is
    // the sync row itself, and it is only consulted because the posting key was CONTENDED.
    assert.equal(await db.accountingPostingRefusal.count({ where: keyFor(referenceId) }), 0, 'precondition: no row')

    const signal: { fire?: () => void } = {}
    const enqueueHasWritten = new Promise<void>((resolve) => { signal.fire = resolve })
    const enqueue = db.$transaction(async (tx) => {
      await createAccountingSyncLogRow<{ id: string }>(tx, {
        connector: 'xero',
        type: TYPE,
        status: 'PENDING',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: { narration: `o3d-j625 r9 probe ${referenceId}` },
      })
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)

    await enqueueHasWritten
    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'))
    await enqueue

    assert.equal(await db.accountingSyncLog.count({ where: { referenceId, status: { not: 'CANCELLED' } } }), 1,
      'the posting IS queued')
    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 0,
      `the posting is queued, so the refusal that lost the race owes nothing. ${describe(rows)}`)
  },
)

test(
  '[o3d-j625 r9] a contended refusal of ANOTHER receipt is still recorded — the sync-log check is keyed on the posting, not the document',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const { lockPostingKey } = await import('../../lib/domain/accounting/posting-suppression.ts')
    const referenceId = probeId('receipt-scope')
    // o3d-j625 r5 HIGH 3, re-asked of r9's new check: an INVOICE_PAYMENT is one RECEIPT against one
    // document, so receipt A's queued row says NOTHING about receipt B's refusal. A sync-log check that
    // matched on the three indexed columns alone would swallow B and restore that HIGH exactly.
    const paymentKey = (payment: string) => ({ type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId, scope: `payment:${payment}` })
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceId } }).catch(() => undefined)
      await db.accountingPostingRefusal.deleteMany({ where: { referenceId } }).catch(() => undefined)
    })

    // Receipt A is queued and settled — its own transaction is long finished.
    await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: 'INVOICE_PAYMENT', status: 'PENDING', referenceType: 'SalesOrder', referenceId,
        payload: { paymentId: 'pay-A', _idempotencyKey: `invoice-payment:${referenceId}:pay-A` },
      },
    })

    // Receipt B's key is held by something else, so B's refusal is CONTENDED and does consult the log.
    const signal: { fire?: () => void } = {}
    const keyIsHeld = new Promise<void>((resolve) => { signal.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, paymentKey('pay-B'))
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await keyIsHeld

    await recordAccountingPostingRefusal(db as never, paymentKey('pay-B'), {
      kind: 'invoice_payment_receipt' as never,
      chartConnector: 'xero',
      activeConnector: 'quickbooks',
      reason: 'payment_account_not_in_ledger',
      committed: 'the receipt is recorded against the order in IMS',
      remedy: 'Re-map the payment method against the connector now in use.',
    })
    await holder

    const rows = await db.accountingPostingRefusal.findMany({ where: { ...paymentKey('pay-B'), resolvedAt: null }, select: { reason: true } })
    assert.deepEqual(rows, [{ reason: 'payment_account_not_in_ledger' }],
      'receipt B is owed: receipt A being queued does not discharge it, and a contended check that reads '
      + 'the document instead of the posting would lose it')
  },
)

test(
  '[o3d-j625 r9] a CANCELLED sync row is not a queued posting — a contended refusal is still recorded',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const { lockPostingKey } = await import('../../lib/domain/accounting/posting-suppression.ts')
    const referenceId = probeId('cancelled-row')
    t.after(cleanup(db, referenceId))
    // The row IMS wrote for this posting was cancelled — by the orphan sweep, or by a mark that was then
    // rolled back. Nothing is in the ledger and nothing will put it there, so the refusal IS owed.
    await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: TYPE, status: 'CANCELLED', referenceType: REFERENCE_TYPE, referenceId,
        payload: { narration: `o3d-j625 r9 cancelled ${referenceId}` },
      },
    })

    const signal: { fire?: () => void } = {}
    const keyIsHeld = new Promise<void>((resolve) => { signal.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, keyFor(referenceId))
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await keyIsHeld

    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'))
    await holder

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 1,
      'a cancelled row means the posting was NOT queued, so the refusal is outstanding work')
  },
)
