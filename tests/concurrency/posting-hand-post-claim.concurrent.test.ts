import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * o3d-j625 r16 (Codex round 15, TWO HIGHs) — SETTLING A REFUSED POSTING BY HAND IS AN ACT IMS TAKES PART
 * IN, NOT AN INSTRUCTION IT PRINTS
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Round 15 returned two findings that pull in opposite directions, and that is the point of them:
 *
 *   HIGH 1  "A stale no-row remedy can still lead to a duplicate posting." When the inbox renders a
 *           refusal whose posting key has NO live row, it shows the refusing site's own remedy — post it
 *           by hand. Nothing stops a second operator (or any automatic path) re-queueing that posting
 *           while the first is in the ledger typing it. The `markPostingHandled` guard fires when the
 *           first operator comes BACK, which is after the duplicate exists. r14's render-time
 *           classification NARROWS that window; it does not close it, and describing a narrowed window
 *           as prevention is what round 15 caught.
 *
 *   HIGH 2  "Earlier synced edits block the remedy for a newly refused edit." SALES_INVOICE_UPDATE and
 *           PURCHASE_INVOICE_UPDATE share one posting key across successive edits BY DESIGN
 *           (postingKeyIsReusedAcrossPostings). An older SYNCED row therefore made a NEWLY refused edit
 *           classify `may-be-sent`, and made "Mark as handled" refuse for ever — the inbox told the
 *           operator to settle a row that had already posted a DIFFERENT edit, so the current ledger
 *           update had no usable remedy at all.
 *
 * The two tests below are the REPRODUCTIONS, written before the fix, against a real PostgreSQL database
 * with real transactions. Neither models a window: HIGH 1's second operator runs in its own transaction
 * and its enqueue is the production primitive, and HIGH 2 is the ordinary state of a document edited
 * twice.
 *
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
    throw new Error('o3d-j625 r16 concurrency test requires a Postgres DATABASE_URL')
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

const probeId = (label: string) => `J625R16-${label}-${process.pid}-${randomUUID()}`

