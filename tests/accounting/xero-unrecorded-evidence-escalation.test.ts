import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Codex r2, HIGH — A FAILED EVIDENCE TRANSACTION WAS RETRIED AS ORDINARY SYNC WORK.
//
// Round 2 made an unwritable conflict record abort its transaction and throw, and justified that by
// saying the job would then be "retried rather than buried". But the retry is an ORDINARY sync attempt
// against a row that by then names the OTHER document: it short-circuits on `externalTransactionId`,
// re-records the id already there (which lands), settles the row SYNCED and completes the outbox job as
// a SUCCESS — and on the outbox path it does not even get that far, because the top of the loop
// completes any job whose row is SYNCED with an id. The displaced identifier was never in the database
// and is not in the retry's memory, so the retry that was meant to preserve it is exactly what loses it.
//
// So the identifier never enters the retry path: it is carried on the error, the transaction is
// re-driven while it is the RECORD that failed, and if it still cannot be written the incident is
// escalated out of band instead of being handed back as a sync failure.
// ---------------------------------------------------------------------------

type Row = {
  id: string
  status: string
  externalTransactionId: string | null
  processingStartedAt: Date | null
  syncedAt: Date | null
  errorMessage: string | null
  retryCount: number
}

const ENTRY = {
  id: 'log-1',
  type: 'SALES_INVOICE' as const,
  referenceType: 'SalesOrder',
  referenceId: 'order-1',
}

/** How many times the activity-log write should fail before it starts succeeding. */
const control = {
  activityFailures: 0,
  transactions: 0,
  activityWrites: [] as Array<Record<string, unknown>>,
  rowUpdateFails: false,
  /**
   * The transaction number (1-based) from which the row `updateMany` starts failing — so an attempt can
   * die BEFORE it reaches the branch that observes the conflict, which is the round-4 finding.
   */
  rowUpdateFailsFrom: Number.MAX_SAFE_INTEGER,
  /**
   * How many COMMITS fail, after a callback that did everything right (Codex r3, HIGH). This is the
   * failure round 3 did not model: a deadlock victim, a serialization failure, a connection lost at
   * COMMIT. The double rolls the writes back when it fires, because a double that let them stand would
   * let the broken code look like it had preserved something.
   */
  commitFailures: 0,
  /** Writes that went through the POOLED client — i.e. outside any transaction. */
  pooledWrites: [] as Array<Record<string, unknown>>,
  pooledWriteFails: false,
  /**
   * THE ONE ACTIVITY-LOG STORE BOTH WORKERS SEE (Codex r4, HIGH).
   *
   * The round-4 finding is about a worker reading evidence ANOTHER worker filed, so the double can no
   * longer keep "what was written" and "what a reader answers with" in two unconnected arrays: with
   * separate arrays the broken code and the fixed code are indistinguishable, because nothing a filer
   * writes can ever appear to a reader. Every create — transactional or pooled — lands here, and the
   * transaction double truncates it on a rolled-back commit, so an uncommitted incident is invisible
   * to a reader exactly as it is in Postgres.
   */
  pooledRows: [] as Array<{ entityId: string | null; action?: string; description: string; createdAt: Date }>,
  pooledReads: [] as Array<Record<string, unknown>>,
  /** Runs at the instant the outbox job is completed — a second worker interleaving with the first. */
  onOutboxWrite: null as null | (() => Promise<void>),
  outboxWrites: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
  /** Outbox burial: how many updateMany calls throw before one succeeds, and how many were made. */
  outboxFailures: 0,
  outboxAttempts: 0,
  outboxUpdatedCount: 1,
  consoleErrors: [] as string[],
  /** Raw statements executed inside a transaction — the database-clock stamp (o3d-batch-billpay). */
  rawStatements: 0,
}

function makeRow(): Row {
  return {
    id: 'log-1',
    status: 'SYNCED',
    // The conflict: a newer claim posted and recorded its own document while this worker was on the wire.
    externalTransactionId: 'INV-XERO-FIRST',
    processingStartedAt: null,
    syncedAt: new Date('2026-03-01T09:30:00.000Z'),
    errorMessage: null,
    retryCount: 0,
  }
}

let row: Row = makeRow()

function matches(where: Record<string, unknown>): boolean {
  if (where.id !== row.id) return false
  const or = where.OR as Array<Record<string, unknown>> | undefined
  if (or) return or.some((arm) => arm.externalTransactionId === row.externalTransactionId)
  return true
}

const accountingSyncLog = {
  updateMany: async ({ where }: { where: Record<string, unknown> }) => {
    if (control.rowUpdateFails || control.transactions >= control.rowUpdateFailsFrom) {
      throw new Error('accounting_sync_logs update failed')
    }
    return { count: matches(where) ? 1 : 0 }
  },
  findUnique: async () => ({ externalTransactionId: row.externalTransactionId }),
}

