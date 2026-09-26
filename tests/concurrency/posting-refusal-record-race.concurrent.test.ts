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
    // o3d-j625 r13: `suppressed` is part of the answer now, and `true` is the right value HERE —
    // MANUFACTURING_JOURNAL's key names one posting for ever, so the mark does write the permanent
    // suppression. Asserted rather than matched away: it is the fact the operator-facing sentence is built
    // from, and a mark that silently stopped suppressing this kind would reintroduce the double post.
    assert.deepEqual(marked, { ok: true, cancelledSyncRows: [], kind: KIND, suppressed: true },
      'the operator marked the posting handled, and this key suppresses for ever')
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

/**
 * o3d-j625 r12 (Codex round 11, HIGH 1) — THIS TEST USED TO PIN THE OTHER ANSWER, AND IT WAS THE LOSS.
 *
 * Until r12 a refusal decided before a clear was discharged by `resolvedAt`/`queued` on the row, with no
 * look at whether a posting still existed. Codex executed the consequence: an enqueue whose row is
 * CANCELLED before it can post — the capacity guard, a deleted payment, an operator settling NOT_POSTED —
 * leaves that column behind, and the refusal it discharges is owed. `resolvedAt` records that an enqueue
 * once happened; the obligation is about whether the ledger has the posting or is going to get it.
 *
 * So the column is no longer evidence, and the case this test drives — a clear with NOTHING queued behind
 * it, which is what a stale refusal looks like from here — is now RECORDED. It is the safe direction: the
 * deferred path, where a refusal really can lose a race with an enqueue, is answered by the baseline
 * instead (the r10/r11/r12 tests below), with no clock and no column.
 */
test(
  '[o3d-j625 r12] a refusal decided BEFORE a clear IS recorded — `resolvedAt` is not evidence a posting exists',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, clearAccountingPostingRefusal } = await loadDeps()
    const referenceId = probeId('decided-before')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedOutstandingRefusal(db, referenceId)

    // The refusal is decided HERE, and lands after the row has been cleared as queued.
    const decidedAt = new Date()
    await sleep(20)
    await clearAccountingPostingRefusal(db as never, keyFor(referenceId))
    const cleared = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusalId }, select: { resolvedAt: true, resolution: true },
    })
    assert.equal(cleared.resolution, 'queued', 'PRECONDITION: the row carries the clear\'s own resolution')
    assert.ok(cleared.resolvedAt && cleared.resolvedAt.getTime() > decidedAt.getTime(),
      'PRECONDITION: stamped AFTER the decision — exactly the state r11 discharged on')
    const live = await db.accountingSyncLog.count({ where: { referenceId, status: { not: 'CANCELLED' } } })
    console.log(`[r12] live sync rows for ${referenceId}: ${live}; resolution=${cleared.resolution}`)
    assert.equal(live, 0, 'PRECONDITION: and NOTHING is queued — no row can post this')

    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'), { decidedAt })

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 1,
      'no posting exists for this key, so nothing can discharge the refusal — whatever `resolvedAt` says. '
      + `${describe(rows)}`)
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
/**
 * o3d-j625 r12 (Codex round 11, HIGH 2) — AND THIS ONE USED TO PIN THE CLOCK COMPARISON.
 *
 * r9's residual: an enqueue that both starts and commits in the gap before an UNCONTENDED refusal takes
 * the key. r10 discharged it because the sync row's `createdAt` beat `decidedAt`, and round 11 showed that
 * comparison orders the clocks of TWO IMS PROCESSES, not two events — a process running fast stamps an
 * OLDER row with a LATER `createdAt` and swallows a real debt (the r12 skew tests below reproduce it).
 *
 * There is no ordering available to a single process that is not a clock: `createdAt`, `resolvedAt` and
 * `decidedAt` are all written by whichever process happened to be there. So the window is open again and
 * the refusal is RECORDED — a debt that may not be owed, which an operator can read, close, and which
 * `markPostingHandled` refuses to "post by hand" while IMS may already have posted it. The alternative was
 * a debt that was owed and which nothing would ever list.
 *
 * THIS IS THE COST OF THE ROUND, stated as a test rather than in prose. It does NOT touch the deferred
 * path: there the refusal has a baseline, and the case r10 worried about most ("the reconciler runs minutes
 * after the claim, uncontended by then") is exactly the one the baseline answers.
 */
test(
  '[o3d-j625 r12] an UNCONTENDED refusal with a posting queued after it IS recorded — the cost of having no clock',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const referenceId = probeId('residual-after')
    t.after(cleanup(db, referenceId))

    // The refusal is decided HERE. The enqueue then starts AND commits — its own transaction is finished
    // and its key is free, so the refusal below takes the key at once and has no contention to learn from.
    const decidedAt = new Date()
    await sleep(20)
    const queued = await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: TYPE, status: 'PENDING', referenceType: REFERENCE_TYPE, referenceId,
        payload: { narration: `o3d-j625 r10 queued after the decision ${referenceId}` },
      },
      select: { id: true, createdAt: true },
    })
    await sleep(20)
    console.log(`[r12] uncontended: row ${queued.id}@${queued.createdAt.toISOString()} vs decidedAt=${decidedAt.toISOString()}`)
    assert.ok(queued.createdAt.getTime() > decidedAt.getTime(),
      'PRECONDITION: the row\'s stamp really is later than the decision — the state r10 discharged on')

    await recordAccountingPostingRefusal(db as never, keyFor(referenceId), refusalRecord('retired_chart'), { decidedAt })

    const rows = await inboxView(db, referenceId)
    assert.equal(rows.length, 1,
      'this refusal was never shut out of the key, so it observed nothing and has no evidence that the '
      + 'posting was queued after it was decided — only two clocks, which are not evidence. The debt is '
      + `kept. ${describe(rows)}`)
    assert.equal(
      await db.activityLog.count({ where: { action: 'accounting_posting_refused_after_queued', description: { contains: referenceId } } }),
      0, 'and nothing is reported as "queued while this was being decided", because nothing established that')
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

/**
 * ── o3d-j625 r11 (Codex round 10, two HIGHs) — A TIMESTAMP COMPARISON IS NOT EVIDENCE OF AN EVENT ──
 *
 * Round 10 answered "was this posting queued after this refusal was decided?" from the accounting sync
 * log: any live row when the key was CONTENDED, or a row whose `createdAt` beat the decision otherwise.
 * Codex executed both halves and both are wrong, in OPPOSITE directions:
 *
 *   HIGH 1 (a debt wrongly DISCHARGED — silent money loss). Successive edits of one invoice share ONE
 *          posting key (SALES_INVOICE_UPDATE). Edit 1's row stays live for ever. A refusal deferred
 *          because another transaction held the key replays with `contendedWhenDecided`, sees edit 1's
 *          row, and calls the debt settled — even when the transaction that held the key ROLLED BACK
 *          and queued nothing. The refusal never reaches the exception inbox.
 *
 *   HIGH 2 (a debt wrongly RECORDED — a double-post risk). `accounting_sync_logs.createdAt` defaults to
 *          `now()`, which is TRANSACTION START. An enqueue can begin before the refusal is decided,
 *          INSERT after it, and commit before the refusal takes the key. Its `createdAt` still predates
 *          the decision, so the refusal is recorded and the inbox tells an operator to post a posting
 *          that is already queued.
 *
 * Both tests below are REPRODUCTIONS: they were written against the r10 head and fail on it. Neither
 * models a window — the interleaving is the one PostgreSQL produces, and each asserts the precondition
 * that the interleaving was actually reached and prints what it examined.
 */

