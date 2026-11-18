import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { Prisma } from '../../app/generated/prisma/client'
import * as realSettingsStore from '../../lib/settings-store'

/**
 * THE TRACKSHIP RE-FIRE SWEEP AGAINST A REAL DATABASE: the state table, the outbox operation woocommerce/trackship.refire, the producer seam, the
 * attempt fence and the drain are real. ONLY the transport boundary (connectorFetch) is doubled, and it records every request, so "nothing was
 * sent" is an observed zero. The two WooCommerce settings the transport reads are supplied by the double; every other setting is the real one.
 * Nothing contacts any vendor (tests/no-outbound-network.cjs fails a test that tried).
 *
 * Committing, with its own cleanup, so it lives in the SERIAL concurrency tier. GATED on RUN_DB_CONCURRENCY_TESTS (npm run test:concurrency).
 *
 * Arms: OFF by default (no scan, no row, no request, with or without the hold); re-fire with the per-order back-off (5 min doubling) and its 24 h cap;
 * covered ends it; an order past the 7 day window is never asked about; the producer hold shadows (no row, a record, no request, the look not
 * spent); a failed request is a retry and is not asked twice; two concurrent scans queue one look; a switch turned off while a job waits sends nothing.
 */
const skip = process.env.RUN_DB_CONCURRENCY_TESTS !== '1'

const requests: Array<{ method: string; url: string; signature: string | null }> = []
let reply: () => Response = () => json({ ok: true, result: 'fired', missing: 1 })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
if (!skip) {
  mock.module('@/lib/security/connector-fetch', {
    namedExports: {
      connectorFetch: async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        requests.push({ method: init?.method ?? 'GET', url: String(url), signature: init?.headers?.['X-OTI-Signature'] ?? null })
        return reply()
      },
    },
  })
  mock.module('@/lib/settings-store', {
    namedExports: {
      ...realSettingsStore,
      getSettingValues: async (keys: string[]) => {
        const real = await realSettingsStore.getSettingValues(keys)
        const fixed: Record<string, string> = { wc_url: 'https://shop.example.test', wc_webhook_secret: 'shared-secret' }
        for (const key of keys) if (fixed[key] !== undefined) real.set(key, fixed[key]!)
        return real
      },
    },
  })
}

const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'WC_WRITEBACK_ALLOWED_ORIGIN', 'WC_WRITES_LIVE_FROM', 'MINTSOFT_WRITES_LIVE_FROM']
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const iso = (date: Date) => date.toISOString().replace(/\.\d+Z$/, 'Z')
const LIVE = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce', WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test', WC_WRITES_LIVE_FROM: iso(new Date(Date.now() - 60 * DAY)), MINTSOFT_WRITES_LIVE_FROM: iso(new Date(Date.now() - 60 * DAY)) }
const HELD = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce' }

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const key of ENV_KEYS) delete process.env[key]
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value
  }
}

async function setup() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
  const [{ db }, jobs, refire] = await Promise.all([
    import('../../lib/db'),
    import('../../lib/connectors/woocommerce/sync/trackship-refire-jobs'),
    import('../../lib/connectors/woocommerce/sync/trackship-refire'),
  ])
  return { db, jobs, refire }
}
type Deps = Awaited<ReturnType<typeof setup>>

async function setSwitch(d: Deps, value: string | null) {
  if (value === null) await d.db.setting.deleteMany({ where: { key: 'trackship_refire_enabled' } })
  else await d.db.setting.upsert({ where: { key: 'trackship_refire_enabled' }, create: { key: 'trackship_refire_enabled', value }, update: { value } })
}