const activityLog = {
  create: async ({ data }: { data: Record<string, unknown> }) => {
    if (control.activityFailures > 0) {
      control.activityFailures--
      throw new Error('activity_log insert failed')
    }
    control.activityWrites.push(data)
    // And into the store a READER can see, because that is the whole subject of round 4.
    control.pooledRows.push({
      entityId: (data.entityId as string | null) ?? null,
      action: data.action as string,
      description: String(data.description),
      createdAt: new Date(),
    })
    return data
  },
}

// The mirror delegates answer NOTHING FOUND, which is their own "no event to update" path. This file is
// about which record survives a failed write, and a half-built mirror event would only add noise.
const tx = new Proxy({ accountingSyncLog }, {
  get(_target, prop: string) {
    if (prop === 'accountingSyncLog') return accountingSyncLog
    if (prop === 'activityLog') return activityLog
    // o3d-batch-billpay (o3d-clxw r4), merged into development after this double was written: the
    // SYNCED write is followed, in the same transaction, by a raw-SQL stamp of `syncedAt` from the
    // DATABASE's clock. `$executeRaw` is used as a TAGGED TEMPLATE, so it must be a function — the
    // generic delegate below answers with an object and the un-taught double died on
    // "$executeRaw is not a function" before it could reach anything this file is about.
    if (prop === '$executeRaw' || prop === '$executeRawUnsafe') {
      return async () => { control.rawStatements++; return 1 }
    }
    return new Proxy({}, {
      // Reads answer NOTHING FOUND; writes answer a ROW. o3d-nf9i (merged into development after this
      // double was written) made `updateMirroredAccountingEventStatus` return an outcome whose success
      // value IS what `accountingEvent.update` resolved to, so a `null` write answer made the mirror
      // dereference `null.id` and throw out of the transaction this file is about. Prisma's `update`
      // returns the row or throws P2025 — it never resolves to null.
      get: (_t, method: string) => async () => {
        if (method === 'findMany') return []
        if (method === 'findUnique' || method === 'findFirst') return null
        if (method === 'updateMany' || method === 'deleteMany') return { count: 1 }
        return { id: 'mirror-event-1' }
      },
    })
  },
})

const pooledActivityLog = {
  create: async ({ data }: { data: Record<string, unknown> }) => {
    if (control.pooledWriteFails) throw new Error('pooled activity_log insert failed')
    control.pooledWrites.push(data)
    control.pooledRows.push({
      entityId: (data.entityId as string | null) ?? null,
      action: data.action as string,
      description: String(data.description),
      createdAt: new Date(),
    })
    return data
  },
  findFirst: async ({ where }: { where: Record<string, unknown> }) => {
    control.pooledReads.push(where)
    const matches = control.pooledRows.filter((row) => (
      row.entityId === where.entityId
      && (row.action === undefined || row.action === where.action)
    ))
    // orderBy createdAt desc — newest first, which is what the reader asks for.
    return matches.length > 0 ? matches[matches.length - 1] : null
  },
}

const pooledIntegrationOutbox = {
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    control.outboxAttempts++
    control.outboxWrites.push({ where, data })
    // THE INTERLEAVE POINT. A second worker gets to run WHILE this write is happening, which is the only
    // honest way to model "the incident was filed between the read and the write".
    const hook = control.onOutboxWrite
    if (hook) {
      control.onOutboxWrite = null
      await hook()
    }
    if (control.outboxFailures > 0) {
      control.outboxFailures--
      throw new Error('integration_outbox update failed')
    }
    return { count: control.outboxUpdatedCount }
  },
  findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => {
        control.transactions++
        // The rollback point. Everything the callback wrote is undone when the commit fails, which is
        // what makes "the record was written" and "the record survived" two different facts.
        const writtenBefore = control.activityWrites.length
        const storedBefore = control.pooledRows.length
        const value = await fn(tx)
        if (control.commitFailures > 0) {
          control.commitFailures--
          control.activityWrites.length = writtenBefore
          // A reader must not be able to see a row whose transaction rolled back.
          control.pooledRows.length = storedBefore
          throw new Error('could not serialize access due to concurrent update')
        }
        return value
      },
      activityLog: pooledActivityLog,
      integrationOutbox: pooledIntegrationOutbox,
    },
  },
})

async function loadProcessor() {
  return import('@/lib/connectors/xero/sync-processor')
}

function reset() {
  row = makeRow()
  control.activityFailures = 0
  control.transactions = 0
  control.activityWrites = []
  control.rowUpdateFails = false
  control.rowUpdateFailsFrom = Number.MAX_SAFE_INTEGER
  control.commitFailures = 0
  control.pooledWrites = []
  control.pooledWriteFails = false
  control.pooledRows = []
  control.pooledReads = []
  control.onOutboxWrite = null
  control.outboxWrites = []
  control.outboxFailures = 0
  control.outboxAttempts = 0
  control.outboxUpdatedCount = 1
  control.consoleErrors = []
}

