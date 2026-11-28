import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * IMS'S OWN XERO CALL-BUDGET REFUSAL (day cap / minute cap) IS HANDED BACK, NOT FAILED - THROUGH THE REAL PROCESSOR OVER A REAL DATABASE.
 *
 * Only the transports are mocked, and they answer with the refusal text the real limiter writes (describeLocalBudgetRefusal): nothing contacts Xero.
 * Two paths: a manual journal (the daily-batch / COGS family, which hands back through the `transport-refused` hand-back) and a tax-rate sync (the
 * generic returned-error path that sales invoices, credit notes, bills and payments also take). Each is drained MORE times than MAX_RETRIES, on the outbox
 * runner (the default) and the direct runner: no retry may be spent, the row is never FAILED and the job never dead-lettered, and the row's next attempt
 * is the computed wait, not "now" (no hot loop). Once the window has passed (the mock lets the post through) the same row posts.
 *
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/xero-local-budget-deferral.test.ts would have been skipped.')
}

const TODAY = new Date().toISOString().slice(0, 10)
const DRAINS = 7
const WAIT_MS = 2 * 3_600_000
let refuse = true
let calls = 0

let loaded: Awaited<ReturnType<typeof load>> | null = null
async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { describeLocalBudgetRefusal } = await import('../../lib/connectors/xero/deferral.ts')
  const refusalText = () => `Xero day budget exhausted for this tenant: 950 calls used. ${describeLocalBudgetRefusal('day', WAIT_MS)}`
  const journals = await import('../../lib/connectors/xero/journals.ts')
  mock.module('../../lib/connectors/xero/journals.ts', {
    namedExports: {
      ...journals,
      postPreparedManualJournal: async () => {
        calls += 1
        if (refuse) return { success: false, error: refusalText(), reachedTheWire: false, notSent: 'rate-budget-refused' }
        return { success: true, journalId: `J-${randomUUID()}`, reachedTheWire: true }
      },
    },
  })
  const taxRates = await import('../../lib/connectors/xero/tax-rates.ts')
  mock.module('../../lib/connectors/xero/tax-rates.ts', {
    namedExports: {
      ...taxRates,
      putXeroTaxRate: async () => {
        calls += 1
        return refuse ? { success: false, error: refusalText() } : { success: true, taxType: `TT-${randomUUID().slice(0, 6)}` }
      },
    },
  })
  const [{ db }, processor] = await Promise.all([import('../../lib/db/index.ts'), import('../../lib/connectors/xero/sync-processor.ts')])
  return { db, processor }
}
async function deps() { return (loaded ??= await load()) }
type Deps = Awaited<ReturnType<typeof deps>>

const tagOf = () => `xlb${randomUUID().slice(0, 8)}`

async function seed(d: Deps, referenceId: string, kind: 'journal' | 'taxrate') {
  return d.db.accountingSyncLog.create({
    data: kind === 'journal'
      ? {
        connector: 'xero', type: 'COGS_JOURNAL', status: 'PENDING', referenceType: 'LocalBudgetProbe', referenceId,
        payload: { date: TODAY, narration: referenceId, lines: [{ description: 'Inventory', accountCode: '630', debit: 16 }, { description: 'Allocated Inventory', accountCode: '631', credit: 16 }] },
        attemptStampingCustodyAt: new Date(),
      }
      : {
        connector: 'xero', type: 'TAX_RATE_SYNC', status: 'PENDING', referenceType: 'LocalBudgetProbe', referenceId,
        payload: { name: referenceId, components: [{ name: 'VAT', rate: 20, compoundOnPrevious: false }] },
        attemptStampingCustodyAt: new Date(),
      },
    select: { id: true },
  } as never) as Promise<{ id: string }>
}

