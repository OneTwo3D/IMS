import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * THE WOOCOMMERCE PRODUCER SEAM AGAINST A REAL DATABASE: THE DIFFERENTIAL, THE SHADOW STORE, THE TRANSACTION, THE DRAIN AND RETENTION.
 *
 * Drives the REAL entry points (the stock enqueue behind the facade, the in-transaction order-job schedule, the stock drain) with
 * the switch OFF, with the switch ON and no grant (the P0/P1 posture), and reads the rows each run leaves: the outbox, and the
 * outbound_shadow_writes record that is the only evidence a WooCommerce shadow has (there is no sync-log row). The store is never
 * contacted: the URL is a placeholder, and in the ON arms the seam stops everything before the transport; in the OFF arms the
 * stock-sync setting is off so the push is refused at its first gate, before any request (the tests/no-outbound-network.cjs trap
 * would fail a test that tried).
 *
 * Fixtures are unique per run and removed afterwards; the settings the enqueue reads are put back as they were.
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 *
 * Named mutations (shown red in the PR, restored from a copy, md5-verified):
 *  a  outbox-queues-a-shadow      the enqueue creates the row anyway: the "no outbox row" arms go red
 *  c  drop-the-unique-key         the shadow upsert becomes a plain insert: the repeat and the concurrent arms go red
 *  g  shadow-outside-the-tx       the shadow is written on the pool instead of the caller's transaction: the rollback arm goes red
 *  h  retention-deletes-shadows   purgeExpiredData also deletes outbound_shadow_writes: the retention arm goes red
 *  d  drain-claims-while-held     the stock drain stops asking the hold: the drain arm goes red
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1: tests/db/woocommerce-producer-seam.test.ts would have been skipped.')
}

const ENV_KEYS = ['PRODUCER_HOLD_ENFORCED_DESTINATIONS', 'WC_WRITEBACK_ALLOWED_ORIGIN', 'WC_WRITES_LIVE_FROM']
const ON = { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'woocommerce' }
const SETTINGS = [
  ['plugin_woocommerce_enabled', 'true'], ['wc_url', 'https://store.example.invalid'], ['wc_consumer_key', 'ck_probe'], ['wc_consumer_secret', 'cs_probe'],
  ['wc_stock_sync_enabled', 'false'],
] as const
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function deps() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const [{ db }, shopping, stockJobs, completion, statusJobs, record, retention] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/shopping.ts'),
    import('../../lib/connectors/woocommerce/sync/stock-sync-jobs.ts'),
    import('../../lib/connectors/woocommerce/sync/order-completion-jobs.ts'),
    import('../../lib/connectors/woocommerce/sync/order-status-jobs.ts'),
    import('../../lib/domain/outbound-shadow/record.ts'),
    import('../../lib/data-retention.ts'),
  ])
  return { db, shopping, stockJobs, completion, statusJobs, record, retention }
}
type Deps = Awaited<ReturnType<typeof deps>>

async function withEnv<T>(values: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, values)
  try { return await fn() } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

async function withSettings<T>(db: Deps['db'], fn: () => Promise<T>): Promise<T> {
  const before = await db.setting.findMany({ where: { key: { in: SETTINGS.map(([key]) => key) } } })
  for (const [key, value] of SETTINGS) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  try { return await fn() } finally {
    for (const [key] of SETTINGS) {
      const prior = before.find((row: { key: string }) => row.key === key)
      if (prior) await db.setting.update({ where: { key }, data: { value: prior.value } })
      else await db.setting.deleteMany({ where: { key } })
    }
  }
}

async function cleanup(d: Deps, ids: string[]): Promise<void> {
  for (const id of ids) {
    await d.db.integrationOutbox.deleteMany({ where: { idempotencyKey: { contains: id } } })
    await d.db.outboundShadowWrite.deleteMany({ where: { subjectId: { contains: id } } })
  }
}

const outboxFor = (d: Deps, id: string) => d.db.integrationOutbox.findMany({ where: { idempotencyKey: { contains: id } }, select: { id: true, status: true, attempts: true, lockedAt: true, operation: true } })
const shadowsFor = (d: Deps, id: string) => d.db.outboundShadowWrite.findMany({
  where: { subjectId: { contains: id } },
  select: { destination: true, operation: true, subjectType: true, subjectId: true, occurrences: true, reason: true, owner: true, phase: true, grantState: true, payloadDigest: true, firstProducedAt: true },
})

