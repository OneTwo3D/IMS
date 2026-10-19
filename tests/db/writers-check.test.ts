import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { config } from 'dotenv'

import { evaluateWritersCheck, readWritersCheckInputs } from '../../lib/ops/writers-check'
import { runWritersCheckRecord } from '../../lib/ops/writers-check-record'
import { recordWcIncumbentEvidence } from '../../lib/domain/incumbent-evidence/record'
import { WRITERS_CHECK_RECORD_ACTION } from '../../lib/security/writers-check-constants'

/**
 * `writers:check` AGAINST A REAL DATABASE, WITH A CONSTRUCTED DOUBLE CLAIM, AND A LOCAL LISTENER ONLY.
 *
 * The unit tests prove the rule over injected readings. What they cannot show is that the reader's SQL runs against the real
 * schema, that the storefront recorder's single-statement upsert is idempotent under concurrent deliveries, and that the whole
 * command makes no vendor call: a local listener stands in for every vendor URL IMS holds and must receive nothing.
 * The reader tests run inside a transaction that is ROLLED BACK, ALWAYS.
 *
 * GATED on RUN_DB_RETENTION_TESTS with the REQUIRE_DB_RETENTION_TESTS tripwire (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/writers-check.test.ts would have been skipped. Fix the invocation (npm run test:db).')
}

class RollbackProbe extends Error {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function getDb() {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  return (await import('../../lib/db')).db
}

async function withRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await getDb()
  let captured: T | undefined
  try {
    await db.$transaction(async (tx: unknown) => {
      captured = await fn(tx as Tx)
      throw new RollbackProbe()
    }, { timeout: 60_000, maxWait: 30_000 })
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error
  }
  return captured as T
}

const NOW = new Date('2026-10-20T12:00:00Z')
const MINTSOFT_ENV = { MINTSOFT_WRITE_ALLOWED: 'https://api.mintsoft.example|89', MINTSOFT_WRITES_LIVE_FROM: '2026-10-10T00:00:00Z', PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'mintsoft' }

async function listener() {
  let hits = 0
  const server = createServer((_req, res) => { hits += 1; res.statusCode = 500; res.end('no') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function seedConfiguration(tx: Tx, vendorUrl: string): Promise<void> {
  const rows: Array<[string, string]> = [
    ['plugin_mintsoft_enabled', 'true'], ['plugin_woocommerce_enabled', 'true'], ['plugin_xero_enabled', 'true'],
    ['cron_wms_order_push_enabled', 'true'], ['wc_url', vendorUrl], ['mintsoft_base_url', vendorUrl], ['xero_sync_enabled', 'false'],
  ]
  for (const [key, value] of rows) await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function seedEvidence(tx: Tx, input: { kind: string; paidAt: Date | null; id: string }): Promise<void> {
  await tx.incumbentWriterEvidence.create({ data: { connector: 'woocommerce', externalOrderId: input.id, kind: input.kind, paidAt: input.paidAt } })
}

test('the constructed double claim: IMS can create Mintsoft orders while a post-cut-off order carries the bridge id => exit 1, and the vendor listener hears nothing', { skip }, async () => {
  const vendor = await listener()
  try {
    const report = await withRollback(async (tx) => {
      await seedConfiguration(tx, vendor.url)
      await seedEvidence(tx, { kind: 'MINTSOFT_ORDER_ID', paidAt: new Date('2026-10-15T09:00:00Z'), id: `s7-${randomUUID()}` })
      // Pre-cut-off and unpaid orders with the same mark are in the table and must not count.
      await seedEvidence(tx, { kind: 'MINTSOFT_ORDER_ID', paidAt: new Date('2026-10-01T09:00:00Z'), id: `s7-${randomUUID()}` })
      await seedEvidence(tx, { kind: 'MINTSOFT_ORDER_ID', paidAt: null, id: `s7-${randomUUID()}` })
      const inputs = await readWritersCheckInputs({ env: MINTSOFT_ENV, now: NOW, windowDays: 14, client: tx })
      return evaluateWritersCheck(inputs)
    })
    const reading = report.evidence!.MINTSOFT_ORDER_ID!
    console.log(`# fixture: counted=${reading.counted} total>=${reading.total} unpaid>=${reading.unpaid} verdict=${report.verdict} exit=${report.exitCode}`)
    assert.equal(reading.counted, 1, 'only the order paid after the cut-off counts')
    assert.ok(reading.total >= 3 && reading.unpaid >= 1)
    assert.equal(report.operations.find((op) => op.key === 'mintsoft.order.create')?.imsCanWrite, true)
    assert.equal(report.exitCode, 1)
    assert.ok(report.findings.some((f) => f.code === 'incumbent-evidence-vs-ims-writer' && f.subject === 'mintsoft.order.create'))
    assert.equal(vendor.hits(), 0, 'the check made a request to a vendor URL')
  } finally {
    await vendor.close()
  }
})

test('the same fixture is clean when the bridge marks all predate the cut-off, and when the cron row is off', { skip }, async () => {
  const vendor = await listener()
  try {
    const pre = await withRollback(async (tx) => {
      await seedConfiguration(tx, vendor.url)
      await seedEvidence(tx, { kind: 'MINTSOFT_ORDER_ID', paidAt: new Date('2026-10-01T09:00:00Z'), id: `s7-${randomUUID()}` })
      return evaluateWritersCheck(await readWritersCheckInputs({ env: MINTSOFT_ENV, now: NOW, windowDays: 14, client: tx }))
    })
    const off = await withRollback(async (tx) => {
      await seedConfiguration(tx, vendor.url)
      await tx.setting.update({ where: { key: 'cron_wms_order_push_enabled' }, data: { value: 'false' } })
      await seedEvidence(tx, { kind: 'MINTSOFT_ORDER_ID', paidAt: new Date('2026-10-15T09:00:00Z'), id: `s7-${randomUUID()}` })
      return evaluateWritersCheck(await readWritersCheckInputs({ env: MINTSOFT_ENV, now: NOW, windowDays: 14, client: tx }))
    })
    assert.equal(pre.evidence!.MINTSOFT_ORDER_ID!.counted, 0)
    assert.ok(!pre.findings.some((f) => f.code === 'incumbent-evidence-vs-ims-writer'))
    assert.equal(off.operations.find((op) => op.key === 'mintsoft.order.create')?.imsCanWrite, false)
    assert.ok(!off.findings.some((f) => f.code === 'incumbent-evidence-vs-ims-writer'))
    assert.equal(vendor.hits(), 0)
  } finally {
    await vendor.close()
  }
})

test('Xero evidence comes from the refusals IMS already logged, not from a Xero call', { skip }, async () => {
  const report = await withRollback(async (tx) => {
    await seedConfiguration(tx, 'http://127.0.0.1:9')
    const meta = (refusalCode: string) => ({ connector: 'xero', refusalCode })
    for (const [code, at] of [['NUMBER_HELD_BY_FOREIGN_DOCUMENT', '2026-10-15T00:00:00Z'], ['NUMBER_HELD_BY_MULTIPLE_DOCUMENTS', '2026-10-16T00:00:00Z'], ['NUMBER_HELD_BY_FOREIGN_DOCUMENT', '2026-10-01T00:00:00Z'], ['NUMBER_HELD_BY_ANOTHER_IMS_DOCUMENT', '2026-10-17T00:00:00Z']] as const) {
      await tx.activityLog.create({ data: { entityType: 'SYSTEM', action: 'sales_invoice_number_not_ours', tag: 'accounting', level: 'WARNING', description: 'x', metadata: meta(code), createdAt: new Date(at) } })
    }
    return evaluateWritersCheck(await readWritersCheckInputs({
      env: { XERO_WRITE_ALLOWED_TENANT: 'tenant-1', XERO_WRITES_LIVE_FROM: '2026-10-10T00:00:00Z' }, now: NOW, windowDays: 14, client: tx,
    }))
  })
  const reading = report.evidence!.XERO_FOREIGN_NUMBER!
  console.log(`# xero evidence counted=${reading.counted} total>=${reading.total}`)
  assert.equal(reading.counted, 2, 'the foreign and multiple-holder refusals after the instant count; the pre-instant one and the IMS-owned one do not')
})

test('entries the import could not record: only those that could matter count, and an unreadable one always does', { skip }, async () => {
  const counted = await withRollback(async (tx) => {
    await seedConfiguration(tx, 'http://127.0.0.1:9')
    const entry = (metadata: object | null) => tx.activityLog.create({ data: { entityType: 'SYNC', action: 'incumbent_evidence_unrecorded', tag: 'sync', level: 'WARNING', description: 'x', metadata } })
    await entry({ kinds: ['MINTSOFT_ORDER_ID'], paidState: 'paid', paidAt: '2026-10-05T00:00:00.000Z' }) // before the instant: cannot matter
    await entry({ kinds: ['MINTSOFT_ORDER_ID'], paidState: 'paid', paidAt: '2026-10-15T00:00:00.000Z' }) // counts
    await entry({ kinds: ['MINTSOFT_ORDER_ID'], paidState: 'unpaid', paidAt: null }) // IMS cannot create an unpaid order
    await entry({ kinds: ['MINTSOFT_ORDER_ID'], paidState: 'unreadable', paidAt: null }) // counts: cannot be shown to predate
    await entry({ kinds: ['META_UNREADABLE'], paidState: 'paid', paidAt: '2026-10-05T00:00:00.000Z' }) // unknown kind: cannot be shown irrelevant
    await entry(null) // unreadable entry
    const inputs = await readWritersCheckInputs({ env: MINTSOFT_ENV, now: NOW, windowDays: 14, client: tx })
    return inputs.evidenceUnrecorded
  })
  assert.equal(counted, 4)
})

test('the recorder keeps one row per order and kind under concurrent deliveries, and updates the paid time', { skip }, async () => {
  const db = await getDb()
  const id = `s7-${randomUUID()}`
  try {
    const order = { id, meta_data: [{ key: 'xeroom_invoice_id', value: 'a' }], date_paid_gmt: '2020-01-02T03:04:05' }
    const results = await Promise.all(Array.from({ length: 8 }, () => recordWcIncumbentEvidence(order)))
    assert.ok(results.every((result) => !('unrecorded' in result)), JSON.stringify(results))
    const rows = await db.incumbentWriterEvidence.findMany({ where: { externalOrderId: id } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.paidAt!.toISOString(), '2020-01-02T03:04:05.000Z')
    await recordWcIncumbentEvidence({ ...order, date_paid_gmt: '2020-01-03T00:00:00' })
    const after = await db.incumbentWriterEvidence.findMany({ where: { externalOrderId: id } })
    assert.equal(after.length, 1)
    assert.equal(after[0]!.paidAt!.toISOString(), '2020-01-03T00:00:00.000Z')
    assert.ok(after[0]!.lastSeenAt.getTime() >= after[0]!.firstSeenAt.getTime())
  } finally {
    await db.incumbentWriterEvidence.deleteMany({ where: { externalOrderId: id } })
  }
})

test('the periodic record keeps the report in the activity log with no data key, and a non-ok verdict is a failed run', { skip }, async () => {
  const db = await getDb()
  const secretOrderId = `s7-secret-${randomUUID()}`
  const before = await db.activityLog.count({ where: { action: WRITERS_CHECK_RECORD_ACTION } })
  // A committed evidence row carrying a recognisable order id: the record may count it but must never carry the id.
  await db.incumbentWriterEvidence.create({ data: { connector: 'woocommerce', externalOrderId: secretOrderId, kind: 'XEROOM_MARKER', paidAt: new Date('2020-01-01T00:00:00Z') } })
  try {
    const outcome = await runWritersCheckRecord()
    const rows = await db.activityLog.findMany({ where: { action: WRITERS_CHECK_RECORD_ACTION }, orderBy: { createdAt: 'desc' }, take: 1 })
    console.log(`# record: status=${outcome.status} verdict=${outcome.verdict} entries ${before} -> ${before + 1}`)
    assert.equal(await db.activityLog.count({ where: { action: WRITERS_CHECK_RECORD_ACTION } }), before + 1)
    const stored = JSON.stringify(rows[0]!.metadata)
    assert.ok(stored.includes('"cannotSee"') && stored.includes('"verdict"'))
    assert.ok(stored.includes('XEROOM_MARKER'), 'precondition: the evidence table was read')
    assert.ok(!stored.includes(secretOrderId))
    assert.equal(outcome.status === 'RECORDED', outcome.verdict === 'ok')
  } finally {
    await db.incumbentWriterEvidence.deleteMany({ where: { externalOrderId: secretOrderId } })
    await db.activityLog.deleteMany({ where: { action: WRITERS_CHECK_RECORD_ACTION } })
  }
})
