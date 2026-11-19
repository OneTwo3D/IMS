import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * A ROW THE PRODUCER-SIDE HOLD IS WAITING ON (the owner's confirmation that an incumbent writer has stopped) IS HANDED BACK UNSENT, AND SPENDS NOTHING.
 *
 * The drains used to claim the row (and its outbox job) and only then ask whether the owner had confirmed. The hand-back went through the failure path, which counts an
 * attempt, so five ticks inside the window between the live-from instant and the confirmation (or the first tick after a restart, before the confirmation is read)
 * dead-lettered every step-X job, and a claimed sync-log row was left PROCESSING. This file drives the REAL drains over a REAL database, with the outbox runner enabled
 * (the default), the direct runner, and the WooCommerce stock and invoice-document drains. Only the transports are mocked: nothing contacts Xero or WooCommerce.
 *
 * Each case is run in the three states of the confirmation: absent, unknown (never read: the first tick after a restart) and recorded (the control that the same
 * row then goes out). GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * Named mutations (shown red in the PR, restored from a copy):
 *  a  claim-before-the-ask        the outbox runner's pre-claim ask is removed and the post-claim hand-back is sent through the failure path: attempts rise
 *  b  direct-runner-claims        the direct runner's pre-claim ask and the held-type selection filter are removed: the row is left PROCESSING
 *  c  stock-held-spends           the stock drain's held branch is removed: a push refused after the claim spends an attempt
 *  d  hand-back-no-delay          the producer-held hand-back defers by 0 instead of PRODUCER_HELD_RETRY_DELAY_MS
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/producer-held-drain.test.ts would have been skipped.')
}

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const ENV_KEYS = [
  'PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM',
  'WC_WRITEBACK_ALLOWED_ORIGIN', 'WC_WRITES_LIVE_FROM', 'MINTSOFT_WRITE_ALLOWED', 'MINTSOFT_WRITES_LIVE_FROM', 'XERO_ACCOUNTING_OUTBOX_ENABLED',
]
const DAY = 86_400_000
const CUTOFF = new Date(Date.now() - DAY)
const LIVE_FROM = CUTOFF.toISOString().replace(/\.\d+Z$/, 'Z')
const TODAY = new Date().toISOString().slice(0, 10)
const xeroLive = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: LIVE_FROM }
const wcLive = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: LIVE_FROM }
const STOCK_ATTESTATION = 'qoblex-stock-push-stopped'
const XERO_ATTESTATION = 'qoblex-xero-stopped'
const DRAINS = 7

const posted: string[] = []
const pushed: string[] = []
let stockPushOutcome: 'ok' | 'held' = 'ok'

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const key of ENV_KEYS) delete process.env[key]
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value
  }
}

let loaded: Awaited<ReturnType<typeof load>> | null = null
async function load() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  // THE TRANSPORTS ARE THE ONLY THING MOCKED. Each is replaced after the real module has been read, and BEFORE the module that imports it is first loaded.
  const journals = await import('../../lib/connectors/xero/journals.ts')
  mock.module('../../lib/connectors/xero/journals.ts', {
    namedExports: {
      ...journals,
      postPreparedManualJournal: async (_prepared: unknown, options: { idempotencyKey: string }) => {
        posted.push(options.idempotencyKey)
        return { success: true, journalId: `J-${randomUUID()}`, reachedTheWire: true }
      },
    },
  })
  const stockSync = await import('../../lib/connectors/woocommerce/sync/stock-sync.ts')
  const { producerHeldNotice } = await import('../../lib/security/producer-disposition-constants.ts')
  mock.module('../../lib/connectors/woocommerce/sync/stock-sync.ts', {
    namedExports: {
      ...stockSync,
      pushStockToWc: async (options: { productIds?: string[] }) => {
        pushed.push(...(options.productIds ?? []))
        if (stockPushOutcome === 'held') {
          const message = producerHeldNotice({ connector: 'woocommerce', reason: 'attestation_missing', owner: 'qoblex-native' })
          return { synced: 0, failed: 0, errors: [message], message, held: true }
        }
        return { synced: 1, failed: 0, errors: [] }
      },
    },
  })
  const [{ db }, processor, outbox, stockJobs, invoiceJobs, snapshot, constants, seam] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
    import('../../lib/domain/integrations/outbox.ts'),
    import('../../lib/connectors/woocommerce/sync/stock-sync-jobs.ts'),
    import('../../lib/connectors/woocommerce/sync/invoice-document-jobs.ts'),
    import('../../lib/security/writer-attestation-snapshot.ts'),
    import('../../lib/security/producer-disposition-constants.ts'),
    import('../../lib/domain/accounting/xero-producer-seam.ts'),
  ])
  return { db, processor, outbox, stockJobs, invoiceJobs, snapshot, constants, seam }
}
async function deps() { return (loaded ??= await load()) }
type Deps = Awaited<ReturnType<typeof deps>>