/** SALES_INVOICE_UPDATE: successive EDITS of one invoice share one posting key, by design. */
const UPDATE_TYPE = 'SALES_INVOICE_UPDATE'
const UPDATE_REFERENCE_TYPE = 'SalesOrder'
const UPDATE_KIND = 'sales_invoice_update'

const updateKeyFor = (referenceId: string) => ({
  type: UPDATE_TYPE, referenceType: UPDATE_REFERENCE_TYPE, referenceId, scope: '',
})

const updateRefusal = (reason: string) => ({
  kind: UPDATE_KIND as never,
  chartConnector: 'xero',
  activeConnector: 'quickbooks',
  reason,
  committed: 'the edited invoice stands in IMS and the ledger still holds the previous version',
  remedy:
    'Post the edited invoice by hand in the ledger it belongs to and mark this row handled — that cancels '
    + 'IMS\'s retry, so it is not posted twice.',
})

/** Exactly what the exception inbox selects, for any posting key. */
async function inboxViewOf(db: Db, key: ReturnType<typeof updateKeyFor>) {
  return db.accountingPostingRefusal.findMany({
    where: { ...key, resolvedAt: null },
    select: { id: true, reason: true, remedy: true, suppressedAt: true, refusedCount: true },
  })
}

test(
  '[o3d-j625 r11] an OLDER edit\'s sync row does not discharge a deferred refusal whose lock holder ROLLED BACK',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, createAccountingSyncLogRow } = await loadDeps()
    const { withSavepoint } = await import('../../lib/db/savepoint.ts')
    const referenceId = probeId('older-row-holder-rollback')
    const key = updateKeyFor(referenceId)
    t.after(cleanup(db, referenceId))

    // EDIT 1 — queued and COMMITTED, long finished. Its sync row stays live for ever, and every later
    // edit of this invoice shares its posting key.
    const edit1 = await db.$transaction(async (tx) => createAccountingSyncLogRow<{ id: string }>(tx, {
      connector: 'xero',
      type: UPDATE_TYPE,
      status: 'SYNCED',
      referenceType: UPDATE_REFERENCE_TYPE,
      referenceId,
      payload: { narration: `o3d-j625 r11 EDIT 1, queued and settled ${referenceId}` },
    }), TX)
    assert.ok(edit1, 'PRECONDITION: edit 1 was queued')
    await sleep(20)

    // EDIT 2 — another transaction takes this exact key, writes its own sync row, and then ABORTS.
    // Nothing it did survives; the posting is owed and the refusal below is the only record of it.
    const signal: { fire?: () => void } = {}
    const holderHasWritten = new Promise<void>((resolve) => { signal.fire = resolve })
    const ABORT = `j625r11 deliberate rollback ${referenceId}`
    const holder = db.$transaction(async (tx) => {
      await createAccountingSyncLogRow<{ id: string }>(tx, {
        connector: 'xero',
        type: UPDATE_TYPE,
        status: 'PENDING',
        referenceType: UPDATE_REFERENCE_TYPE,
        referenceId,
        payload: { narration: `o3d-j625 r11 EDIT 2, rolled back ${referenceId}` },
      })
      signal.fire!()
      await sleep(HOLD_MS)
      throw new Error(ABORT)
    }, TX).then(() => 'committed', (error: unknown) => (error instanceof Error && error.message === ABORT ? 'rolled-back' : Promise.reject(error)))
    await holderHasWritten

    // EDIT 3's refusal, inside its own caller transaction, while edit 2 holds the key.
    const settingKey = `j625r11-older-row-${referenceId}`
    const decidedAt = new Date()
    let outcome: unknown = null
    const startedAt = Date.now()
    await db.$transaction(async (tx) => {
      outcome = await recordAccountingPostingRefusal(tx as never, key, updateRefusal('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt,
      })
      await tx.setting.create({ data: { key: settingKey, value: 'the caller\'s transaction committed' } })
    }, TX)
    const recordMs = Date.now() - startedAt
    t.after(async () => { await db.setting.deleteMany({ where: { key: settingKey } }).catch(() => undefined) })

    // PRECONDITIONS — the interleaving, MEASURED, not assumed.
    assert.ok(recordMs < HOLD_MS - SLACK_MS,
      `the refusal took ${recordMs}ms while edit 2 held the key for ${HOLD_MS}ms: it must have been SHUT `
      + 'OUT of the key (and never waited for it), or this is not the deferred path at all')
    assert.deepEqual(outcome, { recorded: false, because: 'contended', deferred: true },
      'PRECONDITION: the refusal really took the deferred path')
    assert.equal(await holder, 'rolled-back', 'PRECONDITION: the transaction holding the key ABORTED')

    const live = await db.accountingSyncLog.findMany({
      where: { referenceId, status: { not: 'CANCELLED' } },
      select: { id: true, status: true, createdAt: true },
    })
    console.log(`[r11 HIGH-1] live sync rows examined for ${referenceId}: ${live.length} — `
      + live.map((r) => `${r.id}@${r.createdAt.toISOString()}/${r.status}`).join(', '))
    assert.equal(live.length, 1,
      'PRECONDITION: exactly ONE live sync row survives — edit 1\'s. Edit 2\'s went with its rollback')
    assert.equal(live[0]!.id, (edit1 as { id: string }).id, 'PRECONDITION: and it is edit 1\'s row')
    assert.ok(live[0]!.createdAt.getTime() < decidedAt.getTime(),
      `PRECONDITION: edit 1's row (${live[0]!.createdAt.toISOString()}) pre-dates the refusal `
      + `(${decidedAt.toISOString()}), so it is an OLDER posting and discharges nothing`)
    const claims = await claimsFor(db, referenceId)
    assert.equal(claims.length, 1, 'PRECONDITION: the refusal was held as one provisional claim')

    const result = await reconcile()
    console.log(`[r11 HIGH-1] reconcile: ${JSON.stringify(result)}`)

    const rows = await inboxViewOf(db, key)
    assert.equal(rows.length, 1,
      'THE FINDING: the transaction holding this posting\'s key rolled back and queued nothing, so the '
      + 'edited invoice is owed. An OLDER edit\'s sync row is not evidence that THIS posting was queued, '
      + `and the exception inbox must list it. ${describe(rows)}`)
    assert.equal(rows[0]!.reason, 'retired_chart', 'with the refusing site\'s own reason')
    assert.ok(result.recorded >= 1, `and the replay says it recorded a debt (${JSON.stringify(result)})`)
  },
)

/**
 * ── o3d-j625 r12 — THE OTHER DIRECTION OF THE SAME CONTROL, AND WHAT REPLACED r11'S `createdAt` PIN ──
 *
 * r11 pinned that `accounting_sync_logs.createdAt` is stamped at the INSERT rather than at transaction
 * start, because its arm 2 rested on that fact. r12 removed arm 2, so that pin now guards nothing, and a
 * test whose stated purpose is "this is the fact the comparison rests on" standing beside code with no
 * comparison is a claim outrunning its evidence. It is replaced by this, which asks the question that
 * matters now: DOES THE DISCHARGE DEPEND ON THE CLOCK AT ALL?
 *
 * The r12 skew tests above show that a LATER stamp does not discharge. This is the complement: a row
 * queued by a process whose clock is a YEAR BEHIND — a stamp far older than the refusal — still discharges
 * it, because the refusal watched that row appear. If any clock comparison were reinstated as a necessary
 * condition, this test goes red. Together the two directions say the outcome is decided by identity and by
 * nothing else.
 *
 * (The writer that would have made round 10's HIGH 2 real — a raw statement letting the column DEFAULT
 * apply — is still refused by tests/accounting/sync-log-row-primitive.test.ts, which is where that
 * property belongs.)
 */