/** A shipped, tracked order with a storefront link, despatched `shippedAgoMs` ago. */
async function seedOrder(d: Deps, shippedAgoMs = 2 * HOUR) {
  const suffix = randomUUID().slice(0, 8)
  return d.db.salesOrder.create({
    data: {
      orderNumber: `TSR-${suffix}`,
      status: 'SHIPPED',
      currency: 'GBP',
      fxRateToBase: new Prisma.Decimal('1'),
      subtotalForeign: new Prisma.Decimal('100'),
      totalForeign: new Prisma.Decimal('100'),
      subtotalBase: new Prisma.Decimal('100'),
      taxBase: new Prisma.Decimal('0'),
      totalBase: new Prisma.Decimal('100'),
      trackingNumber: `TRK${suffix}`,
      shippedAt: new Date(Date.now() - shippedAgoMs),
      shoppingLinks: { create: { connector: 'woocommerce', externalOrderId: `${900000 + Math.floor(Math.random() * 99999)}`, externalOrderNumber: suffix } },
    },
    select: { id: true, shoppingLinks: { select: { externalOrderId: true } } },
  })
}

async function cleanup(d: Deps, orderIds: string[]) {
  await d.db.integrationOutbox.deleteMany({ where: { OR: orderIds.map((id) => ({ idempotencyKey: { contains: id } })) } })
  await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { in: orderIds } } })
  await d.db.activityLog.deleteMany({ where: { entityId: { in: orderIds } } })
  await d.db.trackshipRefireState.deleteMany({ where: { orderId: { in: orderIds } } })
  await d.db.shoppingOrderLink.deleteMany({ where: { orderId: { in: orderIds } } })
  await d.db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
  await setSwitch(d, null)
  requests.length = 0
  reply = () => json({ ok: true, result: 'fired', missing: 1 })
}

/** The keys of every look an order could have, so the drain is scoped to the test's own orders (other files share this database). */
const keysFor = (d: Deps, orderIds: string[]) => orderIds.flatMap((id) => Array.from({ length: 30 }, (_, i) => d.jobs.wcTrackshipRefireIdempotencyKey(id, i + 1)))

/** Scan and drain ONLY these orders. */
async function tickFor(d: Deps, orderIds: string[], now?: Date) {
  const scan = await d.jobs.enqueueTrackshipRefires({ orderIds, now })
  const run = await d.jobs.runWcTrackshipRefireJobs({ idempotencyKeys: keysFor(d, orderIds), now })
  return { scan, ...run }
}

const stateOf = (d: Deps, orderId: string) => d.db.trackshipRefireState.findUnique({ where: { orderId } })
const jobsFor = (d: Deps, orderId: string) => d.db.integrationOutbox.findMany({ where: { connector: 'woocommerce', operation: 'trackship.refire', payloadJson: { path: ['orderId'], equals: orderId } } })
/** Make the order's next look due now. */
const makeDue = (d: Deps, orderId: string) => d.db.trackshipRefireState.update({ where: { orderId }, data: { nextAttemptAt: new Date(Date.now() - MIN) } })

test('OFF BY DEFAULT: with the setting unset nothing is scanned, queued, claimed or sent, hold or no hold', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, null)
  for (const env of [{}, HELD, LIVE]) {
    await withEnv(env, async () => {
      const tick = await d.jobs.processWcTrackshipRefires({ idempotencyKeys: undefined, limit: 1 })
      assert.equal(tick.reason, 'trackship_refire_disabled')
      assert.deepEqual([tick.claimed, tick.succeeded, tick.retried], [0, 0, 0])
      assert.deepEqual(await d.jobs.enqueueTrackshipRefires({ orderIds: [order.id] }), { registered: 0, expired: 0, queued: 0, shadowed: 0, inFlight: 0 })
    })
  }
  await setSwitch(d, 'yes')
  await withEnv(LIVE, async () => assert.equal((await d.jobs.enqueueTrackshipRefires({ orderIds: [order.id] })).registered, 0, 'anything but an explicit true is off'))
  assert.equal(await d.db.trackshipRefireState.count({ where: { orderId: order.id } }), 0)
  assert.equal((await jobsFor(d, order.id)).length, 0)
  assert.equal(await d.db.outboundShadowWrite.count({ where: { subjectId: order.id } }), 0, 'off means no shadow record either')
  assert.equal(requests.length, 0)
})