/** The process log is one of the two places the incident goes; capture it instead of printing it. */
async function withCapturedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error
  console.error = (...args: unknown[]) => { control.consoleErrors.push(args.map(String).join(' ')) }
  try {
    return await fn()
  } finally {
    console.error = original
  }
}

test('Codex r2 HIGH: a conflict record that fails once is RE-DRIVEN, and the identifier is written', async () => {
  const { recordPostedDocumentDurably } = await loadProcessor()
  reset()
  control.activityFailures = 1

  const record = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {})

  assert.equal(control.transactions, 2, 'the whole conflict transaction is re-driven, not just the insert')
  assert.equal(record.recorded, false)
  assert.equal(control.activityWrites.length, 1, 'and the record is written exactly once')
  assert.match(String(control.activityWrites[0].description), /INV-XERO-SECOND/)
  assert.match(String(control.activityWrites[0].description), /INV-XERO-FIRST/)
})

test('Codex r2 HIGH: when it cannot be written at all, the failure CARRIES the displaced identifier', async () => {
  // The whole point. The row will never name INV-XERO-SECOND, no retry can re-derive it, and this error
  // is the last place in the process that knows it exists — so it has to be on the error, not just a
  // message about a database problem.
  const { recordPostedDocumentDurably } = await loadProcessor()
  const { PostedDocumentEvidenceUnwritten } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  reset()
  control.activityFailures = Number.MAX_SAFE_INTEGER

  const error = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {}).then(
    () => { throw new Error('an unwritable record must not return a result') },
    (e: unknown) => e,
  )

  assert.ok(error instanceof PostedDocumentEvidenceUnwritten)
  assert.equal(error.postedExternalId, 'INV-XERO-SECOND', 'the identifier the row will never name')
  assert.equal(error.namedExternalId, 'INV-XERO-FIRST', 'and the one it keeps')
  assert.equal(error.reason, 'ANOTHER_DOCUMENT_NAMED')
  assert.match(error.operatorMessage, /INV-XERO-SECOND/)
  assert.match(error.operatorMessage, /INV-XERO-FIRST/)
  assert.match(error.operatorMessage, /REMEDY:/, 'a refusal has to name something an operator can do')
  assert.match(error.operatorMessage, /activity_log insert failed/, 'including why the record could not be saved')
  assert.ok(control.transactions > 1, 'and it was re-driven before being declared unsaveable')
})

test('Codex r2 HIGH: an ordinary failure inside the transaction is NOT re-driven and keeps its own handling', async () => {
  // The counter-guard. If the re-drive caught everything, a genuinely failing sync would silently make
  // three attempts and then surface as an evidence problem, and the runners would stop giving the row
  // back for a legitimate retry.
  const { recordPostedDocumentDurably } = await loadProcessor()
  const { PostedDocumentEvidenceUnwritten } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  reset()
  control.rowUpdateFails = true

  const error = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {}).then(
    () => { throw new Error('the transaction failed; there is nothing to return') },
    (e: unknown) => e,
  )

  assert.ok(!(error instanceof PostedDocumentEvidenceUnwritten), 'not an evidence failure')
  assert.match(String(error), /accounting_sync_logs update failed/)
  assert.equal(control.transactions, 1, 'ordinary failures are handed straight back to the caller')
})

test('Codex r2 HIGH: a row that becomes recordable on a later attempt is simply RECORDED', async () => {
  // Not a special case: each attempt re-observes the row, so if the conflicting id is gone by the time
  // the record can be written, the right answer is to record the document normally.
  const { recordPostedDocumentDurably } = await loadProcessor()
  reset()
  row.externalTransactionId = 'INV-XERO-SECOND'

  const record = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {})

  assert.equal(record.recorded, true)
  assert.equal(control.transactions, 1, 'no conflict, so nothing to re-drive')
  assert.deepEqual(control.activityWrites, [], 'and no incident is filed for work that succeeded')
})

// ---------------------------------------------------------------------------
// Codex r3, HIGH — A FAILURE OF THE TRANSACTION, NOT OF THE RECORD.
//
// Round 3 preserved the identifier when the activity-log INSERT failed, because that throws from inside
// the callback and the throw IS the preservation. It did not preserve it when the transaction failed
// anywhere else: the insert succeeds, the COMMIT does not, the record rolls back, and what leaves
// recordPostedDocumentDurably is an ordinary database error. Trace it the way round 3 traced the retry —
// the runners' catch tests for PostedDocumentEvidenceUnwritten, this is not one, so it goes to the
// ordinary failure branch; the next run reads a row the winner already settled SYNCED with ITS id, and
// the outbox runner completes that job at the top of the loop before it claims anything. Green verdict,
// identifier gone.
// ---------------------------------------------------------------------------