test(
  '[o3d-j625 r12] a row queued while the refusal was shut out discharges it even with a stamp a YEAR older',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const [{ lockPostingKey }, { withSavepoint }] = await Promise.all([
      import('../../lib/domain/accounting/posting-suppression.ts'),
      import('../../lib/db/savepoint.ts'),
    ])
    const referenceId = probeId('r12-behind-clock-discharges')
    const key = updateKeyFor(referenceId)
    t.after(cleanup(db, referenceId))

    const YEAR_MS = 365 * 24 * 60 * 60 * 1000
    // The holder takes this posting's key and queues the posting — from a process whose clock is a year
    // behind, so the row it writes carries a stamp far older than the refusal that is about to be decided.
    const signal: { fire?: () => void } = {}
    const holderHasWritten = new Promise<void>((resolve) => { signal.fire = resolve })
    const written: { id?: string; createdAt?: Date } = {}
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, key)
      const row = await tx.accountingSyncLog.create({
        data: {
          connector: 'xero', type: UPDATE_TYPE, status: 'PENDING',
          referenceType: UPDATE_REFERENCE_TYPE, referenceId,
          payload: { narration: `o3d-j625 r12 queued by a process a year behind ${referenceId}` },
          createdAt: new Date(Date.now() - YEAR_MS),
        },
        select: { id: true, createdAt: true },
      })
      written.id = row.id
      written.createdAt = row.createdAt
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await holderHasWritten

    const decidedAt = new Date()
    let deferred: unknown = null
    await db.$transaction(async (tx) => {
      deferred = await recordAccountingPostingRefusal(tx as never, key, updateRefusal('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt,
      })
    }, TX)
    await holder

    assert.deepEqual(deferred, { recorded: false, because: 'contended', deferred: true },
      'PRECONDITION: the refusal was shut out of the key, so it took a baseline')
    const claims = await claimsFor(db, referenceId)
    assert.equal(claims.length, 1, 'PRECONDITION: one claim')
    const baseline = (claims[0]!.payloadJson as { queuedWhenShutOut?: { ids: string[]; complete: boolean } | null }).queuedWhenShutOut
    assert.deepEqual(baseline, { ids: [], complete: true },
      'PRECONDITION: and the baseline is EMPTY and complete — the holder had not committed when it was taken')
    console.log(`[r12 identity] row ${written.id}@${written.createdAt?.toISOString()} vs decidedAt=`
      + `${decidedAt.toISOString()}; baseline=${JSON.stringify(baseline)}`)
    assert.ok(written.createdAt && written.createdAt.getTime() < decidedAt.getTime() - YEAR_MS / 2,
      'PRECONDITION: the row\'s stamp is far OLDER than the refusal, so no clock comparison would pass it')

    const result = await reconcile()
    console.log(`[r12 identity] reconcile: ${JSON.stringify(result)}`)
    const rows = await inboxViewOf(db, key)
    assert.equal(rows.length, 0,
      'the transaction that held this key QUEUED the posting and the refusal watched its row appear, so '
      + `nothing is owed — whatever clock stamped it. ${describe(rows)}`)
    assert.ok(result.settled >= 1, `and the claim settled (${JSON.stringify(result)})`)
  },
)

/**
 * ── HIGH 2's OUTCOME, REPRODUCED THROUGH THE MECHANISM THAT IS ACTUALLY THERE ──
 *
 * r10 did not compare `createdAt` with `decidedAt`. It converted `decidedAt` into DATABASE time first —
 * `clock_timestamp()` less the age of the decision on the application clock — on the stated grounds that
 * "`accounting_sync_logs.createdAt` is a DATABASE clock (`@default(now())`)". The pin above measures that
 * premise and it is false: the column is written by the application. So the conversion did not remove a
 * clock-domain crossing, IT ADDED ONE — the database host's offset from the application's, injected into a
 * comparison of two application timestamps. On this deployment the database shares the host, so the offset
 * is zero and the error cancelled; IMS supports a DATABASE_URL anywhere (docs/installation.md), and there
 * it does not.
 *
 * Both of Codex's outcomes follow, in both directions, and this test drives them: the ONLY thing injected
 * is the answer to `SELECT clock_timestamp()`, the one statement r10 used to bridge the domains. Every
 * other statement — the advisory lock, the suppression read, the sync-log read, the writes — reaches the
 * real database. `clockReads` counts the interceptions, so the test also says whether the seam is there at
 * all: on the fixed code the bridge is gone, nothing asks the database what time it is, and the outcome
 * cannot depend on an offset that is never read.
 *
 * o3d-j625 r12: and since no clock of ANY kind is compared any more, both halves now KEEP the debt — (a)
 * because an uncontended refusal has no evidence, (b) because an earlier edit is not evidence. What the
 * test still establishes is what its name says: the answer does not move with the database host's clock.
 * It is the offset that is under test here, not the direction of the comparison; the r12 tests further
 * down are the ones that drive an APPLICATION clock skew, which is the finding round 11 raised.
 */
async function refuseWithDatabaseClockOffset(
  db: Db,
  key: ReturnType<typeof updateKeyFor>,
  decidedAt: Date,
  offsetMs: number,
): Promise<{ clockReads: number }> {
  const { recordAccountingPostingRefusal } = await loadDeps()
  let clockReads = 0
  const skewed = (tx: never) => {
    const real = tx as unknown as Db
    return {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (Array.isArray(strings) && strings.join('?').includes('clock_timestamp')) {
          clockReads++
          return Promise.resolve([{ at: new Date(Date.now() + offsetMs) }])
        }
        return (real.$queryRaw as unknown as (...a: unknown[]) => unknown)(strings, ...values)
      },
      $executeRaw: (...args: unknown[]) => (real.$executeRaw as unknown as (...a: unknown[]) => unknown)(...args),
      $executeRawUnsafe: (sql: string) => real.$executeRawUnsafe(sql),
      accountingPostingRefusal: real.accountingPostingRefusal,
      accountingSyncLog: real.accountingSyncLog,
    }
  }
  const client = {
    $executeRawUnsafe: (sql: string) => db.$executeRawUnsafe(sql),
    $transaction: (fn: (tx: never) => Promise<unknown>, options?: unknown) =>
      db.$transaction((tx) => fn(skewed(tx as never) as never), options as never),
  }
  await recordAccountingPostingRefusal(client as never, key, updateRefusal('retired_chart'), { decidedAt })
  return { clockReads }
}