test('STOCK ENQUEUE through the facade: OFF queues the row (the control); ON queues nothing, records one shadow per product, and counts a repeat', { skip }, async (t) => {
  const d = await deps()
  const id = `wcs-${randomUUID()}`
  const other = `wcs-${randomUUID()}`
  t.after(() => cleanup(d, [id, other]))
  await withSettings(d.db, async () => {
    await withEnv({}, async () => {
      await d.shopping.enqueueStockSync([id], 'IMS_CHANGE')
      const rows = await outboxFor(d, id)
      console.log(`# OFF: outbox rows=${JSON.stringify(rows.map((r) => [r.operation, r.status, r.attempts]))} shadows=${(await shadowsFor(d, id)).length}`)
      assert.equal(rows.length, 1, 'CONTROL: with the switch off the stock change is queued exactly as before')
      assert.equal(rows[0]!.operation, 'stock.push')
      assert.equal((await shadowsFor(d, id)).length, 0)
    })
    await cleanup(d, [id])
    await withEnv(ON, async () => {
      await d.shopping.enqueueStockSync([id, other], 'IMS_CHANGE')
      await d.shopping.enqueueStockSync([id], 'IMS_CHANGE')
      const rows = [...await outboxFor(d, id), ...await outboxFor(d, other)]
      const shadows = await shadowsFor(d, id)
      const otherShadows = await shadowsFor(d, other)
      console.log(`# ON: outbox rows=${rows.length} shadows(${id})=${JSON.stringify(shadows.map((s) => [s.operation, s.subjectType, s.occurrences, s.reason, s.owner, s.phase, s.grantState]))}`)
      assert.equal(rows.length, 0, 'no queued row for either product')
      assert.equal(otherShadows.length, 1, 'precondition: the seam ran for the second product')
      assert.equal(shadows.length, 1, 'the same work produced twice is ONE record')
      assert.equal(shadows[0]!.occurrences, 2, '...that counts the repeat')
      assert.deepEqual([shadows[0]!.destination, shadows[0]!.operation, shadows[0]!.subjectType], ['woocommerce', 'stock', 'Product'])
      assert.deepEqual([shadows[0]!.reason, shadows[0]!.owner, shadows[0]!.phase, shadows[0]!.grantState], ['no_grant', 'qoblex-native', 'P1', 'absent'])
      assert.match(shadows[0]!.payloadDigest, /^[0-9a-f]{64}$/)
    })
  })
})

test('ORDER JOBS inside a REAL transaction: the shadow commits WITH the business change and rolls back WITH it; OFF queues the job', { skip }, async (t) => {
  const d = await deps()
  const id = `wco-${randomUUID()}`
  t.after(() => cleanup(d, [id]))
  // The order's storefront link is the one thing the schedule reads that needs a sales order; stand it in, keeping the real
  // outbox and shadow tables and the real transaction.
  const withLink = (tx: Tx): Tx => new Proxy(tx, { get: (target, prop) => (prop === 'shoppingOrderLink' ? { findFirst: async () => ({ id: 'link' }) } : Reflect.get(target, prop)) })
  const shippedAt = new Date('2026-06-01T00:00:00Z')
  await withEnv({}, async () => {
    const key = await d.db.$transaction(async (tx: Tx) => d.completion.scheduleWcOrderCompletion(withLink(tx), { orderId: id, shippedAt }), { timeout: 60_000 })
    assert.match(String(key), /^woocommerce:order\.complete:/, 'CONTROL: OFF returns the key')
    assert.equal((await outboxFor(d, id)).length, 1)
  })
  await cleanup(d, [id])
  await withEnv(ON, async () => {
    const committed = await d.db.$transaction(async (tx: Tx) => {
      const shipped = await d.completion.scheduleWcOrderCompletion(withLink(tx), { orderId: id, shippedAt })
      const cancelled = await d.statusJobs.scheduleWcOrderCancel(withLink(tx), { orderId: id, flippedAt: shippedAt })
      return [shipped, cancelled]
    }, { timeout: 60_000 })
    assert.deepEqual(committed, [null, null])
    assert.equal((await outboxFor(d, id)).length, 0)
    const shadows = await shadowsFor(d, id)
    console.log(`# ON committed: shadows=${JSON.stringify(shadows.map((s) => [s.operation, s.subjectType, s.occurrences]))}`)
    assert.equal(shadows.length, 2, 'completion and cancel are different work on the same order: one record each')
    assert.ok(shadows.every((s) => s.operation === 'order.status' && s.subjectType === 'SalesOrder'))
    assert.notEqual(shadows[0]!.payloadDigest, shadows[1]!.payloadDigest)
    await cleanup(d, [id])
    // ROLLBACK: the business change fails after the shadow; the shadow goes with it (it is evidence of work that did not happen).
    await assert.rejects(d.db.$transaction(async (tx: Tx) => {
      await d.completion.scheduleWcOrderCompletion(withLink(tx), { orderId: id, shippedAt })
      assert.equal((await tx.outboundShadowWrite.count({ where: { subjectId: id } })), 1, 'precondition: visible inside the transaction')
      throw new Error('the shipment failed after the schedule')
    }, { timeout: 60_000 }), /the shipment failed/)
    assert.equal((await shadowsFor(d, id)).length, 0, 'rolled back with the business change')
  })
})