/** A MANUAL-only, DOCUMENT-scoped posting whose key names ONE posting for ever. */
const MJ = { type: 'MANUFACTURING_JOURNAL', referenceType: 'ProductionOrder', kind: 'manufacturing_journal' }
/** A REUSED posting key: successive edits of one invoice share it (posting-key.ts SCOPE_RULES). */
const SIU = { type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', kind: 'sales_invoice_update' }

const keyFor = (posting: { type: string; referenceType: string }, referenceId: string) =>
  ({ type: posting.type, referenceType: posting.referenceType, referenceId, scope: '' })

const SITE_REMEDY = 'Post it by hand in the ledger it belongs to and mark this row handled.'

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
 * WHAT AN OPERATOR CAN DO BEFORE THEY GO TO THE LEDGER, asked of the module rather than assumed.
 *
 * Pre-fix the answer is "nothing": the remedy is a sentence and there is no act that makes IMS stand
 * back. The probe is deliberately tolerant so that the pre-fix run REPRODUCES the duplicate instead of
 * dying on a missing import — a test that fails to load proves nothing about the system.
 */
type ClaimFn = (tx: unknown, params: { id: string; userId: string; now?: Date }) => Promise<{ ok: boolean; code?: string; claimedBy?: string | null }>
function claimFnOf(mark: Record<string, unknown>): ClaimFn | null {
  const fn = mark.claimPostingForHandPosting
  return typeof fn === 'function' ? fn as ClaimFn : null
}

/**
 * ── HIGH 1 ── TWO OPERATORS, ONE REFUSAL WITH NO LIVE ROW.
 *
 * Operator A reads the page: no live row, so the refusing site's remedy stands and it says post it by
 * hand. A does whatever IMS offers before going to the ledger, and goes. Operator B — a different
 * session, a different transaction — re-queues the same posting through the production primitive, and the
 * worker posts it. A comes back and marks handled: refused, correctly, and far too late. The ledger has
 * the posting twice.
 *
 * THE ASSERTION IS ABOUT IMS, NOT ABOUT THE WORDING: once an operator is settling this posting by hand,
 * the enqueue that would duplicate it must be REFUSED.
 */
test(
  '[o3d-j625 r16 HIGH 1] while an operator is settling a no-live-row refusal by hand, a concurrent re-queue is REFUSED',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark, createAccountingSyncLogRow } = await loadDeps()
    const referenceId = probeId('high1-two-operators')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedRefusal(db, MJ, referenceId)

    // PRECONDITION — the state round 12 protects and HIGH 1 is about: an outstanding debt with NOTHING
    // live for its posting key, so the page renders the site's own "post it by hand".
    const live0 = await db.accountingSyncLog.count({ where: { referenceId, status: { not: 'CANCELLED' } } })
    assert.equal(live0, 0, 'PRECONDITION: no live row, so the refusing site\'s own remedy is what is shown')
    const shown = await db.accountingPostingRefusal.findUniqueOrThrow({ where: { id: refusalId }, select: { remedy: true, resolvedAt: true } })
    assert.equal(shown.resolvedAt, null)
    assert.equal(shown.remedy, SITE_REMEDY, 'PRECONDITION: and that remedy is an instruction to post by hand')

    // ── OPERATOR A does everything IMS offers before going to the ledger, then goes.
    const claim = claimFnOf(mark as unknown as Record<string, unknown>)
    if (claim) {
      const took = await db.$transaction((tx) => claim(tx, { id: refusalId, userId: 'operator-A' }), TX)
      console.log(`[r16 HIGH-1] operator A took the refusal: ${JSON.stringify(took)}`)
      assert.equal(took.ok, true, 'operator A must be able to take this refusal for hand posting')
    } else {
      console.log('[r16 HIGH-1] PRE-FIX: there is NO act an operator can take before posting by hand — '
        + 'the remedy is a sentence, so nothing at all happens here and IMS is unaware anyone is settling it')
    }

    // ── OPERATOR B, in its own transaction, re-queues the same posting through the production primitive.
    const requeued = await db.$transaction((tx) => createAccountingSyncLogRow<{ id: string }>(tx, {
      connector: 'xero',
      type: MJ.type as never,
      status: 'PENDING',
      referenceType: MJ.referenceType,
      referenceId,
      payload: { narration: `o3d-j625 r16 operator B re-queue ${referenceId}` },
    }), TX)
    console.log(`[r16 HIGH-1] operator B's re-queue produced: ${requeued === null ? 'NOTHING (refused)' : `row ${requeued.id}`}`)

    if (requeued !== null) {
      // The worker then posts it, which is what makes this a DUPLICATE rather than a race nobody notices.
      await db.accountingSyncLog.update({
        where: { id: requeued.id },
        data: { status: 'SYNCED', externalTransactionId: `LEDGER-${referenceId}`, attemptRevision: 1 },
      })
      const back = await db.$transaction((tx) => mark.markPostingHandled(tx as never, {
        id: refusalId, userId: 'operator-A', note: 'posted by hand while B re-queued it',
      }), TX)
      console.log(`[r16 HIGH-1] and operator A coming back to mark it handled: ${JSON.stringify(back)}`)
      // Pre-fix this is `already_resolved`, not even `may_be_posted`: B's enqueue CLEARS the refusal row
      // (createAccountingSyncLogRow), so by the time A returns there is no debt left to close and no record
      // anywhere that she posted it by hand. The duplicate is in the ledger and IMS's account of it is that
      // the posting was queued normally.
      assert.equal(back.ok, false, 'the mark refuses — AFTER the duplicate exists, which is the finding')
    }

    assert.equal(requeued, null,
      'THE FINDING (round 15 HIGH 1): operator A is in the ledger posting this by hand, on the strength of '
      + 'a remedy IMS itself rendered, and IMS queued it anyway. The worker posted it. The ledger now holds '
      + 'the posting twice and markPostingHandled refuses after the damage. A remedy an operator acts on '
      + 'twenty minutes later cannot be made safe by wording it better: while they are settling it, the '
      + 'enqueue has to be REFUSED.')

    // ── AND THE REST OF THE ACT WORKS. The debt stays visible while the claim is held (a posting nobody
    //    can see is the failure this table exists to end), and the acknowledgement closes it.
    const whileClaimed = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusalId }, select: { resolvedAt: true, handPostClaimedBy: true },
    })
    assert.equal(whileClaimed.resolvedAt, null, 'the debt is STILL OUTSTANDING while it is being settled')
    assert.equal(whileClaimed.handPostClaimedBy, 'operator-A', 'and the row says who is settling it')
    const confirmed = await db.$transaction((tx) => mark.markPostingHandled(tx as never, {
      id: refusalId, userId: 'operator-A', note: 'posted by hand as MJ-16',
    }), TX)
    console.log(`[r16 HIGH-1] and the acknowledgement: ${JSON.stringify(confirmed)}`)
    assert.equal(confirmed.ok, true, 'and the operator can record that they posted it')
    const closed = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusalId }, select: { resolvedAt: true, resolution: true, handPostClaimedAt: true, suppressedAt: true },
    })
    assert.ok(closed.resolvedAt, 'the row is closed')
    assert.equal(closed.resolution, 'handled_manually')
    assert.equal(closed.handPostClaimedAt, null,
      'and the claim is GIVEN BACK by the mark — on a reused posting key it is the only thing standing '
      + 'between IMS and the next edit, so a claim that outlived the act would be r13\'s silent one-way door')
    assert.ok(closed.suppressedAt, 'this key names one posting for ever, so the suppression is permanent')
  },
)

