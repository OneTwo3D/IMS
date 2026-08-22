import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CREATE_DISPATCH_REPLAY_MARGIN_MS,
  CREATE_REPLAY_POLICY,
  decideCreateDispatch,
  planCreateDispatch,
  type CreateDispatchClient,
  type CreateDispatchMint,
} from '@/lib/domain/accounting/create-dispatch-record'
import { XERO_IDEMPOTENCY_KEY_RETENTION_MS } from '@/lib/domain/accounting/idempotency-retention'

/**
 * o3d-jit6 — A COMMIT FAILURE AFTER A SUCCESSFUL POST.
 *
 * The failure this file has to model, or none of it can be falsified: the post LANDS, and then the
 * transaction that would have written the returned id fails at COMMIT. The row rolls back to PENDING
 * with no external id, the document is real and in Xero, and its id existed only in the memory of a
 * process that is now handling an ordinary error. The ordinary retry then posts again.
 *
 * The double therefore has to distinguish two things a simpler one conflates: what a transaction
 * WROTE, and what SURVIVED it. `settleTransaction` snapshots the whole row on entry and restores it
 * when the commit fails — which is exactly why the dispatch record survives and the settlement does
 * not: the dispatch record was committed by the claim fence's own statement, BEFORE the post, and the
 * snapshot already contains it. A double that let the settlement's writes stand would make the broken
 * code and the fixed code indistinguishable.
 *
 * AND SINCE Codex r1 FINDING 2 the double must model one more thing: THE CLAIM FENCE. The record is
 * no longer written by a statement of its own ahead of the fence — it rides inside the fence's claim
 * renewal, so a fence that refuses writes nothing at all. `attempt({ claimHeld: false })` is that
 * path, and without it a marker left behind by a post that never happened is invisible to this file.
 */

const ENTRY_ID = 'log-1'
const LABEL = 'COGS_JOURNAL for PurchaseOrder po-1'
const KEY = 'ims-manual-journal-log-1'

type Row = {
  id: string
  status: string
  externalTransactionId: string | null
  processingStartedAt: Date | null
  createDispatchedAt: Date | null
  createDispatchIdempotencyKey: string | null
}

function harness() {
  let now = new Date('2026-08-22T09:00:00.000Z')
  const row: Row = {
    id: ENTRY_ID,
    status: 'PENDING',
    externalTransactionId: null,
    processingStartedAt: new Date('2026-08-22T08:59:00.000Z'),
    createDispatchedAt: null,
    createDispatchIdempotencyKey: null,
  }
  /** Documents that actually exist in the ledger. The number that must never reach 2. */
  const xeroCreates: string[] = []
  /** What the row recorded at the instant each post was put on the wire. */
  const recordAtPostTime: Array<Date | null> = []

  const client: CreateDispatchClient = {
    $queryRaw: (async () => [{ now: new Date(now) }]) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: {
      findUnique: async ({ where }) => (where.id === row.id
        ? { createDispatchedAt: row.createDispatchedAt, createDispatchIdempotencyKey: row.createDispatchIdempotencyKey }
        : null),
    },
  }

  /**
   * `lease.fenceBeforeRemoteWrite` — ONE conditional statement that re-proves the claim and, when the
   * caller supplies one, mints the dispatch record in the same write.
   *
   * `claimHeld: false` is a fence that matches no row: an expired lease or a claim another worker has
   * taken. NOTHING is written, which is the property under test.
   *
   * The trigger's job is modelled too: the pair may be minted, never moved.
   */
  function fenceBeforeRemoteWrite(mint: CreateDispatchMint | undefined, claimHeld: boolean): boolean {
    if (!claimHeld) return false
    row.processingStartedAt = new Date(now)
    if (mint && row.createDispatchedAt === null) {
      row.createDispatchedAt = mint.createDispatchedAt
      row.createDispatchIdempotencyKey = mint.createDispatchIdempotencyKey
    }
    return true
  }

  /** The settle. `commitFails` rolls back EVERYTHING it wrote, as Postgres does. */
  function settleTransaction(externalId: string, commitFails: boolean): void {
    const snapshot = { ...row }
    row.status = 'SYNCED'
    row.externalTransactionId = externalId
    if (!commitFails) return
    Object.assign(row, snapshot)
    throw new Error('could not serialize access due to concurrent update')
  }

  /**
   * One attempt, in the production ORDER: PLAN (a read), then the claim fence (which mints), then
   * post, then settle. Returns the refusal when the plan or the fence stops it, so a caller can
   * assert nothing was sent.
   */
  async function attempt(opts: {
    commitFails: boolean
    type?: keyof typeof CREATE_REPLAY_POLICY
    key?: string
    claimHeld?: boolean
  }): Promise<string | null> {
    const plan = await planCreateDispatch(client, {
      entryId: ENTRY_ID,
      type: opts.type ?? 'COGS_JOURNAL',
      idempotencyKey: opts.key ?? KEY,
      label: LABEL,
    })
    if (!plan.dispatch) return plan.error

    if (!fenceBeforeRemoteWrite(plan.mint ?? undefined, opts.claimHeld ?? true)) {
      return 'claim lost before the remote write; nothing was sent'
    }

    recordAtPostTime.push(row.createDispatchedAt)
    const externalId = `MJ-${xeroCreates.length + 1}`
    xeroCreates.push(externalId)
    settleTransaction(externalId, opts.commitFails)
    return null
  }

  return {
    row,
    xeroCreates,
    recordAtPostTime,
    client,
    attempt,
    advance: (ms: number) => { now = new Date(now.getTime() + ms) },
    at: () => new Date(now),
  }
}

