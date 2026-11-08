import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

const EMAIL = `quill.${randomUUID().slice(0, 8)}@example.test`
const POSTCODE = 'SW1A 2AA'

// Seams, all set by the tests: what each reconcile answers, what the warehouse poll does, whether the audit row builder fails.
const reconcile: Record<string, () => Promise<unknown>> = {}
const ran: string[] = []
let pollImpl: (() => Promise<Array<Record<string, unknown>>>) | null = null
let failAuditRow = false
let mocked = false

async function setup() {
  if (!mocked) {
    config({ path: '.env.local', quiet: true })
    config({ quiet: true })
    mock.module('@/lib/cron-auth', { namedExports: { verifyCron: async () => null } })
    mock.module('@/lib/cron-rate-limit', { namedExports: { enforceCronRateLimit: async () => null } })
    mock.module('@/lib/maintenance-mode', { namedExports: { getMaintenanceModeResponse: async () => null } })
    mock.module('@/lib/email-outbox', { namedExports: { processPendingEmailOutbox: async () => ({ processed: 0 }) } })
    mock.module('@/lib/domain/erasure/reconcile-email-outbox', { namedExports: { reconcileErasedEmailOutbox: async () => { ran.push('email-outbox'); return reconcile['email-outbox']!() } } })
    mock.module('@/lib/domain/erasure/reconcile-free-text', { namedExports: { reconcileErasedFreeText: async () => { ran.push('free-text'); return reconcile['free-text']!() } } })
    mock.module('@/lib/domain/erasure/raw-payloads', { namedExports: { reconcileRawPayloads: async () => { ran.push('raw-payloads'); return reconcile['raw-payloads']!() } } })
    mock.module('@/lib/domain/erasure/derived-copies', { namedExports: { reconcileDerivedCopies: async () => { ran.push('derived-copies'); return reconcile['derived-copies']!() } } })
    const auth = await import('@/lib/auth/server')
    mock.module('@/lib/auth/server', { namedExports: { ...auth, requireApiAuth: async () => ({ user: { id: 'u', role: 'ADMIN', name: 'Admin', email: 'admin@example.test' } }) } })
    const registry = await import('@/lib/connectors/wms/registry')
    mock.module('@/lib/connectors/wms/registry', { namedExports: { ...registry, getWmsConnector: (id: never) => (pollImpl && (id as string) === 'mintsoft' ? { pollReturns: async () => pollImpl!() } : registry.getWmsConnector(id)) } })
    const audit = await import('@/lib/domain/wms/mutation-audit')
    mock.module('@/lib/domain/wms/mutation-audit', { namedExports: { ...audit, toWmsMutationEventRow: (...args: never[]) => { if (failAuditRow) throw new Error(`audit failed for ${EMAIL} at 10 Downing Street ${POSTCODE}`); return (audit.toWmsMutationEventRow as (...a: unknown[]) => unknown)(...args) } } })
    mocked = true
  }
  const { db } = await import('@/lib/db')
  return db
}

const clean = () => { for (const k of ['email-outbox', 'free-text']) reconcile[k] = async () => ({ addressesErased: 0 }); reconcile['raw-payloads'] = async () => ({ projected: 0, remaining: 0 }); reconcile['derived-copies'] = async () => ({ changed: 0, remaining: 0, rounds: 1 }); ran.length = 0 }
const activityRows = async (db: Awaited<ReturnType<typeof setup>>, since: Date) => db.activityLog.findMany({ where: { action: 'erasure_reconcile_incomplete', createdAt: { gte: since } } })

test('[erasure reconcile cron] a clean run answers 200 and writes no failure row', { skip }, async () => {
  const db = await setup()
  const { GET } = await import('@/app/api/cron/email-outbox/route')
  clean()
  const since = new Date()
  const res = await GET(new Request('http://localhost/api/cron/email-outbox'))
  assert.equal(res.status, 200)
  assert.deepEqual(ran, ['email-outbox', 'free-text', 'raw-payloads', 'derived-copies'])
  assert.equal((await activityRows(db, since)).length, 0)
})

test('[erasure reconcile cron] a reconcile that leaves rows, or throws, is a 500 with an identity-free activity row, and the others still run', { skip }, async () => {
  const db = await setup()
  const { GET } = await import('@/app/api/cron/email-outbox/route')
  const cases: Array<{ name: string; set: () => void; expect: string }> = [
    { name: 'derived remaining', set: () => { reconcile['derived-copies'] = async () => ({ changed: 0, remaining: 3, rounds: 20 }) }, expect: 'derived-copies:remaining' },
    { name: 'raw remaining', set: () => { reconcile['raw-payloads'] = async () => ({ projected: 0, remaining: 2 }) }, expect: 'raw-payloads:remaining' },
    { name: 'derived throws', set: () => { reconcile['derived-copies'] = async () => { throw new Error(`boom ${EMAIL}`) } }, expect: 'derived-copies:error' },
    { name: 'raw throws', set: () => { reconcile['raw-payloads'] = async () => { throw new Error('boom') } }, expect: 'raw-payloads:error' },
    { name: 'free-text throws', set: () => { reconcile['free-text'] = async () => { throw new Error('boom') } }, expect: 'free-text:error' },
    { name: 'email outbox throws', set: () => { reconcile['email-outbox'] = async () => { throw new Error('boom') } }, expect: 'email-outbox:error' },
  ]
  for (const c of cases) {
    clean()
    c.set()
    const since = new Date()
    const res = await GET(new Request('http://localhost/api/cron/email-outbox'))
    assert.equal(res.status, 500, c.name)
    const body = await res.json() as { erasureReconcileIncomplete: string[] }
    assert.deepEqual(body.erasureReconcileIncomplete, [c.expect], c.name)
    assert.deepEqual(ran, ['email-outbox', 'free-text', 'raw-payloads', 'derived-copies'], `${c.name}: a failing reconcile does not stop the next`)
    const rows = await activityRows(db, since)
    assert.equal(rows.length, 1, c.name)
    assert.equal(rows[0]!.level, 'ERROR')
    assert.doesNotMatch(JSON.stringify(rows[0]), new RegExp(EMAIL.replace(/[+.]/g, '\\$&')), `${c.name}: the row carries no identity`)
    assert.deepEqual((rows[0]!.metadata as { incomplete: string[] }).incomplete, [c.expect])
  }
})