test(
  '[o3d-j625 r11] whether a debt is kept must not depend on the DATABASE host\'s clock agreeing with this process\'s',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, createAccountingSyncLogRow } = await loadDeps()

    // (a) THE FALSE DEBT. The posting IS queued, after the decision. A database clock five minutes AHEAD
    //     moved r10's cutoff five minutes into the future, so the row read as "queued before the decision"
    //     and the refusal was recorded — the inbox then asks an operator to post what is already queued.
    const aheadRef = probeId('db-clock-ahead')
    const aheadKey = updateKeyFor(aheadRef)
    t.after(cleanup(db, aheadRef))
    const aheadDecidedAt = new Date()
    await sleep(20)
    const queued = await db.$transaction(async (tx) => createAccountingSyncLogRow<{ id: string }>(tx, {
      connector: 'xero', type: UPDATE_TYPE, status: 'PENDING',
      referenceType: UPDATE_REFERENCE_TYPE, referenceId: aheadRef,
      payload: { narration: `o3d-j625 r11 queued after the decision ${aheadRef}` },
    }), TX)
    assert.ok(queued, 'PRECONDITION: the posting was queued')
    const queuedRow = await db.accountingSyncLog.findUniqueOrThrow({ where: { id: (queued as { id: string }).id }, select: { createdAt: true } })
    assert.ok(queuedRow.createdAt.getTime() > aheadDecidedAt.getTime(),
      `PRECONDITION: it was queued (${queuedRow.createdAt.toISOString()}) AFTER the refusal was decided `
      + `(${aheadDecidedAt.toISOString()}), so nothing is owed`)
    const ahead = await refuseWithDatabaseClockOffset(db, aheadKey, aheadDecidedAt, 5 * 60_000)
    const aheadInbox = await inboxViewOf(db, aheadKey)
    console.log(`[r11 HIGH-2] database clock +5min: clock_timestamp reads=${ahead.clockReads}, inbox rows=${aheadInbox.length}`)
    // o3d-j625 r12: ONE, not zero, and the change is deliberate. This refusal was never shut out of the
    // key, so it observed nothing and has no evidence that the posting was queued after it was decided —
    // see the r12 test above on the cost of having no clock. What this half still establishes is the
    // property the test is named for: the answer does not move when the DATABASE host's clock does.
    assert.equal(aheadInbox.length, 1,
      'an uncontended refusal has no evidence that the posting post-dates it, so the debt is kept — and a '
      + `database clock running AHEAD of this process changes nothing about that. ${describe(aheadInbox)}`)

    // (b) THE SWALLOWED DEBT, the same defect in the direction that loses money. An EARLIER edit is
    //     queued, the refusal of the CURRENT edit follows it, and a database clock five minutes BEHIND
    //     moved r10's cutoff five minutes into the past, so the older row read as "queued after the
    //     decision" and discharged a debt that is owed.
    const behindRef = probeId('db-clock-behind')
    const behindKey = updateKeyFor(behindRef)
    t.after(cleanup(db, behindRef))
    const earlier = await db.$transaction(async (tx) => createAccountingSyncLogRow<{ id: string }>(tx, {
      connector: 'xero', type: UPDATE_TYPE, status: 'SYNCED',
      referenceType: UPDATE_REFERENCE_TYPE, referenceId: behindRef,
      payload: { narration: `o3d-j625 r11 an EARLIER edit ${behindRef}` },
    }), TX)
    assert.ok(earlier, 'PRECONDITION: the earlier edit was queued')
    await sleep(20)
    const behindDecidedAt = new Date()
    const earlierRow = await db.accountingSyncLog.findUniqueOrThrow({ where: { id: (earlier as { id: string }).id }, select: { createdAt: true } })
    assert.ok(earlierRow.createdAt.getTime() < behindDecidedAt.getTime(),
      `PRECONDITION: the earlier edit (${earlierRow.createdAt.toISOString()}) pre-dates this refusal `
      + `(${behindDecidedAt.toISOString()}), so the ledger holds a stale invoice and the debt is REAL`)
    const behind = await refuseWithDatabaseClockOffset(db, behindKey, behindDecidedAt, -5 * 60_000)
    const behindInbox = await inboxViewOf(db, behindKey)
    console.log(`[r11 HIGH-2] database clock -5min: clock_timestamp reads=${behind.clockReads}, inbox rows=${behindInbox.length}`)
    assert.equal(behindInbox.length, 1,
      'an EARLIER edit does not discharge a LATER refusal — and a database clock running BEHIND this '
      + `process must not make it look as though it does. ${describe(behindInbox)}`)

    // AND THE SEAM IS GONE, which is why neither answer could have depended on the offset. Non-vacuity:
    // on the r10 head this count was 1 per refusal and both assertions above failed.
    assert.equal(ahead.clockReads + behind.clockReads, 0,
      'nothing in this path asks the database what time it is any more: both sides of the comparison are '
      + 'IMS process clocks, so there is no domain to bridge and no offset to get wrong')
  },
)

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r12 (Codex round 11, two HIGHs) — A STATE THAT LOOKS SETTLED IS NOT PROOF OF A DISCHARGE
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Round 11 replaced "a live sync row exists" with an IDENTITY baseline and kept two ordering
 * comparisons beside it. Codex executed both:
 *
 *   HIGH 1 — `resolvedAt`/`queued` on the refusal row short-circuits AHEAD of the liveness check, so an
 *            enqueue whose row was CANCELLED before it could post still discharges a refusal decided
 *            before it. The accounting debt remains and the inbox drops it. r11's own comment at that
 *            branch says the sync-log check "sees that where 'it was once queued' cannot" — and the
 *            early `return` means that check never runs.
 *
 *   HIGH 2 — the surviving comparison (`createdAt` vs `decidedAt`) orders two timestamps written by two
 *            IMS PROCESSES. A deployment runs several (docs/installation.md), and a process whose clock
 *            is ahead stamps an OLDER row with a LATER `createdAt`, which discharges a refusal decided
 *            afterwards on another process. The identity baseline does not protect the two cases below:
 *            an UNCONTENDED refusal (it got the key, so no baseline was taken) and a LEGACY claim
 *            (written before the baseline field existed).
 *
 * And one inference r11 left untested: `releaseRetiredAccountingSyncRowForLiveSale` (o3d-psvi) puts a
 * CANCELLED row back in front of the connector. r11's baseline read excluded CANCELLED rows, so that
 * row was absent from the baseline and then appeared "new".
 *
 * All four tests below are REPRODUCTIONS written against the r11 head and failing on it. Each asserts
 * the precondition that the state under test was reached, and prints the rows it examined.
 */

/** INVOICE_PAYMENT: one RECEIPT against one invoice, so the scope names the payment. */
const RECEIPT_TYPE = 'INVOICE_PAYMENT'
const RECEIPT_REFERENCE_TYPE = 'SalesOrder'
const RECEIPT_KIND = 'invoice_payment_receipt'

const receiptKeyFor = (referenceId: string, paymentId: string) => ({
  type: RECEIPT_TYPE, referenceType: RECEIPT_REFERENCE_TYPE, referenceId, scope: `payment:${paymentId}`,
})

const receiptRefusal = (reason: string) => ({
  kind: RECEIPT_KIND as never,
  chartConnector: 'xero',
  activeConnector: 'quickbooks',
  reason,
  committed: 'the receipt is recorded against the order in IMS and the invoice shows it as paid',
  remedy:
    'Enter the receipt by hand against the invoice in the ledger it belongs to and mark this row handled '
    + '— that cancels IMS\'s retry, so it is not entered twice.',
})

async function seedOutstandingRefusalFor(db: Db, key: ReturnType<typeof receiptKeyFor>, kind: string): Promise<string> {
  const row = await db.accountingPostingRefusal.create({
    data: {
      ...key,
      kind,
      chartConnector: 'xero',
      activeConnector: 'quickbooks',
      reason: 'retired_chart',
      committed: 'the receipt is recorded against the order in IMS',
      remedy: 'Enter it by hand in the ledger it belongs to and mark this row handled.',
    },
    select: { id: true },
  })
  return row.id
}

/**
 * ── HIGH 1 ── A ROW THAT EXISTS BUT CANNOT POST IS NOT A DISCHARGE.
 *
 * The cancellation here is the one the codebase itself argues is PROVABLY unsent:
 * `retireOverSettlingInvoicePayment` (lib/domain/accounting/invoice-payment-capacity.ts) retires a
 * claimed receipt row the capacity guard refused — "the guard runs BEFORE the remote call, so this row
 * demonstrably never reached the ledger". Its exact patch is applied below. The receipt still stands in
 * IMS, the ledger does not have it, nothing will retry it: the obligation is real and the only record of
 * it is the refusal.
 *
 * `markPostingHandled` also cancels a PENDING row, and that one is NOT this finding: it sets
 * `suppressedAt` in the same transaction, and a suppressed posting is correctly never reopened.
 */