const tagOf = () => `phd${randomUUID().slice(0, 8)}`

/** The three states the owner's confirmation can be in, as the write paths see them. */
function setAttestation(d: Deps, state: 'absent' | 'unknown' | 'present', kind: string): void {
  if (state === 'unknown') d.snapshot.setAttestationSnapshot(null)
  else d.snapshot.setAttestationSnapshot(state === 'present' ? new Set([kind]) : new Set())
}

async function seedXeroRow(d: Deps, referenceId: string, type = 'COGS_JOURNAL') {
  return d.db.accountingSyncLog.create({
    data: {
      connector: 'xero', type, status: 'PENDING', referenceType: 'ProducerHeldProbe', referenceId,
      payload: { date: TODAY, narration: referenceId, lines: [{ description: 'Inventory', accountCode: '630', debit: 16 }, { description: 'Allocated Inventory', accountCode: '631', credit: 16 }] },
      attemptStampingCustodyAt: new Date(),
    } as never,
    select: { id: true },
  })
}

async function cleanupXero(d: Deps, prefix: string) {
  const rows = await d.db.accountingSyncLog.findMany({ where: { referenceId: { startsWith: prefix } }, select: { id: true } })
  for (const row of rows) await d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: row.id } } }).catch(() => undefined)
  await d.db.accountingEvent.deleteMany({ where: { sourceEntityId: { startsWith: prefix } } }).catch(() => undefined)
  await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { startsWith: prefix } } })
  await d.db.accountingSyncLog.deleteMany({ where: { referenceId: { startsWith: prefix } } })
}

const outboxOf = (d: Deps, syncLogId: string) => d.db.integrationOutbox.findFirst({
  where: { connector: 'xero', idempotencyKey: { contains: syncLogId } },
  select: { id: true, status: true, attempts: true, nextAttemptAt: true, lockedAt: true, lastError: true },
})
const syncOf = (d: Deps, id: string) => d.db.accountingSyncLog.findUnique({ where: { id }, select: { status: true, retryCount: true, processingStartedAt: true, externalTransactionId: true } })

