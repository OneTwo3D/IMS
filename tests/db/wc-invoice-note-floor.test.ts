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
  const [{ db }, processor, outbox, retire] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/connectors/xero/sync-processor.ts'),
    import('../../lib/domain/integrations/outbox.ts'),
    import('../../lib/domain/outbound-shadow/retire-held-backlog.ts'),
  ])
  return { db, processor, outbox, retire }
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
  await d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { startsWith: prefix } } })
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

// ---- The delivery half (the `xero/accounting.post` outbox job) and the retirement follow the row's destination, in both cut-off orders -------

const ORDERS = [
  { name: 'WooCommerce goes live FIRST', xero: new Date(Date.now() - DAY), woo: new Date(Date.now() - 3 * DAY) },
  { name: 'Xero goes live FIRST', xero: new Date(Date.now() - 3 * DAY), woo: new Date(Date.now() - DAY) },
] as const
const envFor = (order: (typeof ORDERS)[number]) => ({ ...bothLive, XERO_WRITES_LIVE_FROM: iso(order.xero), WC_WRITES_LIVE_FROM: iso(order.woo) })
const MIDDLE = new Date(Date.now() - 2 * DAY) // between the two instants in both orders
const OLDEST = new Date(Date.now() - 5 * DAY) // before both
const NEWEST = new Date(Date.now() - 60_000) // after both

async function seedJob(d: Deps, tag: string, syncLogId: string, createdAt: Date) {
  return d.db.integrationOutbox.create({
    data: {
      connector: 'xero', operation: 'accounting.post', idempotencyKey: `${tag}-job-${syncLogId}`, payloadJson: { accountingSyncLogId: syncLogId },
      status: 'PENDING', attempts: 0, createdAt, attemptHistoryTracked: true,
    } as never,
    select: { id: true, idempotencyKey: true },
  })
}