test(
  '[o3d-j625 r12] an enqueue whose row was CANCELLED before it could post does not discharge a refusal decided before it',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal, createAccountingSyncLogRow } = await loadDeps()
    const [{ lockPostingKey }, { withSavepoint }] = await Promise.all([
      import('../../lib/domain/accounting/posting-suppression.ts'),
      import('../../lib/db/savepoint.ts'),
    ])
    const referenceId = probeId('r12-cancelled-enqueue')
    const paymentId = `pay-${referenceId}`
    const key = receiptKeyFor(referenceId, paymentId)
    t.after(cleanup(db, referenceId))
    const refusalId = await seedOutstandingRefusalFor(db, key, RECEIPT_KIND)

    // ── T1. THE REFUSAL IS DECIDED, and deferred: another transaction is settling this exact posting,
    //        and this one is inside a caller's transaction, so it may not wait for the key.
    const signal: { fire?: () => void } = {}
    const keyIsHeld = new Promise<void>((resolve) => { signal.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, key)
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await keyIsHeld

    const decidedAt = new Date()
    let deferred: unknown = null
    const startedAt = Date.now()
    await db.$transaction(async (tx) => {
      deferred = await recordAccountingPostingRefusal(tx as never, key, receiptRefusal('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt,
      })
    }, TX)
    const recordMs = Date.now() - startedAt
    await holder
    // LOCK EXCLUSION, MEASURED rather than assumed — twice over. The outcome enum is only reachable when
    // `pg_try_advisory_xact_lock` returned false, and the timing says it did not WAIT for the key either
    // (which inside a caller's transaction is where a deadlock would come from).
    console.log(`[r12 HIGH-1] the refusal returned in ${recordMs}ms while the key was held for ${HOLD_MS}ms`)
    assert.ok(recordMs < HOLD_MS - SLACK_MS,
      `the refusal took ${recordMs}ms against a ${HOLD_MS}ms hold: it must have been SHUT OUT of the key `
      + 'without waiting, or this is not the deferred path and the baseline under test was never taken')
    assert.deepEqual(deferred, { recorded: false, because: 'contended', deferred: true },
      'PRECONDITION: the refusal took the deferred path and is held as a claim')

    // ── T2. THE POSTING IS ENQUEUED, after the decision, and the primitive clears the refusal row.
    const queued = await db.$transaction(async (tx) => createAccountingSyncLogRow<{ id: string }>(tx, {
      connector: 'xero',
      type: RECEIPT_TYPE,
      status: 'PENDING',
      referenceType: RECEIPT_REFERENCE_TYPE,
      referenceId,
      payload: { paymentId, _idempotencyKey: `invoice-payment:${referenceId}:${paymentId}` },
    }), TX)
    const queuedId = (queued as { id: string } | null)?.id
    assert.ok(queuedId, 'PRECONDITION: the enqueue wrote its sync row')
    const cleared = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusalId }, select: { resolvedAt: true, resolution: true },
    })
    assert.equal(cleared.resolution, 'queued', 'PRECONDITION: the enqueue cleared the refusal row')
    assert.ok(cleared.resolvedAt && cleared.resolvedAt.getTime() > decidedAt.getTime(),
      `PRECONDITION: it was cleared (${cleared.resolvedAt?.toISOString()}) AFTER the refusal was decided `
      + `(${decidedAt.toISOString()}) — which is the state that makes r11 return "queued"`)

    // ── T3. AND THAT ROW IS CANCELLED BEFORE IT COULD POST. The capacity guard's own patch, applied to
    //        the row it would have been applied to; the guard runs before the remote call, so nothing
    //        reached the ledger.
    const retired = await db.accountingSyncLog.updateMany({
      where: { id: queuedId, externalTransactionId: null },
      data: {
        status: 'CANCELLED',
        errorMessage: 'Retired: registering this receipt would over-settle the invoice in the ledger.',
        processingStartedAt: null,
      },
    })
    assert.equal(retired.count, 1, 'PRECONDITION: the row was retired')
    const rowsForKey = await db.accountingSyncLog.findMany({
      where: { referenceId }, select: { id: true, status: true, externalTransactionId: true, createdAt: true },
    })
    console.log(`[r12 HIGH-1] sync rows examined for ${referenceId}: ${rowsForKey.length} — `
      + rowsForKey.map((r) => `${r.id}/${r.status}/extId=${r.externalTransactionId ?? 'null'}`).join(', '))
    assert.equal(rowsForKey.filter((r) => r.status !== 'CANCELLED').length, 0,
      'PRECONDITION: NOTHING live is left for this posting — no row can post it')

    // ── T4. THE REPLAY. The debt is real: the receipt stands in IMS, the ledger has nothing, and nothing
    //        will retry it.
    const result = await reconcile()
    console.log(`[r12 HIGH-1] reconcile: ${JSON.stringify(result)}`)
    const rows = await inboxViewOf(db, key)
    assert.equal(rows.length, 1,
      'THE FINDING: the enqueue that cleared this row was CANCELLED before it could post, so the receipt '
      + 'is owed. `resolvedAt`/`queued` says an enqueue once happened; it does not say the posting is in '
      + `the ledger or on its way there, and the inbox must list it. ${describe(rows)}`)
    assert.equal(rows[0]!.reason, 'retired_chart', 'with the refusing site\'s own reason')
  },
)

/**
 * ── HIGH 2 (a) ── AN UNCONTENDED REFUSAL, AND A SYNC ROW WRITTEN BY A PROCESS WHOSE CLOCK IS AHEAD.
 *
 * `accounting_sync_logs.createdAt` is stamped BY THE WRITING PROCESS (r11 measured this: Prisma supplies
 * `@default(now())` in the client, at the INSERT). So the row below is written exactly as an IMS process
 * running five minutes fast writes it — same column, same client, same path. No fixture models a window:
 * the only thing that differs from the row beside it is the clock the writer read.
 *
 * TRUE ORDER OF EVENTS, which the test itself performs and the database's own clock witnesses: the row is
 * inserted FIRST, the refusal is decided AFTERWARDS. The debt is real — successive edits of one invoice
 * share a posting key, so the ledger holds the earlier version and nothing will correct it.
 */