test('LIVE: a shipped order with no TrackShip shipment is re-fired once, signed, at the companion plugin route, and the next look waits at least an hour', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    reply = () => json({ ok: true, result: 'fired', missing: 1 })
    const tick = await tickFor(d, [order.id])
    assert.equal(tick.scan.registered, 1)
    assert.equal(tick.scan.queued, 1, 'despatched 2 hours ago, so its first look (an hour after despatch) is already due')
    assert.equal(tick.succeeded, 1)
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.method, 'POST')
    assert.equal(requests[0]!.url, `https://shop.example.test/wp-json/oti/v1/order/${order.shoppingLinks[0]!.externalOrderId}/trackship-refire`)
    assert.match(requests[0]!.signature ?? '', /^[0-9a-f]{64}$/)
    const state = await stateOf(d, order.id)
    assert.equal(state?.status, 'ACTIVE')
    assert.equal(state?.attempts, 1)
    assert.equal(state?.lastResult, 'fired')
    assert.ok((state?.nextAttemptAt.getTime() ?? 0) >= Date.now() + 59 * MIN, 'after a fire the next look waits for TrackShip\'s background job')
    const jobs = await jobsFor(d, order.id)
    assert.deepEqual(jobs.map((job) => job.status), ['SUCCEEDED'])
    // An immediate second pass asks nothing: the look is not due.
    const again = await tickFor(d, [order.id])
    assert.deepEqual([again.scan.queued, again.claimed], [0, 0])
    assert.equal(requests.length, 1)
  })
})

test('a recently shipped order is registered but not asked about before its first look (an hour after despatch)', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d, 20 * MIN)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    const tick = await tickFor(d, [order.id])
    assert.deepEqual([tick.scan.registered, tick.scan.queued, tick.claimed], [1, 0, 0])
    assert.equal(requests.length, 0)
    const state = await stateOf(d, order.id)
    const wait = (state?.nextAttemptAt.getTime() ?? 0) - Date.now()
    assert.ok(wait > 35 * MIN && wait <= 41 * MIN, `first look about 40 minutes away, was ${Math.round(wait / MIN)}`)
  })
})

test('BACK-OFF AND CAP: each look waits 5 min, 10, 20, 40 ... doubling, and never more than 24 hours', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    // TrackShip's own gate refuses the order every time, so the only thing that moves the next look is the back-off itself.
    reply = () => json({ ok: true, result: 'not_eligible', missing: 1 })
    const delays: number[] = []
    for (let look = 1; look <= 13; look++) {
      if (look > 1) await makeDue(d, order.id)
      const tick = await tickFor(d, [order.id])
      assert.equal(tick.succeeded, 1, `look ${look} was asked`)
      const state = await stateOf(d, order.id)
      assert.equal(state?.attempts, look)
      assert.equal(state?.lastResult, 'not-eligible')
      delays.push(Math.round(((state?.nextAttemptAt.getTime() ?? 0) - (state?.lastAttemptAt?.getTime() ?? 0)) / MIN))
    }
    assert.deepEqual(delays, [5, 10, 20, 40, 80, 160, 320, 640, 1280, 1440, 1440, 1440, 1440])
    assert.equal(requests.length, 13, 'one request per look, never more')
  })
})

test('COVERED ends it: the storefront reports TrackShip holds every shipment, and the order is never asked about again', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    reply = () => json({ ok: true, result: 'fired', missing: 1 })
    await tickFor(d, [order.id])
    reply = () => json({ ok: true, result: 'covered', missing: 0 })
    await makeDue(d, order.id)
    const second = await tickFor(d, [order.id])
    assert.equal(second.succeeded, 1)
    assert.equal((await stateOf(d, order.id))?.status, 'COVERED')
    const before = requests.length
    await d.db.trackshipRefireState.update({ where: { orderId: order.id }, data: { nextAttemptAt: new Date(Date.now() - MIN) } })
    const third = await tickFor(d, [order.id])
    assert.deepEqual([third.scan.queued, third.claimed], [0, 0])
    assert.equal(requests.length, before, 'no request for a covered order')
  })
})

