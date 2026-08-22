import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  CREATE_DISPATCH_REPLAY_MARGIN_MS,
  CREATE_REPLAY_POLICY,
  decideCreateDispatch,
  takeCreateDispatchSlot,
  type CreateDispatchClient,
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
 * not: the dispatch record was committed by its own statement, BEFORE the post, and the snapshot
 * already contains it. A double that let the settlement's writes stand would make the broken code and
 * the fixed code indistinguishable.
 */

const ENTRY_ID = 'log-1'
const LABEL = 'COGS_JOURNAL for PurchaseOrder po-1'
const KEY = 'ims-manual-journal-log-1'

type Row = {
  id: string
  status: string
  externalTransactionId: string | null
  createDispatchedAt: Date | null
  createDispatchIdempotencyKey: string | null
}

function harness() {
  let now = new Date('2026-08-22T09:00:00.000Z')
  const row: Row = {
    id: ENTRY_ID,
    status: 'PENDING',
    externalTransactionId: null,
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
      updateMany: async ({ where, data }) => {
        if (where.id !== row.id) return { count: 0 }
        // The trigger's job, modelled: the pair may be minted, never moved.
        if (row.createDispatchedAt !== null) return { count: 0 }
        row.createDispatchedAt = data.createDispatchedAt
        row.createDispatchIdempotencyKey = data.createDispatchIdempotencyKey
        return { count: 1 }
      },
      findUnique: async ({ where }) => (where.id === row.id
        ? { createDispatchedAt: row.createDispatchedAt, createDispatchIdempotencyKey: row.createDispatchIdempotencyKey }
        : null),
    },
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
   * One attempt, in the production ORDER: record the dispatch, then post, then settle. Returns the
   * refusal when the fence stops it, so a caller can assert nothing was sent.
   */
  async function attempt(opts: { commitFails: boolean; type?: keyof typeof CREATE_REPLAY_POLICY; key?: string }): Promise<string | null> {
    const decision = await takeCreateDispatchSlot(client, {
      entryId: ENTRY_ID,
      type: opts.type ?? 'COGS_JOURNAL',
      idempotencyKey: opts.key ?? KEY,
      label: LABEL,
    })
    if (!decision.dispatch) return decision.error

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

test('o3d-jit6: a dispatch record that cannot be written REFUSES the post', async () => {
  // The o3d-k26m.5 rule: a create whose local record cannot be written is a create whose OUTCOME
  // cannot be recorded either — which IS the lost-response state. Proceeding "because the database is
  // only having a moment" is how the duplicate is produced.
  const broken: CreateDispatchClient = {
    $queryRaw: (async () => [{ now: new Date() }]) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: {
      updateMany: async () => { throw new Error('deadlock detected') },
      findUnique: async () => null,
    },
  }
  const decision = await takeCreateDispatchSlot(broken, {
    entryId: ENTRY_ID, type: 'COGS_JOURNAL', idempotencyKey: KEY, label: LABEL,
  })
  assert.equal(decision.dispatch, false)
  assert.match(decision.dispatch === false ? decision.error : '', /NOTHING WAS SENT/)
  assert.match(decision.dispatch === false ? decision.error : '', /deadlock detected/)

  // And a row that has vanished: there is nowhere left to write the id this post would return.
  const gone: CreateDispatchClient = {
    $queryRaw: (async () => [{ now: new Date() }]) as CreateDispatchClient['$queryRaw'],
    accountingSyncLog: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
    },
  }
  const missing = await takeCreateDispatchSlot(gone, {
    entryId: ENTRY_ID, type: 'COGS_JOURNAL', idempotencyKey: KEY, label: LABEL,
  })
  assert.equal(missing.dispatch, false)
  assert.match(missing.dispatch === false ? missing.error : '', /could not be read back/)
})

test('o3d-jit6: the journal branch takes the slot BEFORE the socket, under the key it will send', async () => {
  // The wiring, which no unit of the module above can prove. A fence built and never called, or
  // called after the request, is the defect with a test suite.
  const source = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const branch = source.slice(
    source.indexOf("const idempotencySource = typeof payload._idempotencyKey === 'string'"),
    source.indexOf("case 'TAX_RATE_SYNC': {"),
  )
  assert.ok(branch.length > 0, 'the manual-journal branch must be locatable')

  const slot = branch.indexOf('takeCreateDispatchSlot(db, {')
  const fence = branch.indexOf("lease.fenceBeforeRemoteWrite('manual-journal')")
  const post = branch.indexOf('pushManualJournal({')
  assert.ok(slot > -1, 'the branch must take a dispatch slot')
  assert.ok(slot < fence, 'the record is written before the claim fence, which is the last thing before the socket')
  assert.ok(fence < post, 'and the fence is still the last thing before the socket')
  assert.match(
    branch.slice(slot, fence),
    /if \(!dispatch\.dispatch\) return \{ success: false, error: dispatch\.error \}/,
    'a refusal must stop the post, not merely be logged',
  )

  // ONE derivation of the key, used for both the record and the header. Two derivations is how a
  // replay ends up comparing a key against a different key and refusing every honest retry — or,
  // worse, allowing one whose header no longer matches what was recorded.
  assert.equal((branch.match(/buildXeroIdempotencyKey\(/g) ?? []).length, 1)
  assert.match(branch.slice(slot, fence), /idempotencyKey: journalIdempotencyKey,/, 'recorded under that key')
  assert.match(branch.slice(post), /\{ idempotencyKey: journalIdempotencyKey \}/, 'and sent under the same one')
})
