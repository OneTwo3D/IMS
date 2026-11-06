import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE WOOCOMMERCE INVOICE NOTE IS FLOORED BY THE WOOCOMMERCE LIVE-FROM INSTANT, AGAINST A REAL DATABASE.
 *
 * A WC_INVOICE_NOTE is an accounting sync-log row whose destination is WooCommerce. WooCommerce and Xero go live at different
 * instants, so the note's claim, selection and last check use the WooCommerce one. Each layer is tested in isolation (the claim
 * statement, the shared selection predicate, the last check before the transport), with Xero live earlier than WooCommerce so a row
 * created between the two instants tells the two floors apart. Also here: the boundary between the producer's decision time and the
 * stamped creation time (a row decided LIVE is never stamped before the instant). Nothing contacts any vendor: every layer under test
 * refuses before a transport call, and tests/no-outbound-network.cjs fails a test that tried.
 *
 * Fixtures are unique per run and removed afterwards. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  note-floored-by-xero       the fragment floors the note by the Xero instant: the between-instants arms go red
 *  b  note-unfloored             the Woo clause is dropped from the fragment: the pre-instant arms go red
 *  c  guard-reads-xero-only      the last-check guard reverts to the Xero floor alone: the last-check arm goes red
 *  d  boundary-stamp-before      createdAt is stamped before the decision time: the boundary arm goes red
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/wc-invoice-note-floor.test.ts would have been skipped.')
}

const TENANT = '4f7f0c6e-1111-4222-8333-944455556666'
const ENV_KEYS = [
  'PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'XERO_WRITE_ALLOWED_TENANT', 'XERO_WRITES_LIVE_FROM', 'WC_WRITEBACK_ALLOWED_ORIGIN', 'WC_WRITES_LIVE_FROM',
]
const DAY = 86_400_000
// Xero went live three days ago, WooCommerce one day ago: a row from two days ago is after the first and before the second.
const XERO_AT = new Date(Date.now() - 3 * DAY)
const WOO_AT = new Date(Date.now() - DAY)
const BEFORE_BOTH = new Date(Date.now() - 5 * DAY)
const BETWEEN = new Date(Date.now() - 2 * DAY)
const AFTER_BOTH = new Date(Date.now() - 60_000)
const iso = (date: Date) => date.toISOString().replace(/\.\d+Z$/, 'Z')
const bothLive = {
  PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero,woocommerce', XERO_WRITE_ALLOWED_TENANT: TENANT, XERO_WRITES_LIVE_FROM: iso(XERO_AT),
  WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: iso(WOO_AT),
}

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, processor, outbox] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
    import('../../lib/domain/integrations/outbox.ts'),
  ])
  return { db, processor, outbox }
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

const tagOf = () => `wn${randomUUID().slice(0, 8)}`

async function seed(d: Deps, referenceId: string, type: string, createdAt: Date) {
  return d.db.accountingSyncLog.create({
    data: {
      connector: 'xero', type, status: 'PENDING', referenceType: 'SalesOrder', referenceId,
      payload: { referenceId, date: '2026-06-01' }, attemptStampingCustodyAt: new Date(), createdAt,
    } as never,
    select: { id: true },
  })
}

async function cleanup(d: Deps, prefix: string) {
  await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { startsWith: prefix } } })
  await d.db.accountingSyncLog.deleteMany({ where: { referenceId: { startsWith: prefix } } })
}

const staleCutoff = () => new Date(Date.now() - 15 * 60_000)
const claim = (d: Deps, row: { id: string }, type: string) => d.processor.claimAccountingSyncLog(
  { id: row.id, type: type as never, referenceType: 'SalesOrder', referenceId: 'x', attemptRevision: 0 }, new Date(), staleCutoff(), { id: row.id, attemptRevision: 1 },
)