test('THE WINDOW: an order despatched more than 7 days ago is never registered, and a registered one that ages out is closed without a request', { skip }, async (t) => {
  const d = await setup()
  const old = await seedOrder(d, 8 * DAY)
  const ageing = await seedOrder(d, 2 * HOUR)
  t.after(() => cleanup(d, [old.id, ageing.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    reply = () => json({ ok: true, result: 'not_eligible', missing: 1 })
    await tickFor(d, [old.id, ageing.id])
    assert.equal(await d.db.trackshipRefireState.count({ where: { orderId: old.id } }), 0, 'never registered')
    assert.equal(requests.length, 1, 'only the recent order was asked about')
    await d.db.salesOrder.update({ where: { id: ageing.id }, data: { shippedAt: new Date(Date.now() - 8 * DAY) } })
    await makeDue(d, ageing.id)
    const tick = await tickFor(d, [ageing.id])
    assert.equal(tick.scan.expired, 1)
    assert.equal((await stateOf(d, ageing.id))?.status, 'EXPIRED')
    assert.equal(requests.length, 1, 'no request for an order past the window')
  })
})

test('THE PRODUCER HOLD: held, the scan leaves a shadow record and no job, the look is not spent, the drain claims nothing, nothing is sent', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, 'true')
  await withEnv(HELD, async () => {
    const tick = await tickFor(d, [order.id])
    assert.deepEqual([tick.scan.registered, tick.scan.queued, tick.scan.shadowed], [1, 0, 1])
    assert.equal(tick.claimed, 0)
    assert.equal((await jobsFor(d, order.id)).length, 0, 'a shadow leaves no job')
    assert.ok(await d.db.outboundShadowWrite.count({ where: { subjectId: order.id } }) >= 1, 'a shadow record says what was not sent')
    assert.equal(requests.length, 0, 'nothing left IMS')
    assert.equal((await stateOf(d, order.id))?.attempts, 0, 'a held look is not a look')
  })
  // A job that was queued before the hold stood stays exactly as it is while it stands: the drain claims nothing.
  await withEnv(LIVE, async () => {
    await makeDue(d, order.id)
    await d.jobs.enqueueTrackshipRefires({ orderIds: [order.id] })
    assert.equal((await jobsFor(d, order.id)).length, 1)
  })
  await withEnv(HELD, async () => {
    const run = await d.jobs.runWcTrackshipRefireJobs({ idempotencyKeys: keysFor(d, [order.id]) })
    assert.equal(run.claimed, 0)
    assert.equal(requests.length, 0)
    assert.equal((await jobsFor(d, order.id))[0]?.status, 'PENDING')
  })
})

test('A FAILED REQUEST is a retry of the same job: it is not asked a second time while that job is unsettled', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    reply = () => json({ code: 'rest_no_route' }, 404)
    const tick = await tickFor(d, [order.id])
    assert.deepEqual([tick.claimed, tick.succeeded, tick.retried], [1, 0, 1])
    assert.match(tick.errors[0] ?? '', /1\.4\.0/, 'a plugin too old to have the route says so')
    assert.equal((await jobsFor(d, order.id))[0]?.status, 'RETRYABLE_FAILED')
    assert.equal(requests.length, 1)
    await makeDue(d, order.id)
    const again = await d.jobs.enqueueTrackshipRefires({ orderIds: [order.id] })
    assert.deepEqual([again.queued, again.inFlight], [0, 1])
    assert.equal((await jobsFor(d, order.id)).length, 1, 'still one job')
  })
})