test(
  '[o3d-j625 r12] an UNCONTENDED refusal is not discharged by an older row whose writer\'s clock ran ahead',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const referenceId = probeId('r12-skew-uncontended')
    const key = updateKeyFor(referenceId)
    t.after(cleanup(db, referenceId))

    const SKEW_MS = 5 * 60_000
    // EDIT 1, queued by a process whose clock is SKEW_MS fast. Its row is live for ever.
    const [{ at: beforeInsert }] = await db.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`
    const older = await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: UPDATE_TYPE, status: 'SYNCED',
        referenceType: UPDATE_REFERENCE_TYPE, referenceId,
        payload: { narration: `o3d-j625 r12 EDIT 1, written by a process running ${SKEW_MS}ms fast` },
        // What a skewed process's own `new Date()` produces. Nothing else about the write differs.
        createdAt: new Date(Date.now() + SKEW_MS),
      },
      select: { id: true, createdAt: true },
    })

    // EDIT 2 is refused HERE, on a process whose clock is right. Uncontended: nothing holds the key.
    const decidedAt = new Date()
    const [{ at: afterDecision }] = await db.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`

    console.log(`[r12 HIGH-2a] older row ${older.id} createdAt=${older.createdAt.toISOString()}; `
      + `refusal decidedAt=${decidedAt.toISOString()}; database clock before the insert=`
      + `${beforeInsert.toISOString()}, after the decision=${afterDecision.toISOString()}`)
    // PRECONDITIONS. The true order, and the skew that contradicts it.
    assert.ok(beforeInsert.getTime() <= afterDecision.getTime(),
      'PRECONDITION: one clock, the database\'s, witnesses that the insert really preceded the decision')
    assert.ok(older.createdAt.getTime() > decidedAt.getTime(),
      `PRECONDITION: and the skewed row's stamp (${older.createdAt.toISOString()}) nonetheless reads as `
      + `LATER than the refusal (${decidedAt.toISOString()}) — the whole finding`)

    await recordAccountingPostingRefusal(db as never, key, updateRefusal('retired_chart'), { decidedAt })

    const rows = await inboxViewOf(db, key)
    assert.equal(rows.length, 1,
      'THE FINDING: the posting queued BEFORE this refusal was decided does not discharge it. Whether the '
      + 'debt is kept must not depend on two IMS processes\' clocks agreeing — a comparison of two '
      + `application timestamps is not evidence of the order of two events. ${describe(rows)}`)
  },
)

/**
 * ── HIGH 2 (b) ── THE SAME DEFECT ON A LEGACY CLAIM, which has no baseline by construction.
 *
 * A provisional claim written before r11 carries no `queuedWhenShutOut`, so the replay skips the identity
 * arm entirely (posting-refusal-reconcile.ts passes it through verbatim, and
 * posting-refusal-inbox.ts leaves an `undefined` baseline with the clock arm alone). The payload below is
 * exactly an r10-shaped claim.
 */
test(
  '[o3d-j625 r12] a LEGACY claim with no baseline is not discharged by an older row whose writer\'s clock ran ahead',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db } = await loadDeps()
    const referenceId = probeId('r12-skew-legacy')
    const key = updateKeyFor(referenceId)
    t.after(cleanup(db, referenceId))

    const SKEW_MS = 5 * 60_000
    const [{ at: beforeInsert }] = await db.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`
    const older = await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: UPDATE_TYPE, status: 'SYNCED',
        referenceType: UPDATE_REFERENCE_TYPE, referenceId,
        payload: { narration: `o3d-j625 r12 EDIT 1, written by a process running ${SKEW_MS}ms fast` },
        createdAt: new Date(Date.now() + SKEW_MS),
      },
      select: { id: true, createdAt: true },
    })
    const decidedAt = new Date()
    const [{ at: afterDecision }] = await db.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`

    // AN r10-SHAPED CLAIM: every field r11 reads except `queuedWhenShutOut`, which did not exist.
    const payloadJson = {
      key,
      record: {
        kind: UPDATE_KIND,
        chartConnector: 'xero',
        activeConnector: 'quickbooks',
        reason: 'retired_chart',
        committed: updateRefusal('retired_chart').committed,
        remedy: updateRefusal('retired_chart').remedy,
      },
      decidedAt: decidedAt.toISOString(),
      mergeOnly: false,
    }
    assert.equal('queuedWhenShutOut' in payloadJson, false,
      'PRECONDITION: the claim is LEGACY — it carries no baseline at all')
    const claim = await db.integrationOutbox.create({
      data: {
        connector: 'accounting',
        operation: 'posting-refusal.provisional',
        idempotencyKey: `accounting:posting-refusal.provisional:legacy:${referenceId.toLowerCase()}`,
        payloadJson,
        status: 'PENDING',
      },
      select: { id: true },
    })
    t.after(async () => { await db.integrationOutbox.deleteMany({ where: { id: claim.id } }).catch(() => undefined) })

    console.log(`[r12 HIGH-2b] legacy claim ${claim.id}; older row ${older.id} `
      + `createdAt=${older.createdAt.toISOString()}; decidedAt=${decidedAt.toISOString()}; database clock `
      + `before the insert=${beforeInsert.toISOString()}, after the decision=${afterDecision.toISOString()}`)
    assert.ok(beforeInsert.getTime() <= afterDecision.getTime(),
      'PRECONDITION: the database\'s clock witnesses that the insert preceded the decision')
    assert.ok(older.createdAt.getTime() > decidedAt.getTime(),
      'PRECONDITION: and the skewed stamp reads as later than the refusal')

    const result = await reconcile()
    console.log(`[r12 HIGH-2b] reconcile: ${JSON.stringify(result)}`)
    const rows = await inboxViewOf(db, key)
    assert.equal(rows.length, 1,
      'THE FINDING: a claim with no baseline has NO evidence that the posting was queued after it was '
      + 'refused, so the debt must be kept. A clock comparison is not that evidence. '
      + `${describe(rows)}`)
  },
)

/**
 * ── THE UNTESTED INFERENCE (r11) ── A REVIVED CANCELLED ROW IS NOT A NEW ENQUEUE.
 *
 * `releaseRetiredAccountingSyncRowForLiveSale` (app/actions/accounting-sync.ts, o3d-psvi) moves a row the
 * cancelled-sale sweep retired from CANCELLED back to SYNCED, so the back-reference repair sweep can
 * finish the link. It writes the SAME ROW — same id, same `createdAt`.
 *
 * r11's baseline excluded CANCELLED rows, so such a row was never in the baseline, and after the release
 * it satisfied "a live row whose id is not in the baseline" — the identity arm's whole test for a NEW
 * enqueue. r11 believed this correct and did not test it.
 *
 * THE ACTION ITSELF IS NOT INVOKED HERE: it is a server action behind `requirePermission('settings')` and
 * a live SalesOrder, which this tier has no session for (tests/accounting/xero-retired-row-release.test.ts
 * covers the action). What is driven is the row transition it performs, on the row it performs it on.
 */