test('Codex r3 HIGH: a COMMIT failure after the conflict was observed still carries both identifiers', async () => {
  const { recordPostedDocumentDurably } = await loadProcessor()
  const { PostedDocumentEvidenceUnwritten } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  reset()
  // The insert is fine every time. It is the transaction that will not commit.
  control.commitFailures = Number.MAX_SAFE_INTEGER

  const error = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {}).then(
    () => { throw new Error('nothing committed; there is no result to return') },
    (e: unknown) => e,
  )

  assert.ok(
    error instanceof PostedDocumentEvidenceUnwritten,
    'a rolled-back conflict transaction is an unwritten record, not an ordinary sync error — an ordinary '
      + 'sync error is handed to the retry that completes the job as a success',
  )
  assert.equal(error.postedExternalId, 'INV-XERO-SECOND', 'the identifier the row will never name')
  assert.equal(error.namedExternalId, 'INV-XERO-FIRST', 'and the one it keeps')
  assert.equal(error.reason, 'ANOTHER_DOCUMENT_NAMED')
  assert.match(error.operatorMessage, /REMEDY:/, 'with the operator wording, not just a database error')
  assert.match(error.operatorMessage, /could not serialize access/, 'and why it could not be saved')
  assert.equal(control.activityWrites.length, 0, 'nothing survived the rollback, which is the premise')
  assert.equal(control.transactions, 3, 'and it was re-driven first: a deadlock victim commits a moment later')
})

test('Codex r3 HIGH: a COMMIT failure that succeeds on the re-drive records the document once', async () => {
  const { recordPostedDocumentDurably } = await loadProcessor()
  reset()
  control.commitFailures = 1

  const record = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {})

  assert.equal(record.recorded, false)
  assert.equal(control.transactions, 2)
  assert.equal(control.activityWrites.length, 1, 'the rolled-back write did not survive, the committed one did')
  assert.match(String(control.activityWrites[0].description), /INV-XERO-SECOND/)
})

test('Codex r3 HIGH: a COMMIT failure with NO conflict observed keeps its ordinary handling', async () => {
  // The counter-guard, and the reason the observation is what converts the error rather than the failure
  // being caught wholesale. This row has nothing to lose: the id it is recording is the one already on
  // it, no document is displaced, and a genuine sync failure must still be given back for an ordinary
  // retry instead of being re-driven three times and reported as an evidence problem.
  const { recordPostedDocumentDurably } = await loadProcessor()
  const { PostedDocumentEvidenceUnwritten } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  reset()
  control.commitFailures = Number.MAX_SAFE_INTEGER

  const error = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-FIRST', {}).then(
    () => { throw new Error('nothing committed; there is no result to return') },
    (e: unknown) => e,
  )

  assert.ok(!(error instanceof PostedDocumentEvidenceUnwritten), 'no conflict was observed, so this is not one')
  assert.match(String(error), /could not serialize access/)
  assert.equal(control.transactions, 1, 'handed straight back to the caller')
})

// ---------------------------------------------------------------------------
// Codex r4, HIGH — A LATER UNOBSERVED ATTEMPT DISCARDED AN EARLIER OBSERVATION.
//
// Round 4 kept the observation PER ATTEMPT, so that a rolled-back attempt could not describe the next
// one. Correct as far as it goes — and it also meant an attempt that observed NOTHING threw the earlier
// observation away. Attempt 1 sees the conflict and cannot write the record; attempt 2 dies in the row
// `updateMany`, BEFORE the branch that would have observed it again; `observed` is undefined, so the
// bare database error is rethrown. The runners do not recognise that type, it takes the ordinary
// failure branch, and the next run finds the winner's settled row and completes the job green. The
// re-drive that exists to PRESERVE the displaced identifier discarded it on the attempt that followed.
// ---------------------------------------------------------------------------

test('Codex r4 HIGH: an attempt that observes nothing does NOT discard the conflict an earlier one saw', async () => {
  const { recordPostedDocumentDurably } = await loadProcessor()
  const { PostedDocumentEvidenceUnwritten } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  reset()
  // Attempt 1: the conflict is observed and the record cannot be written.
  control.activityFailures = 1
  // Attempt 2 onwards: the transaction dies in the row update, before the conflict branch is reached.
  control.rowUpdateFailsFrom = 2

  const error = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {}).then(
    () => { throw new Error('nothing was recorded; there is no result to return') },
    (e: unknown) => e,
  )

  assert.ok(
    error instanceof PostedDocumentEvidenceUnwritten,
    'the conflict attempt 1 observed is still the truth: a bare database error here is handed to the '
      + 'ordinary retry, which settles the row and completes the job as a success',
  )
  assert.equal(error.postedExternalId, 'INV-XERO-SECOND', 'the identifier the row will never name')
  assert.equal(error.namedExternalId, 'INV-XERO-FIRST', 'and the one it keeps')
  assert.equal(error.reason, 'ANOTHER_DOCUMENT_NAMED')
  assert.match(error.operatorMessage, /REMEDY:/)
  assert.match(error.operatorMessage, /accounting_sync_logs update failed/, 'and why the LAST attempt died')
  assert.equal(control.transactions, 3, 'the whole budget was spent before it was declared unsaveable')
  assert.equal(control.activityWrites.length, 0, 'and nothing was written down, which is the premise')
})