/** One tick later: the job's back-off has run out. */
async function tickLater(d: Deps, syncLogId: string) {
  await d.db.integrationOutbox.updateMany({ where: { connector: 'xero', idempotencyKey: { contains: syncLogId } }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
}

// ───────────────────────────────────── Xero: the outbox runner (the default) ─────────────────────────────────────

for (const state of ['absent', 'unknown'] as const) {
  test(`XERO OUTBOX RUNNER, confirmation ${state}: ${DRAINS} drains spend NO attempt, claim NOTHING and never dead-letter; once recorded the next drain posts the row`, { skip }, async (t) => {
    const d = await deps()
    const tag = tagOf()
    t.after(() => cleanupXero(d, tag))
    posted.length = 0
    const row = await seedXeroRow(d, `${tag}-a`)
    const other = await seedXeroRow(d, `${tag}-b`, 'DAILY_BATCH_GROUP_B')
    await withEnv({ ...xeroLive, XERO_ACCOUNTING_OUTBOX_ENABLED: 'true' }, async () => {
      setAttestation(d, state, XERO_ATTESTATION)
      const hold = d.seam.xeroRowDeliveryHold({ type: 'COGS_JOURNAL' })
      assert.notEqual(hold, null, `PRECONDITION: with the confirmation ${state} this row's delivery is held, so "nothing spent" below is not vacuous`)
      for (let drain = 1; drain <= DRAINS; drain++) {
        await d.processor.processPendingXeroSync()
        for (const id of [row.id, other.id]) {
          const job = await outboxOf(d, id)
          const sync = await syncOf(d, id)
          assert.ok(job, `drain ${drain}: the row has an outbox job, so the assertions below are about a real queue`)
          assert.equal(job.attempts, 0, `drain ${drain}: no attempt spent`)
          assert.notEqual(job.status, 'PERMANENT_FAILED', `drain ${drain}: never dead-lettered`)
          assert.equal(job.status, 'PENDING', `drain ${drain}: left out of the candidate query, so untouched and still due`)
          assert.equal(job.lockedAt, null, `drain ${drain}: the job is not left claimed`)
          assert.equal(sync?.status, 'PENDING', `drain ${drain}: the sync-log row was never claimed`)
          assert.equal(sync?.processingStartedAt, null, `drain ${drain}: and never stamped as processing`)
          assert.equal(sync?.retryCount, 0)
        }
        await tickLater(d, row.id)
        await tickLater(d, other.id)
      }
      assert.deepEqual(posted, [], 'nothing was sent while the confirmation was missing')

      // THE OWNER RECORDS THE CONFIRMATION: one drain releases the work.
      setAttestation(d, 'present', XERO_ATTESTATION)
      await d.processor.processPendingXeroSync()
      const job = await outboxOf(d, row.id)
      const sync = await syncOf(d, row.id)
      console.log(`# ${state}: after the confirmation job=${job?.status} attempts=${job?.attempts} sync=${sync?.status} posted=${posted.length}`)
      assert.equal(job?.status, 'SUCCEEDED')
      assert.equal(job?.attempts, 0)
      assert.equal(sync?.status, 'SYNCED')
      assert.ok(sync?.externalTransactionId, 'the (mocked) transport was reached and its answer recorded')
      assert.equal(posted.length >= 1, true)
    })
  })
}

test('XERO DIRECT RUNNER (outbox disabled): a held row is not claimed and not attempted, however many drains; once recorded the next drain posts it', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupXero(d, tag))
  posted.length = 0
  const row = await seedXeroRow(d, `${tag}-direct`)
  await withEnv({ ...xeroLive, XERO_ACCOUNTING_OUTBOX_ENABLED: 'false' }, async () => {
    for (const state of ['absent', 'unknown'] as const) {
      setAttestation(d, state, XERO_ATTESTATION)
      assert.notEqual(d.seam.xeroRowDeliveryHold({ type: 'COGS_JOURNAL' }), null, `PRECONDITION: held while ${state}`)
      for (let drain = 1; drain <= DRAINS; drain++) {
        await d.processor.processPendingXeroSync()
        const sync = await syncOf(d, row.id)
        assert.equal(sync?.status, 'PENDING', `${state}, drain ${drain}: not left PROCESSING`)
        assert.equal(sync?.retryCount, 0, `${state}, drain ${drain}: no retry spent`)
        assert.equal(sync?.processingStartedAt, null)
      }
    }
    assert.deepEqual(posted, [])
    setAttestation(d, 'present', XERO_ATTESTATION)
    await d.processor.processPendingXeroSync()
    const sync = await syncOf(d, row.id)
    assert.equal(sync?.status, 'SYNCED')
    assert.equal(posted.length, 1)
  })
})