for (const order of ORDERS) {
  test(`OUTBOX CLAIM, ${order.name}: the delivery job of a note is floored by the WooCommerce instant, a Xero row's job by the Xero one, whichever is later`, { skip }, async (t) => {
    const d = await deps()
    const tag = tagOf()
    t.after(() => cleanup(d, tag))
    const cases = [
      { key: 'note-middle', type: 'WC_INVOICE_NOTE', at: MIDDLE, wooLive: order.woo.getTime() <= MIDDLE.getTime() },
      { key: 'note-oldest', type: 'WC_INVOICE_NOTE', at: OLDEST, wooLive: false },
      { key: 'note-newest', type: 'WC_INVOICE_NOTE', at: NEWEST, wooLive: true },
      { key: 'bill-middle', type: 'BILL_PAYMENT', at: MIDDLE, wooLive: order.xero.getTime() <= MIDDLE.getTime() },
      { key: 'bill-oldest', type: 'BILL_PAYMENT', at: OLDEST, wooLive: false },
      { key: 'bill-newest', type: 'BILL_PAYMENT', at: NEWEST, wooLive: true },
    ]
    const jobs: Array<{ key: string; id: string; idempotencyKey: string; expectClaimed: boolean; rowId: string }> = []
    for (const c of cases) {
      const row = await seed(d, `${tag}-${c.key}`, c.type, c.at)
      const job = await seedJob(d, tag, row.id, c.at)
      jobs.push({ key: c.key, id: job.id, idempotencyKey: job.idempotencyKey, expectClaimed: c.wooLive, rowId: row.id })
    }
    await withEnv(envFor(order), async () => {
      const claimed = await d.outbox.claimIntegrationOutboxWork({
        connector: 'xero', operation: 'accounting.post', idempotencyKeys: jobs.map((j) => j.idempotencyKey), workerId: 'p1c-note-floor', limit: 20,
      })
      const claimedIds = new Set(claimed.map((job: { id: string }) => job.id))
      const got = Object.fromEntries(jobs.map((j) => [j.key, claimedIds.has(j.id)]))
      console.log(`# ${order.name}: claimed ${JSON.stringify(got)}`)
      for (const j of jobs) assert.equal(claimedIds.has(j.id), j.expectClaimed, `${j.key}: claimed=${claimedIds.has(j.id)}, expected ${j.expectClaimed}`)
      // The final fence asks the same question about the claim's own job (a Xero job whose row writes to WooCommerce is judged by the WooCommerce instant).
      for (const j of jobs) {
        const job = await d.db.integrationOutbox.findUniqueOrThrow({ where: { id: j.id } })
        const refused = await d.outbox.currentOutboxRowBeforeCutoff(job)
        assert.equal(refused === null, j.expectClaimed, `${j.key}: fence refused=${refused !== null}`)
      }
    })
    await withEnv({}, async () => {
      const again = await d.outbox.claimIntegrationOutboxWork({
        connector: 'xero', operation: 'accounting.post', idempotencyKeys: jobs.filter((j) => !j.expectClaimed).map((j) => j.idempotencyKey), workerId: 'p1c-note-floor', limit: 20,
      })
      assert.equal(again.length, jobs.filter((j) => !j.expectClaimed).length, 'CONTROL, switch off: every refused job is claimable again (legacy)')
    })
  })

  test(`RETIREMENT, ${order.name}: a note is selected and attributed by WooCommerce's instant, a Xero row by Xero's; a note between the instants is never cancelled; the apply re-derives the same`, { skip }, async (t) => {
    const d = await deps()
    const tag = tagOf()
    t.after(() => cleanup(d, tag))
    const rows = {
      noteOldest: await seed(d, `${tag}-note-oldest`, 'WC_INVOICE_NOTE', OLDEST),
      noteMiddle: await seed(d, `${tag}-note-middle`, 'WC_INVOICE_NOTE', MIDDLE),
      billOldest: await seed(d, `${tag}-bill-oldest`, 'BILL_PAYMENT', OLDEST),
      billMiddle: await seed(d, `${tag}-bill-middle`, 'BILL_PAYMENT', MIDDLE),
    }
    const jobs = {
      noteOldest: await seedJob(d, tag, rows.noteOldest.id, OLDEST),
      noteMiddle: await seedJob(d, tag, rows.noteMiddle.id, MIDDLE),
      billOldest: await seedJob(d, tag, rows.billOldest.id, OLDEST),
    }
    const scope = { destinations: ['xero', 'woocommerce'] as const, cutoffs: { xero: order.xero, woocommerce: order.woo }, allQueued: false, limit: 5000 }
    const plan = await d.retire.planHeldBacklogRetirement({ ...scope, destinations: [...scope.destinations] })
    const mineIds = new Set<string>([...Object.values(rows).map((r) => r.id), ...Object.values(jobs).map((j) => j.id)])
    const mine = plan.items.filter((item: { id: string }) => mineIds.has(item.id))
    const destinationOf = (id: string) => mine.find((item: { id: string }) => item.id === id)?.destination
    console.log(`# ${order.name}: plan ${JSON.stringify(Object.fromEntries(Object.entries({ ...rows, ...jobs }).map(([k, v]) => [k, destinationOf(v.id) ?? null])))}`)
    // A note is planned only under WooCommerce, only when created before the WooCommerce instant; never under Xero.
    assert.equal(destinationOf(rows.noteOldest.id), 'woocommerce')
    assert.equal(destinationOf(jobs.noteOldest.id), 'woocommerce', 'its delivery half is WooCommerce\'s too')
    const middleBeforeWoo = MIDDLE.getTime() < order.woo.getTime()
    assert.equal(destinationOf(rows.noteMiddle.id), middleBeforeWoo ? 'woocommerce' : undefined, 'a note between the instants is selected only if it predates the WooCommerce instant')
    assert.equal(destinationOf(jobs.noteMiddle.id), middleBeforeWoo ? 'woocommerce' : undefined)
    assert.equal(destinationOf(rows.billOldest.id), 'xero')
    assert.equal(destinationOf(jobs.billOldest.id), 'xero')
    assert.equal(destinationOf(rows.billMiddle.id), MIDDLE.getTime() < order.xero.getTime() ? 'xero' : undefined)
    const applied = await d.retire.applyHeldBacklogRetirement({ ...plan, items: mine }, { ...scope, destinations: [...scope.destinations] })
    console.log(`# applied: ${JSON.stringify(applied.counts)}`)
    const status = async (id: string) => (await d.db.accountingSyncLog.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
    assert.equal(await status(rows.noteOldest.id), 'CANCELLED')
    assert.equal(await status(rows.billOldest.id), 'CANCELLED')
    assert.equal(await status(rows.noteMiddle.id), middleBeforeWoo ? 'CANCELLED' : 'PENDING', 'a note created after the WooCommerce instant is NEVER cancelled by a Xero retirement')
    const shadows = await d.db.outboundShadowWrite.findMany({ where: { subjectId: { startsWith: tag } }, select: { destination: true, subjectId: true } })
    for (const shadow of shadows) {
      assert.equal(shadow.destination, shadow.subjectId.includes('-note-') ? 'woocommerce' : 'xero', `${shadow.subjectId}: attributed to the destination it writes to`)
    }
    assert.ok(shadows.some((shadow: { subjectId: string }) => shadow.subjectId.includes('-note-oldest')) && shadows.some((shadow: { subjectId: string }) => shadow.subjectId.includes('-bill-oldest')))
    // The apply re-derives under the row lock: a plan item forced onto the WRONG destination changes nothing.
    const forced = { ...plan, items: plan.items.filter((item: { id: string }) => item.id === rows.noteMiddle.id).map((item: object) => ({ ...item, destination: 'xero' })) }
    const wrong = await d.retire.applyHeldBacklogRetirement(forced as never, { ...scope, destinations: [...scope.destinations] })
    assert.equal(wrong.outcomes.every((outcome: { result: string }) => outcome.result === 'changed_since_plan' || outcome.result === 'left_alone'), true)
    assert.equal(await status(rows.noteMiddle.id), middleBeforeWoo ? 'CANCELLED' : 'PENDING')
  })
}
