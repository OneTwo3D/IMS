import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r18 (Codex round 17, HIGH 1) — A LATER EDIT ARRIVING DURING A CLAIM MUST BE PRESERVED
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * r16 made an operator's hand posting an act IMS takes part in: they TAKE the refusal (a claim), go to the
 * ledger, and come back to mark it handled. While the claim is held, every creation of an accounting sync
 * row is declined through the suppression channel — which is what stops the worker duplicating the posting.
 *
 * Round 17's HIGH 1: that decline answered `{ queued: true, reason: 'handled-by-hand' }`, the same answer a
 * COMPLETED hand posting gives. On the three posting keys successive edits SHARE by design
 * (`postingKeyIsReusedAcrossPostings` — SALES_INVOICE_UPDATE, PURCHASE_INVOICE_UPDATE, BILL_PAYMENT),
 * saving a LATER edit while the claim is held therefore wrote no sync row AND recorded no refusal, because
 * every consumer reads `queued: true` as "a counterpart exists". Ending the claim did not requeue it. The
 * ledger stays behind IMS with no outstanding debt for that edit — worse than the duplicate r16 stopped,
 * because a duplicate is visible in the ledger and this is visible nowhere.
 *
 * THE FIX CHOSEN (stated here because the alternative was rejected on the record): the later edit's debt is
 * KEPT VISIBLE as an outstanding refusal, not replayed from a stored payload. On exactly the types that lose
 * the edit, the posting OVERWRITES a document the ledger already holds, so the correct posting is the
 * CURRENT state of that document and not the state at the instant the enqueue was declined; replaying a
 * stale payload would post a version that a third edit had already superseded. `clearing: 'retried'` already
 * promises the discharge those kinds have ("Re-saving the bill queues the update again"), and what was
 * missing was the DEBT that tells an operator to. So: a declined enqueue is recorded on the refusal row
 * CAUSALLY (`handPostDeferredCount`, incremented under the posting key's lock — no clock comparison, which
 * round 12 removed the last of), and both ways a claim can end must account for it.
 *
 * The four tests below are the reproduction and its controls, against a real PostgreSQL database.
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TX = { timeout: 30_000, maxWait: 20_000 }

function loadEnv(): void {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error('o3d-j625 r18 concurrency test requires a Postgres DATABASE_URL')
  }
}

async function loadDeps() {
  loadEnv()
  const [{ db }, mark, row] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/domain/accounting/posting-mark-handled.ts'),
    import('../../lib/domain/accounting/sync-log-row.ts'),
  ])
  return { db, mark, createAccountingSyncLogRow: row.createAccountingSyncLogRow }
}

type Db = Awaited<ReturnType<typeof loadDeps>>['db']

const probeId = (label: string) => `J625R18-${label}-${process.pid}-${randomUUID()}`