test('XERO DIRECT RUNNER: held rows do not fill the bounded batch and starve the rows behind them (the selection leaves the held types out)', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupXero(d, tag))
  const types = await withEnv(xeroLive, async () => {
    setAttestation(d, 'absent', XERO_ATTESTATION)
    return d.seam.xeroHeldDeliveryTypes()
  })
  console.log(`# held types with the confirmation absent: ${types.join(',')}`)
  assert.ok(types.includes('COGS_JOURNAL' as never), 'step-X journals are among them')
  assert.equal(types.includes('INVOICE_PDF' as never), false, 'a PDF fetch is no destination write and is never held')
  await withEnv(xeroLive, async () => {
    setAttestation(d, 'present', XERO_ATTESTATION)
    const stillHeld = d.seam.xeroHeldDeliveryTypes()
    // Types of a step that is not live at all (step M here) stay held for THAT reason; the confirmation is what releases the step-X ones.
    assert.equal(stillHeld.includes('COGS_JOURNAL' as never), false, 'CONTROL: with the confirmation recorded the step-X journal is released')
    assert.ok(stillHeld.length < types.length, 'CONTROL: and fewer types are held')
  })
})

test('XERO POST-CLAIM HAND-BACK of a producer-held row (the confirmation went away between the ask and the claim): the claim is released and the job deferred by a short fixed delay with NO attempt spent', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupXero(d, tag))
  const { claimHeldFrom } = await import('../../lib/domain/accounting/sync-claim-fence.ts')
  const row = await seedXeroRow(d, `${tag}-race`)
  const claimedAt = new Date()
  await d.db.accountingSyncLog.update({ where: { id: row.id }, data: { status: 'PROCESSING', processingStartedAt: claimedAt, attemptRevision: 1 } })
  const job = await d.db.integrationOutbox.create({
    data: {
      connector: 'xero', operation: 'post_accounting_event', idempotencyKey: `xero:accounting.post:${row.id}`, payloadJson: { accountingSyncLogId: row.id },
      status: 'PROCESSING', attempts: 0, lockedAt: claimedAt, lockedBy: 'xero-accounting-sync', attemptHistoryTracked: true,
    } as never,
  })
  const message = d.constants.producerHeldNotice({ connector: 'xero', reason: 'attestation_missing', owner: 'qoblex-native' })
  const before = Date.now()
  await d.db.$transaction((tx) => d.processor.recordAndReleaseUnsentTransportRefusal(tx as never, {
    entry: { id: row.id, type: 'COGS_JOURNAL' },
    notPosted: { reason: 'producer-held', operation: 'COGS_JOURNAL', message },
    lease: claimHeldFrom(claimedAt),
    attempt: { id: row.id, attemptRevision: 1 },
    job: job as never,
  }))
  const sync = await syncOf(d, row.id)
  const after = await d.db.integrationOutbox.findUnique({ where: { id: job.id }, select: { status: true, attempts: true, nextAttemptAt: true, lockedAt: true } })
  assert.equal(sync?.status, 'PENDING', 'the claim is released: the row is not left PROCESSING')
  assert.equal(sync?.retryCount, 0)
  assert.equal(after?.status, 'RETRYABLE_FAILED')
  assert.equal(after?.attempts, 0, 'no attempt spent')
  assert.equal(after?.lockedAt, null)
  const delay = (after!.nextAttemptAt as Date).getTime() - before
  assert.ok(delay >= d.constants.PRODUCER_HELD_RETRY_DELAY_MS - 1000 && delay <= d.constants.PRODUCER_HELD_RETRY_DELAY_MS + 30_000, `deferred by the fixed producer-held delay (was ${delay} ms)`)
})

// ───────────────── Xero outbox runner: held jobs take no slot of the bounded batch, and are offered again once the hold lifts ─────────────────

