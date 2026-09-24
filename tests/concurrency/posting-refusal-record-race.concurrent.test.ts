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
    // o3d-j625 r10: and the provisional claims. The idempotency key is normalised to lower case by
    // `buildOutboxIdempotencyKey`, which is why this does not match on the probe id verbatim.
    await db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: referenceId.toLowerCase() } } }).catch(() => undefined)
  }
}

/** The provisional claims this posting has, whatever state they are in. */
async function claimsFor(db: Db, referenceId: string) {
  return db.integrationOutbox.findMany({
    where: { idempotencyKey: { contains: referenceId.toLowerCase() } },
    select: { id: true, connector: true, operation: true, status: true, payloadJson: true },
  })
}

/** Drain the claims exactly as `/api/cron/accounting-sync` does, on the pool, where waiting is allowed. */
async function reconcile() {
  const { reconcileProvisionalPostingRefusals } = await import('../../lib/domain/accounting/posting-refusal-reconcile.ts')
  return reconcileProvisionalPostingRefusals()
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

/**
 * o3d-j625 r10 (Codex round 9, HIGH) — THE TEST THAT USED TO PIN THE LOSS.
 *
 * Until r10 this test asserted that a contended in-transaction refusal recorded NOTHING and that the
 * caller committed anyway, and called that correct. It was half correct: the caller must commit (review
 * M-14) and this path must never WAIT for the key. What it also asserted — that the refusal simply
 * disappeared, leaving an activity-log WARNING — is the finding. If the transaction holding the key then
 * rolls back, the posting is owed and nothing lists it.
 *
 * So the same interleaving is driven, the same two properties are still required, and the third is now
 * the opposite: the refusal is PERSISTED with the caller's own transaction and reconciled afterwards.
 */
test(
  '[o3d-j625 r10] inside a CALLER transaction a key another transaction holds DEFERS the refusal — the caller commits and nothing is lost',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const [{ lockPostingKey }, { withSavepoint }] = await Promise.all([
      import('../../lib/domain/accounting/posting-suppression.ts'),
      import('../../lib/db/savepoint.ts'),
    ])
    const referenceId = probeId('contended')
    t.after(cleanup(db, referenceId))

    // Someone else is settling this exact posting and holds its key — and, in this test, never queues
    // anything. That is the case r9 lost: the debt is real and the refusal was the only record of it.
    const signal: { fire?: () => void } = {}
    const keyIsHeld = new Promise<void>((resolve) => { signal.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, keyFor(referenceId))
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await keyIsHeld

    const startedAt = Date.now()
    const settingKey = `j625r10-committed-${referenceId}`
    const decidedAt = new Date()
    await db.$transaction(async (tx) => {
      await recordAccountingPostingRefusal(tx as never, keyFor(referenceId), refusalRecord('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt,
      })
      await tx.setting.create({ data: { key: settingKey, value: 'the caller\'s transaction committed' } })
    }, TX)
    const recordMs = Date.now() - startedAt
    t.after(async () => { await db.setting.deleteMany({ where: { key: settingKey } }).catch(() => undefined) })

    // UNCHANGED, and both still load-bearing.
    assert.ok(recordMs < HOLD_MS - SLACK_MS,
      `the refusal waited ${recordMs}ms for a key another transaction held. Inside a caller's transaction `
      + 'it must not wait at all — that wait is where a deadlock against the caller\'s own locks comes from')
    assert.equal(await db.setting.count({ where: { key: settingKey } }), 1,
      'the caller\'s transaction committed: a refusal that cannot be recorded must not abort it (review M-14)')

    // AND THE REFUSAL SURVIVED IT. Nothing in the refusal table yet — that write needs the key — but the
    // obligation is durable, and it committed with the caller's own work.
    assert.equal((await db.accountingPostingRefusal.findMany({ where: keyFor(referenceId) })).length, 0,
      'nothing may be written to the refusal row from a state that could not be read under the key')
    const claims = await claimsFor(db, referenceId)
    assert.equal(claims.length, 1,
      'the refusal is held as a provisional claim; without one, a holder that rolls back leaves an owed posting nowhere')
    assert.equal(claims[0]!.operation, 'posting-refusal.provisional')
    assert.equal(
      await db.activityLog.count({ where: { action: 'accounting_posting_refusal_not_recorded_contended', description: { contains: referenceId } } }),
      1, 'and it is reported, never silent')

    await holder

    // The holder queued nothing, so the posting IS owed — and reconciling says so.
    const result = await reconcile()
    assert.ok(result.recorded >= 1, `the replay recorded the debt (${JSON.stringify(result)})`)
    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 1,
      `the transaction holding the key never queued this posting, so it is owed and the exception inbox must `
      + `list it. ${describe(rows)}`)
    assert.equal(rows[0]!.reason, 'retired_chart', 'with the refusing site\'s own reason, not a generic one')
    assert.equal((await claimsFor(db, referenceId))[0]!.status, 'SUCCEEDED', 'and the claim is settled')
  },
)

