import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

import { unlicensedHistoryClaims } from '../helpers/unconditional-instruction.ts'

/**
 * THE WRITER-SIDE CUT-OFF AND THE RETIREMENT OF THE HELD BACKLOG, AGAINST A REAL DATABASE.
 *
 * A destination that goes live must never deliver work that was queued before it did. Every layer that could deliver is tested in
 * ISOLATION, because two sufficient layers mask each other's removal: the claim statement, the selection predicate, the last check
 * before the transport, the outbox claim (selection and compare-and-set separately), and the re-arm refusals. The retirement is run for
 * real over rows the real enqueue paths produced. Nothing here contacts Xero, Mintsoft or WooCommerce; the layers under test refuse
 * before any transport call, and tests/no-outbound-network.cjs fails a test that tried to leave the box.
 *
 * Fixtures are unique per run and removed afterwards. Every read of a shared queue is scoped to this run's own rows (a prefix or an
 * explicit key list), and the retirement is applied only to this run's items, because other test files seed the same tables
 * concurrently. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * Named mutations (each shown red in the PR, restored from a copy, md5-verified):
 *  a  claim-ignores-the-cutoff        the Xero claim statement drops the createdAt clause: the claim arm goes red
 *  a2 selection-ignores-the-cutoff    the shared selection predicate drops the clause: the starvation arm goes red
 *  a3 transport-check-removed         processClaimedEntry's last check is removed: the pre-transport arm goes red
 *  a4 outbox-select-ignores-cutoff    the outbox selection drops the clause: the starvation arm goes red
 *  a5 outbox-cas-ignores-cutoff       the outbox claim statement drops it (the selection still has it): the mid-claim flip arm goes red
 *  b  replay-ignores-the-cutoff       the admin replay of a pre-cut-off job is allowed: the replay arm goes red
 *  c  retirement-ignores-the-stamp    a maybe-sent money row is shadowed: the honesty arm goes red
 *  i  redate-removed                  a live producer's re-armed stock job keeps its old creation time: the stock arm goes red
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/writer-cutoff.test.ts would have been skipped.')
}

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const ENV_KEYS = [
  'PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM',
  'WC_WRITEBACK_ALLOWED_ORIGIN', 'WC_WRITES_LIVE_FROM', 'MINTSOFT_WRITE_ALLOWED', 'MINTSOFT_WRITES_LIVE_FROM',
]
const DAY = 86_400_000
// The cut-off is one day ago, so "now" is in the live phase and rows seeded with createdAt before it are pre-cut-off.
const CUTOFF = new Date(Date.now() - DAY)
const BEFORE = new Date(Date.now() - 3 * DAY)
const AFTER = new Date(Date.now() - 60_000)
const xeroLive = (cutoff = CUTOFF) => ({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: cutoff.toISOString().replace(/\.\d+Z$/, 'Z') })
const wcLive = (cutoff = CUTOFF) => ({ PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: cutoff.toISOString().replace(/\.\d+Z$/, 'Z') })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, processor, outbox, admin, stock, retire, accounting, xeroSeam, daily, sweep] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
    import('../../lib/domain/integrations/outbox.ts'),
    import('../../lib/domain/integrations/outbox-admin.ts'),
    import('../../lib/connectors/woocommerce/sync/stock-sync-jobs.ts'),
    import('../../lib/domain/outbound-shadow/retire-held-backlog.ts'),
    import('../../lib/accounting.ts'),
    import('../../lib/domain/accounting/xero-producer-seam.ts'),
    import('../../lib/connectors/xero/daily-sync.ts'),
    import('../../lib/domain/wms/order-push-sweep.ts'),
  ])
  return { db, processor, outbox, admin, stock, retire, accounting, xeroSeam, daily, sweep }
}
type Deps = Awaited<ReturnType<typeof deps>>

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const key of ENV_KEYS) delete process.env[key]
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value
  }
}

const tagOf = () => `wc${randomUUID().slice(0, 8)}`

async function seedSyncLog(d: Deps, referenceId: string, over: Record<string, unknown> = {}) {
  return d.db.accountingSyncLog.create({
    data: {
      connector: 'xero', type: 'STOCK_RECEIPT', status: 'PENDING', referenceType: 'WriterCutoffProbe', referenceId,
      payload: { date: '2026-06-01', narration: referenceId, lines: [] }, attemptStampingCustodyAt: new Date(), createdAt: AFTER, ...over,
    } as never,
    select: { id: true, createdAt: true },
  })
}

async function cleanupSync(d: Deps, prefix: string) {
  const rows = await d.db.accountingSyncLog.findMany({ where: { referenceId: { startsWith: prefix } }, select: { id: true } })
  for (const row of rows) await d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: row.id } } }).catch(() => undefined)
  await d.db.accountingEvent.deleteMany({ where: { sourceEntityId: { startsWith: prefix } } }).catch(() => undefined)
  await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { startsWith: prefix } } })
  await d.db.accountingSyncLog.deleteMany({ where: { referenceId: { startsWith: prefix } } })
}

const attemptFor = (row: { id: string }) => ({ id: row.id, attemptRevision: 1 })
const staleCutoff = () => new Date(Date.now() - 15 * 60_000)

// ───────────────────────────────── Xero: the claim statement ─────────────────────────────────

test('XERO CLAIM, in isolation: a row created before the cut-off is not claimed (the statement itself refuses it); a later row is; a PDF fetch is exempt; with the switch OFF the same pre-cut-off row IS claimed', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const pre = await seedSyncLog(d, `${tag}-pre`, { createdAt: BEFORE })
  const post = await seedSyncLog(d, `${tag}-post`)
  const pdf = await seedSyncLog(d, `${tag}-pdf`, { createdAt: BEFORE, type: 'INVOICE_PDF' })
  const control = await seedSyncLog(d, `${tag}-control`, { createdAt: BEFORE })
  const claim = (row: { id: string }) => d.processor.claimAccountingSyncLog(
    { id: row.id, type: 'STOCK_RECEIPT', referenceType: 'WriterCutoffProbe', referenceId: 'x', attemptRevision: 0 }, new Date(), staleCutoff(), attemptFor(row),
  )
  await withEnv(xeroLive(), async () => {
    const refused = await claim(pre)
    const allowed = await claim(post)
    const exempt = await d.processor.claimAccountingSyncLog(
      { id: pdf.id, type: 'INVOICE_PDF', referenceType: 'WriterCutoffProbe', referenceId: 'x', attemptRevision: 0 }, new Date(), staleCutoff(), attemptFor(pdf),
    )
    console.log(`# claim: pre=${refused.outcome} post=${allowed.outcome} pdf=${exempt.outcome}`)
    assert.equal(refused.outcome, 'not-claimable')
    assert.equal(allowed.outcome, 'claimed', 'CONTROL: the same statement claims a row created after the instant')
    assert.equal(exempt.outcome, 'claimed', 'a PDF fetch is not a write to Xero')
    const untouched = await d.db.accountingSyncLog.findUnique({ where: { id: pre.id }, select: { status: true, attemptRevision: true, processingStartedAt: true } })
    assert.deepEqual([untouched?.status, untouched?.attemptRevision, untouched?.processingStartedAt], ['PENDING', 0, null], 'the refused row was not touched at all')
  })
  await withEnv({}, async () => {
    const legacy = await claim(control)
    assert.equal(legacy.outcome, 'claimed', 'CONTROL: switch off, the identical row is claimed exactly as before the hold existed')
  })
})

test('XERO CLAIM UNDER THE ORDER LOCK, in isolation: an order-scoped payment row created before the cut-off is refused by the statement that runs INSIDE the order lock; a later one is claimed', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const orderRef = `${tag}-order`
  const pre = await seedSyncLog(d, orderRef, { createdAt: BEFORE, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder' })
  const claimPayment = (row: { id: string }) => d.processor.claimAccountingSyncLog(
    { id: row.id, type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: orderRef, attemptRevision: 0 }, new Date(), staleCutoff(), attemptFor(row),
  )
  await withEnv(xeroLive(), async () => {
    const refused = await claimPayment(pre)
    console.log(`# claim under lock: ${refused.outcome}`)
    assert.equal(refused.outcome, 'not-claimable', 'the locked statement carries the floor too')
    await d.db.accountingSyncLog.update({ where: { id: pre.id }, data: { createdAt: AFTER } })
    const allowed = await claimPayment(pre)
    assert.equal(allowed.outcome, 'claimed', 'CONTROL: the same row, once it is after the instant, is claimed by the same path')
  })
})

test('XERO SELECTION, in isolation: pre-cut-off rows do not occupy the oldest-first window, so a later row is reached; with no floor the window is theirs (the starvation the floor removes)', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  for (let index = 0; index < 5; index += 1) await seedSyncLog(d, `${tag}-pre${index}`, { createdAt: new Date(BEFORE.getTime() + index * 1000) })
  const post = await seedSyncLog(d, `${tag}-post`)
  const window = async (floor: Date | null) => (await d.db.accountingSyncLog.findMany({
    where: { AND: [d.processor.claimableXeroSyncLogWhere(new Date(), staleCutoff(), floor), { referenceId: { startsWith: tag } }] },
    orderBy: { createdAt: 'asc' }, take: 5,
  })).map((row: { id: string }) => row.id)
  const withFloor = await window(CUTOFF)
  const without = await window(null)
  console.log(`# window with floor: ${withFloor.length} row(s); without: ${without.length} row(s), reaches the later row: ${without.includes(post.id)}`)
  assert.deepEqual(withFloor, [post.id], 'the only row the processor may pick up')
  assert.equal(without.length, 5, 'CONTROL: without the floor the five old rows fill the window of five')
  assert.equal(without.includes(post.id), false, 'CONTROL: and the later row is starved')
})

test('XERO LAST CHECK BEFORE THE TRANSPORT, in isolation: processClaimedEntry on a pre-cut-off row returns "before-cutoff" and sends nothing, with the single-sourced sentence', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const pre = await seedSyncLog(d, `${tag}-pre`, { createdAt: BEFORE, type: 'BILL_PAYMENT', status: 'PROCESSING', attemptRevision: 1, processingStartedAt: new Date() })
  await withEnv(xeroLive(), async () => {
    const result = await d.processor.processClaimedEntry(
      pre.id, 'BILL_PAYMENT' as never, 'WriterCutoffProbe', `${tag}-pre`,
      { paymentDate: '2026-12-02', amount: 10 } as never, {} as never, { id: pre.id, attemptRevision: 1 },
    )
    console.log(`# last check: ${JSON.stringify({ success: result.success, reason: result.notPosted?.reason })}`)
    assert.equal(result.success, false)
    assert.equal(result.notPosted?.reason, 'before-cutoff')
    assert.equal(result.notPosted?.message, d.xeroSeam.xeroBeforeCutoffRefusal({ createdAt: BEFORE, type: 'BILL_PAYMENT' }), 'the one sentence')
    assert.match(String(result.error), /check Xero before acting/)
  })
})

test('DAILY-BATCH RESET: the every-run reset of FAILED batch rows skips a row created before the cut-off (a clause of the write itself), resets a later one, and resets both with the switch off', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const make = async (name: string, createdAt: Date) => seedSyncLog(d, `${tag}-${name}`, {
    type: 'DAILY_BATCH_GROUP_B', referenceType: 'DailyBatch', status: 'FAILED', createdAt, retryCount: 3, errorMessage: 'old failure',
    payload: { date: AFTER.toISOString().slice(0, 10), narration: name, lines: [] },
  })
  const old = await make('old', BEFORE)
  const fresh = await make('new', AFTER)
  const statuses = async () => ({
    old: (await d.db.accountingSyncLog.findUnique({ where: { id: old.id }, select: { status: true } }))?.status,
    fresh: (await d.db.accountingSyncLog.findUnique({ where: { id: fresh.id }, select: { status: true } }))?.status,
  })
  // GROUP_B is owned by IMS in the live phase and needs the batch date as its business-event time, which the payload carries: it is dated today,
  // after the instant, so the producer DECISION says LIVE for both rows and only the cut-off can refuse the old one.
  await withEnv(xeroLive(), async () => {
    await d.daily.resetFailedDailyBatchLogs()
    const got = await statuses()
    console.log(`# daily reset: ${JSON.stringify(got)}`)
    assert.deepEqual(got, { old: 'FAILED', fresh: 'PENDING' })
  })
  await d.db.accountingSyncLog.updateMany({ where: { id: { in: [old.id, fresh.id] } }, data: { status: 'FAILED' } })
  await withEnv({}, async () => {
    await d.daily.resetFailedDailyBatchLogs()
    assert.deepEqual(await statuses(), { old: 'PENDING', fresh: 'PENDING' }, 'CONTROL: switch off, the legacy status-wide reset takes both')
  })
})

// ───────────────────────────────── The outbox ─────────────────────────────────

async function seedJob(d: Deps, key: string, createdAt: Date, over: Record<string, unknown> = {}) {
  return d.db.integrationOutbox.create({
    data: {
      connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key, payloadJson: { productId: key, reason: 'IMS_CHANGE', force: false },
      status: 'PENDING', attempts: 0, createdAt, attemptHistoryTracked: true, ...over,
    } as never,
    select: { id: true, idempotencyKey: true },
  })
}
const cleanupJobs = (d: Deps, prefix: string) => d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { startsWith: prefix } } })

test('OUTBOX SELECTION, in isolation: pre-cut-off jobs do not occupy the oldest-first claim window; with the switch off they do (control)', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const keys: string[] = []
  for (let index = 0; index < 4; index += 1) {
    const key = `woocommerce:stock.push:${tag}-pre${index}`
    keys.push(key)
    await seedJob(d, key, new Date(BEFORE.getTime() + index * 1000))
  }
  const postKey = `woocommerce:stock.push:${tag}-post`
  keys.push(postKey)
  await seedJob(d, postKey, AFTER)
  const claimOnce = (suffix: string) => d.outbox.claimIntegrationOutboxWork({
    connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: keys, limit: 4, workerId: `w-${suffix}`,
  })
  await withEnv(wcLive(), async () => {
    const claimed = await claimOnce('live')
    console.log(`# outbox live: claimed ${claimed.map((row: { idempotencyKey: string }) => row.idempotencyKey.slice(-5)).join(',')}`)
    assert.deepEqual(claimed.map((row: { idempotencyKey: string }) => row.idempotencyKey), [postKey], 'only the post-cut-off job; the four old ones are not even in the window')
  })
  await d.db.integrationOutbox.updateMany({ where: { idempotencyKey: { in: keys } }, data: { status: 'PENDING', lockedAt: null, lockedBy: null } })
  await withEnv({}, async () => {
    const claimed = await claimOnce('legacy')
    assert.equal(claimed.length, 4, 'CONTROL: switch off, the same window is the four oldest jobs')
    assert.equal(claimed.some((row: { idempotencyKey: string }) => row.idempotencyKey === postKey), false, 'CONTROL: and the later job is starved by them')
  })
})

test('OUTBOX CLAIM STATEMENT, in isolation: the cut-off is re-derived INSIDE the claim, so a floor that comes into force between selection and claim still refuses the job', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const key = `woocommerce:stock.push:${tag}-flip`
  const job = await seedJob(d, key, new Date(Date.now() - 2 * 3_600_000)) // two hours old
  await withEnv(wcLive(new Date(Date.now() - DAY)), async () => {
    // Selection sees the job as AFTER the instant (the instant is a day ago). Between the selection and the claim statement the gate (which runs
    // inside the claim's own transaction) moves the instant to one hour ago: the job is now before it.
    const claimed = await d.outbox.claimIntegrationOutboxWork({
      connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'w-flip',
      claimGate: {
        keyOf: () => 'writer-cutoff-flip',
        mayClaim: async () => {
          process.env.WC_WRITES_LIVE_FROM = new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z')
          return true
        },
      },
    })
    console.log(`# flip: claimed ${claimed.length}`)
    assert.equal(claimed.length, 0, 'the claim statement carries the floor of that moment')
  })
  const after = await d.db.integrationOutbox.findUnique({ where: { id: job.id }, select: { status: true, lockedBy: true } })
  assert.deepEqual([after?.status, after?.lockedBy], ['PENDING', null], 'the job was not taken')
})

test('OUTBOX RE-ARM: an operator replay of a pre-cut-off job is refused with the single-sourced sentence; a SHADOWED job is never replayed; a post-cut-off failed job replays (control)', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const old = await seedJob(d, `woocommerce:stock.push:${tag}-old`, BEFORE, { status: 'PERMANENT_FAILED', attempts: 5, lastError: 'boom' })
  const fresh = await seedJob(d, `woocommerce:stock.push:${tag}-new`, AFTER, { status: 'PERMANENT_FAILED', attempts: 5, lastError: 'boom' })
  const shadowed = await seedJob(d, `woocommerce:stock.push:${tag}-shadow`, BEFORE, { status: 'SHADOWED' })
  await withEnv(wcLive(), async () => {
    await assert.rejects(d.admin.replayIntegrationOutboxAdminRow({ id: old.id }), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, 'before_cutoff')
      assert.match(String(error.message), /^Not sent by IMS: this was queued before writes to WooCommerce went live/)
      return true
    })
    await assert.rejects(d.admin.replayIntegrationOutboxAdminRow({ id: shadowed.id }), (error: { code?: string }) => error.code === 'shadowed')
    await assert.rejects(d.admin.permanentlyFailIntegrationOutboxAdminRow({ id: shadowed.id }), (error: { code?: string }) => error.code === 'not_permanent_failable')
    const replayed = await d.admin.replayIntegrationOutboxAdminRow({ id: fresh.id })
    assert.equal(replayed.row.status, 'PENDING', 'CONTROL: a job created after the instant replays')
    const listed = await d.admin.listIntegrationOutboxAdminRows({ status: 'SHADOWED', connector: 'woocommerce', limit: 100 })
    assert.ok(listed.rows.some((row: { id: string }) => row.id === shadowed.id), 'the listing handles the SHADOWED status')
  })
  assert.equal((await d.db.integrationOutbox.findUnique({ where: { id: old.id }, select: { status: true } }))?.status, 'PERMANENT_FAILED', 'the refused job is untouched')
})

test('STOCK JOB RE-DATING: a product keeps ONE stock job; a live producer re-arming a pre-cut-off one makes a new push that is claimable, and with the switch off the row is untouched', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  const productId = `${tag}-product`
  const key = `woocommerce:stock.push:${productId}`
  t.after(async () => { await cleanupJobs(d, `woocommerce:stock.push:${tag}`) })
  await seedJob(d, key, BEFORE, { status: 'SUCCEEDED' })
  await withEnv({}, async () => {
    // Switch off: nothing is re-dated (the legacy update, byte for byte).
    await d.stock.enqueueWcStockSyncJobs([productId], 'MANUAL')
    const legacy = await d.db.integrationOutbox.findUnique({ where: { idempotencyKey: key }, select: { createdAt: true, status: true } })
    assert.equal(legacy?.createdAt.getTime(), BEFORE.getTime(), 'CONTROL: the creation time is untouched with the switch off')
    assert.equal(legacy?.status, 'PENDING')
    await d.db.integrationOutbox.update({ where: { idempotencyKey: key }, data: { status: 'SUCCEEDED' } })
  })
  await withEnv(wcLive(), async () => {
    await d.stock.enqueueWcStockSyncJobs([productId], 'MANUAL')
    const row = await d.db.integrationOutbox.findUnique({ where: { idempotencyKey: key }, select: { createdAt: true, status: true } })
    console.log(`# re-dated: createdAt ${row?.createdAt.toISOString()} (cut-off ${CUTOFF.toISOString()})`)
    assert.equal(row?.status, 'PENDING')
    assert.ok(row!.createdAt.getTime() >= CUTOFF.getTime(), 're-dated to the new push')
    const claimed = await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'w-stock' })
    assert.equal(claimed.length, 1, 'the product\'s stock keeps syncing: without the re-dating the cut-off would refuse its only job for ever')
  })
})

// ───────────────────────────────── The retirement ─────────────────────────────────

const enqueueReal = async (d: Deps, referenceId: string, type: string, payload: Record<string, unknown>, referenceType = 'CogsEntry') => {
  await d.db.$transaction(async (tx: Tx) => {
    await d.accounting.queueAccountingSyncTxWithOutcome(tx, { type, connector: 'xero', referenceType, referenceId, payload, chartConnector: 'xero' } as never)
  }, { timeout: 60_000, maxWait: 30_000 })
}
const SETTINGS = [['plugin_xero_enabled', 'true'], ['xero_sync_enabled', 'true']] as const
async function withSettings<T>(d: Deps, fn: () => Promise<T>): Promise<T> {
  const before = await d.db.setting.findMany({ where: { key: { in: SETTINGS.map(([key]) => key) } } })
  for (const [key, value] of SETTINGS) await d.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  try { return await fn() } finally {
    for (const [key] of SETTINGS) {
      const prior = before.find((row: { key: string }) => row.key === key)
      if (prior) await d.db.setting.update({ where: { key }, data: { value: prior.value } })
      else await d.db.setting.deleteMany({ where: { key } })
    }
  }
}

test('RETIREMENT of Xero rows queued by the real enqueue: proven-unsent rows become HELD_SHADOW with a shadow record and a non-revivable void mirror; maybe-sent rows are PARKED "outcome unknown"; a row a worker holds is left alone', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const payload = (ref: string) => ({ date: '2026-06-01', narration: `probe ${ref}`, lines: [{ description: 'Inventory', accountCode: '630', debit: 16 }, { description: 'Allocated Inventory', accountCode: '631', credit: 16 }] })
  // Real rows, queued with the switch OFF as the WP1-only window queued them: a PENDING row, its outbox job and its mirrored event.
  await withSettings(d, () => withEnv({}, async () => {
    await enqueueReal(d, `${tag}-clean`, 'UNEARNED_REV_REVERSAL', payload(`${tag}-clean`))
    await enqueueReal(d, `${tag}-claimed`, 'UNEARNED_REV_REVERSAL', payload(`${tag}-claimed`))
    await enqueueReal(d, `${tag}-busy`, 'UNEARNED_REV_REVERSAL', payload(`${tag}-busy`))
  }))
  const rows = await d.db.accountingSyncLog.findMany({ where: { referenceId: { startsWith: tag } }, select: { id: true, referenceId: true, status: true, attemptRevision: true, attemptStampingCustodyAt: true } })
  const byRef = Object.fromEntries(rows.map((row: { referenceId: string; id: string }) => [row.referenceId.slice(tag.length + 1), row]))
  console.log(`# queued: ${rows.map((r: { referenceId: string; status: string; attemptRevision: number; attemptStampingCustodyAt: Date | null }) => `${r.referenceId.slice(tag.length + 1)}:${r.status}:rev${r.attemptRevision}:custody=${r.attemptStampingCustodyAt !== null}`).join(' ')}`)
  assert.equal(rows.length, 3, 'precondition: the real enqueue made three queued rows')
  assert.ok(rows.every((r: { attemptStampingCustodyAt: Date | null }) => r.attemptStampingCustodyAt !== null), 'precondition: created in stamping custody')
  // The claimed row has history (a claim and a retry were recorded): it MAY have been sent.
  await d.db.accountingSyncLog.update({ where: { id: byRef.claimed.id }, data: { attemptRevision: 2, retryCount: 1 } })
  // A MONEY row with a recorded remote attempt: the stamp says a call left.
  const money = await seedSyncLog(d, `${tag}-money`, { createdAt: BEFORE, type: 'BILL_PAYMENT', remoteAttemptedAt: new Date(), attemptRevision: 1 })
  const cutoff = new Date(Date.now() + 60_000)
  const scope = { destinations: ['xero' as const], cutoffs: { xero: cutoff }, allQueued: false, limit: 5000 }
  const planned = await d.retire.planHeldBacklogRetirement(scope)
  const mine = (id: string) => planned.items.filter((item: { id: string; subject: string }) => item.id === id)[0]
  const outboxJobsMine = planned.items.filter((item: { kind: string; subject: string }) => item.kind === 'outbox_job')
  console.log(`# plan: ${planned.items.length} item(s) over the shared tables; mine: clean=${mine(byRef.clean.id)?.classification.disposition} claimed=${mine(byRef.claimed.id)?.classification.disposition} money=${mine(money.id)?.classification.disposition}; outbox jobs in plan=${outboxJobsMine.length}`)
  assert.equal(mine(byRef.clean.id)?.classification.disposition, 'SHADOW')
  assert.equal(mine(byRef.claimed.id)?.classification.disposition, 'PARK')
  assert.equal(mine(money.id)?.classification.disposition, 'PARK', 'MAYBE-SENT money row: the stamp says a call left')
  // The worker takes `busy` after the plan: the apply re-reads and leaves it alone.
  await d.db.accountingSyncLog.update({ where: { id: byRef.busy.id }, data: { status: 'PROCESSING', processingStartedAt: new Date(), attemptRevision: 1 } })

  const myIds = new Set<string>([byRef.clean.id, byRef.claimed.id, byRef.busy.id, money.id])
  const myJobIds: string[] = []
  for (const id of [byRef.clean.id, byRef.claimed.id, byRef.busy.id]) {
    const jobs = await d.db.integrationOutbox.findMany({ where: { idempotencyKey: { contains: id } }, select: { id: true } })
    myJobIds.push(...jobs.map((job: { id: string }) => job.id))
  }
  const only = { ...planned, items: planned.items.filter((item: { id: string }) => myIds.has(item.id) || myJobIds.includes(item.id)) }
  const applied = await d.retire.applyHeldBacklogRetirement(only, scope)
  console.log(`# applied: ${JSON.stringify(applied.counts)}`)

  const after = async (id: string) => d.db.accountingSyncLog.findUnique({ where: { id }, select: { status: true, settlementBasis: true, abandonedBeforeRemoteCall: true, errorMessage: true, externalTransactionId: true } })
  const clean = await after(byRef.clean.id)
  assert.deepEqual([clean?.status, clean?.settlementBasis, clean?.abandonedBeforeRemoteCall, clean?.externalTransactionId], ['CANCELLED', 'HELD_SHADOW', true, null])
  assert.match(String(clean?.errorMessage), /^Retired by IMS and kept as a shadow: this was queued before writes to Xero were live/)
  assert.match(String(clean?.errorMessage), /check Xero before acting/)
  const shadow = await d.db.outboundShadowWrite.findMany({ where: { subjectId: `${tag}-clean` }, select: { destination: true, reason: true, accountingSyncLogId: true, summary: true } })
  assert.equal(shadow.length, 1)
  assert.deepEqual([shadow[0]?.destination, shadow[0]?.reason, shadow[0]?.accountingSyncLogId], ['xero', 'before_cutoff', byRef.clean.id])
  const event = await d.db.accountingEvent.findFirst({ where: { sourceEntityId: `${tag}-clean` }, select: { status: true, voidBasis: true } })
  assert.deepEqual([event?.status, event?.voidBasis], ['VOID', 'held_shadow'], 'the mirrored event is retired, and not revivable')
  const job = await d.db.integrationOutbox.findFirst({ where: { idempotencyKey: { contains: byRef.clean.id } }, select: { status: true, lastError: true } })
  assert.equal(job?.status, 'SHADOWED', 'the delivery job of a retired row is retired with it')

  const claimed = await after(byRef.claimed.id)
  assert.equal(claimed?.status, 'FAILED')
  assert.notEqual(claimed?.settlementBasis, 'HELD_SHADOW', 'a row that may have been sent is NEVER a shadow')
  assert.match(String(claimed?.errorMessage), /outcome unknown: check Xero before acting/)
  assert.deepEqual(unlicensedHistoryClaims(String(claimed?.errorMessage), null), [], 'and it never claims anything about what was or was not sent')
  const claimedJob = await d.db.integrationOutbox.findFirst({ where: { idempotencyKey: { contains: byRef.claimed.id } }, select: { status: true } })
  assert.equal(claimedJob?.status, 'SHADOWED', 'the job itself was never claimed: its own record is untouched since it was queued')
  const moneyAfter = await after(money.id)
  assert.equal(moneyAfter?.status, 'FAILED')
  assert.match(String(moneyAfter?.errorMessage), /outcome unknown: check Xero before acting/)
  assert.equal(moneyAfter?.settlementBasis, null)

  const busy = await after(byRef.busy.id)
  assert.equal(busy?.status, 'PROCESSING', 'a row a worker holds is left exactly as it is')
  assert.ok(applied.outcomes.some((o: { item: { id: string }; result: string }) => o.item.id === byRef.busy.id && o.result !== 'shadowed' && o.result !== 'parked'))
})

test('RETIREMENT is idempotent and honest about a second sibling: a mirror is left alone when another live attempt owns the document; a second run changes nothing', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const ref = `${tag}-doc`
  await withSettings(d, () => withEnv({}, async () => {
    await d.db.$transaction(async (tx: Tx) => {
      await d.accounting.queueAccountingSyncTxWithOutcome(tx, {
        type: 'UNEARNED_REV_REVERSAL', connector: 'xero', referenceType: 'CogsEntry', referenceId: ref, chartConnector: 'xero',
        payload: { date: '2026-06-01', narration: ref, lines: [{ description: 'Inventory', accountCode: '630', debit: 5 }, { description: 'Allocated Inventory', accountCode: '631', credit: 5 }] },
      } as never)
    }, { timeout: 60_000 })
  }))
  const row = await d.db.accountingSyncLog.findFirst({ where: { referenceId: ref }, select: { id: true, type: true, payload: true } })
  // Another attempt at the SAME document is live (a post-cut-off re-production): it owns the mirror.
  await seedSyncLog(d, ref, { type: row!.type, referenceType: 'CogsEntry', payload: row!.payload, status: 'PENDING', createdAt: AFTER })
  const scope = { destinations: ['xero' as const], cutoffs: { xero: new Date(Date.now() + 60_000) }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const mineItems = plan.items.filter((item: { id: string }) => item.id === row!.id)
  assert.equal(mineItems.length, 1, 'precondition: the old row is in the plan (only it is applied: the later attempt is left live)')
  const first = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mineItems }, scope)
  assert.equal(first.counts.shadowed, 1)
  const eventAfter = await d.db.accountingEvent.findFirst({ where: { sourceEntityId: ref }, select: { status: true, voidBasis: true } })
  assert.notEqual(eventAfter?.status, 'VOID', 'another live attempt owns the document\'s mirrored event: it is not voided from under it')
  const second = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mineItems }, scope)
  assert.deepEqual([second.counts.shadowed, second.counts.parked, second.counts.changed_since_plan], [0, 0, 1], 'the row is no longer queued: reported, not rewritten')
  const shadows = await d.db.outboundShadowWrite.findMany({ where: { subjectId: ref }, select: { occurrences: true } })
  assert.equal(shadows.length, 1)
})

async function seedLinkedOrder(d: Deps, tag: string, paidAt: Date, link: Record<string, unknown>) {
  const warehouse = await d.db.warehouse.create({ data: { code: `${tag}-W`.slice(0, 20), name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: `WCO-${tag}`, status: 'PROCESSING', paidAt, shipFromWarehouseId: warehouse.id, customerName: 'Pat Example', customerEmail: 'pat@example.com',
      currency: 'GBP', shippingAddress: { line1: '1 Test Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
      subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      lines: { create: [{ description: 'Widget', sku: `SKU-${tag}`, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }] },
    },
    select: { id: true },
  })
  const created = await d.db.wmsOrderPushLink.create({ data: { orderId: order.id, connector: 'mintsoft', state: 'PENDING_CREATE', claimHistoryTracked: true, ...link } as never, select: { id: true } })
  return { warehouseId: warehouse.id, orderId: order.id, linkId: created.id }
}
async function cleanupLinked(d: Deps, seeded: { warehouseId: string; orderId: string }) {
  await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: seeded.orderId } })
  await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: seeded.orderId } })
  await d.db.salesOrderLine.deleteMany({ where: { orderId: seeded.orderId } })
  await d.db.salesOrder.deleteMany({ where: { id: seeded.orderId } })
  await d.db.warehouse.deleteMany({ where: { id: seeded.warehouseId } })
}

test('RETIREMENT of Mintsoft links queued before go-live: a bare PENDING_CREATE link is removed with a shadow (so it no longer shows "Queued" and no longer blocks a hard delete); a link with history is PARKED as an unknown create; an order paid after the cut-off is not in scope', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  const bare = await seedLinkedOrder(d, `${tag}a`, BEFORE, {})
  const attempted = await seedLinkedOrder(d, `${tag}b`, BEFORE, { attempts: 1, lastAttemptAt: new Date(Date.now() - 1000), lastError: 'timeout' })
  const later = await seedLinkedOrder(d, `${tag}c`, AFTER, {})
  t.after(async () => { for (const s of [bare, attempted, later]) await cleanupLinked(d, s) })
  const scope = { destinations: ['mintsoft' as const], cutoffs: { mintsoft: CUTOFF }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const ids = new Set([bare.linkId, attempted.linkId, later.linkId])
  const mine = plan.items.filter((item: { id: string }) => ids.has(item.id))
  console.log(`# links in plan: ${mine.map((i: { id: string; classification: { disposition: string } }) => `${i.id.slice(-4)}:${i.classification.disposition}`).join(' ')}`)
  assert.deepEqual(mine.map((item: { id: string }) => item.id).sort(), [bare.linkId, attempted.linkId].sort(), 'an order paid after the cut-off is IMS\'s own and is not touched')
  const linkOf = (id: string) => d.db.wmsOrderPushLink.findUnique({ where: { id }, select: { state: true, attempts: true, pushedAt: true, externalOrderId: true } })
  assert.equal(d.sweep.provesNoRemoteWmsCall(await linkOf(bare.linkId)), false, 'BEFORE: the hard-delete guard treats a bare queued link as possibly sent, so the order cannot be deleted')
  const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope)
  assert.deepEqual([applied.counts.shadowed, applied.counts.parked], [1, 1])
  assert.equal(await d.db.wmsOrderPushLink.findUnique({ where: { id: bare.linkId } }), null, 'the bare link is gone: nothing says Queued')
  assert.equal(d.sweep.provesNoRemoteWmsCall(await linkOf(bare.linkId)), true, 'AFTER: no link, so the hard-delete guard no longer blocks on it')
  assert.equal(d.sweep.provesNoRemoteWmsCall(await linkOf(attempted.linkId)), false, 'a parked link (a create may have left) still blocks the delete, as it must')
  const shadows = await d.db.outboundShadowWrite.findMany({ where: { subjectId: bare.orderId }, select: { destination: true, operation: true, subjectType: true, reason: true } })
  assert.deepEqual(shadows.map((s: { destination: string; operation: string; subjectType: string; reason: string }) => [s.destination, s.operation, s.subjectType, s.reason]), [['mintsoft', 'order.create', 'SalesOrder', 'before_cutoff']])
  const parked = await d.db.wmsOrderPushLink.findUnique({ where: { id: attempted.linkId }, select: { state: true, lastError: true, attempts: true } })
  assert.equal(parked?.state, 'AMBIGUOUS_CREATE')
  assert.match(String(parked?.lastError), /outcome unknown: check Mintsoft before acting/)
  assert.equal(parked?.attempts, 1, 'the evidence of the attempt is kept')
  assert.equal(await d.db.wmsOrderPushLink.count({ where: { id: later.linkId } }), 1, 'the later order\'s queued link is untouched')
})

// ───────────────── plan -> apply: every write is guarded by what justified the classification, re-derived under lock ─────────────────
//
// Named mutations (each shown red in the PR): t1 outbox apply drops the createdAt/cut-off re-check; t2 xero apply drops it; t3 link apply drops it;
// t4 the plan applies a configured cut-off under --all-queued.

test('PLAN -> APPLY (outbox): a stock job re-dated and re-armed after planning is NOT shadowed (live work); one attempted after planning is PARKED, never shadowed', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const redated = await seedJob(d, `woocommerce:stock.push:${tag}-redated`, BEFORE, { updatedAt: BEFORE })
  const attempted = await seedJob(d, `woocommerce:stock.push:${tag}-attempted`, BEFORE, { updatedAt: BEFORE })
  const control = await seedJob(d, `woocommerce:stock.push:${tag}-control`, BEFORE, { updatedAt: BEFORE })
  const scope = { destinations: ['woocommerce' as const], cutoffs: { woocommerce: CUTOFF }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const ids = new Set([redated.id, attempted.id, control.id])
  const mine = plan.items.filter((item: { id: string; classification: { disposition: string } }) => ids.has(item.id))
  assert.deepEqual(mine.map((i: { classification: { disposition: string } }) => i.classification.disposition), ['SHADOW', 'SHADOW', 'SHADOW'], 'precondition: all three plan as SHADOW')
  // After planning: a live producer re-dates and re-arms one; another is claimed and fails once.
  await d.db.integrationOutbox.update({ where: { id: redated.id }, data: { createdAt: new Date(), updatedAt: new Date(), status: 'PENDING' } })
  await d.db.integrationOutbox.update({ where: { id: attempted.id }, data: { attempts: 1, status: 'RETRYABLE_FAILED', lastError: 'boom' } })
  const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope)
  const state = async (id: string) => (await d.db.integrationOutbox.findUnique({ where: { id }, select: { status: true } }))?.status
  console.log(`# outbox plan->apply: ${JSON.stringify(applied.outcomes.map((o: { result: string }) => o.result))}`)
  assert.equal(await state(redated.id), 'PENDING', 'the re-dated job is live work and is untouched')
  assert.equal(applied.outcomes.find((o: { item: { id: string } }) => o.item.id === redated.id)?.result, 'changed_since_plan')
  assert.equal(await state(attempted.id), 'PERMANENT_FAILED', 'an attempt after planning: parked, not shadowed')
  assert.equal(await state(control.id), 'SHADOWED', 'CONTROL: an unchanged job is retired')
})

test('PLAN -> APPLY (Xero): a sync row re-dated after planning is left alone; one claimed or retried after planning is not shadowed', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const redated = await seedSyncLog(d, `${tag}-redated`, { createdAt: BEFORE })
  const retried = await seedSyncLog(d, `${tag}-retried`, { createdAt: BEFORE })
  const control = await seedSyncLog(d, `${tag}-control`, { createdAt: BEFORE })
  const scope = { destinations: ['xero' as const], cutoffs: { xero: CUTOFF }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const ids = new Set([redated.id, retried.id, control.id])
  const mine = plan.items.filter((item: { id: string }) => ids.has(item.id))
  assert.equal(mine.filter((i: { classification: { disposition: string } }) => i.classification.disposition === 'SHADOW').length, 3, 'precondition')
  await d.db.accountingSyncLog.update({ where: { id: redated.id }, data: { createdAt: AFTER } })
  await d.db.accountingSyncLog.update({ where: { id: retried.id }, data: { attemptRevision: 1, retryCount: 1 } })
  const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope)
  const row = (id: string) => d.db.accountingSyncLog.findUnique({ where: { id }, select: { status: true, settlementBasis: true } })
  assert.deepEqual(await row(redated.id), { status: 'PENDING', settlementBasis: null })
  assert.equal(applied.outcomes.find((o: { item: { id: string } }) => o.item.id === redated.id)?.result, 'changed_since_plan')
  const retriedAfter = await row(retried.id)
  assert.notEqual(retriedAfter?.settlementBasis, 'HELD_SHADOW')
  assert.equal(retriedAfter?.status, 'FAILED')
  assert.equal((await row(control.id))?.settlementBasis, 'HELD_SHADOW')
})

test('PLAN -> APPLY (warehouse link): an order paid after the cut-off since planning keeps its queued link; an attempted link is parked, not deleted', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  const repaid = await seedLinkedOrder(d, `${tag}a`, BEFORE, {})
  const attempted = await seedLinkedOrder(d, `${tag}b`, BEFORE, {})
  t.after(async () => { for (const s of [repaid, attempted]) await cleanupLinked(d, s) })
  const scope = { destinations: ['mintsoft' as const], cutoffs: { mintsoft: CUTOFF }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const mine = plan.items.filter((item: { id: string }) => item.id === repaid.linkId || item.id === attempted.linkId)
  assert.equal(mine.length, 2)
  await d.db.salesOrder.update({ where: { id: repaid.orderId }, data: { paidAt: AFTER } })
  await d.db.wmsOrderPushLink.update({ where: { id: attempted.linkId }, data: { attempts: 1, lastAttemptAt: new Date() } })
  const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope)
  assert.equal(await d.db.wmsOrderPushLink.count({ where: { id: repaid.linkId } }), 1, 'the link of an order paid after the instant is IMS\'s own and stays')
  assert.equal(applied.outcomes.find((o: { item: { id: string } }) => o.item.id === repaid.linkId)?.result, 'changed_since_plan')
  assert.equal((await d.db.wmsOrderPushLink.findUnique({ where: { id: attempted.linkId }, select: { state: true } }))?.state, 'AMBIGUOUS_CREATE')
})

test('--all-queued ignores a configured cut-off in the plan AND the apply, and the scope it reports says so', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const old = await seedJob(d, `woocommerce:stock.push:${tag}-old`, BEFORE, { updatedAt: BEFORE })
  const fresh = await seedJob(d, `woocommerce:stock.push:${tag}-fresh`, AFTER, { updatedAt: AFTER })
  const base = { destinations: ['woocommerce' as const], cutoffs: { woocommerce: CUTOFF }, limit: 5000 }
  const ids = (plan: { items: Array<{ id: string }> }) => plan.items.filter((i) => i.id === old.id || i.id === fresh.id).map((i) => i.id).sort()
  assert.deepEqual(ids(await d.retire.planHeldBacklogRetirement({ ...base, allQueued: false })), [old.id], 'with a cut-off only the old job')
  const all = { ...base, allQueued: true }
  const plan = await d.retire.planHeldBacklogRetirement(all)
  assert.deepEqual(ids(plan), [old.id, fresh.id].sort(), 'allQueued: the configured cut-off does not narrow the plan')
  assert.equal(d.retire.effectiveRetirementCutoff(all, 'woocommerce'), null)
  const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: plan.items.filter((i: { id: string }) => i.id === fresh.id) }, all)
  assert.equal(applied.counts.shadowed, 1, 'and the apply does not refuse the newer job on the ignored cut-off')
})

// ───────────────── the durable attempt history: a replay or release must not make an attempted unit look unsent ─────────────────
//
// Named mutations (each shown red in the PR): h1 the classifier ignores firstAttemptedAt; h2 the hold branch withdraws the stamp unconditionally;
// h3 the link classifier ignores firstClaimedAt; h4 the Xero PARK guard demands null send evidence.

test('OUTBOX HISTORY through the real functions: an attempted job that is REPLAYED (attempts reset, error cleared) and then refused by the hold is PARKED; a job only ever refused by the hold is SHADOWED', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  // A hold text is recognised only with the installation's settings key (its reference is derived from it); the db tier may run without one.
  const savedKey = process.env.SETTINGS_ENCRYPTION_KEY
  if (!savedKey) process.env.SETTINGS_ENCRYPTION_KEY = 'prod_readiness_ci_settings_key__'
  t.after(() => { if (!savedKey) delete process.env.SETTINGS_ENCRYPTION_KEY })
  const held = (await import('../../lib/security/outbound-write-hold-constants.ts')).outboundHeldMessage({
    connector: 'woocommerce', code: 'no_grant', granted: null, attempted: null, method: 'PUT', target: 'https://shop.example.test/wp-json/x', hop: 0,
  })
  const make = async (name: string) => {
    const key = `woocommerce:stock.push:${tag}-${name}`
    const row = await d.outbox.enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key, payloadJson: { productId: key, reason: 'IMS_CHANGE', force: false } })
    await d.db.integrationOutbox.update({ where: { id: (row as { id: string }).id }, data: { createdAt: BEFORE } })
    return { key, id: (row as { id: string }).id }
  }
  const claim = async (key: string, worker: string) => (await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: worker }))[0]!
  const refuse = (row: { id: string; lockedAt: Date | null }, worker: string, error: string) => d.outbox.markIntegrationOutboxRetryableFailure({
    id: row.id, workerId: worker, lockedAt: row.lockedAt!, error, attemptsBeforeFailure: 0, retryDelayMs: 1000, noWriteSent: true,
  })
  const stamp = async (id: string) => d.db.integrationOutbox.findUnique({ where: { id }, select: { firstAttemptedAt: true, attemptHistoryTracked: true, attempts: true, status: true } })

  const heldOnly = await make('held-only')
  assert.deepEqual(await stamp(heldOnly.id).then((r: { firstAttemptedAt: Date | null; attemptHistoryTracked: boolean } | null) => [r?.attemptHistoryTracked, r?.firstAttemptedAt]), [true, null], 'a new row is tracked and unclaimed')
  const c1 = await claim(heldOnly.key, 'w1')
  assert.notEqual((await stamp(heldOnly.id))?.firstAttemptedAt, null, 'the claim stamps the first attempt')
  await refuse(c1, 'w1', held)
  const afterHold = await stamp(heldOnly.id)
  assert.deepEqual([afterHold?.firstAttemptedAt, afterHold?.attempts], [null, 0], 'a hold refusal that created the stamp withdraws it, and spends no attempt')

  const replayed = await make('replayed')
  const r1 = await claim(replayed.key, 'w2')
  await refuse(r1, 'w2', 'connect ECONNRESET while sending')           // a real failure: the request may have left
  assert.equal((await stamp(replayed.id))?.attempts, 1)
  await d.db.integrationOutbox.update({ where: { id: replayed.id }, data: { status: 'PERMANENT_FAILED', nextAttemptAt: null } })
  await withEnv({}, async () => { await d.admin.replayIntegrationOutboxAdminRow({ id: replayed.id }) })   // attempts -> 0, lastError -> null
  const r2 = await claim(replayed.key, 'w3')
  await refuse(r2, 'w3', held)                                        // and now only a hold refusal is left on the row
  const afterReplay = await d.db.integrationOutbox.findUnique({ where: { id: replayed.id }, select: { attempts: true, lastError: true, firstAttemptedAt: true, status: true } })
  console.log(`# replayed row: attempts=${afterReplay?.attempts} stamp=${afterReplay?.firstAttemptedAt ? 'kept' : 'cleared'} status=${afterReplay?.status}`)
  assert.equal(afterReplay?.attempts, 0, 'precondition: the visible fields now look exactly like a never-attempted job')
  assert.notEqual(afterReplay?.firstAttemptedAt, null, 'the stamp survived the replay and the later hold')

  const scope = { destinations: ['woocommerce' as const], cutoffs: { woocommerce: new Date(Date.now() + 60_000) }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const mine = plan.items.filter((item: { id: string }) => item.id === heldOnly.id || item.id === replayed.id)
  const by = (id: string) => mine.find((i: { id: string }) => i.id === id)?.classification.disposition
  assert.equal(by(heldOnly.id), 'SHADOW', 'CONTROL: only ever refused by the hold')
  assert.equal(by(replayed.id), 'PARK', 'attempted, replayed, then held: PARKED, never shadowed')
  const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope)
  assert.equal((await stamp(replayed.id))?.status, 'PERMANENT_FAILED')
  assert.equal((await stamp(heldOnly.id))?.status, 'SHADOWED')
  assert.equal(applied.counts.parked, 1)
})

test('XERO PARK with send evidence: a row naming a document id, and a row with a create-dispatch marker, are each PARKED with the unknown-outcome text (the guard is the OBSERVED evidence, not null)', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const withId = await seedSyncLog(d, `${tag}-id`, { createdAt: BEFORE, externalTransactionId: `X-${tag}` })
  const dispatched = await seedSyncLog(d, `${tag}-dispatch`, { createdAt: BEFORE })
  // The database refuses the pair on INSERT and makes it write-once on UPDATE: mint it the way the dispatch does, with an UPDATE.
  await d.db.accountingSyncLog.update({ where: { id: dispatched.id }, data: { createDispatchedAt: new Date(Date.now() - 3600_000), createDispatchIdempotencyKey: `dispatch-${tag}` } })
  const scope = { destinations: ['xero' as const], cutoffs: { xero: new Date(Date.now() + 60_000) }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const mine = plan.items.filter((item: { id: string }) => item.id === withId.id || item.id === dispatched.id)
  assert.deepEqual(mine.map((i: { classification: { disposition: string } }) => i.classification.disposition), ['PARK', 'PARK'])
  const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope)
  assert.deepEqual([applied.counts.parked, applied.counts.changed_since_plan], [2, 0], 'both land: neither is reported as changed since planning')
  for (const row of [withId, dispatched]) {
    const after = await d.db.accountingSyncLog.findUnique({ where: { id: row.id }, select: { status: true, errorMessage: true, settlementBasis: true } })
    assert.equal(after?.status, 'FAILED')
    assert.match(String(after?.errorMessage), /outcome unknown: check Xero before acting/)
    assert.notEqual(after?.settlementBasis, 'HELD_SHADOW')
  }
})

test('LINK HISTORY: a link that was claimed and then reset (attempts and attempt time cleared, as a release or replay does) is PARKED; the real claim stamps the history', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  const reset = await seedLinkedOrder(d, `${tag}r`, BEFORE, { firstClaimedAt: new Date(Date.now() - 86_400_000) })
  const claimed = await seedLinkedOrder(d, `${tag}c`, BEFORE, {})
  t.after(async () => { for (const s of [reset, claimed]) await cleanupLinked(d, s) })
  // The real claim on a link that has none: it stamps firstClaimedAt, then a release-style reset clears everything else.
  await d.db.wmsOrderPushLink.delete({ where: { id: claimed.linkId } })
  const port = d.sweep.createPrismaWmsOrderPushPort()
  const outcome = await port.claimForCreate(claimed.orderId, 'mintsoft', new Date())
  assert.equal(outcome, 'CLAIMED')
  const stamped = await d.db.wmsOrderPushLink.findUnique({ where: { orderId: claimed.orderId }, select: { id: true, firstClaimedAt: true, claimHistoryTracked: true } })
  assert.deepEqual([stamped?.claimHistoryTracked, stamped?.firstClaimedAt !== null], [true, true])
  await d.db.wmsOrderPushLink.update({ where: { id: stamped!.id }, data: { attempts: 0, lastAttemptAt: null, lastError: null, state: 'PENDING_CREATE' } })
  const scope = { destinations: ['mintsoft' as const], cutoffs: { mintsoft: CUTOFF }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const ids = new Set([reset.linkId, stamped!.id])
  const mine = plan.items.filter((item: { id: string }) => ids.has(item.id))
  assert.deepEqual(mine.map((i: { classification: { disposition: string } }) => i.classification.disposition), ['PARK', 'PARK'])
  await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope)
  for (const id of ids) assert.equal((await d.db.wmsOrderPushLink.findUnique({ where: { id }, select: { state: true } }))?.state, 'AMBIGUOUS_CREATE')
})

// ───────────── the history fails CLOSED in the database; a shared mirrored event is never voided over an unresolved sibling ─────────────
//
// Named mutations (each shown red in the PR): f1 the outbox/link triggers are dropped; f2 the false->true guard is dropped; f3 the sibling check
// ignores FAILED siblings; f4 the sibling check ignores send evidence on a CANCELLED sibling.

test('DATABASE GUARD (outbox): a claim by a binary that does not stamp forfeits the tracked flag, so replay then a hold refusal PARKS the job; the flag can never go false -> true by UPDATE', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const savedKey = process.env.SETTINGS_ENCRYPTION_KEY
  if (!savedKey) process.env.SETTINGS_ENCRYPTION_KEY = 'prod_readiness_ci_settings_key__'
  t.after(() => { if (!savedKey) delete process.env.SETTINGS_ENCRYPTION_KEY })
  const held = (await import('../../lib/security/outbound-write-hold-constants.ts')).outboundHeldMessage({
    connector: 'woocommerce', code: 'no_grant', granted: null, attempted: null, method: 'PUT', target: 'https://shop.example.test/wp-json/x', hop: 0,
  })
  const key = `woocommerce:stock.push:${tag}-old-binary`
  const row = (await d.outbox.enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key, payloadJson: { productId: key, reason: 'IMS_CHANGE', force: false } })) as { id: string }
  await d.db.integrationOutbox.update({ where: { id: row.id }, data: { createdAt: BEFORE } })
  const read = () => d.db.integrationOutbox.findUnique({ where: { id: row.id }, select: { attemptHistoryTracked: true, firstAttemptedAt: true, attempts: true, status: true } })
  assert.equal((await read())?.attemptHistoryTracked, true, 'precondition: created tracked')
  // An OLDER binary claims it: the status moves to PROCESSING and nothing writes the stamp.
  await d.db.integrationOutbox.update({ where: { id: row.id }, data: { status: 'PROCESSING', lockedAt: new Date(), lockedBy: 'old-binary' } })
  const afterOld = await read()
  console.log(`# old-binary claim: tracked=${afterOld?.attemptHistoryTracked} stamp=${afterOld?.firstAttemptedAt}`)
  assert.equal(afterOld?.attemptHistoryTracked, false, 'the database forfeited the history of an unstamped claim')
  await d.db.integrationOutbox.update({ where: { id: row.id }, data: { status: 'PERMANENT_FAILED', lockedAt: null, lockedBy: null, attempts: 5 } })
  await withEnv({}, async () => { await d.admin.replayIntegrationOutboxAdminRow({ id: row.id }) })    // attempts -> 0, error cleared
  const claimed = (await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'new-binary' }))[0]!
  await d.outbox.markIntegrationOutboxRetryableFailure({ id: row.id, workerId: 'new-binary', lockedAt: claimed.lockedAt!, error: held, attemptsBeforeFailure: 0, retryDelayMs: 1000, noWriteSent: true })
  const after = await read()
  assert.deepEqual([after?.attemptHistoryTracked, after?.attempts, after?.status], [false, 0, 'RETRYABLE_FAILED'], 'it now looks like a never-attempted job that was only held, but it is untracked')
  // The flag cannot be switched back on by an update (a replay, a re-arm or a careless script).
  await d.db.integrationOutbox.update({ where: { id: row.id }, data: { attemptHistoryTracked: true } })
  assert.equal((await read())?.attemptHistoryTracked, false, 'false -> true by UPDATE is refused')
  const scope = { destinations: ['woocommerce' as const], cutoffs: { woocommerce: new Date(Date.now() + 60_000) }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const item = plan.items.find((i: { id: string }) => i.id === row.id)
  assert.equal(item?.classification.disposition, 'PARK', 'PARKED, never shadowed')
  await d.retire.applyHeldBacklogRetirement({ ...plan, items: [item!] }, scope)
  assert.equal((await read())?.status, 'PERMANENT_FAILED')
})

test('DATABASE GUARD (link): an unstamped claim, an attempts increment or a warehouse id forfeits the claim history; the real claim stamps in the SAME statement and keeps it; false -> true is refused', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  const oldClaim = await seedLinkedOrder(d, `${tag}o`, BEFORE, {})
  const realClaim = await seedLinkedOrder(d, `${tag}n`, BEFORE, {})
  t.after(async () => { for (const s of [oldClaim, realClaim]) await cleanupLinked(d, s) })
  const read = (id: string) => d.db.wmsOrderPushLink.findUnique({ where: { id }, select: { claimHistoryTracked: true, firstClaimedAt: true } })
  assert.deepEqual(await read(oldClaim.linkId).then((r: { claimHistoryTracked: boolean } | null) => r?.claimHistoryTracked), true)
  await d.db.wmsOrderPushLink.update({ where: { id: oldClaim.linkId }, data: { lastAttemptAt: new Date() } })   // an older binary's claim: no stamp
  assert.equal((await read(oldClaim.linkId))?.claimHistoryTracked, false, 'forfeited')
  await d.db.wmsOrderPushLink.update({ where: { id: oldClaim.linkId }, data: { claimHistoryTracked: true, lastAttemptAt: null, attempts: 0 } })
  assert.equal((await read(oldClaim.linkId))?.claimHistoryTracked, false, 'false -> true refused, even after the attempt fields were reset')
  // The real claim on an existing tracked link with no stamp (the UPDATE branch) stamps and keeps the history.
  const outcome = await d.sweep.createPrismaWmsOrderPushPort().claimForCreate(realClaim.orderId, 'mintsoft', new Date())
  assert.equal(outcome, 'CLAIMED')
  const kept = await read(realClaim.linkId)
  assert.deepEqual([kept?.claimHistoryTracked, kept?.firstClaimedAt !== null], [true, true], 'a self-stamping claim is unaffected')
})

test('SHARED MIRRORED EVENT: a FAILED sibling attempt (with or without send evidence) blocks voiding the event; an inert CANCELLED sibling does not', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const payload = (ref: string) => ({ date: '2026-06-01', narration: ref, lines: [{ description: 'Inventory', accountCode: '630', debit: 5 }, { description: 'Allocated Inventory', accountCode: '631', credit: 5 }] })
  const refs = { failedBare: `${tag}-fb`, failedSent: `${tag}-fs`, inert: `${tag}-in`, cancelledSent: `${tag}-cs` }
  await withSettings(d, () => withEnv({}, async () => {
    for (const ref of Object.values(refs)) {
      await d.db.$transaction(async (tx: Tx) => { await d.accounting.queueAccountingSyncTxWithOutcome(tx, { type: 'UNEARNED_REV_REVERSAL', connector: 'xero', referenceType: 'CogsEntry', referenceId: ref, chartConnector: 'xero', payload: payload(ref) } as never) }, { timeout: 60_000 })
    }
  }))
  const queued = async (ref: string) => (await d.db.accountingSyncLog.findFirst({ where: { referenceId: ref }, select: { id: true, type: true, payload: true } }))!
  const rows = { failedBare: await queued(refs.failedBare), failedSent: await queued(refs.failedSent), inert: await queued(refs.inert), cancelledSent: await queued(refs.cancelledSent) }
  const sibling = (ref: string, over: Record<string, unknown>) => seedSyncLog(d, ref, { type: 'UNEARNED_REV_REVERSAL', referenceType: 'CogsEntry', payload: payload(ref), createdAt: BEFORE, ...over })
  await sibling(refs.failedBare, { status: 'FAILED', attemptRevision: 1, retryCount: 2 })
  await sibling(refs.failedSent, { status: 'FAILED', attemptRevision: 1, retryCount: 2, externalTransactionId: `X-${tag}` })
  await sibling(refs.inert, { status: 'CANCELLED' })
  await sibling(refs.cancelledSent, { status: 'CANCELLED', externalTransactionId: `X-${tag}-c` })
  const scope = { destinations: ['xero' as const], cutoffs: { xero: new Date(Date.now() + 60_000) }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const mine = plan.items.filter((item: { id: string }) => Object.values(rows).some((r) => r.id === item.id))
  assert.equal(mine.length, 4)
  const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope)
  const event = async (ref: string) => (await d.db.accountingEvent.findFirst({ where: { sourceEntityId: ref }, select: { status: true, voidBasis: true } }))
  const detail = (id: string) => applied.outcomes.find((o: { item: { id: string } }) => o.item.id === id)?.detail
  console.log(`# mirror: failedBare=${(await event(refs.failedBare))?.status} failedSent=${(await event(refs.failedSent))?.status} inert=${(await event(refs.inert))?.status}`)
  assert.notEqual((await event(refs.failedBare))?.status, 'VOID', 'a FAILED sibling has an unverified outcome')
  assert.notEqual((await event(refs.failedSent))?.status, 'VOID', 'and one with send evidence certainly does')
  assert.notEqual((await event(refs.cancelledSent))?.status, 'VOID', 'a CANCELLED sibling that names a document is not inert')
  assert.match(String(detail(rows.failedBare.id)), /mirrored accounting event was left untouched/)
  assert.match(String(detail(rows.failedSent.id)), /mirrored accounting event was left untouched/)
  assert.deepEqual([(await event(refs.inert))?.status, (await event(refs.inert))?.voidBasis], ['VOID', 'held_shadow'], 'CONTROL: an inert cancelled sibling does not block the retirement of the mirror')
})

test('HOLD REFUSAL IS ATOMIC: a replay and a second claim that land right after the hold worker\'s release cannot have the first-attempt stamp withdrawn from under them', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const savedKey = process.env.SETTINGS_ENCRYPTION_KEY
  if (!savedKey) process.env.SETTINGS_ENCRYPTION_KEY = 'prod_readiness_ci_settings_key__'
  t.after(() => { if (!savedKey) delete process.env.SETTINGS_ENCRYPTION_KEY })
  const held = (await import('../../lib/security/outbound-write-hold-constants.ts')).outboundHeldMessage({
    connector: 'woocommerce', code: 'no_grant', granted: null, attempted: null, method: 'PUT', target: 'https://shop.example.test/wp-json/x', hop: 0,
  })
  const key = `woocommerce:stock.push:${tag}-race`
  const row = (await d.outbox.enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key, payloadJson: { productId: key, reason: 'IMS_CHANGE', force: false } })) as { id: string }
  await d.db.integrationOutbox.update({ where: { id: row.id }, data: { createdAt: BEFORE } })
  const w1 = (await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'w1' }))[0]!
  // The hook runs the moment the FIRST update of the hold worker's release has executed: an operator replay and a second worker's claim land there.
  let interleaved = 0
  const real = d.db.integrationOutbox
  const hooked = {
    integrationOutbox: {
      findUnique: (a: unknown) => real.findUnique(a as never),
      findMany: (a: unknown) => real.findMany(a as never),
      create: (a: unknown) => real.create(a as never),
      updateMany: async (a: unknown) => {
        const result = await real.updateMany(a as never)
        if (interleaved === 0) {
          interleaved += 1
          await withEnv({}, async () => { await d.admin.replayIntegrationOutboxAdminRow({ id: row.id }) })
          await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'w2' })
        }
        return result
      },
    },
  }
  await d.outbox.markIntegrationOutboxRetryableFailure({ client: hooked as never, id: row.id, workerId: 'w1', lockedAt: w1.lockedAt!, error: held, attemptsBeforeFailure: 0, retryDelayMs: 1000, noWriteSent: true })
  const after = await d.db.integrationOutbox.findUnique({ where: { id: row.id }, select: { firstAttemptedAt: true, status: true, lockedBy: true, attemptHistoryTracked: true } })
  console.log(`# atomic hold: interleaved=${interleaved} stamp=${after?.firstAttemptedAt ? 'present' : 'absent'} holder=${after?.lockedBy}`)
  assert.equal(interleaved, 1, 'precondition: the interleave ran')
  assert.equal(after?.status, 'PROCESSING', 'the second worker holds the row')
  assert.notEqual(after?.firstAttemptedAt, null, 'the second worker may be sending: the stamp must not be withdrawn from under it')
  // While worker two holds the row it is not a retirement candidate at all (a fresh claim is skipped), so nothing can shadow it mid-send.
  const plan = await d.retire.planHeldBacklogRetirement({ destinations: ['woocommerce' as const], cutoffs: { woocommerce: new Date(Date.now() + 60_000) }, allQueued: false, limit: 5000 })
  assert.equal(plan.items.find((i: { id: string }) => i.id === row.id)?.classification.disposition, 'SKIP')
})

// ───────────── the cut-off is re-asked immediately before a claimed job sends (R5) ─────────────
//
// Named mutations (each shown red in the PR): c1 refuseClaimedJobBeforeCutoff never refuses; c2 the Xero fence statement drops the floor.

test('CLAIMED OUTBOX JOB: a claim taken with no floor in force is parked WITHOUT sending once the floor is in force (SHADOWED when this claim made the stamp, PERMANENT_FAILED otherwise); switch off is a no-op', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const make = async (name: string) => {
    const key = `woocommerce:stock.push:${tag}-${name}`
    const row = (await d.outbox.enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key, payloadJson: { productId: key, reason: 'IMS_CHANGE', force: false } })) as { id: string }
    await d.db.integrationOutbox.update({ where: { id: row.id }, data: { createdAt: BEFORE } })
    // Claimed while the switch is OFF (no floor), so the claim itself is not refused.
    const claimed = await withEnv({}, async () => (await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'w1' }))[0]!)
    return { id: row.id, claimed }
  }
  const fresh = await make('fresh')
  const earlier = await make('earlier')
  // `earlier` had been claimed before: its stamp is older than this claim.
  await d.db.integrationOutbox.update({ where: { id: earlier.id }, data: { firstAttemptedAt: new Date(Date.now() - 3600_000) } })
  const state = (id: string) => d.db.integrationOutbox.findUnique({ where: { id }, select: { status: true, lockedBy: true, lastError: true } })

  assert.equal(await withEnv({}, () => d.outbox.refuseClaimedJobBeforeCutoff(fresh.claimed, 'w1')), null, 'switch off: nothing refused, nothing written')
  assert.equal((await state(fresh.id))?.status, 'PROCESSING')

  await withEnv(wcLive(), async () => {
    const refused = await d.outbox.refuseClaimedJobBeforeCutoff(fresh.claimed, 'w1')
    assert.match(String(refused), /^Not sent by IMS: this was queued before writes to WooCommerce went live/)
    await d.outbox.refuseClaimedJobBeforeCutoff(earlier.claimed, 'w1')
  })
  assert.deepEqual([(await state(fresh.id))?.status, (await state(fresh.id))?.lockedBy], ['SHADOWED', null], 'this claim made the stamp and nothing left: proven unsent')
  assert.equal((await state(earlier.id))?.status, 'PERMANENT_FAILED', 'an earlier claim may have sent: parked with the check-the-destination sentence, never shadowed')
  assert.match(String((await state(earlier.id))?.lastError), /check WooCommerce before acting/)
  // A post-cutoff job is untouched.
  const later = await withEnv({}, async () => {
    const key = `woocommerce:stock.push:${tag}-later`
    await d.outbox.enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: undefined, idempotencyKey: key, payloadJson: { productId: key, reason: 'IMS_CHANGE', force: false } } as never)
    return (await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'w1' }))[0]!
  })
  await withEnv(wcLive(new Date(Date.now() - 60_000 * 60 * 24)), async () => {
    assert.equal(await d.outbox.refuseClaimedJobBeforeCutoff(later, 'w1'), null, 'created after the instant')
  })
})

test('XERO FENCE: a lease opened while no floor was in force refuses the remote write once the floor is in force (before-cutoff, nothing sent); the same row with the switch off still writes', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const row = await seedSyncLog(d, `${tag}-fence`, { createdAt: BEFORE, status: 'PROCESSING', attemptRevision: 1, processingStartedAt: new Date() })
  const claimedAt = (await d.db.accountingSyncLog.findUnique({ where: { id: row.id }, select: { processingStartedAt: true } }))!.processingStartedAt!
  const lease = await withEnv({}, async () => d.processor.openRemoteWriteLease(row.id, claimedAt))
  assert.ok(lease, 'precondition: the lease opened with no floor')
  const control = await withEnv({}, async () => lease!.fenceBeforeRemoteWrite('stock-receipt'))
  assert.equal(control.ok, true, 'CONTROL: switch off, the fence lets the write through')
  await withEnv(xeroLive(), async () => {
    const fenced = await lease!.fenceBeforeRemoteWrite('stock-receipt')
    console.log(`# fence under a floor: ${JSON.stringify({ ok: fenced.ok, reason: !fenced.ok ? fenced.result.notPosted?.reason : null })}`)
    assert.equal(fenced.ok, false)
    if (!fenced.ok) assert.equal(fenced.result.notPosted?.reason, 'before-cutoff')
  })
})

test('SERVER IDENTITY on a real connection: it is readable by an ordinary role, stable, and an apply whose connection is not the confirmed server aborts before touching a row', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const identity = await d.retire.readServerIdentity(d.db)
  const [name, systemId] = identity.split('@')
  console.log(`# identity: ${name}@<${systemId?.length} digits>`)
  assert.ok(name && /^\d{10,}$/.test(String(systemId)), 'database @ cluster system identifier')
  assert.equal(await d.retire.readServerIdentity(d.db), identity, 'stable')
  const job = await seedJob(d, `woocommerce:stock.push:${tag}-id`, BEFORE, { updatedAt: BEFORE })
  const scope = { destinations: ['woocommerce' as const], cutoffs: { woocommerce: new Date(Date.now() + 60_000) }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const mine = plan.items.filter((i: { id: string }) => i.id === job.id)
  await assert.rejects(d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope, { expectedIdentity: `${name}@1111111111111111111` }), /not the .* that was confirmed/)
  assert.equal((await d.db.integrationOutbox.findUnique({ where: { id: job.id }, select: { status: true } }))?.status, 'PENDING', 'nothing was changed')
  const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, scope, { expectedIdentity: identity })
  assert.equal(applied.counts.shadowed, 1, 'CONTROL: the right identity applies')
})

// ───────────── Mintsoft: the floor is re-derived under the claim lock and again immediately before the send (R7) ─────────────
//
// Named mutations (each shown red in the PR): m1 claimForCreate trusts the caller's floor; m2 the pre-send re-derivation is removed;
// s1 the status count includes the cut-off-exempt types.

const MS_ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'MINTSOFT_WRITE_ALLOWED', 'MINTSOFT_WRITES_LIVE_FROM']
async function seedMintsoftOrder(d: Deps, tag: string, paidAt: Date) {
  const warehouse = await d.db.warehouse.create({ data: { code: `${tag}-W`.slice(0, 20), name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const connection = await d.db.wmsConnection.create({ data: { connector: 'mintsoft', label: tag, active: true }, select: { id: true } })
  const binding = await d.db.externalWmsBinding.create({
    data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: `ext-${tag}`, active: true, stockSyncMode: 'ALIGN_TO_WMS', alignmentConfirmedAt: new Date() },
    select: { id: true },
  })
  const order = await d.db.salesOrder.create({
    data: {
      orderNumber: `MSC-${tag}`, status: 'PROCESSING', paidAt, shipFromWarehouseId: warehouse.id, customerName: 'Pat Example', customerEmail: 'pat@example.com',
      currency: 'GBP', shippingAddress: { line1: '1 Test Street', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
      subtotalForeign: 10, totalForeign: 10, subtotalBase: 10, totalBase: 10,
      lines: { create: [{ description: 'Widget', sku: `SKU-${tag}`, qty: 1, unitPriceForeign: 10, unitPriceBase: 10, totalForeign: 10, totalBase: 10 }] },
    },
    select: { id: true },
  })
  return { warehouseId: warehouse.id, connectionId: connection.id, bindingId: binding.id, orderId: order.id }
}
async function cleanupMintsoftOrder(d: Deps, s: { warehouseId: string; connectionId: string; bindingId: string; orderId: string }) {
  await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: s.orderId } })
  await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: s.orderId } })
  await d.db.salesOrderLine.deleteMany({ where: { orderId: s.orderId } })
  await d.db.salesOrder.deleteMany({ where: { id: s.orderId } })
  await d.db.externalWmsBinding.deleteMany({ where: { id: s.bindingId } })
  await d.db.wmsConnection.deleteMany({ where: { id: s.connectionId } })
  await d.db.warehouse.deleteMany({ where: { id: s.warehouseId } })
}
const msConnector = () => {
  const calls: string[] = []
  return {
    calls,
    connector: {
      pushOrder: async (input: { orderNumber: string }) => { calls.push(`pushOrder:${input.orderNumber}`); return { externalOrderId: 'wms-c-1', externalOrderNumber: 'WN-C-1', status: 'NEW' } },
      updateOrder: async () => ({ updated: true, status: 'NEW' }), cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
      addOrderComment: async () => undefined, verifyPushedOrder: async () => 'ours' as const, probeOrderPresence: async () => 'MISSING' as const,
    },
  }
}

test('MINTSOFT CREATE: a live-from instant that moves after the pass began is honoured under the claim lock AND again immediately before the send; with it unmoved the order is created', { skip }, async (t) => {
  const d = await deps()
  const tag = `msc${randomUUID().slice(0, 8)}`
  const seeded = await seedMintsoftOrder(d, tag, new Date('2026-06-10T00:00:00Z'))
  t.after(() => cleanupMintsoftOrder(d, seeded))
  const base = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft', MINTSOFT_WRITE_ALLOWED: 'https://wms.example.test|89', MINTSOFT_WRITES_LIVE_FROM: '2026-06-01T00:00:00Z' }
  const MOVED = '2026-06-20T00:00:00Z'   // after the order was paid, still in the past
  const real = d.sweep.createPrismaWmsOrderPushPort()
  const run = async (hook: 'none' | 'before-claim' | 'after-claim') => withEnv(base, async () => {
    const port = {
      ...real,
      verifyWithdrawalFence: async (id: string) => { if (hook === 'before-claim') process.env.MINTSOFT_WRITES_LIVE_FROM = MOVED; return real.verifyWithdrawalFence ? real.verifyWithdrawalFence(id) : true },
      claimForCreate: async (...args: Parameters<typeof real.claimForCreate>) => { const r = await real.claimForCreate(...args); if (hook === 'after-claim') process.env.MINTSOFT_WRITES_LIVE_FROM = MOVED; return r },
    }
    const double = msConnector()
    await d.sweep.runWmsOrderPushSweepCore(double.connector as never, 'mintsoft', port as never, { batchSize: 1000 })
    return double.calls.filter((c) => c.startsWith('pushOrder') && c.endsWith(`MSC-${tag}`))
  })
  const link = () => d.db.wmsOrderPushLink.findUnique({ where: { orderId: seeded.orderId }, select: { state: true, attempts: true, lastAttemptAt: true, firstClaimedAt: true, lastError: true } })

  assert.deepEqual(await run('before-claim'), [], 'moved before the claim: the claim, under the lock, refuses; nothing is sent')
  assert.equal(await link(), null, 'and no link was written')
  assert.deepEqual(await run('after-claim'), [], 'moved after the claim: the send is refused')
  const given = await link()
  console.log(`# given back: ${JSON.stringify(given && { state: given.state, lastAttemptAt: given.lastAttemptAt, claimed: given.firstClaimedAt !== null })}`)
  assert.equal(given?.state, 'PENDING_CREATE')
  assert.equal(given?.lastAttemptAt, null, 'the claim stamp is given back, as for a proven pre-send hold')
  assert.notEqual(given?.firstClaimedAt, null, 'the durable claim history stays: a later retirement parks it, never calls it unsent')
  assert.match(String(given?.lastError), /Check the warehouse before acting/)
  await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: seeded.orderId } })
  assert.deepEqual(await run('none'), [`pushOrder:MSC-${tag}`], 'CONTROL: nothing moved, the same order is created')
})

test('STATUS: pre-cutoff-queued does not count the Xero types the cut-off exempts (a PDF fetch, an e-mail)', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupSync(d, tag))
  const { readProducerCountsFromDatabase } = await import('../../lib/ops/outbound-producer-status.ts')
  const env = xeroLive()
  const read = async () => (await readProducerCountsFromDatabase({ destinations: ['xero'], now: new Date(), env })).byDestination.xero!.preCutoffQueued.syncLog
  const before = await withEnv(env, read)
  await seedSyncLog(d, `${tag}-pdf`, { createdAt: BEFORE, type: 'INVOICE_PDF' })
  await seedSyncLog(d, `${tag}-mail`, { createdAt: BEFORE, type: 'INVOICE_EMAIL' })
  assert.equal(await withEnv(env, read), before, 'exempt types are not counted')
  await seedSyncLog(d, `${tag}-journal`, { createdAt: BEFORE, type: 'STOCK_RECEIPT' })
  assert.equal(await withEnv(env, read), before + 1, 'CONTROL: a write type is')
})

// ───────────── a multi-write claim: once ANY write left, a later hold must not withdraw the first-attempt stamp (R8) ─────────────
//
// Named mutations (each shown red in the PR): k1 the hold branch withdraws without the zero-writes proof; k2 the transport does not count writes.

test('WRITE LEDGER: tracking sent, then the status request refused by the hold -> the stamp is kept and the job is PARKED, never shadowed; a hold with zero writes still withdraws it', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const savedKey = process.env.SETTINGS_ENCRYPTION_KEY
  if (!savedKey) process.env.SETTINGS_ENCRYPTION_KEY = 'prod_readiness_ci_settings_key__'
  t.after(() => { if (!savedKey) delete process.env.SETTINGS_ENCRYPTION_KEY })
  const { createWriteLedger, runInWriteLedger } = await import('../../lib/security/write-ledger.ts')
  const { noteRemoteWriteDispatched } = await import('../../lib/security/write-ledger.ts')
  const held = (await import('../../lib/security/outbound-write-hold-constants.ts')).outboundHeldMessage({
    connector: 'woocommerce', code: 'no_grant', granted: null, attempted: null, method: 'PUT', target: 'https://shop.example.test/wp-json/x', hop: 0,
  })
  const make = async (name: string) => {
    const key = `woocommerce:stock.push:${tag}-${name}`
    const row = (await d.outbox.enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key, payloadJson: { productId: key, reason: 'IMS_CHANGE', force: false } })) as { id: string }
    await d.db.integrationOutbox.update({ where: { id: row.id }, data: { createdAt: BEFORE } })
    const claimed = (await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'w1' }))[0]!
    return { id: row.id, claimed }
  }
  const sent = await make('tracking-sent')
  const none = await make('none-sent')

  // The completion attempt: the tracking write leaves (the transport counts it, tests/connectors/write-ledger.test.ts proves the hook), then the status
  // request is refused by the hold. A read does not count.
  const ledger = createWriteLedger()
  await runInWriteLedger(ledger, async () => { noteRemoteWriteDispatched('GET'); noteRemoteWriteDispatched('PUT') })
  assert.equal(ledger.writes, 1, 'the write that left was counted; the read was not')
  const idle = createWriteLedger()
  assert.equal(idle.writes, 0)

  // The status request is then refused by the hold; the drain reports the hold with the ledger's proof.
  await d.outbox.markIntegrationOutboxRetryableFailure({ id: sent.id, workerId: 'w1', lockedAt: sent.claimed.lockedAt!, error: held, attemptsBeforeFailure: 0, retryDelayMs: 1000, noWriteSent: Number(ledger.writes) === 0 })
  await d.outbox.markIntegrationOutboxRetryableFailure({ id: none.id, workerId: 'w1', lockedAt: none.claimed.lockedAt!, error: held, attemptsBeforeFailure: 0, retryDelayMs: 1000, noWriteSent: idle.writes === 0 })
  const read = (id: string) => d.db.integrationOutbox.findUnique({ where: { id }, select: { firstAttemptedAt: true, status: true, attempts: true } })
  assert.notEqual((await read(sent.id))?.firstAttemptedAt, null, 'a write left in this claim: the stamp is KEPT')
  assert.equal((await read(none.id))?.firstAttemptedAt, null, 'CONTROL: nothing left, so the hold-only job withdraws it')

  const scope = { destinations: ['woocommerce' as const], cutoffs: { woocommerce: new Date(Date.now() + 60_000) }, allQueued: false, limit: 5000 }
  const plan = await d.retire.planHeldBacklogRetirement(scope)
  const by = (id: string) => plan.items.find((i: { id: string }) => i.id === id)?.classification.disposition
  assert.equal(by(sent.id), 'PARK', 'held error, zero counted attempts, and still parked')
  assert.equal(by(none.id), 'SHADOW')
})

// ───────────── send-time rechecks judge the CURRENT row, not a snapshot (R9) ─────────────
//
// Named mutations (each shown red in the PR): p1 the Mintsoft hand-off judges the candidate snapshot; p2 the outbox refusal judges the claim's copy.

test('MINTSOFT CREATE: an order whose paid time is corrected to before the instant AFTER the claim is not created (the paid time is read afresh at the hand-off)', { skip }, async (t) => {
  const d = await deps()
  const tag = `msp${randomUUID().slice(0, 8)}`
  const seeded = await seedMintsoftOrder(d, tag, new Date('2026-06-10T00:00:00Z'))
  t.after(() => cleanupMintsoftOrder(d, seeded))
  const env = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft', MINTSOFT_WRITE_ALLOWED: 'https://wms.example.test|89', MINTSOFT_WRITES_LIVE_FROM: '2026-06-01T00:00:00Z' }
  const real = d.sweep.createPrismaWmsOrderPushPort()
  const run = (correctAfterClaim: boolean) => withEnv(env, async () => {
    const port = {
      ...real,
      claimForCreate: async (...args: Parameters<typeof real.claimForCreate>) => {
        const r = await real.claimForCreate(...args)
        if (correctAfterClaim) await d.db.salesOrder.update({ where: { id: seeded.orderId }, data: { paidAt: new Date('2026-05-01T00:00:00Z') } })   // a correction after the claim's lock was released
        return r
      },
    }
    const double = msConnector()
    await d.sweep.runWmsOrderPushSweepCore(double.connector as never, 'mintsoft', port as never, { batchSize: 1000 })
    return double.calls.filter((c) => c.endsWith(`MSC-${tag}`))
  })
  assert.deepEqual(await run(true), [], 'nothing is sent: the order is now paid before the instant')
  const link = await d.db.wmsOrderPushLink.findUnique({ where: { orderId: seeded.orderId }, select: { lastAttemptAt: true, firstClaimedAt: true } })
  assert.deepEqual([link?.lastAttemptAt, link?.firstClaimedAt !== null], [null, true], 'claim given back, durable history kept')
  await d.db.wmsOrderPushLink.deleteMany({ where: { orderId: seeded.orderId } })
  await d.db.salesOrder.update({ where: { id: seeded.orderId }, data: { paidAt: new Date('2026-06-10T00:00:00Z') } })
  assert.deepEqual(await run(false), [`pushOrder:MSC-${tag}`], 'CONTROL: no correction, the order is created')
})

test('OUTBOX: the send-time recheck judges the job\'s CURRENT creation time, not the copy the claim returned', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const key = `woocommerce:stock.push:${tag}-current`
  const row = (await d.outbox.enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key, payloadJson: { productId: key, reason: 'IMS_CHANGE', force: false } })) as { id: string }
  const claimed = await withEnv({}, async () => (await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'w1' }))[0]!)
  assert.ok(claimed.createdAt.getTime() > CUTOFF.getTime(), 'precondition: the claim\'s copy says the job is after the instant')
  await d.db.integrationOutbox.update({ where: { id: row.id }, data: { createdAt: BEFORE } })   // the row has since been corrected to before it
  await withEnv(wcLive(), async () => {
    assert.notEqual(await d.outbox.currentOutboxRowBeforeCutoff(claimed), null, 'judged on the current row')
    const refused = await d.outbox.refuseClaimedJobBeforeCutoff(claimed, 'w1')
    assert.match(String(refused), /^Not sent by IMS: this was queued before writes to WooCommerce went live/)
  })
  assert.equal((await d.db.integrationOutbox.findUnique({ where: { id: row.id }, select: { status: true } }))?.status, 'SHADOWED')
})

// ───────────── a live stock event arriving while an older job is held by a worker is not stranded by the cut-off (R10) ─────────────
//
// Named mutation (shown red in the PR): q1 the PROCESSING branch merges the payload without re-dating.

test('STOCK JOB IN FLIGHT: a live event merged into a job a worker holds re-dates it, so the worker\'s send-time check passes and the update is not stranded; identical payloads too; no floor changes nothing', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const claimNew = async (name: string) => {
    const productId = `${tag}-${name}`
    const key = `woocommerce:stock.push:${productId}`
    const row = (await d.outbox.enqueueIntegrationOutbox({ connector: 'woocommerce', operation: 'stock.push', idempotencyKey: key, payloadJson: { productId, reason: 'MANUAL', force: false } })) as { id: string }
    await d.db.integrationOutbox.update({ where: { id: row.id }, data: { createdAt: BEFORE } })
    // The worker claims it while no floor is in force (the cut-off transition happens during the claim).
    const claimed = await withEnv({}, async () => (await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'w1' }))[0]!)
    return { productId, id: row.id, claimed }
  }
  const differs = await claimNew('differs')
  const same = await claimNew('same')
  const off = await claimNew('off')
  const read = (id: string) => d.db.integrationOutbox.findUnique({ where: { id }, select: { createdAt: true, payloadJson: true, status: true } })

  await withEnv(wcLive(), async () => {
    await d.stock.enqueueWcStockSyncJobs([differs.productId], 'MANUAL', { force: true })   // a different payload
    await d.stock.enqueueWcStockSyncJobs([same.productId], 'MANUAL')                       // an identical one
    for (const j of [differs, same]) {
      const row = await read(j.id)
      assert.equal(row?.status, 'PROCESSING', 'still held by the worker')
      assert.ok(row!.createdAt.getTime() >= CUTOFF.getTime(), 're-dated by the live producer')
      assert.equal(await d.outbox.refuseClaimedJobBeforeCutoff(j.claimed, 'w1'), null, 'the worker, judging the current row, sends it')
    }
    assert.equal(((await read(differs.id))!.payloadJson as { force?: boolean }).force, true, 'the new payload was merged')
  })
  await withEnv({}, async () => {
    await d.stock.enqueueWcStockSyncJobs([off.productId], 'MANUAL', { force: true })
    assert.equal((await read(off.id))?.createdAt.getTime(), BEFORE.getTime(), 'CONTROL: no floor, nothing is re-dated (the legacy statement)')
  })
})

// ───────────── an identical payload merged during a claim is not proof the new event was handled (R11) ─────────────
//
// Named mutation (shown red in the PR): g1 completeClaimedJob takes an unchanged payload for completion without comparing the generation.

test('STOCK COMPLETION GENERATION: an event merged into the job while a worker held it (identical payload included) makes the completion REQUEUE it, not succeed; nothing merged completes; the switch off is the legacy completion', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanupJobs(d, `woocommerce:stock.push:${tag}`))
  const claim = async (name: string, env: Record<string, string>) => {
    const productId = `${tag}-${name}`
    const key = `woocommerce:stock.push:${productId}`
    await withEnv(env, async () => { await d.stock.enqueueWcStockSyncJobs([productId], 'MANUAL') })
    const claimed = await withEnv(env, async () => (await d.outbox.claimIntegrationOutboxWork({ connector: 'woocommerce', operation: 'stock.push', idempotencyKeys: [key], limit: 1, workerId: 'woocommerce-stock-sync' }))[0]!)
    return { productId, id: claimed.id, claimed }
  }
  const read = (id: string) => d.db.integrationOutbox.findUnique({ where: { id }, select: { status: true } })
  const live = wcLive(new Date(Date.now() - 3600_000))

  const merged = await claim('merged', live)
  await withEnv(live, async () => { await d.stock.enqueueWcStockSyncJobs([merged.productId], 'MANUAL') })   // the SAME payload, a new event, after the worker read the stock
  assert.equal(await d.stock.completeClaimedJob(merged.claimed), 'requeued', 'identical payload, but a newer generation: requeued')
  assert.equal((await read(merged.id))?.status, 'PENDING')

  const quiet = await claim('quiet', live)
  assert.equal(await d.stock.completeClaimedJob(quiet.claimed), 'succeeded', 'CONTROL: nothing merged, the claimed work is complete')

  const legacy = await claim('legacy', {})
  await withEnv({}, async () => { await d.stock.enqueueWcStockSyncJobs([legacy.productId], 'MANUAL') })
  assert.equal(await d.stock.completeClaimedJob(legacy.claimed), 'succeeded', 'CONTROL: switch off, an identical payload is handled exactly as before')
})