test('XERO OUTBOX RUNNER: more held jobs than a batch holds, OLDER than a deliverable one, do not take its slot; once the confirmation is recorded the held jobs are picked up', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupXero(d, tag))
  posted.length = 0
  const MAX_PER_RUN = 50
  await withEnv({ ...xeroLive, XERO_ACCOUNTING_OUTBOX_ENABLED: 'true' }, async () => {
    setAttestation(d, 'absent', XERO_ATTESTATION)
    const heldNow = new Set<string>(d.seam.xeroHeldDeliveryTypes())
    // The invoice note writes to WooCommerce, which is not enforced here, so only Xero's step-X confirmation could hold it and it does not.
    const free = heldNow.has('WC_INVOICE_NOTE') ? null : 'WC_INVOICE_NOTE'
    console.log(`# held types=${[...heldNow].join(',')} free=${free}`)
    assert.ok(free, 'PRECONDITION: a queued type the confirmation does not hold exists, so "the deliverable job is reached" is a real contrast')
    const heldRows = []
    for (let i = 0; i < MAX_PER_RUN + 5; i++) heldRows.push(await seedXeroRow(d, `${tag}-held${i}`))
    assert.notEqual(d.seam.xeroRowDeliveryHold({ type: 'COGS_JOURNAL' }), null, 'PRECONDITION: the journals are held')
    const deliverable = await seedXeroRow(d, `${tag}-free`, free)
    // Production queues the job with the row; the drain's own top-up only looks at the oldest MAX_PER_RUN rows, so queue them here as the producers do.
    const { scheduleXeroAccountingOutbox } = await import('../../lib/connectors/xero/outbox.ts')
    for (const row of [...heldRows, deliverable]) await scheduleXeroAccountingOutbox(d.db as never, { accountingSyncLogId: row.id, nextAttemptAt: new Date(Date.now() - 1000), attempts: 0, resetAttempts: true })
    await d.processor.processPendingXeroSync()
    const freeJob = await outboxOf(d, deliverable.id)
    assert.ok(freeJob, 'the deliverable row has a job')
    assert.notEqual(freeJob.status, 'PENDING', 'the deliverable job was reached although more than a batch of OLDER held jobs is queued')
    const heldJobs = await Promise.all(heldRows.map((row) => outboxOf(d, row.id)))
    for (const job of heldJobs) assert.deepEqual([job?.status, job?.attempts, job?.lockedAt], ['PENDING', 0, null], 'a held job is untouched: not claimed, not deferred, no attempt')
    assert.deepEqual(posted, [])

    // THE HOLD LIFTS: the same jobs are offered again with no intervention, and the oldest first.
    setAttestation(d, 'present', XERO_ATTESTATION)
    for (let drain = 0; drain < 3; drain++) await d.processor.processPendingXeroSync()   // a drain takes at most MAX_PER_RUN jobs
    const after = await Promise.all(heldRows.map((row) => outboxOf(d, row.id)))
    assert.ok(after.every((job) => job?.status === 'SUCCEEDED'), `CONTROL: once recorded every held job was picked up and delivered (${after.map((job) => job?.status).join(',')})`)
    assert.equal(posted.length, heldRows.length)
  })
})

// ───────────────── A permanent SHADOW verdict is not a hold: it must reach its terminal state as it did before the hold existed, and never cycle ─────────────────

/** A row whose decision is SHADOW although its step is open and the confirmation recorded: dated before the live-from instant. */
async function seedShadowRow(d: Deps, referenceId: string) {
  const row = await seedXeroRow(d, referenceId)
  await d.db.accountingSyncLog.update({ where: { id: row.id }, data: { payload: { date: '2020-01-01', narration: referenceId, lines: [{ description: 'Inventory', accountCode: '630', debit: 16 }, { description: 'Allocated Inventory', accountCode: '631', credit: 16 }] } as never } })
  return row
}
const handBackCommits = (d: Deps, syncLogId: string) => d.db.activityLog.count({ where: { entityId: syncLogId, action: 'xero_sync_transport_refusal_handback_committed' } })
const producerHeldEvidence = (d: Deps, syncLogId: string) => d.db.activityLog.count({ where: { entityId: syncLogId, action: 'xero_sync_producer_held_before_post' } })