test('TWO CONCURRENT SCANS queue one look (repeated: one pass proves nothing about a race)', { skip }, async (t) => {
  const d = await setup()
  const orders = await Promise.all([seedOrder(d), seedOrder(d), seedOrder(d)])
  const ids = orders.map((order) => order.id)
  t.after(() => cleanup(d, ids))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    for (let round = 0; round < 3; round++) {
      await Promise.all([d.jobs.enqueueTrackshipRefires({ orderIds: ids }), d.jobs.enqueueTrackshipRefires({ orderIds: ids })])
      for (const id of ids) {
        const state = await stateOf(d, id)
        assert.ok((state?.attempts ?? 0) <= 1, 'never two looks for one due time')
        assert.ok((await jobsFor(d, id)).length <= 1)
      }
    }
    for (const id of ids) assert.equal((await jobsFor(d, id)).length, 1)
  })
})

test('a switch turned off while a job waits: the job is settled without a request, and nothing is sent until it is switched on again', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    await d.jobs.enqueueTrackshipRefires({ orderIds: [order.id] })
    assert.equal((await jobsFor(d, order.id)).length, 1)
    await setSwitch(d, 'false')
    const run = await d.jobs.runWcTrackshipRefireJobs({ idempotencyKeys: keysFor(d, [order.id]) })
    assert.deepEqual([run.claimed, run.succeeded], [1, 1])
    assert.equal(requests.length, 0, 'no request while the switch is off')
    assert.equal((await stateOf(d, order.id))?.lastResult ?? null, null)
  })
})

test('REGRESSION: a job that waited past the 7 day window is settled at SEND time without a request (retries, or a Replay from Sync exceptions)', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d, 6 * DAY + 23 * HOUR)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    // The scan judged it inside the window and queued the look; nothing is sent yet.
    await d.jobs.enqueueTrackshipRefires({ orderIds: [order.id] })
    assert.equal((await jobsFor(d, order.id)).length, 1)
    // The job waits (a failing store, a parked row replayed later); the order's despatch is now more than 7 days old.
    await d.db.salesOrder.update({ where: { id: order.id }, data: { shippedAt: new Date(Date.now() - 7 * DAY - HOUR) } })
    const run = await d.jobs.runWcTrackshipRefireJobs({ idempotencyKeys: keysFor(d, [order.id]) })
    assert.deepEqual([run.claimed, run.succeeded], [1, 1])
    assert.equal(requests.length, 0, 'nothing sent after the window')
    const state = await stateOf(d, order.id)
    assert.equal(state?.status, 'EXPIRED')
    assert.equal(state?.lastResult, 'window-closed')
  })
})

test('REGRESSION: an order that was erased, or is no longer shipped, is settled at send time without a request', { skip }, async (t) => {
  const d = await setup()
  const erased = await seedOrder(d)
  const cancelled = await seedOrder(d)
  t.after(() => cleanup(d, [erased.id, cancelled.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    await d.jobs.enqueueTrackshipRefires({ orderIds: [erased.id, cancelled.id] })
    await d.db.salesOrder.update({ where: { id: erased.id }, data: { erasedAt: new Date() } })
    await d.db.salesOrder.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } })
    const run = await d.jobs.runWcTrackshipRefireJobs({ idempotencyKeys: keysFor(d, [erased.id, cancelled.id]) })
    assert.deepEqual([run.claimed, run.succeeded], [2, 2])
    assert.equal(requests.length, 0)
  })
})

test('the storefront refusing an order past the window (outside_window) closes it: no further asks', { skip }, async (t) => {
  const d = await setup()
  const order = await seedOrder(d)
  t.after(() => cleanup(d, [order.id]))
  await setSwitch(d, 'true')
  await withEnv(LIVE, async () => {
    reply = () => json({ ok: true, result: 'outside_window', missing: 1 })
    await tickFor(d, [order.id])
    assert.equal(requests.length, 1)
    assert.equal((await stateOf(d, order.id))?.status, 'EXPIRED')
    await makeDue(d, order.id)
    await tickFor(d, [order.id])
    assert.equal(requests.length, 1)
  })
})