/**
 * ── THE GUARD IS PROVEN ABLE TO FAIL ── If the enqueue above were refused for any reason OTHER than the
 * claim, the first test would pass while examining nothing. So: release the claim and enqueue again. The
 * same call, the same key, the same state in every other respect — and it must now SUCCEED.
 *
 * It is also the window this round leaves, executed rather than described: from the release onwards IMS may
 * queue and post the posting, so an operator who posted it by hand and then released instead of confirming
 * has duplicated it. That is one explicit human action against an explicit warning, not a race.
 */
test(
  '[o3d-j625 r16 HIGH 1] RELEASING the claim lets the very same enqueue through again',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark, createAccountingSyncLogRow } = await loadDeps()
    const referenceId = probeId('high1-release')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedRefusal(db, MJ, referenceId)

    const took = await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)
    assert.equal(took.ok, true)
    const enqueue = () => db.$transaction((tx) => createAccountingSyncLogRow<{ id: string }>(tx, {
      connector: 'xero', type: MJ.type as never, status: 'PENDING',
      referenceType: MJ.referenceType, referenceId,
      payload: { narration: `o3d-j625 r16 release probe ${referenceId}` },
    }), TX)
    assert.equal(await enqueue(), null, 'PRECONDITION: while the claim is held the enqueue is refused')

    const released = await db.$transaction((tx) => mark.releasePostingHandPostClaim(tx as never, { id: refusalId }), TX)
    console.log(`[r16 release] ${JSON.stringify(released)}`)
    assert.equal(released.ok, true)
    if (released.ok) assert.equal(released.releasedFrom, 'operator-A')

    const after = await enqueue()
    console.log(`[r16 release] the same enqueue after the release produced: ${after === null ? 'NOTHING' : `row ${after.id}`}`)
    assert.ok(after, 'THE CONTROL: the refusal above was the CLAIM and nothing else — the identical enqueue '
      + 'succeeds the moment the claim is given back. This is also the window that remains: a release '
      + 'reopens it, deliberately, because a claim nobody finishes must be recoverable.')
    const stillOwed = await db.accountingPostingRefusal.findUnique({ where: { id: refusalId }, select: { resolvedAt: true, handPostClaimedAt: true } })
    assert.equal(stillOwed?.handPostClaimedAt ?? null, null, 'and nobody is settling it any more')
  },
)

test(
  '[o3d-j625 r16 HIGH 1] two operators cannot both be settling the same refusal by hand',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark } = await loadDeps()
    const referenceId = probeId('high1-both-operators')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedRefusal(db, MJ, referenceId)

    const claim = claimFnOf(mark as unknown as Record<string, unknown>)
    if (!claim) {
      assert.fail('PRE-FIX: there is no act of settling at all, so BOTH operators read "post it by hand" '
        + 'and both post it. Two operators on one refusal is not even detectable.')
    }
    const a = await db.$transaction((tx) => claim(tx, { id: refusalId, userId: 'operator-A' }), TX)
    const b = await db.$transaction((tx) => claim(tx, { id: refusalId, userId: 'operator-B' }), TX)
    console.log(`[r16 HIGH-1 two] A=${JSON.stringify(a)} B=${JSON.stringify(b)}`)
    assert.equal(a.ok, true, 'the first operator takes it')
    assert.equal(b.ok, false, 'and the second is REFUSED rather than racing')
    assert.equal(b.code, 'claimed_by_other')
    assert.equal(b.claimedBy, 'operator-A', 'and is told who is settling it')
  },
)

/**
 * ── HIGH 2 ── AN EARLIER EDIT'S SYNCED ROW IS SETTLED HISTORY, NOT A ROW THAT COULD POST THIS REFUSAL.
 *
 * Edit 1 of an invoice is queued and posted: a SYNCED row carrying the ledger's document id, on a key
 * that successive edits SHARE by design. Edit 2 is refused (a retired chart). The debt is real — the
 * ledger holds the stale invoice — and it is the state the r10 CONTROL already requires to be listed.
 *
 * Pre-fix the remedy for it is unreachable: the classification asks "is there a row for this key that is
 * not provably unsent", the SYNCED row answers yes, and `markPostingHandled` refuses `may_be_posted` for
 * ever. The row that "may have posted this" posted a DIFFERENT edit, and no amount of settling it in the
 * accounting sync log can change that.
 */