/** A REUSED posting key: successive edits of one invoice share it (posting-key.ts SCOPE_RULES). */
const SIU = { type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', kind: 'sales_invoice_update' }
/** A key that names ONE posting for ever, so a declined retry during a claim is the SAME posting. */
const MJ = { type: 'MANUFACTURING_JOURNAL', referenceType: 'ProductionOrder', kind: 'manufacturing_journal' }

const SITE_REMEDY = 'Re-save the order once the cause is resolved, or correct the invoice by hand in the ledger.'

const keyFor = (posting: { type: string; referenceType: string }, referenceId: string) =>
  ({ type: posting.type, referenceType: posting.referenceType, referenceId, scope: '' })

async function seedRefusal(db: Db, posting: { type: string; referenceType: string; kind: string }, referenceId: string): Promise<string> {
  const row = await db.accountingPostingRefusal.create({
    data: {
      ...keyFor(posting, referenceId),
      kind: posting.kind,
      chartConnector: 'xero',
      activeConnector: 'quickbooks',
      reason: 'retired_chart',
      committed: 'the document stands in IMS and the ledger does not have this posting',
      remedy: SITE_REMEDY,
    },
    select: { id: true },
  })
  return row.id
}

function cleanup(db: Db, referenceId: string) {
  return async () => {
    await db.accountingSyncLog.deleteMany({ where: { referenceId } })
    await db.accountingPostingRefusal.deleteMany({ where: { referenceId } })
    await db.activityLog.deleteMany({ where: { description: { contains: referenceId } } })
  }
}

/**
 * THE LATER EDIT, saved through the production primitive.
 *
 * Tolerant of BOTH return shapes on purpose, so the PRE-FIX run reproduces the lost edit instead of dying
 * on a type it cannot see — a test that fails to load proves nothing about the system.
 */
async function saveLaterEdit(
  db: Db,
  createAccountingSyncLogRow: unknown,
  posting: { type: string; referenceType: string },
  referenceId: string,
  narration: string,
): Promise<{ rowId: string | null; suppressed: string | null }> {
  const create = createAccountingSyncLogRow as (tx: unknown, data: unknown) => Promise<unknown>
  const answer = await db.$transaction((tx) => create(tx, {
    connector: 'xero',
    type: posting.type,
    status: 'PENDING',
    referenceType: posting.referenceType,
    referenceId,
    payload: { narration },
  }), TX)
  if (answer && typeof answer === 'object' && 'row' in (answer as object)) {
    const shaped = answer as { row: { id: string } | null; suppressed: string | null }
    return { rowId: shaped.row?.id ?? null, suppressed: shaped.suppressed ?? null }
  }
  return { rowId: (answer as { id: string } | null)?.id ?? null, suppressed: null }
}

/** Every column both discharge paths are judged on, read in one go. */
function readRefusal(db: Db, id: string) {
  return db.accountingPostingRefusal.findUniqueOrThrow({
    where: { id },
    select: {
      resolvedAt: true, resolution: true, suppressedAt: true, refusedCount: true, lastRefusedAt: true,
      handPostClaimedAt: true, handPostClaimedBy: true,
    },
  })
}

/** `handPostDeferredCount`, read without requiring the column to exist pre-fix. */
async function deferredCount(db: Db, id: string): Promise<number | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT "handPostDeferredCount" AS n FROM accounting_posting_refusals WHERE id = $1`, id,
    )
    return rows[0] ? Number(rows[0].n) : null
  } catch {
    return null
  }
}

/**
 * ── THE REPRODUCTION, DISCHARGED BY THE MARK ──
 *
 * Operator A holds the claim for edit 1. Edit 2 is saved. A posts edit 1 by hand and marks it handled. The
 * ledger now holds edit 1; IMS holds edit 2. The refusal must NOT close, because it says "the ledger holds
 * the current version of this document" and it does not.
 */
test(
  '[o3d-j625 r18 HIGH 1] a later edit saved during a claim survives the MARK as an outstanding debt',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark, createAccountingSyncLogRow } = await loadDeps()
    const referenceId = probeId('mark-discharge')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedRefusal(db, SIU, referenceId)

    const took = await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)
    assert.equal(took.ok, true, `PRECONDITION: operator A holds the claim (${JSON.stringify(took)})`)
    const before = await readRefusal(db, refusalId)
    assert.equal(before.resolvedAt, null, 'PRECONDITION: the debt for edit 1 is outstanding')

    const later = await saveLaterEdit(db, createAccountingSyncLogRow, SIU, referenceId, `r18 edit 2 ${referenceId}`)
    console.log(`[r18 mark] the later edit produced: ${JSON.stringify(later)}`)
    assert.equal(later.rowId, null, 'PRECONDITION: no sync row — the claim is what stops the duplicate, and must')
    const live = await db.accountingSyncLog.count({ where: { referenceId, status: { not: 'CANCELLED' } } })
    assert.equal(live, 0, 'PRECONDITION: so IMS holds no queued posting for edit 2 at all')
    // Printed rather than asserted HERE, so the pre-fix run reaches the finding itself below instead of
    // stopping on a column that does not exist yet. Pre-fix it is `null`: the declined edit is recorded
    // NOWHERE, because `handled-by-hand` told every consumer a counterpart existed.
    const deferred = await deferredCount(db, refusalId)
    console.log(`[r18 mark] handPostDeferredCount=${deferred}`)

    const marked = await db.$transaction((tx) => mark.markPostingHandled(tx as never, {
      id: refusalId, userId: 'operator-A', note: 'posted edit 1 by hand as INV-18',
    }), TX)
    console.log(`[r18 mark] the mark answered: ${JSON.stringify(marked)}`)
    assert.equal(marked.ok, true, 'the operator can still record the posting they really made')

    const after = await readRefusal(db, refusalId)
    console.log(`[r18 mark] after=${JSON.stringify(after)}`)
    assert.equal(after.resolvedAt, null,
      'THE FINDING: marking handled CLOSED the debt. The operator posted EDIT 1; edit 2 never '
      + 'reached the ledger and never will, and the row that would have said so is resolved. The ledger is '
      + 'behind IMS with no outstanding debt for that edit.')
    assert.equal(after.suppressedAt, null, 'and nothing is suppressed — a later edit must still be queueable')
    assert.equal(after.handPostClaimedAt, null, 'the claim is given back, so IMS may queue the current version')
    assert.ok(after.refusedCount > before.refusedCount,
      `and the postponed edit is accounted for as debt (${before.refusedCount} -> ${after.refusedCount})`)
    assert.ok(after.lastRefusedAt > before.lastRefusedAt, 'with the clock the operator reads moved to now')
    assert.equal(deferred, 1, 'and the deferral it discharged was recorded CAUSALLY, under the claim')
    assert.equal(await deferredCount(db, refusalId), 0, 'and is DISCHARGED, not left to be counted twice')
  },
)

/**
 * ── THE SAME REPRODUCTION, DISCHARGED BY THE RELEASE ── Round 17 asked for both paths, and release is the
 * one r16 called "the window that remains": it is also the path a claim nobody finishes leaves by.
 */
test(
  '[o3d-j625 r18 HIGH 1] a later edit saved during a claim survives the RELEASE as an outstanding debt',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark, createAccountingSyncLogRow } = await loadDeps()
    const referenceId = probeId('release-discharge')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedRefusal(db, SIU, referenceId)

    const took = await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)
    assert.equal(took.ok, true, 'PRECONDITION: the claim is held')
    const before = await readRefusal(db, refusalId)

    const later = await saveLaterEdit(db, createAccountingSyncLogRow, SIU, referenceId, `r18 release edit 2 ${referenceId}`)
    assert.equal(later.rowId, null, 'PRECONDITION: the later edit queued nothing')
    console.log(`[r18 release] handPostDeferredCount=${await deferredCount(db, refusalId)}`)

    const released = await db.$transaction((tx) => mark.releasePostingHandPostClaim(tx as never, { id: refusalId }), TX)
    console.log(`[r18 release] ${JSON.stringify(released)}`)
    assert.equal(released.ok, true)
    assert.equal((released as { deferredEdits?: number }).deferredEdits, 1,
      'THE FINDING: the release accounts for nothing it postponed — it cannot, because nothing recorded it. '
      + 'It must REPORT what was postponed, so the operator is told rather than left to notice.')

    const after = await readRefusal(db, refusalId)
    console.log(`[r18 release] after=${JSON.stringify(after)}`)
    assert.equal(after.handPostClaimedAt, null, 'nobody is settling it any more')
    assert.equal(after.resolvedAt, null, 'and the debt stands')
    assert.ok(after.refusedCount > before.refusedCount,
      `and the postponed edit becomes visible debt on the outstanding row `
      + `(${before.refusedCount} -> ${after.refusedCount}) — nothing requeues it on its own.`)
    assert.ok(after.lastRefusedAt > before.lastRefusedAt)
    assert.equal(await deferredCount(db, refusalId), 0, 'and the deferral is discharged')

    // STATED AS A WINDOW, NOT AS PREVENTION: releasing does not REQUEUE the postponed edit. IMS is free to
    // queue the CURRENT version of the document from here on, and the outstanding row is what tells an
    // operator to make that happen (re-save it) — which is exactly what this kind's `clearing` promises.
    const requeued = await db.accountingSyncLog.count({ where: { referenceId, status: { not: 'CANCELLED' } } })
    console.log(`[r18 release] rows queued by the release itself: ${requeued}`)
    assert.equal(requeued, 0,
      'the release does not replay the stale payload — see the header for why the CURRENT document is the '
      + 'only correct posting on a reused key')
  },
)

/**
 * ── CONTROL 1: WITH NOTHING POSTPONED, THE MARK STILL CLOSES THE DEBT ──
 *
 * Without this, "the row stays outstanding" would pass by never closing anything, and the whole remedy r7
 * built would be gone. This is the "what would still pass it" question asked of the test above.
 */
test(
  '[o3d-j625 r18 CONTROL] with NO later edit, the mark closes the refusal exactly as before',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark } = await loadDeps()
    const referenceId = probeId('control-no-later-edit')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedRefusal(db, SIU, referenceId)

    assert.equal((await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)).ok, true)
    assert.equal((await deferredCount(db, refusalId)) ?? 0, 0, 'PRECONDITION: nothing was postponed')
    const marked = await db.$transaction((tx) => mark.markPostingHandled(tx as never, { id: refusalId, userId: 'operator-A', note: null }), TX)
    assert.equal(marked.ok, true)
    const after = await readRefusal(db, refusalId)
    console.log(`[r18 control-none] after=${JSON.stringify(after)}`)
    assert.ok(after.resolvedAt, 'the debt CLOSES — the operator posted the current version and said so')
    assert.equal(after.resolution, 'handled_manually')
    assert.equal(after.handPostClaimedAt, null)
  },
)

/**
 * ── CONTROL 2: ON A KEY THAT NAMES ONE POSTING FOR EVER, A POSTPONED ENQUEUE IS THE SAME POSTING ──
 *
 * The lost edit is a property of the three REUSED keys. On every other key the posting key names one posting
 * for ever, so an enqueue declined during the claim was a RETRY of the very posting the operator then made
 * by hand — the hand posting satisfies it, and the row must still close and still suppress. A fix that kept
 * every claim with a postponed enqueue outstanding would turn r7's remedy into one that never completes.
 */
test(
  '[o3d-j625 r18 CONTROL] on a NON-reused key a postponed retry is satisfied by the hand posting, and the row closes',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark, createAccountingSyncLogRow } = await loadDeps()
    const referenceId = probeId('control-non-reused')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedRefusal(db, MJ, referenceId)

    assert.equal((await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)).ok, true)
    const retry = await saveLaterEdit(db, createAccountingSyncLogRow, MJ, referenceId, `r18 retry ${referenceId}`)
    assert.equal(retry.rowId, null, 'PRECONDITION: the retry was declined by the claim')
    console.log(`[r18 control-non-reused] handPostDeferredCount=${await deferredCount(db, refusalId)}`)

    const marked = await db.$transaction((tx) => mark.markPostingHandled(tx as never, { id: refusalId, userId: 'operator-A', note: 'MJ-18' }), TX)
    console.log(`[r18 control-non-reused] ${JSON.stringify(marked)}`)
    assert.equal(marked.ok, true)
    const after = await readRefusal(db, refusalId)
    console.log(`[r18 control-non-reused] after=${JSON.stringify(after)}`)
    assert.ok(after.resolvedAt, 'the debt closes: the postponed enqueue WAS this posting, and a human made it')
    assert.ok(after.suppressedAt, 'and the suppression is permanent, as it is for every key that names one posting')
    assert.equal(after.resolution, 'handled_manually')
    assert.equal((await deferredCount(db, refusalId)) ?? 0, 0, 'with the deferral discharged rather than left standing')
  },
)

/**
 * ── CONTROL 3: THE DEBT IS NOT KEPT OUTSTANDING FOR EVER ──
 *
 * A postponement that survived its own discharge would make a reused-key refusal unclosable: every later act
 * would see a count it did not earn, and the remedy r7 built would never complete. So the whole cycle is
 * driven: postpone, mark (the row stays open, correctly), take it again with the document NOT edited since,
 * mark again — and now it closes. This is what proves the discharge is real rather than "outstanding always".
 */
test(
  '[o3d-j625 r18 CONTROL] a discharged postponement does not keep the row outstanding on the NEXT act',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark, createAccountingSyncLogRow } = await loadDeps()
    const referenceId = probeId('control-second-act')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedRefusal(db, SIU, referenceId)

    // ACT 1: a later edit arrives, so the mark leaves the row open.
    assert.equal((await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)).ok, true)
    await saveLaterEdit(db, createAccountingSyncLogRow, SIU, referenceId, `r18 act1 edit2 ${referenceId}`)
    const firstMark = await db.$transaction((tx) => mark.markPostingHandled(tx as never, { id: refusalId, userId: 'operator-A', note: 'act 1' }), TX)
    console.log(`[r18 second-act] first mark=${JSON.stringify(firstMark)}`)
    assert.equal(firstMark.ok && firstMark.stillOutstanding, true, 'PRECONDITION: act 1 leaves the debt open')
    assert.equal((await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT "handPostDeferredCount" AS n FROM accounting_posting_refusals WHERE id = $1`, refusalId,
    ))[0]!.n, 0, 'PRECONDITION: and discharges the count it acted on')

    // ACT 2: the operator posts the CURRENT version by hand, and nothing is saved behind them this time.
    const retake = await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)
    assert.equal(retake.ok, true, 'the row is still markable — it was never resolved')
    const secondMark = await db.$transaction((tx) => mark.markPostingHandled(tx as never, { id: refusalId, userId: 'operator-A', note: 'act 2' }), TX)
    console.log(`[r18 second-act] second mark=${JSON.stringify(secondMark)}`)
    assert.equal(secondMark.ok, true)
    assert.equal(secondMark.ok && secondMark.stillOutstanding, false,
      'and NOW it closes: a discharged postponement must not be counted a second time, or a reused-key '
      + 'refusal could never be settled by hand at all')
    const after = await readRefusal(db, refusalId)
    console.log(`[r18 second-act] after=${JSON.stringify(after)}`)
    assert.ok(after.resolvedAt, 'the debt is closed')
    assert.equal(after.resolution, 'handled_manually')
  },
)