test('Codex r4 HIGH: a FRESH observation still overrides the carried one', async () => {
  // The per-attempt property round 4 was defending, kept: a later attempt that observes its own conflict
  // describes ITS row state, not the previous attempt's. Green under revert BY DESIGN — it is the
  // control that stops the fix being "keep the first observation for ever".
  const { recordPostedDocumentDurably } = await loadProcessor()
  const { PostedDocumentEvidenceUnwritten } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  reset()
  control.activityFailures = Number.MAX_SAFE_INTEGER
  const previousUpdate = accountingSyncLog.updateMany
  accountingSyncLog.updateMany = async ({ where }: { where: Record<string, unknown> }) => {
    // Between attempt 1 and attempt 2 the row is re-pointed at a THIRD document.
    if (control.transactions >= 2) row.externalTransactionId = 'INV-XERO-THIRD'
    return previousUpdate({ where })
  }
  try {
    const error = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {}).then(
      () => { throw new Error('nothing was recorded; there is no result to return') },
      (e: unknown) => e,
    )
    assert.ok(error instanceof PostedDocumentEvidenceUnwritten)
    assert.equal(error.namedExternalId, 'INV-XERO-THIRD', 'the LAST attempt observed this, and it is what the row keeps')
  } finally {
    accountingSyncLog.updateMany = previousUpdate
  }
})

// ---------------------------------------------------------------------------
// Codex r3, HIGH — WHEN THE BURIAL ITSELF FAILS.
//
// Round 3 buried the outbox job precisely because burying is what stops the retry that erases the
// incident. A burial that throws undoes that choice: before this change the throw escaped the catch
// handler, the loop and the run, leaving the job PROCESSING and locked — so CLAIM_STALE_MS later it is
// re-claimed as a stale lock, and the run that gets it reads a SYNCED row with an id and completes it as
// a SUCCESS. The incident is lost with a green verdict, one layer further out than round 3 looked.
// ---------------------------------------------------------------------------

const JOB = { id: 'job-1', lockedAt: new Date('2026-03-01T09:00:00.000Z') }

async function unwritten() {
  const { PostedDocumentEvidenceUnwritten } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  return new PostedDocumentEvidenceUnwritten(
    {
      entry: ENTRY,
      postedExternalId: 'INV-XERO-SECOND',
      reason: 'ANOTHER_DOCUMENT_NAMED',
      namedExternalId: 'INV-XERO-FIRST',
    },
    new Error('activity_log insert failed'),
  )
}

function job() {
  return JOB as unknown as Parameters<
    Awaited<ReturnType<typeof loadProcessor>>['buryOutboxJobForUnwrittenPostedEvidence']
  >[0]
}

/** A SECOND outbox job pointing at the SAME sync log — duplicates are the ordinary case here. */
function secondJob() {
  return { ...JOB, id: 'job-2' } as unknown as ReturnType<typeof job>
}

test('Codex r3 HIGH: the escalation writes the record OUTSIDE the transaction that could not commit', async () => {
  // The durable half. The transaction is gone; the record it wanted to write need not be — and since a
  // commit failure now arrives here too, the insert itself was often never the problem.
  const { escalateUnwrittenPostedEvidence } = await loadProcessor()
  const { UNRECORDED_POSTED_DOCUMENT_ACTION } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  reset()

  const filed = await withCapturedConsole(async () => escalateUnwrittenPostedEvidence(await unwritten()))

  assert.equal(filed, true, 'and it reports that it landed, because the burial message depends on it')
  assert.equal(control.pooledWrites.length, 1)
  assert.equal(control.pooledWrites[0].action, UNRECORDED_POSTED_DOCUMENT_ACTION, 'the action the retention sweep exempts')
  assert.equal(control.pooledWrites[0].entityId, ENTRY.id, 'keyed to the sync row, which is how a later run finds it')
  assert.match(String(control.pooledWrites[0].description), /INV-XERO-SECOND/)
  assert.match(String(control.pooledWrites[0].description), /INV-XERO-FIRST/)
  assert.match(String(control.pooledWrites[0].description), /REMEDY:/)
  assert.equal(control.consoleErrors.length, 1, 'the process log gets it first, because that cannot fail')
})

test('Codex r3 HIGH: an escalation whose own write fails says so instead of throwing', async () => {
  const { escalateUnwrittenPostedEvidence } = await loadProcessor()
  reset()
  control.pooledWriteFails = true

  const filed = await withCapturedConsole(async () => escalateUnwrittenPostedEvidence(await unwritten()))

  assert.equal(filed, false)
  assert.equal(control.pooledWrites.length, 0)
  assert.equal(control.consoleErrors.length, 2, 'the incident, and then that it could not be written down')
})

