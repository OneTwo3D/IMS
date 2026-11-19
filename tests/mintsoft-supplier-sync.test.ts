import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * THE MINTSOFT SUPPLIER READ SYNC (o3d-qk7z0): single-flight, batched, and the missing sweep covers rows no read ever saw. Doubles only; Mintsoft is
 * never contacted.
 */

const listCalls: number[] = []
let lockAvailable = true
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
  mintsoftSupplier: { count: async () => 0 },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
}
mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('@/lib/connectors/wms/registry', { namedExports: { getWmsConnector: () => ({ listSuppliers: async () => { listCalls.push(1); return supplierList } }) } })
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