test('o3d-jit6: the dispatch is recorded BEFORE the wire, and the record survives a commit failure', async () => {
  const h = harness()

  await assert.rejects(h.attempt({ commitFails: true }), /could not serialize access/)

  assert.equal(h.xeroCreates.length, 1, 'the post landed: a real journal exists in Xero')
  assert.ok(h.recordAtPostTime[0] instanceof Date, 'and the dispatch was already recorded when it left')
  // The settlement is gone — this is the defect, faithfully reproduced.
  assert.equal(h.row.status, 'PENDING')
  assert.equal(h.row.externalTransactionId, null, 'the id Xero returned was discarded with the rollback')
  // And the one thing that did NOT roll back is the only thing the retry can learn from.
  assert.ok(h.row.createDispatchedAt instanceof Date, 'the dispatch record committed before the post')
  assert.equal(h.row.createDispatchIdempotencyKey, KEY)
})

test('o3d-jit6 r1#2: a fence that refuses writes NO dispatch record — the prohibition never stands over a post nobody made', async () => {
  // CODEX ROUND 1, FINDING 2. The record used to be minted in a statement of its own, ahead of the
  // claim fence. A fence that then reported an expired lease or a lost claim returned WITH THE MARKER
  // WRITTEN and nothing sent — and the next legitimate attempt read a dispatch that had never
  // happened and refused a create that had never been made.
  const h = harness()

  const refusal = await h.attempt({ commitFails: false, claimHeld: false })

  assert.ok(refusal, 'the fence stops the attempt')
  assert.equal(h.xeroCreates.length, 0, 'nothing was sent — this is the precondition of the finding')
  assert.equal(h.row.createDispatchedAt, null, 'THE POINT: and nothing was recorded either')
  assert.equal(h.row.createDispatchIdempotencyKey, null)

  // The next attempt — the one that legitimately holds the claim — must be a FIRST dispatch. Under
  // the defect it met a record it did not make and refused for ever, one cron cycle after the row was
  // handed back for a reason that had nothing to do with Xero.
  h.advance(XERO_IDEMPOTENCY_KEY_RETENTION_MS + 60_000)
  const second = await h.attempt({ commitFails: false })
  assert.equal(second, null, 'the legitimate attempt is not refused by a dispatch that never happened')
  assert.equal(h.xeroCreates.length, 1, 'and it actually posts')
  assert.equal(h.row.externalTransactionId, 'MJ-1')
})