/**
 * CODEX'S OWN NEXT STEP: the lock holder ROLLS BACK, and the refused posting must remain outstanding.
 *
 * The holder here does what the r9 comment assumed away — it writes the accounting sync row for this
 * exact posting (taking the key, clearing any refusal) and then ABORTS. Every trace of it disappears, so
 * the refusal that lost the race to it is the only record that the posting is owed.
 */
test(
  '[o3d-j625 r10] the transaction holding the key ROLLS BACK, and the refused posting stays outstanding',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, createAccountingSyncLogRow } = await loadDeps()
    const { withSavepoint } = await import('../../lib/db/savepoint.ts')
    const referenceId = probeId('holder-rollback')
    t.after(cleanup(db, referenceId))

    const signal: { fire?: () => void } = {}
    const enqueueHasWritten = new Promise<void>((resolve) => { signal.fire = resolve })
    const ABORT = `j625r10 deliberate rollback ${referenceId}`
    const holder = db.$transaction(async (tx) => {
      await createAccountingSyncLogRow<{ id: string }>(tx, {
        connector: 'xero',
        type: TYPE,
        status: 'PENDING',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: { narration: `o3d-j625 r10 rolled back ${referenceId}` },
      })
      signal.fire!()
      await sleep(HOLD_MS)
      throw new Error(ABORT)
    }, TX).then(() => 'committed', (error: unknown) => (error instanceof Error && error.message === ABORT ? 'rolled-back' : Promise.reject(error)))
    await enqueueHasWritten

    const settingKey = `j625r10-rollback-${referenceId}`
    await db.$transaction(async (tx) => {
      await recordAccountingPostingRefusal(tx as never, keyFor(referenceId), refusalRecord('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt: new Date(),
      })
      await tx.setting.create({ data: { key: settingKey, value: 'committed' } })
    }, TX)
    t.after(async () => { await db.setting.deleteMany({ where: { key: settingKey } }).catch(() => undefined) })

    assert.equal(await holder, 'rolled-back', 'PRECONDITION: the transaction holding the key aborted')
    assert.equal(await db.accountingSyncLog.count({ where: { referenceId } }), 0,
      'PRECONDITION: its accounting sync row went with it — nothing will post this')
    assert.equal((await claimsFor(db, referenceId)).length, 1, 'PRECONDITION: the refusal was held as a claim')

    await reconcile()

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 1,
      `the posting was never queued — the transaction that held its key rolled back — so the refusal is `
      + `outstanding work. ${describe(rows)}`)
    assert.equal(rows[0]!.remedy, refusalRecord('retired_chart').remedy,
      'and it carries the refusing site\'s own remedy, so the operator is told what to do')
  },
)