test(
  '[o3d-j625 r12] a CANCELLED row RELEASED back to the connector is not a new enqueue, and does not discharge a held refusal',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const [{ lockPostingKey }, { withSavepoint }, settlement] = await Promise.all([
      import('../../lib/domain/accounting/posting-suppression.ts'),
      import('../../lib/db/savepoint.ts'),
      import('../../lib/domain/accounting/sync-row-settlement.ts'),
    ])
    const referenceId = probeId('r12-released-row')
    const key = updateKeyFor(referenceId)
    t.after(cleanup(db, referenceId))

    // A row the cancelled-sale sweep RETIRED. It is CANCELLED now, and it pre-dates everything below.
    const retired = await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: UPDATE_TYPE, status: 'CANCELLED',
        referenceType: UPDATE_REFERENCE_TYPE, referenceId,
        externalTransactionId: `INV-${referenceId}`,
        errorMessage: 'Retired: the sale was not live when this row was swept.',
        payload: { narration: `o3d-j625 r12 a RETIRED posting ${referenceId}` },
      },
      select: { id: true, createdAt: true },
    })

    // A refusal of the CURRENT edit, deferred because another transaction holds the key — and that
    // transaction queues NOTHING, so the debt is real.
    const signal: { fire?: () => void } = {}
    const keyIsHeld = new Promise<void>((resolve) => { signal.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, key)
      signal.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await keyIsHeld

    const decidedAt = new Date()
    let deferred: unknown = null
    const startedAt = Date.now()
    await db.$transaction(async (tx) => {
      deferred = await recordAccountingPostingRefusal(tx as never, key, updateRefusal('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt,
      })
    }, TX)
    const recordMs = Date.now() - startedAt
    await holder
    console.log(`[r12 release] the refusal returned in ${recordMs}ms while the key was held for ${HOLD_MS}ms`)
    assert.ok(recordMs < HOLD_MS - SLACK_MS,
      `the refusal took ${recordMs}ms against a ${HOLD_MS}ms hold — measured, so the baseline under test `
      + 'really was taken from a caller that had been refused the key')
    assert.deepEqual(deferred, { recorded: false, because: 'contended', deferred: true },
      'PRECONDITION: the refusal was deferred, so a baseline was taken for it')
    const claims = await claimsFor(db, referenceId)
    assert.equal(claims.length, 1, 'PRECONDITION: exactly one claim')
    const baseline = (claims[0]!.payloadJson as { queuedWhenShutOut?: { ids: string[]; complete: boolean } | null }).queuedWhenShutOut
    console.log(`[r12 release] retired row ${retired.id}; claim baseline=${JSON.stringify(baseline)}`)

    // THE RELEASE: the sale is live again, so the operator puts the row back in front of the connector.
    // The same row, the same id — `applyFencedAttemptDecision`'s patch as the action builds it.
    const released = await db.accountingSyncLog.updateMany({
      where: { id: retired.id, status: 'CANCELLED' },
      data: {
        status: 'SYNCED',
        syncedAt: new Date(),
        errorMessage: 'Released: the sales order is live again.',
        settlementBasis: settlement.OPERATOR_RELEASE_SETTLEMENT_BASIS,
      },
    })
    assert.equal(released.count, 1, 'PRECONDITION: the retired row was released back to the connector')
    const live = await db.accountingSyncLog.findMany({
      where: { referenceId, status: { not: 'CANCELLED' } }, select: { id: true, status: true, createdAt: true },
    })
    console.log(`[r12 release] live rows now: ${live.map((r) => `${r.id}/${r.status}@${r.createdAt.toISOString()}`).join(', ')}`)
    assert.deepEqual(live.map((r) => r.id), [retired.id],
      'PRECONDITION: the only live row is the RELEASED one — no new enqueue happened')
    assert.ok(retired.createdAt.getTime() < decidedAt.getTime(),
      'PRECONDITION: and it was created before the refusal was decided, so it is an OLDER posting')

    const result = await reconcile()
    console.log(`[r12 release] reconcile: ${JSON.stringify(result)}`)
    const rows = await inboxViewOf(db, key)
    assert.equal(rows.length, 1,
      'THE FINDING: releasing a retired row does not enqueue anything — it is the same row, with the same '
      + 'id, put back in front of the connector. The transaction that held this posting\'s key queued '
      + `nothing, so the edited invoice is still owed. ${describe(rows)}`)
  },
)

/**
 * ── o3d-j625 r12 — THE BASELINE IS ONLY A BASELINE UNDER READ COMMITTED ──
 *
 * The identity rule says "a live row whose id was not in the baseline was inserted after the baseline was
 * taken". That inference needs the baseline read to have seen everything already committed. Under
 * REPEATABLE READ or SERIALIZABLE the caller's snapshot is fixed at its FIRST statement, so a row committed
 * after that is invisible to the baseline — and would later read as NEW, discharging a debt that is owed.
 * It is the r11 finding one isolation level along.
 *
 * Driven here, and the interleaving is real: a SERIALIZABLE caller opens and fixes its snapshot, ANOTHER
 * transaction then queues an earlier edit and commits, and only then is the refusal decided and shut out of
 * the key. Its baseline read cannot see that row. The subject asks the transaction what isolation it is in
 * and abstains (`queuedWhenShutOut: null`), so the replay keeps the debt.
 */
test(
  '[o3d-j625 r12] a caller under SERIALIZABLE cannot take a baseline, so the refusal is kept rather than discharged',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, recordAccountingPostingRefusal } = await loadDeps()
    const [{ lockPostingKey }, { withSavepoint }] = await Promise.all([
      import('../../lib/domain/accounting/posting-suppression.ts'),
      import('../../lib/db/savepoint.ts'),
    ])
    const referenceId = probeId('r12-serializable-caller')
    const key = updateKeyFor(referenceId)
    t.after(cleanup(db, referenceId))

    // Someone holds this posting's key and queues nothing, so the debt below is real.
    const held: { fire?: () => void } = {}
    const keyIsHeld = new Promise<void>((resolve) => { held.fire = resolve })
    const holder = db.$transaction(async (tx) => {
      await lockPostingKey(tx as never, key)
      held.fire!()
      await sleep(HOLD_MS)
    }, TX)
    await keyIsHeld

    const opened: { fire?: () => void } = {}
    const snapshotFixed = new Promise<void>((resolve) => { opened.fire = resolve })
    const mayDecide: { fire?: () => void } = {}
    const goAhead = new Promise<void>((resolve) => { mayDecide.fire = resolve })
    const seen: { isolation?: string; outcome?: unknown } = {}

    const caller = db.$transaction(async (tx) => {
      // FIRST statement: this is where a SERIALIZABLE snapshot is taken.
      const [row] = await tx.$queryRaw<Array<{ level: string }>>`SELECT current_setting('transaction_isolation') AS level`
      seen.isolation = row!.level
      opened.fire!()
      await goAhead
      seen.outcome = await recordAccountingPostingRefusal(tx as never, key, updateRefusal('retired_chart'), {
        withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        decidedAt: new Date(),
      })
    }, { ...TX, isolationLevel: 'Serializable' })

    await snapshotFixed
    assert.equal(seen.isolation, 'serializable', 'PRECONDITION: the caller really is SERIALIZABLE')
    // An EARLIER edit is queued and committed AFTER the caller's snapshot was fixed, so the caller cannot
    // see it. Under the identity rule an unseen row is a NEW row, which is what must not happen here.
    const earlier = await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: UPDATE_TYPE, status: 'SYNCED',
        referenceType: UPDATE_REFERENCE_TYPE, referenceId,
        payload: { narration: `o3d-j625 r12 an EARLIER edit, committed after the snapshot ${referenceId}` },
      },
      select: { id: true },
    })
    mayDecide.fire!()
    await caller
    await holder

    assert.deepEqual(seen.outcome, { recorded: false, because: 'contended', deferred: true },
      'PRECONDITION: the refusal was shut out of the key and deferred')
    const claims = await claimsFor(db, referenceId)
    assert.equal(claims.length, 1, 'PRECONDITION: one claim')
    const baseline = (claims[0]!.payloadJson as { queuedWhenShutOut?: unknown }).queuedWhenShutOut
    console.log(`[r12 isolation] caller isolation=${seen.isolation}; earlier row ${earlier.id}; `
      + `claim baseline=${JSON.stringify(baseline)}`)
    assert.equal(baseline, null,
      'the observation ABSTAINED: a snapshot fixed before that row committed cannot say what was already '
      + 'there, and `null` is "I cannot tell" rather than "nothing was there"')

    const result = await reconcile()
    console.log(`[r12 isolation] reconcile: ${JSON.stringify(result)}`)
    const rows = await inboxViewOf(db, key)
    assert.equal(rows.length, 1,
      'the transaction holding the key queued nothing, so the posting is owed — and an unobservable '
      + `baseline must keep the debt rather than let an unseen row discharge it. ${describe(rows)}`)
  },
)

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r13 (independent review, HIGH) — "MARK AS HANDLED" MUST NOT SUPPRESS EVERY *LATER* POSTING
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `AccountingPostingRefusal.suppressedAt` is written in exactly one place (`markPostingHandled`) and
 * cleared nowhere — the migration says so: "set once by the mark, never cleared" — and it is keyed on the
 * POSTING KEY. For nearly every type that key names ONE posting for ever, so the suppression is exactly the
 * operator's assertion made durable.
 *
 * THREE TYPES ARE DIFFERENT BY DESIGN, and their own scope rules say so: SALES_INVOICE_UPDATE,
 * PURCHASE_INVOICE_UPDATE and BILL_PAYMENT share one key across SUCCESSIVE, DISTINCT postings. On those the
 * suppression was a one-way door across every FUTURE posting, and the review executed the whole chain:
 *
 *   mark one refusal handled → the cause clears (the connector is reconnected, the provenance repaired) →
 *   the bill is edited again → `createAccountingSyncLogRow` reads the suppression and returns `null` →
 *   the enqueue answers `{ queued: true, reason: 'handled-by-hand' }` → `recordTransitSubledgerMovement`
 *   writes a movement for a GL journal that does not exist → `purchaseInvoiceUpdateIsOwed('queued')` is
 *   false, so nothing is recorded outstanding.
 *
 * IMS then holds edit n, the ledger holds edit 1, the transit subledger claims a movement the GL never
 * received, and nothing anywhere says so — the divergence lib/domain/accounting/enqueue-outcome.ts calls
 * "the worst outcome in the issue", reached through the remedy for it.
 *
 * The test below drives the suppression half against a real database. The `queued: true` half and the
 * orphan movement are unit-testable through the module's own injected deps and are pinned in
 * tests/domain/purchasing/purchase-invoice-update-sync.test.ts.
 */