test('NOTE CLAIM STATEMENT: refused before the WooCommerce instant even though Xero is already live; claimed after it; a Xero row between the two instants is claimed', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanup(d, tag))
  const early = await seed(d, `${tag}-early`, 'WC_INVOICE_NOTE', BEFORE_BOTH)
  const between = await seed(d, `${tag}-between`, 'WC_INVOICE_NOTE', BETWEEN)
  const late = await seed(d, `${tag}-late`, 'WC_INVOICE_NOTE', AFTER_BOTH)
  const xeroBetween = await seed(d, `${tag}-xero-between`, 'BILL_PAYMENT', BETWEEN)
  const xeroEarly = await seed(d, `${tag}-xero-early`, 'BILL_PAYMENT', BEFORE_BOTH)
  const control = await seed(d, `${tag}-control`, 'WC_INVOICE_NOTE', BETWEEN)
  await withEnv(bothLive, async () => {
    const outcomes = {
      early: (await claim(d, early, 'WC_INVOICE_NOTE')).outcome,
      between: (await claim(d, between, 'WC_INVOICE_NOTE')).outcome,
      late: (await claim(d, late, 'WC_INVOICE_NOTE')).outcome,
      xeroBetween: (await claim(d, xeroBetween, 'BILL_PAYMENT')).outcome,
      xeroEarly: (await claim(d, xeroEarly, 'BILL_PAYMENT')).outcome,
    }
    console.log(`# note claim: ${JSON.stringify(outcomes)}`)
    assert.equal(outcomes.early, 'not-claimable')
    assert.equal(outcomes.between, 'not-claimable', 'created after the Xero instant but before the WooCommerce one: still its former writer\'s')
    assert.equal(outcomes.late, 'claimed')
    assert.equal(outcomes.xeroBetween, 'claimed', 'the same creation time is past the Xero instant for a Xero write')
    assert.equal(outcomes.xeroEarly, 'not-claimable')
    const untouched = await d.db.accountingSyncLog.findUnique({ where: { id: between.id }, select: { status: true, attemptRevision: true, processingStartedAt: true } })
    assert.deepEqual([untouched?.status, untouched?.attemptRevision, untouched?.processingStartedAt], ['PENDING', 0, null], 'the refused note was not touched at all')
  })
  await withEnv({}, async () => {
    assert.equal((await claim(d, control, 'WC_INVOICE_NOTE')).outcome, 'claimed', 'CONTROL, switch off: the same between-instants note is claimed (legacy)')
  })
  await withEnv({ ...bothLive, PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'xero' }, async () => {
    const row = await seed(d, `${tag}-xero-only`, 'WC_INVOICE_NOTE', BEFORE_BOTH)
    assert.equal((await claim(d, row, 'WC_INVOICE_NOTE')).outcome, 'claimed', 'WooCommerce not enforced: no WooCommerce floor, and the Xero floor does not govern the note')
  })
})

test('NOTE SELECTION: pre-instant notes do not occupy the oldest-first window, so a later note is reached; Xero rows are unaffected by the WooCommerce instant', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanup(d, tag))
  for (let i = 0; i < 4; i++) await seed(d, `${tag}-pre-${i}`, 'WC_INVOICE_NOTE', new Date(BEFORE_BOTH.getTime() + i))
  const late = await seed(d, `${tag}-late`, 'WC_INVOICE_NOTE', AFTER_BOTH)
  const xeroOld = await seed(d, `${tag}-xero-old`, 'BILL_PAYMENT', BETWEEN)
  await withEnv(bothLive, async () => {
    const where = { AND: [{ referenceId: { startsWith: tag } }, d.processor.claimableXeroSyncLogWhere(new Date(), staleCutoff(), XERO_AT)] }
    const rows = await d.db.accountingSyncLog.findMany({ where: where as never, orderBy: { createdAt: 'asc' }, take: 2, select: { id: true } })
    console.log(`# window of 2: ${rows.map((row) => row.id).join(',')}`)
    assert.deepEqual(rows.map((row) => row.id).sort(), [late.id, xeroOld.id].sort())
  })
  await withEnv({}, async () => {
    const where = { AND: [{ referenceId: { startsWith: tag } }, d.processor.claimableXeroSyncLogWhere(new Date(), staleCutoff(), null)] }
    const rows = await d.db.accountingSyncLog.findMany({ where: where as never, orderBy: { createdAt: 'asc' }, take: 2, select: { referenceId: true } })
    assert.ok(rows.every((row) => row.referenceId.includes('-pre-')), 'CONTROL, no floor: the old rows occupy the window (the starvation the floor removes)')
  })
})