/** The complement, and the reason the reconciler may not simply record every claim it finds. */
test(
  '[o3d-j625 r10] the transaction holding the key COMMITS the posting, and the deferred refusal settles to nothing owed',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, createAccountingSyncLogRow } = await loadDeps()
    const { withSavepoint } = await import('../../lib/db/savepoint.ts')
    const referenceId = probeId('holder-commit')
    t.after(cleanup(db, referenceId))

    const signal: { fire?: () => void } = {}
    const enqueueHasWritten = new Promise<void>((resolve) => { signal.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await createAccountingSyncLogRow<{ id: string }>(tx, {
        connector: 'xero',
        type: TYPE,
        status: 'PENDING',
        referenceType: REFERENCE_TYPE,
        referenceId,
        payload: { narration: `o3d-j625 r10 committed ${referenceId}` },
      })
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await enqueueHasWritten

    await db.$transaction(async (tx) => {
      await recordAccountingPostingRefusal(tx as never, keyFor(referenceId), refusalRecord('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt: new Date(),
      })
    }, TX)
    await holder

    assert.equal(await db.accountingSyncLog.count({ where: { referenceId, status: { not: 'CANCELLED' } } }), 1,
      'PRECONDITION: the posting IS queued')
    assert.equal((await claimsFor(db, referenceId)).length, 1, 'PRECONDITION: the refusal was held as a claim')

    const result = await reconcile()
    assert.ok(result.settled >= 1, `the replay found the posting settled (${JSON.stringify(result)})`)
    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 0,
      `the posting is in the accounting sync log, so the refusal that lost the race owes nothing. ${describe(rows)}`)
    assert.equal(
      await db.activityLog.count({ where: { action: 'accounting_posting_refused_after_queued', description: { contains: referenceId } } }),
      1, 'and the replay says so rather than closing the claim silently')
    assert.equal((await claimsFor(db, referenceId))[0]!.status, 'SUCCEEDED')
  },
)

/**
 * THE CLAIM IS THE CALLER'S OWN WRITE, and it has to vanish with the caller.
 *
 * Written through the pool instead, it would survive a rolled-back goods receipt / bill / MO completion
 * and leave the exception inbox asking about a posting for work that never happened.
 */
test(
  '[o3d-j625 r10] a provisional claim rolls back with the caller that could not record its refusal',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const [{ lockPostingKey }, { withSavepoint }] = await Promise.all([
      import('../../lib/domain/accounting/posting-suppression.ts'),
      import('../../lib/db/savepoint.ts'),
    ])
    const referenceId = probeId('caller-rollback')
    t.after(cleanup(db, referenceId))

    const signal: { fire?: () => void } = {}
    const keyIsHeld = new Promise<void>((resolve) => { signal.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, keyFor(referenceId))
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await keyIsHeld

    const ABORT = `j625r10 caller abort ${referenceId}`
    let deferred = false
    const caller = await db.$transaction(async (tx) => {
      const outcome = await recordAccountingPostingRefusal(tx as never, keyFor(referenceId), refusalRecord('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt: new Date(),
      })
      deferred = outcome.recorded === false && outcome.because === 'contended' && outcome.deferred
      throw new Error(ABORT)
    }, TX).then(() => 'committed', (error: unknown) => (error instanceof Error && error.message === ABORT ? 'rolled-back' : Promise.reject(error)))
    await holder

    assert.equal(caller, 'rolled-back', 'PRECONDITION: the caller aborted after the refusal was deferred')
    assert.equal(deferred, true, 'PRECONDITION: the refusal really did take the deferred path')
    assert.deepEqual(await claimsFor(db, referenceId), [],
      'the claim is written through the CALLER\'s client, so a rolled-back caller leaves no debt for work it undid')
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

/**
 * o3d-j625 r10 — THE r9 RESIDUAL, CLOSED, AND THE CONTROL THAT SAYS THE CURE IS NOT WORSE.
 *
 * r9 stated this and did not fix it: a refusal decided before a successful enqueue that both STARTED and
 * COMMITTED in the gap, with the refusal then taking the key UNCONTENDED, was still recorded — a debt the
 * ledger did not owe. It had to be closed this round, because the reconciler replays claims minutes later
 * with the key long free, which would have turned that rare race into the ordinary path.
 *
 * The evidence is the sync row's own creation, compared against the moment the refusal was decided. The
 * CONTROL is the other half, and it is what a blanket "a live row exists, so nothing is owed" would fail:
 * several posting types share ONE key across successive postings (SALES_INVOICE_UPDATE and friends), so a
 * row created BEFORE the decision is an EARLIER posting and discharges nothing.
 */
test(
  '[o3d-j625 r10] a posting queued AFTER the refusal was decided is not a debt, even with no contention',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const referenceId = probeId('residual-after')
    t.after(cleanup(db, referenceId))

    // The refusal is decided HERE. The enqueue then starts AND commits — its own transaction is finished
    // and its key is free, so the refusal below takes the key at once and has no contention to learn from.
    const decidedAt = new Date()
    await sleep(20)
    await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: TYPE, status: 'PENDING', referenceType: REFERENCE_TYPE, referenceId,
        payload: { narration: `o3d-j625 r10 queued after the decision ${referenceId}` },
      },
    })
    await sleep(20)

    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'), { decidedAt })

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 0,
      `the posting was queued after this refusal was decided, so it is queued and nothing is owed. ${describe(rows)}`)
    assert.equal(
      await db.activityLog.count({ where: { action: 'accounting_posting_refused_after_queued', description: { contains: referenceId } } }),
      1, 'and the refusal that was not recorded is reported rather than vanishing')
  },
)