const BILL_UPDATE_TYPE = 'PURCHASE_INVOICE_UPDATE'
const BILL_UPDATE_REFERENCE_TYPE = 'PurchaseOrder'

/** The key a bill update carries: the PO is the reference, the bill is named in the payload. */
const billUpdateKey = (poId: string, billId: string) => ({
  type: BILL_UPDATE_TYPE, referenceType: BILL_UPDATE_REFERENCE_TYPE, referenceId: poId, scope: `bill:${billId}`,
})

test(
  '[o3d-j625 r13] marking a BILL UPDATE handled does not suppress the NEXT edit of that bill',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, markPostingHandled, createAccountingSyncLogRow } = await loadDeps()
    const poId = probeId('r13-bill-update')
    const billId = `BILL-${poId}`
    const key = billUpdateKey(poId, billId)
    t.after(async () => {
      await db.accountingSyncLog.deleteMany({ where: { referenceId: poId } }).catch(() => undefined)
      await db.accountingPostingRefusal.deleteMany({ where: { referenceId: poId } }).catch(() => undefined)
      await db.activityLog.deleteMany({ where: { description: { contains: poId } } }).catch(() => undefined)
    })

    // EDIT 1 was refused (a retired chart), and the operator posted it by hand and marked it handled.
    const refusal = await db.accountingPostingRefusal.create({
      data: {
        ...key,
        kind: 'purchase_invoice_update',
        chartConnector: 'xero',
        activeConnector: null,
        reason: 'retired_chart',
        committed: 'the edited bill stands in IMS and the ledger holds the previous version',
        remedy: 'Correct the bill by hand in the ledger it belongs to and mark this row handled.',
      },
      select: { id: true },
    })
    const marked = await db.$transaction(async (tx) => markPostingHandled(tx as never, {
      id: refusal.id, userId: 'j625r13-operator', note: 'corrected bill by hand',
    }), TX)
    assert.equal((marked as { ok: boolean }).ok, true, `PRECONDITION: the mark succeeded: ${JSON.stringify(marked)}`)

    const afterMark = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusal.id }, select: { resolvedAt: true, resolution: true, suppressedAt: true },
    })
    console.log(`[r13 mark] resolution=${afterMark.resolution} suppressedAt=${afterMark.suppressedAt?.toISOString() ?? 'null'} `
      + `markResult=${JSON.stringify(marked)}`)
    assert.equal(afterMark.resolution, 'handled_manually', 'the operator\'s assertion is recorded')
    assert.ok(afterMark.resolvedAt, 'and the debt is closed')
    assert.equal(afterMark.suppressedAt, null,
      'THE FINDING: no PERMANENT suppression may be written on a posting key that successive edits SHARE. '
      + 'It is written once and cleared nowhere, so it would silence every later edit of this bill for ever.')
    assert.equal((marked as { suppressed?: boolean }).suppressed, false,
      'and the result SAYS so, so the operator-facing sentence can be true about which of the two happened')

    // THE CAUSE CLEARS AND THE BILL IS EDITED AGAIN — a DIFFERENT posting on the same key.
    const laterEdit = await db.$transaction(async (tx) => createAccountingSyncLogRow<{ id: string }>(tx, {
      connector: 'xero',
      type: BILL_UPDATE_TYPE,
      status: 'PENDING',
      referenceType: BILL_UPDATE_REFERENCE_TYPE,
      referenceId: poId,
      payload: { accountingInvoiceId: billId, _idempotencyKey: `purchase-invoice-update:${poId}:edit-2` },
    }), TX)

    console.log(`[r13 later edit] row=${JSON.stringify(laterEdit)}`)
    assert.ok(laterEdit,
      'THE FINDING: the LATER edit is a DIFFERENT posting that the ledger still needs, and it must be '
      + 'queued. `null` here is the silent suppression — the enqueue then answers `handled-by-hand`, the '
      + 'caller reads `queued: true`, and a transit movement is written for a GL journal that does not exist.')
    const live = await db.accountingSyncLog.count({ where: { referenceId: poId, status: { not: 'CANCELLED' } } })
    assert.equal(live, 1, 'exactly one live row: the later edit is queued')
  },
)

test(
  '[o3d-j625 r13] CONTROL — marking a posting whose key names ONE posting for ever DOES still suppress',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    /**
     * Without this the fix above is satisfied by having stopped suppressing altogether — which would
     * reintroduce the double post the mark exists to prevent. MANUFACTURING_JOURNAL is document-scoped and
     * there is exactly one completion journal per production order, so a later posting on that key is the
     * SAME posting and must stay suppressed for ever.
     */
    const { db, markPostingHandled, createAccountingSyncLogRow } = await loadDeps()
    const referenceId = probeId('r13-suppress-control')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedOutstandingRefusal(db, referenceId)

    const marked = await db.$transaction(async (tx) => markPostingHandled(tx as never, {
      id: refusalId, userId: 'j625r13-operator', note: 'posted by hand as journal MJ-9',
    }), TX)
    assert.equal((marked as { ok: boolean }).ok, true, 'PRECONDITION: the mark succeeded')
    assert.equal((marked as { suppressed?: boolean }).suppressed, true, 'and it DID suppress')

    const row = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusalId }, select: { suppressedAt: true },
    })
    assert.ok(row.suppressedAt, 'the suppression is written for a key that names one posting for ever')

    const later = await db.$transaction(async (tx) => createAccountingSyncLogRow<{ id: string }>(tx, {
      connector: 'xero',
      type: TYPE,
      status: 'PENDING',
      referenceType: REFERENCE_TYPE,
      referenceId,
      payload: { narration: `o3d-j625 r13 the same journal again ${referenceId}` },
    }), TX)
    console.log(`[r13 control] suppressedAt=${row.suppressedAt?.toISOString()} laterRow=${JSON.stringify(later)}`)
    assert.equal(later, null,
      'and IMS still refuses to write it: the operator posted THIS journal by hand, and posting it again '
      + 'would put a second one in the ledger')
  },
)