test(
  '[o3d-j625 r16 HIGH 2] a SYNCED row from an EARLIER edit must not block the remedy for a newly refused edit',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark } = await loadDeps()
    const referenceId = probeId('high2-earlier-edit')
    t.after(cleanup(db, referenceId))

    // Edit 1: queued and POSTED. Its row is SYNCED for ever and carries the ledger's document id.
    const edit1 = await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: SIU.type as never, status: 'SYNCED',
        referenceType: SIU.referenceType, referenceId,
        externalTransactionId: `INV-${referenceId}`,
        attemptRevision: 1,
        payload: { narration: `o3d-j625 r16 EDIT 1 ${referenceId}` },
      },
      select: { id: true },
    })
    // Edit 2: refused. IMS holds it, the ledger holds edit 1.
    const refusalId = await seedRefusal(db, SIU, referenceId)

    const { postingKeyIsReusedAcrossPostings } = await import('../../lib/accounting/posting-key.ts')
    assert.equal(postingKeyIsReusedAcrossPostings(SIU.type), true,
      'PRECONDITION: successive edits of this document share ONE posting key — that sharing is deliberate '
      + 'and must stay, so the classification cannot ask "is there a SYNCED row for this key"')

    // The remedy's FIRST step, which is where the classification is asked (o3d-j625 r16 HIGH 1): taking the
    // posting for hand posting. Pre-fix this answered `may_be_posted` from edit 1's row, and so did the mark.
    const took = await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)
    console.log(`[r16 HIGH-2] edit1=${edit1.id} SYNCED → taking the edit-2 refusal: ${JSON.stringify(took)}`)
    assert.equal(took.ok, true,
      'THE FINDING (round 15 HIGH 2), at the first step: the only row for this key posted an EARLIER edit '
      + 'and can never post again, yet it made the newly refused edit classify as "may already have been '
      + 'sent" — so the remedy could not even be STARTED and the current ledger update had no way forward.')
    if (took.ok) {
      assert.deepEqual(took.earlierPostings, [`INV-${referenceId}`],
        'and what the ledger already holds is REPORTED rather than ignored: the hand posting replaces that '
        + 'document, so the operator has to be told which one it is')
      assert.deepEqual(took.cancelledSyncRows, [],
        'nothing is cancelled — the earlier edit\'s posting is history, not work to be withdrawn')
    }

    const marked = await db.$transaction((tx) => mark.markPostingHandled(tx as never, {
      id: refusalId, userId: 'operator-A', note: 'posted edit 2 by hand',
    }), TX)
    console.log(`[r16 HIGH-2] mark of the edit-2 refusal: ${JSON.stringify(marked)}`)

    assert.equal(marked.ok, true,
      'THE FINDING (round 15 HIGH 2): the only row for this key posted an EARLIER edit and can never post '
      + 'again, yet it classifies the newly refused edit as "may already have been sent" and makes the '
      + 'remedy refuse indefinitely. The operator is sent to settle a row that is settled history, so the '
      + 'current ledger update has no way forward at all.')
    if (marked.ok) {
      assert.deepEqual(marked.cancelledSyncRows, [],
        'and nothing is cancelled: the earlier edit\'s posting is history, not work to be withdrawn')
      assert.equal(marked.suppressed, false,
        'and no permanent suppression is written on a reused key (r13) — a LATER edit is still queued')
    }
  },
)

test(
  '[o3d-j625 r16 HIGH 2 CONTROL] on a key that names ONE posting for ever, a SYNCED row still blocks the remedy',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    /**
     * The discriminator is "could this row post THIS refusal", and for a key that is NOT reused a SYNCED
     * row may well BE this refusal's posting — a false debt round 12 deliberately keeps. Without this
     * control, HIGH 2 is satisfied by ignoring every SYNCED row, which re-opens exactly the duplicate
     * HIGH 1 is about.
     */
    const { db, mark } = await loadDeps()
    const referenceId = probeId('high2-control-not-reused')
    t.after(cleanup(db, referenceId))
    await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: MJ.type as never, status: 'SYNCED',
        referenceType: MJ.referenceType, referenceId,
        externalTransactionId: `MJ-${referenceId}`, attemptRevision: 1,
        payload: { narration: `o3d-j625 r16 control ${referenceId}` },
      },
    })
    const refusalId = await seedRefusal(db, MJ, referenceId)
    const { postingKeyIsReusedAcrossPostings } = await import('../../lib/accounting/posting-key.ts')
    assert.equal(postingKeyIsReusedAcrossPostings(MJ.type), false, 'PRECONDITION: this key names one posting for ever')

    const took = await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)
    console.log(`[r16 HIGH-2 control] ${JSON.stringify(took)}`)
    assert.equal(took.ok, false, 'still refused at the FIRST step — this SYNCED row may be this very posting')
    if (!took.ok) {
      assert.equal(took.code, 'may_be_posted')
      assert.match(took.message, /settle that row in the accounting sync log first/,
        'and the operator is sent to the surface that owns the ambiguity rather than to the ledger')
    }
  },
)