test(
  '[o3d-j625 r10] THE CONTROL — a posting queued BEFORE the refusal was decided does NOT discharge it',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const referenceId = probeId('residual-before')
    t.after(cleanup(db, referenceId))

    // Edit 1 of a document-scoped posting: queued, settled, its row live for ever.
    await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: TYPE, status: 'SYNCED', referenceType: REFERENCE_TYPE, referenceId,
        payload: { narration: `o3d-j625 r10 an EARLIER posting ${referenceId}` },
      },
    })
    await sleep(20)
    // Edit 2, refused. The ledger holds the earlier document and nothing will correct it.
    const decidedAt = new Date()

    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'), { decidedAt })

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 1,
      'an EARLIER posting being in the sync log does not discharge a LATER refusal — a check that swallowed '
      + 'this would lose exactly the debt this table exists to show')
  },
)

/**
 * o3d-j625 r10 — THE CUTOFF IS THE DATABASE'S CLOCK *NOW*, NOT THIS TRANSACTION'S START.
 *
 * The sync-log arm compares a row's `createdAt` (a database clock) against the moment the refusal was
 * decided (an application clock), and bridges the two by asking the database what time it is. Ask with
 * `now()` and the answer is `transaction_timestamp()` — the moment THIS transaction began. On the
 * in-transaction path that transaction is the caller's: a goods receipt or an MO completion that may
 * have started minutes earlier. The cutoff then sits in the past and rows created BEFORE the refusal was
 * decided are read as having come after it, which swallows a real debt.
 *
 * Driven here: the caller's transaction begins, an EARLIER posting of the same key is queued from the
 * pool 300ms later, and only then is the refusal decided and recorded. The debt is real — the refusal
 * post-dates that posting — and must be listed.
 */
test(
  '[o3d-j625 r10] a refusal from a LONG-RUNNING caller transaction is not swallowed by a posting queued after that transaction began',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const { withSavepoint } = await import('../../lib/db/savepoint.ts')
    const referenceId = probeId('caller-tx-age')
    t.after(cleanup(db, referenceId))

    const opened: { fire?: () => void } = {}
    const callerHasBegun = new Promise<void>((resolve) => { opened.fire = resolve })
    const gate: { fire?: () => void } = {}
    const mayDecide = new Promise<void>((resolve) => { gate.fire = resolve })
    const decision: { at: Date | null } = { at: null }

    const caller = db.$transaction(async (tx) => {
      // Force the BEGIN, so `transaction_timestamp()` is stamped before the sync row below exists.
      await tx.$queryRaw`SELECT 1`
      opened.fire!()
      await mayDecide
      decision.at = new Date()
      await recordAccountingPostingRefusal(tx as never, keyFor(referenceId), refusalRecord('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt: decision.at,
      })
    }, TX)

    await callerHasBegun
    await sleep(300)
    const earlier = await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: TYPE, status: 'SYNCED', referenceType: REFERENCE_TYPE, referenceId,
        payload: { narration: `o3d-j625 r10 an earlier posting ${referenceId}` },
      },
      select: { createdAt: true },
    })
    await sleep(50)
    gate.fire!()
    await caller

    // PRECONDITIONS: the interleaving the test is about actually happened.
    const decidedAt = decision.at
    assert.ok(decidedAt, 'the refusal was decided')
    assert.ok(earlier.createdAt.getTime() < decidedAt.getTime(),
      `PRECONDITION: the earlier posting (${earlier.createdAt.toISOString()}) was queued BEFORE the refusal `
      + `was decided (${decidedAt.toISOString()}) — otherwise it would rightly discharge it`)

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 1,
      'the posting queued before this refusal was decided does not discharge it — and a cutoff taken from '
      + `the CALLER transaction's start rather than the database's clock now would have said it did. ${describe(rows)}`)
  },
)
