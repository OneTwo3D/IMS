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
      status: 'PENDING', attempts: 0, createdAt, ...over,
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
  const created = await d.db.wmsOrderPushLink.create({ data: { orderId: order.id, connector: 'mintsoft', state: 'PENDING_CREATE', ...link } as never, select: { id: true } })
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
