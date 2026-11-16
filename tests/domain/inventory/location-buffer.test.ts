import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test, { mock } from 'node:test'

/**
 * LOCATION BUFFER: the save path, its audit entry and permission, the enqueue, and the fence around who may read bufferQty.
 * In-memory transaction; the real-database run is tests/db/location-buffer.test.ts.
 */
const state = {
  denied: false,
  asked: [] as string[],
  levels: new Map<string, { bufferQty: number }>(), // by warehouseId
  writes: [] as Array<{ kind: string; data: unknown }>,
  activity: [] as Array<Record<string, unknown>>,
  enqueued: [] as Array<{ ids: string[]; reason: string }>,
  enqueueThrows: false,
  fallbackLogs: [] as Array<Record<string, unknown>>,
}

const Dec = (n: number) => ({ equals: (o: unknown) => Number(String(o)) === n, toString: () => String(n), valueOf: () => n })
const tx = {
  product: { findUnique: async () => ({ id: 'p1', sku: 'SKU-1', type: 'SIMPLE' }) },
  warehouse: { findMany: async () => [{ id: 'w1', code: 'EAR2' }, { id: 'w2', code: 'EAR3' }] },
  stockLevel: {
    findMany: async () => [...state.levels].map(([warehouseId, l]) => ({ warehouseId, bufferQty: Dec(l.bufferQty) })),
    update: async (args: { where: { productId_warehouseId: { warehouseId: string } }; data: { bufferQty: { toString(): string } } }) => {
      state.writes.push({ kind: 'update', data: args.data })
      state.levels.set(args.where.productId_warehouseId.warehouseId, { bufferQty: Number(args.data.bufferQty.toString()) })
    },
    upsert: async (args: { create: { warehouseId: string; quantity: number; bufferQty: { toString(): string } } }) => {
      state.writes.push({ kind: 'upsert', data: args.create })
      state.levels.set(args.create.warehouseId, { bufferQty: Number(args.create.bufferQty.toString()) })
    },
  },
  activityLog: { create: async (args: { data: Record<string, unknown> }) => { state.activity.push(args.data) } },
}

mock.module('@/lib/db', { namedExports: { db: { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      state.asked.push(permission)
      if (state.denied) throw new Error('Forbidden')
      return { user: { id: 'u1', role: 'MANAGER' } }
    },
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async (ids: string[], reason: string) => {
      if (state.enqueueThrows) throw new Error('queue down')
      state.enqueued.push({ ids, reason })
    },
  },
})
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (p: Record<string, unknown>) => { state.fallbackLogs.push(p); return true },
    logActivityInTransaction: async (_c: unknown, p: Record<string, unknown>) => { state.activity.push({ ...p }) },
  },
})

function reset() {
  state.denied = false
  state.asked = []
  state.levels = new Map([['w1', { bufferQty: 0 }]])
  state.writes = []
  state.activity = []
  state.enqueued = []
  state.enqueueThrows = false
  state.fallbackLogs = []
}

test('parseBufferInput: blank is 0; decimals allowed; negatives, junk and too many places are refused', async () => {
  const { parseBufferInput } = await import('@/lib/domain/inventory/location-buffer')
  assert.equal(parseBufferInput('')?.ok && (parseBufferInput('') as { value: { toString(): string } }).value.toString(), '0')
  assert.equal((parseBufferInput(' 12.5 ') as { value: { toString(): string } }).value.toString(), '12.5')
  for (const bad of ['-1', '1e3', 'abc', '1,5', '0.0000001', '999999999']) assert.equal(parseBufferInput(bad).ok, false, bad)
})

test('saving writes the buffer, an audit row with who/old/new/reason, and enqueues the normal stock push', async () => {
  reset()
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  const result = await saveLocationBuffers('p1', [{ warehouseId: 'w1', bufferQty: '20' }, { warehouseId: 'w2', bufferQty: '' }], 'Hold for the trade show')
  assert.deepEqual(result, { success: true, changed: 1 }) // w2 stays 0: unchanged, nothing written
  assert.deepEqual(state.asked, ['inventory.edit'])
  assert.equal(state.activity.length, 1)
  const row = state.activity[0] as { userId: string; entityType: string; entityId: string; action: string; description: string; metadata: Record<string, unknown> }
  assert.equal(row.userId, 'u1')
  assert.equal(row.entityType, 'PRODUCT')
  assert.equal(row.entityId, 'p1')
  assert.equal(row.action, 'location_buffer_changed')
  assert.match(row.description, /changed from 0 to 20\. Reason: Hold for the trade show/)
  assert.deepEqual(row.metadata, { sku: 'SKU-1', warehouseId: 'w1', warehouseCode: 'EAR2', oldValue: '0', newValue: '20', reason: 'Hold for the trade show' })
  assert.deepEqual(state.enqueued, [{ ids: ['p1'], reason: 'IMS_CHANGE' }])
})