/**
 * o3d-j625 r16 — THE MARK IS THE SECOND HALF OF THE ACT, AND SAYS SO.
 *
 * Without this, a mutation that drops the claim requirement from `markPostingHandled` changes no test: the
 * enqueue refusal above comes from the SUPPRESSION read, not from the mark. The requirement is what makes
 * the ordering a mechanism rather than an instruction — an operator cannot record "I posted this by hand"
 * over an interval in which IMS was free to post it.
 */
test(
  '[o3d-j625 r16 HIGH 1] "Mark as handled" is REFUSED on a posting nobody took for hand posting',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark } = await loadDeps()
    const referenceId = probeId('high1-unclaimed-mark')
    t.after(cleanup(db, referenceId))
    const refusalId = await seedRefusal(db, MJ, referenceId)

    const marked = await db.$transaction((tx) => mark.markPostingHandled(tx as never, {
      id: refusalId, userId: 'operator-A', note: 'I just posted it, honest',
    }), TX)
    console.log(`[r16 unclaimed mark] ${JSON.stringify(marked)}`)
    assert.equal(marked.ok, false,
      'a hand posting IMS was not standing back for cannot be recorded as one: the interval it covers is '
      + 'exactly the interval in which IMS could have posted it too')
    if (!marked.ok) assert.equal(marked.code, 'not_claimed')
    const untouched = await db.accountingPostingRefusal.findUniqueOrThrow({
      where: { id: refusalId }, select: { resolvedAt: true, suppressedAt: true },
    })
    assert.equal(untouched.resolvedAt, null, 'and nothing is changed')
    assert.equal(untouched.suppressedAt, null)

    // And the same operator, having taken it, can then record it — so the refusal is a missing FIRST STEP,
    // not a dead end.
    const took = await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)
    assert.equal(took.ok, true)
    const second = await db.$transaction((tx) => mark.markPostingHandled(tx as never, {
      id: refusalId, userId: 'operator-A', note: 'MJ-17',
    }), TX)
    assert.equal(second.ok, true, 'taking it is the way forward the refusal names')
  },
)

/**
 * o3d-j625 r16 HIGH 2, SECOND CONTROL — "COMPLETED" IS HALF THE DISCRIMINATOR, AND THE OTHER HALF IS LOAD-
 * BEARING TOO.
 *
 * WHAT WOULD STILL PASS THE HIGH-2 TEST WITHOUT THIS ONE: ignoring EVERY row on a reused key, whatever its
 * status. A reused key can perfectly well have a row that is still going to post — a claimed PENDING row for
 * the previous edit, which the worker may send at any moment — and posting the current edit by hand while
 * that is outstanding is how the ledger ends up holding the older version last.
 */
test(
  '[o3d-j625 r16 HIGH 2 CONTROL] on a REUSED key, a row that can still post STILL blocks',
  { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' },
  async (t) => {
    const { db, mark } = await loadDeps()
    const referenceId = probeId('high2-control-still-postable')
    t.after(cleanup(db, referenceId))
    await db.accountingSyncLog.create({
      data: {
        connector: 'xero', type: SIU.type as never, status: 'PENDING',
        referenceType: SIU.referenceType, referenceId,
        // Claimed by a processor: it may have been sent and put back for a retry (r14's predicate).
        attemptRevision: 3,
        payload: { narration: `o3d-j625 r16 still-postable ${referenceId}` },
      },
    })
    const refusalId = await seedRefusal(db, SIU, referenceId)

    const took = await db.$transaction((tx) => mark.claimPostingForHandPosting(tx as never, { id: refusalId, userId: 'operator-A' }), TX)
    console.log(`[r16 HIGH-2 control 2] ${JSON.stringify(took)}`)
    assert.equal(took.ok, false,
      'a reused key is not a licence to ignore its rows — this one can still reach the ledger, and it '
      + 'carries an EARLIER edit, so a hand posting now can be overwritten by it afterwards')
    if (!took.ok) assert.equal(took.code, 'may_be_posted')
  },
)