async function cleanup(d: Deps, prefix: string) {
  const rows = await d.db.accountingSyncLog.findMany({ where: { referenceId: { startsWith: prefix } }, select: { id: true } })
  for (const row of rows) await d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: row.id } } }).catch(() => undefined)
  await d.db.accountingEvent.deleteMany({ where: { sourceEntityId: { startsWith: prefix } } }).catch(() => undefined)
  await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { startsWith: prefix } } }).catch(() => undefined)
  await d.db.accountingSyncLog.deleteMany({ where: { referenceId: { startsWith: prefix } } })
}

const syncOf = (d: Deps, id: string) => d.db.accountingSyncLog.findUnique({ where: { id }, select: { status: true, retryCount: true, processingStartedAt: true, externalTransactionId: true, errorMessage: true } })
const jobOf = (d: Deps, id: string) => d.db.integrationOutbox.findFirst({ where: { connector: 'xero', idempotencyKey: { contains: id } }, select: { status: true, attempts: true, nextAttemptAt: true, lockedAt: true } })

async function dueNow(d: Deps, id: string) {
  await d.db.accountingSyncLog.updateMany({ where: { id, status: 'PENDING', processingStartedAt: { not: null } }, data: { processingStartedAt: new Date(Date.now() - 1000) } })
  await d.db.integrationOutbox.updateMany({ where: { connector: 'xero', idempotencyKey: { contains: id } }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
}

for (const outbox of ['true', 'false']) {
  for (const kind of ['journal', 'taxrate'] as const) {
    test(`LOCAL BUDGET REFUSAL, ${kind}, outbox runner ${outbox}: ${DRAINS} drains spend no retry, never FAIL the row, wait the computed time; once the window passes the row posts`, { skip }, async (t) => {
      const d = await deps()
      const tag = tagOf()
      const saved = process.env.XERO_ACCOUNTING_OUTBOX_ENABLED
      process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = outbox
      t.after(async () => { if (saved === undefined) delete process.env.XERO_ACCOUNTING_OUTBOX_ENABLED; else process.env.XERO_ACCOUNTING_OUTBOX_ENABLED = saved; await cleanup(d, tag) })
      refuse = true
      calls = 0
      const row = await seed(d, `${tag}-a`, kind)
      for (let drain = 1; drain <= DRAINS; drain++) {
        const before = Date.now()
        const run = await d.processor.processPendingXeroSync()
        if (drain === 1) console.log('# run', JSON.stringify(run))
        const sync = await syncOf(d, row.id)
        assert.equal(sync?.retryCount, 0, `drain ${drain}: no retry spent`)
        assert.equal(sync?.status, 'PENDING', `drain ${drain}: never FAILED, never left PROCESSING (${sync?.errorMessage})`)
        const job = await jobOf(d, row.id)
        if (outbox === 'true') {
          assert.ok(job, `drain ${drain}: there is a job, so the job assertions are about a real queue`)
          assert.equal(job.attempts, 0, `drain ${drain}: no job attempt spent`)
          assert.notEqual(job.status, 'PERMANENT_FAILED')
        }
        // The row's gate is a FUTURE processingStartedAt on the PENDING row (releaseClaimForRetry), or the job's own next attempt on the outbox runner.
        const gate = outbox === 'true' ? (job?.nextAttemptAt?.getTime() ?? 0) : (sync?.processingStartedAt?.getTime() ?? 0)
        assert.ok(gate - before >= WAIT_MS - 1000, `drain ${drain}: waits for calls to fall out of the window, not "now" (waits ${gate - before} ms)`)
        await dueNow(d, row.id)
      }
      assert.ok(calls >= DRAINS, `PRECONDITION: the transport was reached on each drain (${calls}), so "nothing spent" is not vacuous`)

      // THE WINDOW HAS PASSED: the limiter lets the post through and the same row goes out.
      refuse = false
      await d.processor.processPendingXeroSync()
      const sync = await syncOf(d, row.id)
      assert.equal(sync?.status, 'SYNCED')
      assert.ok(sync?.externalTransactionId)
    })
  }
}