test('NOTE LAST CHECK BEFORE THE TRANSPORT: processClaimedEntry on a note created before the WooCommerce instant returns before-cutoff and sends nothing; a later one goes on', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  t.after(() => cleanup(d, tag))
  const between = await seed(d, `${tag}-between`, 'WC_INVOICE_NOTE', BETWEEN)
  const late = await seed(d, `${tag}-late`, 'WC_INVOICE_NOTE', AFTER_BOTH)
  const lease = { fenceBeforeRemoteWrite: async () => { throw new Error('reached the pre-write fence') } } as never
  const run = (row: { id: string }, ref: string) => d.processor.processClaimedEntry(
    row.id, 'WC_INVOICE_NOTE' as never, 'SalesOrder', ref, { referenceId: ref, date: iso(AFTER_BOTH).slice(0, 10) }, lease, { attemptRevision: 1 } as never,
  ).then((result) => ({ result, threw: null as string | null }), (error) => ({ result: null, threw: String(error) }))
  await withEnv(bothLive, async () => {
    const refused = await run(between, `${tag}-between`)
    console.log(`# last check: ${JSON.stringify(refused.result)?.slice(0, 160)} threw=${refused.threw}`)
    assert.equal(refused.result?.notPosted?.reason, 'before-cutoff')
    assert.match(String(refused.result?.error), /went live on this installation/)
    assert.match(String(refused.result?.error), /WooCommerce/)
    const passed = await run(late, `${tag}-late`)
    assert.notEqual(passed.result?.notPosted?.reason, 'before-cutoff', 'CONTROL: a note created after the instant is not refused by the last check')
  })
})

test('BOUNDARY: a job the producer decided LIVE is never stamped before the instant the decision went live (no live-decided job strands as pre-cut-off)', { skip }, async (t) => {
  const d = await deps()
  const tag = tagOf()
  const keys: string[] = []
  t.after(async () => { await d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { in: keys } } }) })
  const instant = new Date(Date.now() + 150)
  const live = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: instant.toISOString() }
  let queued = 0
  let shadowed = 0
  await withEnv(live, async () => {
    // Enqueue continuously across the instant. Before it every decision is a shadow; from it every decision is live. A live-decided row
    // must carry a creation time at or after the instant: the decision clock and the stamping clock are both this process's.
    for (let i = 0; Date.now() < instant.getTime() + 120 && i < 5000; i++) {
      const key = `${tag}-${i}`
      const answer = await d.outbox.enqueueIntegrationOutbox({
        connector: 'woocommerce', operation: 'order.cancel', idempotencyKey: key, payloadJson: { orderId: key },
        producer: { subjectType: 'SalesOrder', subjectId: key, obligationAt: new Date() },
      })
      if ('shadowed' in answer) { shadowed += 1; continue }
      keys.push(key)
      queued += 1
      assert.ok(answer.createdAt.getTime() >= instant.getTime(), `row ${key} decided LIVE was stamped ${answer.createdAt.toISOString()}, before the instant ${instant.toISOString()}`)
      assert.equal(d.outbox.outboxRowBeforeCutoff(answer, { now: new Date() }), null, 'and the floor does not refuse it')
    }
  })
  await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { startsWith: tag } } })
  console.log(`# boundary: shadowed=${shadowed} queued=${queued}`)
  assert.ok(shadowed > 0 && queued > 0, 'PRECONDITION: the loop crossed the instant (both kinds of decision were made)')
})