test('XERO OUTBOX RUNNER, SHADOW verdict (open step, recorded confirmation): spends attempts and dead-letters as before the hold; no no-attempt hand-back, no per-tick evidence', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupXero(d, tag))
  posted.length = 0
  const row = await seedShadowRow(d, `${tag}-shadow`)
  await withEnv({ ...xeroLive, XERO_ACCOUNTING_OUTBOX_ENABLED: 'true' }, async () => {
    setAttestation(d, 'present', XERO_ATTESTATION)
    assert.equal(d.seam.xeroRowDeliveryHold({ type: 'COGS_JOURNAL' }), null, 'PRECONDITION: nothing HOLDS this type, so the verdict below is the shadow arm')
    const verdict = d.seam.xeroProducerSeamVerdict({ connector: 'xero', type: 'COGS_JOURNAL', payload: { date: '2020-01-01' } })
    assert.equal(verdict.kind, 'shadow', 'PRECONDITION: the row is a shadow verdict')
    let last: Awaited<ReturnType<typeof outboxOf>> = null
    for (let drain = 1; drain <= 8; drain++) {
      await d.processor.processPendingXeroSync()
      last = await outboxOf(d, row.id)
      assert.ok(last, `drain ${drain}: a job exists`)
      if (last.status === 'PERMANENT_FAILED') break
      assert.ok(last.attempts >= drain, `drain ${drain}: an attempt is SPENT each tick (it is not a free hand-back): attempts=${last.attempts}`)
      await tickLater(d, row.id)
    }
    console.log(`# outbox shadow: job=${last?.status} attempts=${last?.attempts}`)
    assert.equal(last?.status, 'PERMANENT_FAILED', 'dead-lettered, not cycling')
    assert.ok((last?.attempts ?? 0) >= 1)
    assert.equal(await handBackCommits(d, row.id), 0, 'never taken through the no-attempt hand-back')
    assert.ok(await producerHeldEvidence(d, row.id) <= 5, 'evidence is bounded by the attempts, not written every tick for ever')
    assert.deepEqual(posted, [], 'nothing was sent')
  })
})

test('XERO DIRECT RUNNER, SHADOW verdict (open step, recorded confirmation): not handed back through the no-attempt path, however many drains; nothing sent', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupXero(d, tag))
  posted.length = 0
  const row = await seedShadowRow(d, `${tag}-shadow-direct`)
  await withEnv({ ...xeroLive, XERO_ACCOUNTING_OUTBOX_ENABLED: 'false' }, async () => {
    setAttestation(d, 'present', XERO_ATTESTATION)
    for (let drain = 1; drain <= DRAINS; drain++) {
      await d.processor.processPendingXeroSync()
      assert.equal(await handBackCommits(d, row.id), 0, `drain ${drain}: never the no-attempt hand-back`)
    }
    assert.ok(await producerHeldEvidence(d, row.id) <= 1, 'the row is not re-offered every tick: at most the one evidence row')
    assert.deepEqual(posted, [])
  })
})

test('XERO DELIVERY HOLD vs SHADOW at the claim boundary: a held row is `producer-held` (waits, no attempt), a shadow verdict is `producer-shadowed`', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupXero(d, tag))
  const { claimHeldFrom } = await import('../../lib/domain/accounting/sync-claim-fence.ts')
  const lease = { ...claimHeldFrom(new Date()), fenceBeforeRemoteWrite: async () => { throw new Error('the fence must not be reached') } } as never
  const row = await seedXeroRow(d, `${tag}-claim`)
  const run = (payload: object) => d.processor.processClaimedEntry(row.id, 'COGS_JOURNAL', 'ProducerHeldProbe', `${tag}-claim`, { _postingMode: 'submitted', ...payload } as never, lease, { id: row.id, attemptRevision: 1 } as never)
  await withEnv({ ...xeroLive }, async () => {
    setAttestation(d, 'absent', XERO_ATTESTATION)
    const held = await run({ date: TODAY })
    assert.equal(held.notPosted?.reason, 'producer-held', 'the owner has not confirmed: a hold')
    setAttestation(d, 'present', XERO_ATTESTATION)
    const shadow = await run({ date: '2020-01-01' })
    assert.equal(shadow.notPosted?.reason, 'producer-shadowed', 'a row dated before the live-from instant is never delivered: not a hold')
  })
})