test('[returns sync] the error text written to the sync log and returned for a failed job is scrubbed (emails, postcodes)', { skip }, async (t) => {
  const db = await setup()
  const { runMintsoftReturnsSync } = await import('@/lib/connectors/mintsoft/sync/returns-sync')
  const uid = randomUUID().slice(0, 8)
  const warehouse = await db.warehouse.create({ data: { code: `RS-${uid}`, name: 'Returns scrub warehouse', syncToStore: true, availableForSale: true } })
  const connection = await db.wmsConnection.create({ data: { connector: 'mintsoft', label: `rs-${uid}`, active: true }, select: { id: true } })
  const binding = await db.externalWmsBinding.create({ data: { connectionId: connection.id, warehouseId: warehouse.id, connector: 'mintsoft', externalWarehouseId: `ext-${uid}`, active: true, returnsMode: 'POLL' } as never, select: { id: true } })
  const returnId = `RET-SCRUB-${uid}`
  t.after(async () => {
    pollImpl = null; failAuditRow = false
    await db.wmsReturnsInbox.deleteMany({ where: { externalReturnId: returnId } })
    await db.externalWmsBinding.deleteMany({ where: { id: binding.id } })
    await db.wmsConnection.deleteMany({ where: { id: connection.id } })
    await db.warehouse.deleteMany({ where: { id: warehouse.id } })
  })
  // (a) a record whose processing throws: the per-record error log.
  pollImpl = async () => [{ externalReturnId: returnId, externalWarehouseId: `ext-${uid}`, sku: `SKU-${uid}`, qty: 1, orderReference: null, reason: 'x', receivedAt: '2026-11-04T10:00:00.000Z', raw: {} }]
  failAuditRow = true
  const result = await runMintsoftReturnsSync('test')
  const logs = await db.wmsSyncLog.findMany({ where: { sku: `SKU-${uid}`, action: 'error' } })
  assert.ok(logs.length > 0, `PRECONDITION: the failure was logged (job ${result.status})`)
  for (const l of logs) {
    assert.doesNotMatch(l.reason ?? '', new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))
    assert.doesNotMatch(l.reason ?? '', /SW1A/)
    assert.match(l.reason ?? '', /redacted/, 'the text was scrubbed, not dropped')
  }
  // (b) the poll itself fails: the job-level message, returned and written to the activity log.
  failAuditRow = false
  pollImpl = async () => { throw new Error(`warehouse said no to ${EMAIL} ${POSTCODE}`) }
  const since = new Date()
  const failed = await runMintsoftReturnsSync('test')
  assert.equal(failed.status, 'FAILED')
  assert.doesNotMatch(failed.skippedReason ?? '', new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))
  assert.doesNotMatch(failed.skippedReason ?? '', /SW1A/)
  const rows = await db.activityLog.findMany({ where: { action: 'mintsoft_returns_sync_failed', createdAt: { gte: since } } })
  assert.ok(rows.length > 0)
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))
})

test('[mintsoft sync export] the CSV reason column is scrubbed on the way out, and plain reasons are untouched', { skip }, async (t) => {
  const db = await setup()
  const { GET } = await import('@/app/api/export/mintsoft-sync/[jobId]/route')
  const job = await db.wmsSyncJob.create({ data: { connector: 'mintsoft', type: 'RETURNS_SYNC', status: 'SUCCEEDED', startedAt: new Date() } as never })
  t.after(async () => { await db.wmsSyncLog.deleteMany({ where: { jobId: job.id } }); await db.wmsSyncJob.deleteMany({ where: { id: job.id } }) })
  await db.wmsSyncLog.create({ data: { jobId: job.id, action: 'error', sku: 'S1', reason: `legacy raw error for ${EMAIL} at ${POSTCODE}` } as never })
  await db.wmsSyncLog.create({ data: { jobId: job.id, action: 'error', sku: 'S2', reason: 'IMS 5 vs WMS 3 corrected' } as never })
  const res = await GET(new Request('http://localhost/x'), { params: Promise.resolve({ jobId: job.id }) })
  assert.equal(res.status, 200)
  const csv = await res.text()
  assert.doesNotMatch(csv, new RegExp(EMAIL.replace(/[+.]/g, '\\$&')))
  assert.doesNotMatch(csv, /SW1A/)
  assert.match(csv, /redacted/)
  assert.match(csv, /IMS 5 vs WMS 3 corrected/)
})