test('STOCK DRAIN: a row queued BEFORE enforcement is switched on is not claimed, no attempt is spent; OFF it is claimed (the control)', { skip }, async (t) => {
  const d = await deps()
  const id = `wcd-${randomUUID()}`
  t.after(() => cleanup(d, [id]))
  await withSettings(d.db, async () => {
    const queue = async () => {
      await d.db.integrationOutbox.create({
        data: { connector: 'woocommerce', operation: 'stock.push', idempotencyKey: `woocommerce:stock.push:${id}`, payloadJson: { productId: id, reason: 'IMS_CHANGE', force: false, webhookQty: null }, status: 'PENDING', attempts: 0, nextAttemptAt: new Date(Date.now() - 1000) },
      })
    }
    await queue()
    await withEnv(ON, async () => {
      const summary = await d.stockJobs.processQueuedWcStockSyncJobs({ productIds: [id], limit: 10 })
      const rows = await outboxFor(d, id)
      console.log(`# held drain: ${JSON.stringify(summary)} row=${JSON.stringify(rows.map((r) => [r.status, r.attempts, r.lockedAt]))}`)
      assert.equal(summary.held, true)
      assert.deepEqual(rows.map((r) => [r.status, r.attempts, r.lockedAt]), [['PENDING', 0, null]])
    })
    await withEnv({}, async () => {
      const summary = await d.stockJobs.processQueuedWcStockSyncJobs({ productIds: [id], limit: 10 })
      const rows = await outboxFor(d, id)
      console.log(`# control drain (OFF): ${JSON.stringify(summary)} row=${JSON.stringify(rows.map((r) => [r.status, r.attempts]))}`)
      assert.equal(summary.processed, 1, 'CONTROL: the same drain claims the same row when the switch is off')
      assert.notDeepEqual(rows.map((r) => [r.status, r.attempts]), [['PENDING', 0]])
    })
  })
})

test('CONCURRENCY: eight producers of the same work make ONE shadow row counting eight, never a lost update or a duplicate', { skip }, async (t) => {
  const d = await deps()
  const id = `wcc-${randomUUID()}`
  t.after(() => cleanup(d, [id]))
  const decision = { disposition: 'SHADOW', reason: 'no_grant', owner: 'qoblex-native', phase: 'P1', cutoff: null, grant: 'absent' } as never
  const results = await Promise.all(Array.from({ length: 8 }, () => d.record.recordOutboundShadow(d.db, {
    destination: 'woocommerce', operation: 'stock', subjectType: 'Product', subjectId: id, payload: { productId: id }, decision,
  })))
  const shadows = await shadowsFor(d, id)
  console.log(`# concurrent: rows=${shadows.length} occurrences=${shadows[0]?.occurrences} inserted=${results.filter((r) => r.inserted).length}`)
  assert.equal(shadows.length, 1)
  assert.equal(shadows[0]!.occurrences, 8)
  assert.equal(results.filter((r) => r.inserted).length, 1, 'exactly one producer created it')
})