// ───────────────────────────────────── WooCommerce: stock ─────────────────────────────────────

const stockKeyOf = (productId: string) => `woocommerce:stock.push:${productId}`
async function seedStockJob(d: Deps, productId: string) {
  return d.db.integrationOutbox.create({
    data: {
      connector: 'woocommerce', operation: 'stock.push', idempotencyKey: stockKeyOf(productId), payloadJson: { productId, reason: 'IMS_CHANGE', force: false },
      status: 'PENDING', attempts: 0, attemptHistoryTracked: true,
    } as never,
    select: { id: true },
  })
}
const stockJobOf = (d: Deps, id: string) => d.db.integrationOutbox.findUnique({ where: { id }, select: { status: true, attempts: true, lockedAt: true, nextAttemptAt: true } })

for (const state of ['absent', 'unknown'] as const) {
  test(`WOOCOMMERCE STOCK DRAIN, confirmation ${state}: ${DRAINS} drains claim nothing and spend no attempt; once recorded the next drain pushes the job`, { skip }, async (t) => {
    const d = await deps()
    const tag = tagOf()
    const key = `${tag}-product`
    t.after(() => d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: stockKeyOf(key) } }))
    pushed.length = 0
    stockPushOutcome = 'ok'
    const job = await seedStockJob(d, key)
    await withEnv(wcLive, async () => {
      setAttestation(d, state, STOCK_ATTESTATION)
      for (let drain = 1; drain <= DRAINS; drain++) {
        const summary = await d.stockJobs.processQueuedWcStockSyncJobs({ productIds: [key] })
        const row = await stockJobOf(d, job.id)
        assert.equal(summary.held, true, `drain ${drain}: the drain reports it stood down`)
        assert.deepEqual([row?.status, row?.attempts, row?.lockedAt], ['PENDING', 0, null], `drain ${drain}: untouched`)
      }
      assert.deepEqual(pushed, [])
      setAttestation(d, 'present', STOCK_ATTESTATION)
      const summary = await d.stockJobs.processQueuedWcStockSyncJobs({ productIds: [key] })
      const row = await stockJobOf(d, job.id)
      console.log(`# stock ${state}: after the confirmation summary=${JSON.stringify(summary)} job=${row?.status}`)
      assert.equal(summary.synced, 1)
      assert.equal(row?.status, 'SUCCEEDED')
      assert.deepEqual(pushed, [key])
    })
  })
}

test('WOOCOMMERCE STOCK DRAIN: a push the hold refuses AFTER the job was claimed (the confirmation went away mid-drain) is handed back with NO attempt spent, however many times, and never dead-letters', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  const key = `${tag}-race`
  t.after(() => d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: stockKeyOf(key) } }))
  stockPushOutcome = 'held'
  const job = await seedStockJob(d, key)
  await withEnv(wcLive, async () => {
    setAttestation(d, 'present', STOCK_ATTESTATION)   // the drain's own ask passes; the push then reports the hold
    for (let drain = 1; drain <= 14; drain++) {   // more than the 12 attempts this queue allows
      const summary = await d.stockJobs.processQueuedWcStockSyncJobs({ productIds: [key] })
      const row = await stockJobOf(d, job.id)
      assert.equal(summary.processed, 1, `drain ${drain}: the job WAS claimed (the race), so the assertions below are about the hand-back`)
      assert.deepEqual([row?.status, row?.attempts, row?.lockedAt], ['RETRYABLE_FAILED', 0, null], `drain ${drain}: held, no attempt spent`)
      assert.ok((row!.nextAttemptAt as Date).getTime() - Date.now() <= 120_000, 'a short fixed delay')
      await d.db.integrationOutbox.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
    }
  })
  stockPushOutcome = 'ok'
  await withEnv(wcLive, async () => {
    const summary = await d.stockJobs.processQueuedWcStockSyncJobs({ productIds: [key] })
    assert.equal(summary.synced, 1, 'CONTROL: once nothing holds the push the same job goes out')
  })
})