test('Codex r3 HIGH: a burial that fails is RE-DRIVEN rather than lost', async () => {
  const { buryOutboxJobForUnwrittenPostedEvidence } = await loadProcessor()
  reset()
  control.outboxFailures = 2

  await buryOutboxJobForUnwrittenPostedEvidence(job(), await unwritten(), true)

  assert.equal(control.outboxAttempts, 3, 'the common failure here is a blip, not a verdict')
})

test('Codex r3 HIGH: a burial that cannot be written FAILS THE RUN, carrying the wording', async () => {
  // Not swallowed, and not a bare database error either: at this moment the wording is the only account
  // of the incident that names both documents, so it has to travel with the failure.
  const { buryOutboxJobForUnwrittenPostedEvidence } = await loadProcessor()
  reset()
  control.outboxFailures = Number.MAX_SAFE_INTEGER

  const error = await buryOutboxJobForUnwrittenPostedEvidence(job(), await unwritten(), false).then(
    () => { throw new Error('a burial that never happened must not resolve') },
    (e: unknown) => e,
  )

  assert.match(String(error), /INV-XERO-SECOND/)
  assert.match(String(error), /INV-XERO-FIRST/)
  assert.match(String(error), /job-1/, 'and which job is still sitting there claimed')
  assert.match(String(error), /NOTHING WAS WRITTEN DOWN/, 'nothing durable exists, and the message says so')
  assert.equal(control.outboxAttempts, 3)
})

test('Codex r3 HIGH: a burial that lost its claim is a loud failure too, not a silent skip', async () => {
  // markIntegrationOutboxPermanentFailure refuses a row this worker no longer holds. That refusal used
  // to escape as a bare claim-conflict error; it is still a job that was NOT buried.
  const { buryOutboxJobForUnwrittenPostedEvidence } = await loadProcessor()
  reset()
  control.outboxUpdatedCount = 0

  const error = await buryOutboxJobForUnwrittenPostedEvidence(job(), await unwritten(), true).then(
    () => { throw new Error('an unclaimed job was not buried') },
    (e: unknown) => e,
  )

  assert.match(String(error), /COULD NOT BE BURIED/)
  assert.match(
    String(error),
    /IS on record in the activity log/,
    'and when the record DID land, the message says the reclaim will bury the job rather than complete it',
  )
})

test('Codex r3 HIGH: the reclaim reader answers with the recorded incident, for one sync row', async () => {
  const { findUnrecordedPostedDocumentEvidenceFor } = await loadProcessor()
  const { UNRECORDED_POSTED_DOCUMENT_ACTION } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  reset()
  control.pooledRows = [
    {
      entityId: 'log-1',
      action: UNRECORDED_POSTED_DOCUMENT_ACTION,
      description: 'INV-XERO-SECOND was posted and cannot be recorded',
      createdAt: new Date(),
    },
  ]

  assert.equal(
    await findUnrecordedPostedDocumentEvidenceFor('log-1'),
    'INV-XERO-SECOND was posted and cannot be recorded',
  )
  assert.equal(await findUnrecordedPostedDocumentEvidenceFor('log-2'), undefined, 'a row with no incident is completed as before')
  assert.equal(control.pooledReads[0].action, UNRECORDED_POSTED_DOCUMENT_ACTION)
  assert.equal(control.pooledReads[0].entityType, 'SYSTEM', 'so it lands on the (entityType, entityId) index')
  assert.equal(control.pooledReads[0].entityId, 'log-1', 'one row, asked for by id — not a batch of them')
})

// ---------------------------------------------------------------------------
// WHAT THE RUNNERS DO WITH IT. Structural, because reaching this branch through either runner means
// driving a whole sweep; the behaviour that matters is which of three mutually exclusive verdicts the
// job gets, and each one is a single named call.
// ---------------------------------------------------------------------------

function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '\n').split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
}

function catchBlockOf(runner: string): string {
  const at = runner.lastIndexOf('} catch (e) {')
  assert.notEqual(at, -1, 'the runner must have a top-level catch')
  return runner.slice(at, runner.indexOf('result.failed++\n    }', at))
}