test('o3d-jit6 r1#2: planning writes NOTHING, whatever it answers', async () => {
  // The type says so — `CreateDispatchClient` has no writer on it at all — and the module is checked
  // for one, because a future call site adding `db.accountingSyncLog.update` here would reintroduce
  // exactly the marker-without-a-request the finding is about.
  const source = readFileSync('lib/domain/accounting/create-dispatch-record.ts', 'utf8')
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/*')).join('\n')
  assert.ok(!/accountingSyncLog\.(update|updateMany|create|upsert)\(/.test(code),
    'this module must never write the dispatch record; only the claim fence may')
  assert.ok(!/\$executeRaw/.test(code))

  // And the plan really does leave the row alone on the path that ALLOWS the post.
  const h = harness()
  const plan = await planCreateDispatch(h.client, {
    entryId: ENTRY_ID, type: 'COGS_JOURNAL', idempotencyKey: KEY, label: LABEL,
  })
  assert.equal(plan.dispatch, true)
  assert.ok(plan.dispatch === true && plan.mint, 'it hands the fence what to record')
  assert.equal(h.row.createDispatchedAt, null, 'but has recorded nothing itself')
})

test('o3d-jit6: the retry after that commit failure is REFUSED, not posted a second time', async () => {
  const h = harness()
  await assert.rejects(h.attempt({ commitFails: true }), /could not serialize access/)

  // The real retry schedule: the outbox's first backoff floor is five minutes and it is only
  // claimable on the next five-minute cron tick, so by the time it runs Xero has forgotten the key.
  h.advance(XERO_IDEMPOTENCY_KEY_RETENTION_MS + 60_000)

  const refusal = await h.attempt({ commitFails: false })

  assert.equal(h.xeroCreates.length, 1, 'THE WHOLE POINT: no second journal in the accounts')
  assert.ok(refusal, 'and the attempt says so rather than failing silently')
  assert.match(refusal, /NOTHING WAS SENT/)
  assert.match(refusal, /already dispatched a create for COGS_JOURNAL for PurchaseOrder po-1/)
  assert.match(refusal, /no number or reference Xero deduplicates on/)
  // A refusal an operator cannot act on is a stalled row nobody resolves.
  assert.match(refusal, /REMEDY:/)
  assert.match(refusal, /per-row settlement action/)
  assert.match(refusal, /cancel this row and re-queue/)
})

test('o3d-jit6: INSIDE the window, the same key replays — Xero answers with the original document', async () => {
  const h = harness()
  await assert.rejects(h.attempt({ commitFails: true }), /could not serialize access/)

  // Comfortably inside, margin included.
  h.advance(XERO_IDEMPOTENCY_KEY_RETENTION_MS - CREATE_DISPATCH_REPLAY_MARGIN_MS - 60_000)

  const refusal = await h.attempt({ commitFails: false })
  assert.equal(refusal, null, 'a provable replay is allowed rather than refused')
  // The double counts REQUESTS, not documents. This request carries the same Idempotency-Key Xero
  // still remembers, so it is answered with the first journal instead of creating a second — which
  // is what makes this arm safe and is why it is gated on the key MATCHING.
  assert.equal(h.row.externalTransactionId, 'MJ-2')
  assert.equal(h.row.createDispatchedAt?.toISOString(), h.recordAtPostTime[0]?.toISOString(),
    'and the record is never moved forward, or the window would renew itself for ever')
})

test('o3d-jit6: a DIFFERENT key inside the window is refused — a replay must be provable, not likely', async () => {
  const h = harness()
  await assert.rejects(h.attempt({ commitFails: true }), /could not serialize access/)
  h.advance(60_000)

  const refusal = await h.attempt({ commitFails: false, key: 'ims-manual-journal-rebuilt' })
  assert.equal(h.xeroCreates.length, 1)
  assert.match(refusal ?? '', /DIFFERENT idempotency key than the dispatch on record/)
})

test('o3d-jit6: the margin is subtracted, so a decision taken at 5m59s does not arrive at 6m01s', async () => {
  const dispatchedAt = new Date('2026-08-22T09:00:00.000Z')
  const justInside = new Date(dispatchedAt.getTime() + XERO_IDEMPOTENCY_KEY_RETENTION_MS - CREATE_DISPATCH_REPLAY_MARGIN_MS - 1)
  const justOutside = new Date(dispatchedAt.getTime() + XERO_IDEMPOTENCY_KEY_RETENTION_MS - CREATE_DISPATCH_REPLAY_MARGIN_MS)
  const recorded = { dispatchedAt, idempotencyKey: KEY }

  const inside = decideCreateDispatch({ type: 'COGS_JOURNAL', idempotencyKey: KEY, recorded, now: justInside, label: LABEL })
  assert.equal(inside.dispatch, true)
  assert.equal(inside.dispatch === true ? inside.basis : null, 'replay-within-idempotency-window')

  const outside = decideCreateDispatch({ type: 'COGS_JOURNAL', idempotencyKey: KEY, recorded, now: justOutside, label: LABEL })
  assert.equal(outside.dispatch, false)

  // A record stamped in the future is not "very fresh": nobody can order it, so it refuses.
  const skewed = decideCreateDispatch({
    type: 'COGS_JOURNAL', idempotencyKey: KEY, recorded, label: LABEL,
    now: new Date(dispatchedAt.getTime() - 1000),
  })
  assert.equal(skewed.dispatch, false)
})

test('o3d-jit6: a type whose create UPSERTS on a number IMS mints may still re-post past the window', async () => {
  // The honest exception, and it is narrow: `POST /CreditNotes` is keyed on `CreditNoteNumber`, the
  // number comes from this row's own payload, and Xero requires ACCRECCREDIT numbers to be unique —
  // so the re-post replaces the same document instead of adding one. Refusing it would strand a
  // credit note that converges on its own.
  assert.equal(CREATE_REPLAY_POLICY.CREDIT_NOTE, 'natural-key-upsert')
  const decision = decideCreateDispatch({
    type: 'CREDIT_NOTE',
    idempotencyKey: KEY,
    recorded: { dispatchedAt: new Date('2026-08-22T09:00:00.000Z'), idempotencyKey: KEY },
    now: new Date('2026-08-22T10:00:00.000Z'),
    label: 'CREDIT_NOTE for SalesOrderRefund r-1',
  })
  assert.equal(decision.dispatch, true)
  assert.equal(decision.dispatch === true ? decision.basis : null, 'natural-key-upsert')

  // And the eighteen journal types are the population with no such remedy — the reason this exists.
  const noRemedy = Object.entries(CREATE_REPLAY_POLICY).filter(([, policy]) => policy === 'no-remedy')
  assert.equal(noRemedy.length, 18)
  assert.ok(noRemedy.every(([type]) => type.startsWith('DAILY_BATCH_') || [
    'COGS_JOURNAL', 'INVENTORY_ADJUSTMENT', 'STOCK_IN_TRANSIT', 'STOCK_RECEIPT', 'COGS_REVERSAL',
    'STOCK_ALLOCATION', 'UNEARNED_REV_REVERSAL', 'ALLOCATION_REVERSAL', 'REALISED_FX_JOURNAL',
    'UNREALISED_FX_JOURNAL', 'MANUFACTURING_JOURNAL', 'MANUFACTURING_RECLASS',
  ].includes(type)))
})

test('o3d-jit6: a dispatch record that cannot be PLANNED refuses the post', async () => {
  // The o3d-k26m.5 rule: a create whose local record cannot be written is a create whose OUTCOME
  // cannot be recorded either — which IS the lost-response state. Proceeding "because the database is
  // only having a moment" is how the duplicate is produced.
  const broken: CreateDispatchClient = {
    $queryRaw: (async () => [{ now: new Date() }]) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: {
      findUnique: async () => { throw new Error('deadlock detected') },
    },
  }
  const decision = await planCreateDispatch(broken, {
    entryId: ENTRY_ID, type: 'COGS_JOURNAL', idempotencyKey: KEY, label: LABEL,
  })
  assert.equal(decision.dispatch, false)
  assert.match(decision.dispatch === false ? decision.error : '', /NOTHING WAS SENT/)
  assert.match(decision.dispatch === false ? decision.error : '', /deadlock detected/)

  // And a row that has vanished: there is nowhere left to write the id this post would return.
  const gone: CreateDispatchClient = {
    $queryRaw: (async () => [{ now: new Date() }]) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: {
      findUnique: async () => null,
    },
  }
  const missing = await planCreateDispatch(gone, {
    entryId: ENTRY_ID, type: 'COGS_JOURNAL', idempotencyKey: KEY, label: LABEL,
  })
  assert.equal(missing.dispatch, false)
  assert.match(missing.dispatch === false ? missing.error : '', /could not be read back/)
})

test('o3d-jit6 r1#2: the journal branch PLANS before the fence and RECORDS in it — never before it', async () => {
  // The wiring, which no unit of the module above can prove. A fence built and never called, or a
  // record written before the gate that can refuse, is the defect with a test suite.
  const source = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const branch = source.slice(
    source.indexOf("const idempotencySource = typeof payload._idempotencyKey === 'string'"),
    source.indexOf("case 'TAX_RATE_SYNC': {"),
  )
  assert.ok(branch.length > 0, 'the manual-journal branch must be locatable')

  const plan = branch.indexOf('planCreateDispatch(db, {')
  const fence = branch.indexOf("lease.fenceBeforeRemoteWrite('manual-journal'")
  const post = branch.indexOf('pushManualJournal({')
  assert.ok(plan > -1, 'the branch must plan the dispatch')
  assert.ok(plan < fence, 'the READ comes first — nothing awaitable may sit between the fence and the socket')
  assert.ok(fence < post, 'and the fence is still the last thing before the socket')
  assert.match(
    branch.slice(plan, fence),
    /if \(!dispatch\.dispatch\) return \{ success: false, error: dispatch\.error \}/,
    'a refusal must stop the post, not merely be logged',
  )
  // THE FINDING ITSELF: the record travels INTO the fence, so it is written by the statement that
  // proves the claim rather than by one that runs whether or not the post is going to happen.
  assert.match(
    branch,
    /lease\.fenceBeforeRemoteWrite\('manual-journal', dispatch\.mint \?\? undefined\)/,
    'the mint must be handed to the fence — a record written outside it can outlive a post that never left',
  )
  assert.ok(!/takeCreateDispatchSlot|accountingSyncLog\.update/.test(branch),
    'and the branch must not write the record for itself')

  // ONE derivation of the key, used for both the record and the header. Two derivations is how a
  // replay ends up comparing a key against a different key and refusing every honest retry — or,
  // worse, allowing one whose header no longer matches what was recorded.
  assert.equal((branch.match(/buildXeroIdempotencyKey\(/g) ?? []).length, 1)
  assert.match(branch.slice(plan, fence), /idempotencyKey: journalIdempotencyKey,/, 'recorded under that key')
  assert.match(branch.slice(post), /\{ idempotencyKey: journalIdempotencyKey \}/, 'and sent under the same one')
})

test('o3d-jit6 r1#2: the fence writes the claim renewal and the dispatch record in ONE statement', async () => {
  // Two statements would be two failure modes: a record with no claim (the finding), or a claim
  // proven and then an await before the socket (o3d-xl63 r5 #1). One `updateMany` is neither.
  const source = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const renew = source.slice(
    source.indexOf('export async function renewClaimForRemoteWrite('),
    source.indexOf('function lostClaimMessage('),
  )
  assert.equal((renew.match(/await db\.accountingSyncLog\./g) ?? []).length, 1, 'exactly one write')
  assert.match(renew, /data: mint \? \{ processingStartedAt: renewedAt, \.\.\.mint \} : \{ processingStartedAt: renewedAt \}/)
  assert.match(renew, /where: \{ \.\.\.heldClaimWhere\(entryId, held\), connector: XERO_CONNECTOR \}/,
    'and the mint is scoped to the claim, so only the worker that owns the row can record a dispatch for it')
})

test('o3d-jit6 r1#3: every no-remedy type prescribes a remedy the settlement action would actually ACCEPT', async () => {
  // CODEX ROUND 1, FINDING 3. A refusal whose remedy cannot be performed is not a remedy. The generic
  // wording told every one of the eighteen no-remedy types to record the document id with the per-row
  // settlement action, or to cancel and re-queue — and six of them are DAILY_BATCH types, for which
  // that action refused everything and no cancel exists at all. This asserts the coupling directly:
  // whatever the refusal prescribes, `refuseSettlement` must admit for that type.
  const { refuseSettlement, settleableSettlementOutcomes } =
    await import('@/lib/domain/accounting/sync-row-settlement')

  const noRemedy = Object.entries(CREATE_REPLAY_POLICY)
    .filter(([, policy]) => policy === 'no-remedy')
    .map(([type]) => type as keyof typeof CREATE_REPLAY_POLICY)
  assert.equal(noRemedy.length, 18)

  for (const type of noRemedy) {
    const decision = decideCreateDispatch({
      type,
      idempotencyKey: KEY,
      recorded: { dispatchedAt: new Date('2026-08-22T09:00:00.000Z'), idempotencyKey: KEY },
      now: new Date('2026-08-22T10:00:00.000Z'),
      label: `${type} for DailyBatch b-1`,
    })
    assert.equal(decision.dispatch, false, type)
    const error = decision.dispatch === false ? decision.error : ''

    // The one remedy every no-remedy type has: record the id you found. It must be admitted.
    assert.match(error, /per-row settlement action/, type)
    const row = { status: 'FAILED', type, externalTransactionId: null }
    assert.equal(
      refuseSettlement(row, { outcome: 'POSTED', externalTransactionId: 'MJ-1' }),
      null,
      `${type}: the refusal points at the POSTED settlement, so the POSTED settlement must run`,
    )

    const outcomes = settleableSettlementOutcomes(type)
    if (outcomes.includes('NOT_POSTED')) {
      assert.match(error, /cancel this row and re-queue/, type)
      assert.equal(refuseSettlement(row, { outcome: 'NOT_POSTED' }), null, type)
    } else {
      // A DAILY_BATCH row: the refusal must NOT send the operator to a cancel that is refused, and
      // must say what to do when the journal is not in the ledger either.
      assert.doesNotMatch(error, /cancel this row and re-queue/, type)
      assert.match(error, /DAILY BATCH row accepts that assertion/, type)
      assert.match(error, /post it in the accounting system/, type)
      assert.equal(
        refuseSettlement(row, { outcome: 'NOT_POSTED' })?.code,
        'daily_batch_not_settleable',
        `${type}: and the half it does not offer is genuinely the refused one`,
      )
    }
  }
})
