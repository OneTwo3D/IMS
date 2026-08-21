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
   * How many COMMITS fail, after a callback that did everything right (Codex r3, HIGH). This is the
   * failure round 3 did not model: a deadlock victim, a serialization failure, a connection lost at
   * COMMIT. The double rolls the writes back when it fires, because a double that let them stand would
   * let the broken code look like it had preserved something.
   */
  commitFailures: 0,
  /** Writes that went through the POOLED client — i.e. outside any transaction. */
  pooledWrites: [] as Array<Record<string, unknown>>,
  pooledWriteFails: false,
  /** Rows the pooled reader will answer with. */
  pooledRows: [] as Array<{ entityId: string | null; description: string; createdAt: Date }>,
  pooledReads: [] as Array<Record<string, unknown>>,
  /** Outbox burial: how many updateMany calls throw before one succeeds, and how many were made. */
  outboxFailures: 0,
  outboxAttempts: 0,
  outboxUpdatedCount: 1,
  consoleErrors: [] as string[],
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
    if (control.rowUpdateFails) throw new Error('accounting_sync_logs update failed')
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
    return data
  },
}

// The mirror delegates answer NOTHING FOUND, which is their own "no event to update" path. This file is
// about which record survives a failed write, and a half-built mirror event would only add noise.
const tx = new Proxy({ accountingSyncLog }, {
  get(_target, prop: string) {
    if (prop === 'accountingSyncLog') return accountingSyncLog
    if (prop === 'activityLog') return activityLog
    return new Proxy({}, {
      get: (_t, method: string) => async () => (method === 'findMany' ? [] : null),
    })
  },
})

const pooledActivityLog = {
  create: async ({ data }: { data: Record<string, unknown> }) => {
    if (control.pooledWriteFails) throw new Error('pooled activity_log insert failed')
    control.pooledWrites.push(data)
    return data
  },
  findMany: async ({ where }: { where: Record<string, unknown> }) => {
    control.pooledReads.push(where)
    const ids = (where.entityId as { in?: string[] } | undefined)?.in ?? []
    return control.pooledRows.filter((row) => row.entityId && ids.includes(row.entityId))
  },
}

const pooledIntegrationOutbox = {
  updateMany: async () => {
    control.outboxAttempts++
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
        const value = await fn(tx)
        if (control.commitFailures > 0) {
          control.commitFailures--
          control.activityWrites.length = writtenBefore
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
  control.commitFailures = 0
  control.pooledWrites = []
  control.pooledWriteFails = false
  control.pooledRows = []
  control.pooledReads = []
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

test('Codex r3 HIGH: the reclaim reader answers with the recorded incident, per sync row', async () => {
  const { findUnrecordedPostedDocumentEvidence } = await loadProcessor()
  const { UNRECORDED_POSTED_DOCUMENT_ACTION } = await import('@/lib/domain/accounting/unrecorded-posted-document')
  reset()
  control.pooledRows = [
    { entityId: 'log-1', description: 'INV-XERO-SECOND was posted and cannot be recorded', createdAt: new Date() },
  ]

  const found = await findUnrecordedPostedDocumentEvidence(['log-1', 'log-2'])

  assert.equal(found.get('log-1'), 'INV-XERO-SECOND was posted and cannot be recorded')
  assert.equal(found.get('log-2'), undefined, 'a row with no incident is completed as before')
  assert.equal(control.pooledReads.length, 1, 'one read for the whole batch, not one per job')
  assert.equal(control.pooledReads[0].action, UNRECORDED_POSTED_DOCUMENT_ACTION)
  assert.equal(control.pooledReads[0].entityType, 'SYSTEM', 'so it lands on the (entityType, entityId) index')

  assert.equal((await findUnrecordedPostedDocumentEvidence([])).size, 0)
  assert.equal(control.pooledReads.length, 1, 'and an empty batch asks nothing')
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

  const guardAt = block.indexOf('unrecordedPostedDocuments.get(entry.id)')
  assert.notEqual(guardAt, -1, 'it must consult the recorded incident at all')
  assert.ok(
    guardAt < block.indexOf('markXeroOutboxSuccess(job)'),
    'and BEFORE completing the job, or the incident is converted into a success exactly as it was',
  )
  assert.ok(
    block.slice(guardAt, block.indexOf('markXeroOutboxSuccess(job)')).includes('markXeroOutboxPermanent(job,'),
    'a job with an incident on its row is buried, not completed',
  )
  assert.ok(
    outbox.indexOf('findUnrecordedPostedDocumentEvidence(') < shortCircuitAt,
    'read once for the batch, before the loop, not once per settled job',
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

  const guardAt = block.indexOf('unrecordedPostedDocuments.get(entry.id)')
  assert.notEqual(guardAt, -1, 'it must consult the recorded incident')
  assert.ok(
    guardAt < block.indexOf('markXeroOutboxSuccess(job)'),
    'and before completing the job, or a settled row with a filed incident is reported as a success',
  )

  // And an incident filed DURING this run has to reach the batch answer, or the second job for the same
  // row is decided from a read taken before the incident existed.
  for (const site of outbox.split('if (!record.recorded) {').slice(1)) {
    const decided = site.slice(0, site.indexOf('continue'))
    assert.ok(
      decided.indexOf('unrecordedPostedDocuments.set(entry.id, record.evidence)') !== -1
        && decided.indexOf('unrecordedPostedDocuments.set(entry.id, record.evidence)') < decided.indexOf('markXeroOutboxPermanent('),
      'every in-line burial records the incident in the batch answer before burying',
    )
  }
})