test('Codex r2 HIGH: neither runner feeds an unwritten record back into the ordinary retry', async () => {
  const src = strip(readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8'))
  const direct = src.slice(
    src.indexOf('async function processPendingXeroSyncDirect('),
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
  )
  const outbox = src.slice(
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
    src.indexOf('async function guardCancelledSalesOrderInvoice('),
  )

  for (const [name, runner] of [['direct', direct], ['outbox', outbox]] as const) {
    const caught = catchBlockOf(runner)
    const guardAt = caught.indexOf('e instanceof PostedDocumentEvidenceUnwritten')
    assert.notEqual(guardAt, -1, `the ${name} runner must recognise an unwritten record`)
    assert.ok(
      guardAt < caught.indexOf('isRateLimitError('),
      `the ${name} runner must decide that BEFORE the ordinary failure handling, or the identifier is `
        + 'handed to a retry that settles the row and reports success',
    )
    const branch = caught.slice(guardAt, caught.indexOf('continue', guardAt))
    assert.ok(!branch.includes('applyMainSyncFailureRetry('), `${name}: must not schedule an ordinary retry`)
    assert.ok(!branch.includes('releaseClaimForRetry('), `${name}: must not give the row back`)
    assert.ok(branch.includes('escalateUnwrittenPostedEvidence(e)'), `${name}: must escalate out of band`)
    if (name === 'outbox') {
      assert.ok(
        branch.includes('buryOutboxJobForUnwrittenPostedEvidence(job, e, recordFiled)'),
        'the outbox job is buried with the wording that names both documents — burying is what stops '
          + 'the retry from completing it as a success — and through the helper that does not ASSUME '
          + 'the burial happened (Codex r3, HIGH)',
      )
      assert.ok(!branch.includes('markXeroOutboxRetry('), 'a retry here erases the incident')
      assert.ok(!branch.includes('markXeroOutboxSuccess('), 'and completing it is worse')
    }
  }
})


test('Codex r3 HIGH: the settled-replay short-circuit reads the record before it completes anything', async () => {
  // The one line a failed burial delivers the job to. It cannot ask the process that failed — that
  // process is gone — so it asks the store, and a job whose row has an incident filed against it is
  // buried with that wording instead of completed.
  const src = strip(readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8'))
  const outbox = src.slice(
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
    src.indexOf('async function guardCancelledSalesOrderInvoice('),
  )
  const shortCircuitAt = outbox.indexOf("if (entry.status === 'SYNCED' && entry.externalTransactionId) {")
  assert.notEqual(shortCircuitAt, -1, 'the settled-replay short-circuit must still exist')
  const block = outbox.slice(shortCircuitAt, outbox.indexOf('const claimedAt', shortCircuitAt))

  assert.ok(
    block.includes('completeSettledOutboxJobUnlessIncidentFiled(job, entry.id)'),
    'it must go through the one function that asks the store before it completes anything',
  )
  assert.ok(
    !block.includes('markXeroOutboxSuccess(job)'),
    'and must not complete the job itself, or the question can be skipped at this door alone',
  )
  assert.ok(
    !outbox.includes('findUnrecordedPostedDocumentEvidenceFor(entries'),
    'THE BATCH SNAPSHOT IS GONE (Codex r4, HIGH): a read taken before the run makes its first Xero call '
      + 'cannot contain an incident a CONCURRENT worker files during it, so the door it guarded reopened '
      + 'under exactly the concurrency the fence exists for',
  )
  assert.ok(
    !outbox.includes('unrecordedPostedDocuments'),
    'and no per-batch Map survives for a later change to start consulting again',
  )
})

test('Codex r3 HIGH: the claim-failure branch does not complete a settled job with an incident on it either', async () => {
  // The second door. A job whose row was settled BETWEEN the batch read and the claim lands here, and
  // that window is exactly when a displaced worker files its conflict.
  const src = strip(readFileSync(join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8'))
  const outbox = src.slice(
    src.indexOf('async function processPendingXeroSyncViaOutbox('),
    src.indexOf('async function guardCancelledSalesOrderInvoice('),
  )
  const branchAt = outbox.indexOf('const liveStatus = fresh?.status ?? entry.status')
  assert.notEqual(branchAt, -1, 'the claim-failure branch must still exist')
  const block = outbox.slice(branchAt, outbox.indexOf('result.processed++', branchAt))

  assert.ok(
    block.includes('completeSettledOutboxJobUnlessIncidentFiled(job, entry.id)'),
    'the second door asks through the SAME function as the first, not through a second spelling of the '
      + 'same question',
  )
  assert.ok(
    !block.includes('markXeroOutboxSuccess(job)'),
    'and never completes a settled job itself',
  )
  // CANCELLED goes through it too (Codex r4). A row can be retired while a worker is on the wire, and
  // that worker's refusal is filed against a row whose live status is CANCELLED.
  const cancelledAt = block.indexOf("liveStatus === 'CANCELLED'")
  assert.notEqual(cancelledAt, -1)
  assert.ok(
    cancelledAt < block.indexOf('completeSettledOutboxJobUnlessIncidentFiled('),
    'CANCELLED is inside the branch that asks, not a separate branch that completes unasked',
  )
  assert.ok(
    !block.slice(0, cancelledAt).includes('markXeroOutboxSuccess('),
    'and nothing completes a job before the CANCELLED case reaches the question',
  )
})

// ---------------------------------------------------------------------------
// Codex r4, HIGH — A SNAPSHOT CANNOT SEE AN INCIDENT A CONCURRENT WORKER FILED.
//
// Round 3 closed both doors by reading the filed incidents ONCE, before the loop. The incident those
// doors exist for is filed by a DIFFERENT worker, mid-run, while it is on the wire — after the snapshot
// was taken. So the guard answered "nothing on file" for a row that had an incident on file, and the
// door reopened under exactly the concurrency the fence was built for.
//
// These drive two real workers through one shared store: worker A is `recordPostedDocumentDurably`, the
// production path that files the incident, and worker B is the settled-job door. Only the INSTANT A
// runs differs between them.
// ---------------------------------------------------------------------------

test('Codex r4 HIGH: two workers — an incident filed AFTER an earlier job was answered still buries the next', async () => {
  const { recordPostedDocumentDurably, completeSettledOutboxJobUnlessIncidentFiled } = await loadProcessor()
  reset()

  // t0 — the FIRST settled job for this row is answered "nothing on file", and it is answered
  // correctly. Round 3 kept that answer for the whole batch; this is the read it kept.
  const first = await completeSettledOutboxJobUnlessIncidentFiled(job(), 'log-1')
  assert.equal(first.verdict, 'COMPLETED')

  // t1 — worker A comes back from Xero holding INV-XERO-SECOND, finds the row naming INV-XERO-FIRST,
  // and files the incident. A different process; nothing in this run's memory changes.
  const filedByA = await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {})
  assert.equal(filedByA.recorded, false, 'the premise: A could not record its document')

  // t2 — a SECOND job for the same sync row reaches the same door. Duplicate outbox jobs for one sync
  // log are the ordinary case this fence was written for, and under a batch answer this one is decided
  // from a read taken before the incident existed.
  const second = await completeSettledOutboxJobUnlessIncidentFiled(secondJob(), 'log-1')

  assert.equal(second.verdict, 'BURIED', 'the job must not be completed while a document is unaccounted for')
  assert.match(second.verdict === 'BURIED' ? second.evidence : '', /INV-XERO-SECOND/)
  assert.equal(control.outboxWrites.length, 2, 'the first job completed, the second was buried')
  assert.equal(control.outboxWrites[0].data.status, 'SUCCEEDED')
  assert.equal(
    control.outboxWrites[1].data.status,
    'PERMANENT_FAILED',
    'and the second is the burial, not a completion — a completion is how the identifier disappears',
  )
  assert.match(String(control.outboxWrites[1].data.lastError), /INV-XERO-SECOND/, 'carrying both ids into the job')
  assert.match(String(control.outboxWrites[1].data.lastError), /INV-XERO-FIRST/)
})

test('Codex r4 HIGH: two workers — an incident filed DURING the completion write RETRACTS it', async () => {
  // The residual window of "read it fresh": the read says nothing, and A's insert lands before the
  // completion is written. The hook makes A run at exactly that instant, which no assertion about a
  // return value could reach.
  const { recordPostedDocumentDurably, completeSettledOutboxJobUnlessIncidentFiled } = await loadProcessor()
  reset()
  control.onOutboxWrite = async () => { await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {}) }

  const verdict = await completeSettledOutboxJobUnlessIncidentFiled(job(), 'log-1')

  assert.equal(verdict.verdict, 'RETRACTED')
  assert.equal(control.outboxWrites.length, 2, 'the completion, and then the retraction of it')
  assert.equal(control.outboxWrites[0].data.status, 'SUCCEEDED', 'the read really did say nothing was on file')
  assert.equal(control.outboxWrites[1].data.status, 'PERMANENT_FAILED')
  assert.equal(
    (control.outboxWrites[1].where as Record<string, unknown>).status,
    'SUCCEEDED',
    'the retraction is fenced on the row it just completed, not on a claim it no longer holds',
  )
  assert.match(String(control.outboxWrites[1].data.lastError), /INV-XERO-SECOND/)
})

test('Codex r4 HIGH: a settled job with nothing on file is completed, and nothing is retracted', async () => {
  // The counter-guard. If the door buried on anything but a filed incident, every ordinary replay of
  // settled work would become a PERMANENT_FAILED job.
  const { completeSettledOutboxJobUnlessIncidentFiled } = await loadProcessor()
  reset()

  const verdict = await completeSettledOutboxJobUnlessIncidentFiled(job(), 'log-1')

  assert.equal(verdict.verdict, 'COMPLETED')
  assert.equal(control.outboxWrites.length, 1)
  assert.equal(control.outboxWrites[0].data.status, 'SUCCEEDED')
  assert.equal(control.pooledReads.length, 2, 'asked before the write and again after it')
})

test('Codex r4 HIGH: an incident whose transaction ROLLED BACK does not bury anything', async () => {
  // The other counter-guard, and it is the one the shared store makes possible: an insert that happened
  // but did not commit must be invisible to the reader, exactly as in Postgres. If the double let it
  // stand, the fixed code would bury a job on evidence that does not exist.
  const { recordPostedDocumentDurably, completeSettledOutboxJobUnlessIncidentFiled } = await loadProcessor()
  reset()
  control.commitFailures = Number.MAX_SAFE_INTEGER

  await recordPostedDocumentDurably(ENTRY, 'INV-XERO-SECOND', {}).catch(() => undefined)
  const verdict = await completeSettledOutboxJobUnlessIncidentFiled(job(), 'log-1')

  assert.equal(verdict.verdict, 'COMPLETED', 'nothing committed, so nothing is on file')
})
