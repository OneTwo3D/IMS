import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE MINTSOFT SUPPLIER READ SYNC (o3d-qk7z0): single-flight, batched, and the missing sweep covers rows no read ever saw. Doubles only; Mintsoft is
 * never contacted.
 */

const listCalls: number[] = []
let lockAvailable = true
let liveCount = 0
const activity: Array<{ action: string; level?: string }> = []
let listDelayHook: null | (() => void) = null
let released = 0
const transactions: Array<{ upserts: number; sweeps: unknown[]; settings: unknown[] }> = []
let supplierList: Array<{ externalId: string; name: string; code: null; email: null; vatNumber: null; active: boolean; raw: null }> = []

const makeTx = () => {
  const record = { upserts: 0, sweeps: [] as unknown[], settings: [] as unknown[] }
  transactions.push(record)
  return {
    mintsoftSupplier: {
      findMany: async () => [],
      upsert: async () => { record.upserts += 1 },
      updateMany: async (args: unknown) => { record.sweeps.push(args); return { count: 2 } },
    },
    setting: { upsert: async (args: unknown) => { record.settings.push(args) } },
  }
}
const fakeDb = {
  mintsoftSupplier: { count: async () => liveCount },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
}
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (entry: { action: string; level?: string }) => { activity.push(entry) } } })
mock.module('@/lib/connectors/wms/registry', { namedExports: { getWmsConnector: () => ({ listSuppliers: async () => { listCalls.push(1); listDelayHook?.(); return supplierList } }) } })
mock.module('@/lib/db/pinned-advisory-lock', {
  namedExports: {
    acquirePinnedAdvisoryLockOrNull: async () => (lockAvailable ? { assertHeld: () => undefined, release: async () => { released += 1 } } : null),
  },
})

const sup = (n: number) => ({ externalId: String(n), name: `S${n}`, code: null, email: null, vatNumber: null, active: true, raw: null })

test('a second refresh while one runs is refused and never reads Mintsoft', async () => {
  const { runMintsoftSupplierSync } = await import('../lib/connectors/mintsoft/suppliers/supplier-sync.ts')
  lockAvailable = false
  listCalls.length = 0
  await assert.rejects(runMintsoftSupplierSync({ triggeredBy: 't' }), /already running/)
  assert.equal(listCalls.length, 0, 'no request to the live tenant')
  lockAvailable = true
})

test('a large list is many short transactions, not one; the lock is released; the stamp is written with the sweep', async () => {
  const { runMintsoftSupplierSync, SUPPLIER_UPSERT_BATCH } = await import('../lib/connectors/mintsoft/suppliers/supplier-sync.ts')
  supplierList = Array.from({ length: SUPPLIER_UPSERT_BATCH * 2 + 5 }, (_, i) => sup(i + 1))
  transactions.length = 0
  released = 0
  const out = await runMintsoftSupplierSync({ triggeredBy: 't' })
  assert.equal(out.fetched, SUPPLIER_UPSERT_BATCH * 2 + 5)
  assert.deepEqual(transactions.map((t) => t.upserts), [SUPPLIER_UPSERT_BATCH, SUPPLIER_UPSERT_BATCH, 5, 0], 'three batches, then the sweep')
  assert.equal(released, 1)
  const last = transactions[3]!
  assert.equal(last.settings.length, 1, 'the last-read stamp rides with the sweep')
  assert.equal((last.settings[0] as { where: { key: string } }).where.key, 'mintsoft_supplier_last_sync_at')
})

test('the missing sweep includes rows whose lastSeenRunId is NULL (an IMS-created row no read has seen)', async () => {
  const { runMintsoftSupplierSync } = await import('../lib/connectors/mintsoft/suppliers/supplier-sync.ts')
  supplierList = [sup(1)]
  transactions.length = 0
  await runMintsoftSupplierSync({ triggeredBy: 't' })
  const where = (transactions.at(-1)!.sweeps[0] as { where: { OR: unknown[]; missingSince: null } }).where
  assert.deepEqual(where.OR[0], { lastSeenRunId: null })
  assert.ok((where.OR[1] as { lastSeenRunId: { not: string } }).lastSeenRunId.not.startsWith('msupp-'))
})

test('the "last read" stamp is taken BEFORE the walk, and the sweep spares rows created at or after it (an IMS create mid-walk)', async () => {
  const { runMintsoftSupplierSync } = await import('../lib/connectors/mintsoft/suppliers/supplier-sync.ts')
  supplierList = [sup(1)]
  transactions.length = 0
  const before = Date.now()
  let walkEnded = 0
  listDelayHook = () => { const spin = Date.now() + 25; while (Date.now() < spin); walkEnded = Date.now() }
  await runMintsoftSupplierSync({ triggeredBy: 't' })
  listDelayHook = null
  const last = transactions.at(-1)!
  const stamp = new Date((last.settings[0] as { update: { value: string } }).update.value).getTime()
  assert.ok(stamp >= before && stamp < walkEnded, 'the stamp predates the end of the walk')
  const where = (last.sweeps[0] as { where: { createdAt: { lt: Date } } }).where
  assert.equal(where.createdAt.lt.getTime(), stamp, 'only rows created before the walk started are swept')
})

test('a list more than 20% smaller than the cached one is refused, recorded, and writes nothing; an administrator can confirm it', async () => {
  const { runMintsoftSupplierSync } = await import('../lib/connectors/mintsoft/suppliers/supplier-sync.ts')
  liveCount = 100
  supplierList = Array.from({ length: 79 }, (_, i) => sup(i + 1))
  transactions.length = 0
  activity.length = 0
  released = 0
  await assert.rejects(runMintsoftSupplierSync({ triggeredBy: 't' }), /shrank by 21%/)
  assert.equal(transactions.length, 0, 'nothing written')
  assert.equal(released, 1, 'the lock is released')
  assert.deepEqual(activity.map((a) => [a.action, a.level]), [['mintsoft_supplier_sync_refused_shrink', 'WARNING']])
  // Exactly 20% smaller is allowed; so is a small cache.
  supplierList = Array.from({ length: 80 }, (_, i) => sup(i + 1))
  await runMintsoftSupplierSync({ triggeredBy: 't' })
  liveCount = 9
  supplierList = [sup(1)]
  await runMintsoftSupplierSync({ triggeredBy: 't' })
  // Confirmed: it proceeds and the override is recorded.
  liveCount = 100
  supplierList = Array.from({ length: 50 }, (_, i) => sup(i + 1))
  activity.length = 0
  const out = await runMintsoftSupplierSync({ triggeredBy: 't', confirmShrink: true })
  assert.equal(out.fetched, 50)
  assert.equal(activity[0]?.action, 'mintsoft_supplier_sync_shrink_confirmed')
  liveCount = 0
})