// ───────────────────── WooCommerce writes of step X: the invoice document (outbox job) and the invoice note (a sync-log row) ─────────────────────

const stepX = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero,woocommerce', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: LIVE_FROM, WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: LIVE_FROM }

for (const state of ['absent', 'unknown'] as const) {
  test(`INVOICE DOCUMENT (step X), confirmation ${state}: ${DRAINS} drains claim nothing and spend no attempt; once recorded the next drain claims the job`, { skip }, async (t) => {
    const d = await deps()
    const tag = tagOf()
    const key = `woocommerce:order.invoice-document:${tag}`
    t.after(() => d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: key } }))
    const job = await d.db.integrationOutbox.create({
      data: {
        connector: 'woocommerce', operation: 'order.invoice-document', idempotencyKey: key, payloadJson: { orderId: `${tag}-order` },
        status: 'PENDING', attempts: 0, attemptHistoryTracked: true,
      } as never,
      select: { id: true },
    })
    await withEnv(stepX, async () => {
      const { wooDrainHold } = await import('../../lib/connectors/woocommerce/producer-egress.ts')
      setAttestation(d, state, XERO_ATTESTATION)
      assert.equal(wooDrainHold(undefined, 'order.invoice-document').held, true, `PRECONDITION: held while the confirmation is ${state}`)
      for (let drain = 1; drain <= DRAINS; drain++) {
        const summary = await d.invoiceJobs.runWcInvoiceDocumentJobs({ idempotencyKeys: [key] })
        const row = await stockJobOf(d, job.id)
        assert.equal(summary.claimed, 0, `drain ${drain}: nothing claimed`)
        assert.deepEqual([row?.status, row?.attempts, row?.lockedAt], ['PENDING', 0, null], `drain ${drain}: untouched`)
      }
      setAttestation(d, 'present', XERO_ATTESTATION)
      assert.equal(wooDrainHold(undefined, 'order.invoice-document').held, false)
      const summary = await d.invoiceJobs.runWcInvoiceDocumentJobs({ idempotencyKeys: [key] })
      assert.equal(summary.claimed, 1, 'CONTROL: recorded, the drain now takes the job')
    })
  })
}

for (const state of ['absent', 'unknown'] as const) {
  test(`INVOICE NOTE (WC_INVOICE_NOTE, step X, outbox runner), confirmation ${state}: ${DRAINS} drains spend no attempt and claim nothing; recorded, the hold lifts`, { skip }, async (t) => {
    const d = await deps()
    const tag = tagOf()
    t.after(() => cleanupXero(d, tag))
    const row = await seedXeroRow(d, `${tag}-note`, 'WC_INVOICE_NOTE')
    await withEnv({ ...stepX, XERO_ACCOUNTING_OUTBOX_ENABLED: 'true' }, async () => {
      setAttestation(d, state, XERO_ATTESTATION)
      assert.notEqual(d.seam.xeroRowDeliveryHold({ type: 'WC_INVOICE_NOTE' }), null, `PRECONDITION: held while the confirmation is ${state}`)
      for (let drain = 1; drain <= DRAINS; drain++) {
        await d.processor.processPendingXeroSync()
        const job = await outboxOf(d, row.id)
        const sync = await syncOf(d, row.id)
        assert.ok(job, `drain ${drain}: the note has an outbox job`)
        assert.deepEqual([job.status, job.attempts, job.lockedAt, sync?.status, sync?.retryCount, sync?.processingStartedAt], ['PENDING', 0, null, 'PENDING', 0, null], `drain ${drain}`)
        await tickLater(d, row.id)
      }
      setAttestation(d, 'present', XERO_ATTESTATION)
      assert.equal(d.seam.xeroRowDeliveryHold({ type: 'WC_INVOICE_NOTE' }), null, 'CONTROL: recorded, the hold lifts')
    })
  })
}