test('RETENTION: the shadow record of a WooCommerce push (its only evidence) survives the real retention sweep, aged far past every window', { skip }, async (t) => {
  const d = await deps()
  const id = `wcr-${randomUUID()}`
  t.after(() => cleanup(d, [id]))
  await withEnv(ON, async () => {
    const { wooProducerSeam } = await import('../../lib/connectors/woocommerce/producer-seam.ts')
    const answer = await wooProducerSeam({ operation: 'stock', subjectType: 'Product', subjectId: id, payload: { productId: id } })
    assert.equal(answer.proceed, false, 'precondition: the seam recorded a shadow through the pooled client')
  })
  const old = new Date(Date.now() - 2000 * 24 * 3600 * 1000)
  await d.db.outboundShadowWrite.updateMany({ where: { subjectId: id }, data: { firstProducedAt: old, lastProducedAt: old } })
  const purged = await d.retention.purgeExpiredData()
  const after = await shadowsFor(d, id)
  console.log(`# retention ran (${Object.keys(purged).length} counters); aged shadow records remaining: ${after.length}`)
  assert.equal(after.length, 1)
  assert.ok(after[0]!.firstProducedAt.getTime() < Date.now() - 1500 * 24 * 3600 * 1000, 'precondition: the row really is older than every retention window')
})

test('SEPARATE EVIDENCE STATE: a WooCommerce shadow is never read as a Xero posting - the durable-evidence reader the destructive Xero guards use does not see it', { skip }, async (t) => {
  const d = await deps()
  const id = `wcx-${randomUUID()}`
  t.after(() => cleanup(d, [id]))
  const { findDurableShadowRecords } = await import('../../lib/domain/outbound-shadow/durable-evidence.ts')
  const decision = { disposition: 'SHADOW', reason: 'no_grant', owner: 'woo-mintsoft-plugin', phase: 'P1', cutoff: null, grant: 'absent' } as never
  // The same subject (a sales order id) shadowed for BOTH destinations.
  await d.record.recordOutboundShadow(d.db, { destination: 'woocommerce', operation: 'order.status', subjectType: 'SalesOrder', subjectId: id, payload: { a: 1 }, decision })
  const wooOnly = await findDurableShadowRecords(d.db as never, 'xero', [{ subjectType: 'SalesOrder', exactIds: [id] }])
  assert.deepEqual(wooOnly, [], 'a WooCommerce shadow does not make an order look shadowed for Xero')
  await d.record.recordOutboundShadow(d.db, { destination: 'xero', operation: 'sales.invoice', subjectType: 'SalesOrder', subjectId: id, payload: { a: 1 }, decision })
  const both = await findDurableShadowRecords(d.db as never, 'xero', [{ subjectType: 'SalesOrder', exactIds: [id] }])
  assert.deepEqual(both.map((r) => r.operation), ['sales.invoice'], 'only the Xero record answers the Xero question')
  const woo = await findDurableShadowRecords(d.db as never, 'woocommerce', [{ subjectType: 'SalesOrder', exactIds: [id] }])
  assert.deepEqual(woo.map((r) => r.operation), ['order.status'])
})

test('UNIVERSAL: nothing in app/, lib/ or scripts/ deletes from outbound_shadow_writes (the evidence is never expired by code)', () => {
  const root = process.cwd()
  const offenders: string[] = []
  let files = 0
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.next', 'generated', 'archive'].includes(name)) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (['.ts', '.tsx', '.mjs', '.sql'].includes(extname(name))) {
        files += 1
        const text = readFileSync(p, 'utf8')
        if (/outboundShadowWrite\s*\.\s*(delete|deleteMany)\b|DELETE\s+FROM\s+"?outbound_shadow_writes"?|TRUNCATE[^;]*outbound_shadow_writes/i.test(text)) offenders.push(relative(root, p))
      }
    }
  }
  for (const dir of ['app', 'lib', 'scripts']) walk(join(root, dir))
  console.log(`# scanned ${files} files; offenders: ${JSON.stringify(offenders)}`)
  assert.ok(files > 800, `precondition: the scan reached the tree (${files} files)`)
  assert.deepEqual(offenders, [])
  // CONTROL: the detector sees a delete when there is one.
  assert.match('await db.outboundShadowWrite.deleteMany({})', /outboundShadowWrite\s*\.\s*(delete|deleteMany)\b/)
})