test('the reason is REQUIRED when something changes: refused, nothing written, no push', async () => {
  reset()
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  for (const reason of ['', '   ']) {
    const result = await saveLocationBuffers('p1', [{ warehouseId: 'w1', bufferQty: '5' }], reason)
    assert.equal(result.success, false)
    assert.ok(!result.success && result.fieldErrors?.reason)
  }
  const tooLong = await saveLocationBuffers('p1', [{ warehouseId: 'w1', bufferQty: '5' }], 'x'.repeat(501))
  assert.equal(tooLong.success, false)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.activity, [])
  assert.deepEqual(state.enqueued, [])
})

test('an unchanged save needs no reason and writes, audits and pushes nothing', async () => {
  reset()
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  assert.deepEqual(await saveLocationBuffers('p1', [{ warehouseId: 'w1', bufferQty: '' }], ''), { success: true, changed: 0 })
  assert.deepEqual([state.writes, state.activity, state.enqueued], [[], [], []])
})

test('a location with no stock row gets one at zero quantity to carry the buffer', async () => {
  reset()
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  await saveLocationBuffers('p1', [{ warehouseId: 'w2', bufferQty: '4' }], 'reserve for B2B')
  assert.equal(state.writes.length, 1)
  assert.equal(state.writes[0]!.kind, 'upsert')
  assert.equal((state.writes[0]!.data as { quantity: number }).quantity, 0)
})

test('without inventory.edit nothing is written, audited or pushed', async () => {
  reset()
  state.denied = true
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  await assert.rejects(saveLocationBuffers('p1', [{ warehouseId: 'w1', bufferQty: '5' }], 'why'), /Forbidden/)
  assert.deepEqual(state.asked, ['inventory.edit'])
  assert.deepEqual([state.writes, state.activity, state.enqueued], [[], [], []])
})

test('a failed enqueue does not undo the saved buffer; it is logged as a warning', async () => {
  reset()
  state.enqueueThrows = true
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  assert.deepEqual(await saveLocationBuffers('p1', [{ warehouseId: 'w1', bufferQty: '5' }], 'why'), { success: true, changed: 1 })
  assert.equal(state.fallbackLogs.length, 1)
  assert.equal(state.fallbackLogs[0]!.level, 'WARNING')
})

test('negative and malformed buffers are refused before anything is written', async () => {
  reset()
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  const result = await saveLocationBuffers('p1', [{ warehouseId: 'w1', bufferQty: '-3' }], 'why')
  assert.equal(result.success, false)
  assert.deepEqual([state.writes, state.activity, state.enqueued], [[], [], []])
})

/**
 * THE FENCE. bufferQty is a channel-availability figure. IMS allocation (which MAY use buffered units: the buffer says what the
 * store may sell, not what the warehouse may ship), on-hand/reserved maths and the Mintsoft alignment pass must keep working on real
 * stock, so none of them may read it. A new reader fails here until it is decided.
 */
const cwd = new URL('../../..', import.meta.url).pathname
test('only the WooCommerce stock push, the buffer editor and the schema read or write bufferQty', () => {
  const files = execFileSync('git', ['grep', '--untracked', '-lw', 'bufferQty', '--', 'app', 'lib', 'components', 'prisma/schema.prisma', ':!app/generated'], { encoding: 'utf8', cwd }).trim().split('\n').filter(Boolean).sort()
  assert.deepEqual(files, [
    'app/actions/location-buffer.ts',
    'components/inventory/location-buffer.tsx',
    'lib/connectors/woocommerce/sync/stock-sync.ts',
    'lib/domain/inventory/location-buffer.ts',
    'prisma/schema.prisma',
  ].sort())
})

test('the allocation services and the Mintsoft alignment read stock_levels without bufferQty', () => {
  for (const file of [
    'lib/domain/sales/allocation-service.ts',
    'lib/fulfillment/backorder-allocator.ts',
    'lib/fulfillment/reallocation-sweep.ts',
    'lib/connectors/mintsoft/sync/stock-sync.ts',
    'lib/domain/wms/booked-in-service.ts',
  ]) assert.ok(!/bufferQty/.test(readFileSync(`${cwd}${file}`, 'utf8')), `${file} must not read the channel buffer`)
})

test('the buffer reason is operator text on a PRODUCT activity row, which erasure does not treat as identity-bearing', async () => {
  const { IDENTITY_BEARING_ENTITY_TYPES } = await import('@/lib/domain/erasure/activity-identity')
  assert.ok(!IDENTITY_BEARING_ENTITY_TYPES.includes('PRODUCT' as never))
  const { ERASURE_CLASSIFICATION } = await import('@/lib/domain/erasure/erasure-classification')
  assert.ok(!('StockLevel' in ERASURE_CLASSIFICATION), 'stock_levels is not customer- or order-linked, and carries no text column')
})
