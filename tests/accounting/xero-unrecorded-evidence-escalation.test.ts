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
const control = { activityFailures: 0, transactions: 0, activityWrites: [] as Array<Record<string, unknown>>, rowUpdateFails: false }

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

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => {
        control.transactions++
        return fn(tx)
      },
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
        branch.includes('markXeroOutboxPermanent(job, e.operatorMessage)'),
        'the outbox job is buried with the wording that names both documents — burying is what stops '
          + 'the retry from completing it as a success',
      )
      assert.ok(!branch.includes('markXeroOutboxRetry('), 'a retry here erases the incident')
      assert.ok(!branch.includes('markXeroOutboxSuccess('), 'and completing it is worse')
    }
  }
})
