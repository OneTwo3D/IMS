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
  rows: new Map<string, number>(), // location_stock_buffers by warehouseId (this product)
  ops: [] as Array<{ op: string; warehouseId: string; value?: number }>,
  activity: [] as Array<Record<string, unknown>>,
  enqueued: [] as Array<{ ids: string[]; reason: string }>,
  enqueueThrows: false,
  fallbackLogs: [] as Array<Record<string, unknown>>,
}

const num = (v: { toString(): string }) => Number(v.toString())
const tx = {
  product: { findUnique: async () => ({ id: 'p1', sku: 'SKU-1', type: 'SIMPLE' }) },
  warehouse: { findMany: async () => [{ id: 'w1', code: 'EAR2' }, { id: 'w2', code: 'EAR3' }] },
  locationStockBuffer: {
    createMany: async (args: { data: Array<{ warehouseId: string }>; skipDuplicates: boolean }) => {
      assert.equal(args.skipDuplicates, true)
      for (const d of args.data) if (!state.rows.has(d.warehouseId)) { state.rows.set(d.warehouseId, 0); state.ops.push({ op: 'insert', warehouseId: d.warehouseId }) }
    },
    update: async (args: { where: { productId_warehouseId: { warehouseId: string } }; data: { bufferQty: { toString(): string } } }) => {
      const w = args.where.productId_warehouseId.warehouseId
      state.rows.set(w, num(args.data.bufferQty))
      state.ops.push({ op: 'update', warehouseId: w, value: num(args.data.bufferQty) })
    },
    deleteMany: async (args: { where: { warehouseId: string; bufferQty?: number } }) => {
      const w = args.where.warehouseId
      if (args.where.bufferQty === 0 && state.rows.get(w) !== 0) return
      state.rows.delete(w)
      state.ops.push({ op: 'delete', warehouseId: w })
    },
  },
  // The FOR UPDATE read of the one row (tagged template: values are [productId, warehouseId]).
  $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    state.ops.push({ op: 'lock', warehouseId: String(values[1]) })
    return [{ bufferQty: { toString: () => String(state.rows.get(String(values[1])) ?? 0) } }]
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
  state.rows = new Map()
  state.ops = []
  state.activity = []
  state.enqueued = []
  state.enqueueThrows = false
  state.fallbackLogs = []
}

const cwd = new URL('../../..', import.meta.url).pathname

test('parseBufferInput: blank is 0; decimals allowed; negatives, junk and too many places are refused', async () => {
  const { parseBufferInput } = await import('@/lib/domain/inventory/location-buffer')
  assert.equal(parseBufferInput('')?.ok && (parseBufferInput('') as { value: { toString(): string } }).value.toString(), '0')
  assert.equal((parseBufferInput(' 12.5 ') as { value: { toString(): string } }).value.toString(), '12.5')
  for (const bad of ['-1', '1e3', 'abc', '1,5', '0.0000001', '999999999']) assert.equal(parseBufferInput(bad).ok, false, bad)
})

const E = (warehouseId: string, expectedOld: string, bufferQty: string) => ({ warehouseId, expectedOld, bufferQty })
const writesTo = (w: string) => state.ops.filter((o) => o.warehouseId === w && o.op !== 'lock')

test('saving writes only the edited buffer, an audit row with who/old/new/reason, and enqueues the normal stock push', async () => {
  reset()
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  const result = await saveLocationBuffers('p1', [E('w1', '', '20')], 'Hold for the trade show')
  assert.deepEqual(result, { success: true, changed: 1, stale: [] })
  assert.deepEqual(state.asked, ['inventory.edit'])
  assert.equal(state.rows.get('w1'), 20)
  assert.deepEqual(writesTo('w2'), [], 'an untouched warehouse is never written')
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

test('a STALE cell is refused with the other cells still saved; the audit carries the true old value; one push', async () => {
  reset()
  state.rows.set('w1', 10) // another operator set 10 after this page loaded (it expected 0)
  state.rows.set('w2', 4)
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  const result = await saveLocationBuffers('p1', [E('w1', '', '3'), E('w2', '4', '6')], 'rebalance')
  assert.deepEqual(result, { success: true, changed: 1, stale: ['EAR2'] })
  assert.equal(state.rows.get('w1'), 10, 'the stale cell was not overwritten')
  assert.equal(state.rows.get('w2'), 6)
  assert.deepEqual(writesTo('w1'), [], 'nothing written to the stale warehouse')
  assert.deepEqual(state.activity.map((a) => (a.metadata as Record<string, unknown>).warehouseCode), ['EAR3'])
  assert.equal((state.activity[0]!.metadata as Record<string, unknown>).oldValue, '4')
  assert.equal(state.enqueued.length, 1)
})

test('when every edited cell is stale nothing is audited and NO push is queued', async () => {
  reset()
  state.rows.set('w1', 10)
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  const result = await saveLocationBuffers('p1', [E('w1', '', '3')], 'why')
  assert.deepEqual(result, { success: true, changed: 0, stale: ['EAR2'] })
  assert.deepEqual([state.activity, state.enqueued], [[], []])
  assert.equal(state.rows.get('w1'), 10)
})

test('a stale expectation of a row that has since been removed leaves no stray zero row', async () => {
  reset() // the page loaded 5, the row is gone (0)
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  const result = await saveLocationBuffers('p1', [E('w1', '5', '8')], 'why')
  assert.deepEqual(result, { success: true, changed: 0, stale: ['EAR2'] })
  assert.equal(state.rows.has('w1'), false)
})

test('setting a buffer back to 0 removes the row', async () => {
  reset()
  state.rows.set('w1', 5)
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  assert.deepEqual(await saveLocationBuffers('p1', [E('w1', '5', '')], 'released'), { success: true, changed: 1, stale: [] })
  assert.equal(state.rows.has('w1'), false)
  assert.equal(state.activity[0]!.description && (state.activity[0]!.metadata as Record<string, unknown>).newValue, '0')
})

test('the reason is REQUIRED when something is to change: refused, nothing written, no push', async () => {
  reset()
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  for (const reason of ['', '   ']) {
    const result = await saveLocationBuffers('p1', [E('w1', '', '5')], reason)
    assert.equal(result.success, false)
    assert.ok(!result.success && result.fieldErrors?.reason)
  }
  const tooLong = await saveLocationBuffers('p1', [E('w1', '', '5')], 'x'.repeat(501))
  assert.equal(tooLong.success, false)
  assert.deepEqual([state.ops, state.activity, state.enqueued], [[], [], []])
})

test('an unchanged cell needs no reason and writes, audits and pushes nothing', async () => {
  reset()
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  assert.deepEqual(await saveLocationBuffers('p1', [E('w1', '', '')], ''), { success: true, changed: 0, stale: [] })
  assert.deepEqual([state.ops, state.activity, state.enqueued], [[], [], []])
})

test('without inventory.edit nothing is written, audited or pushed', async () => {
  reset()
  state.denied = true
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  await assert.rejects(saveLocationBuffers('p1', [E('w1', '', '5')], 'why'), /Forbidden/)
  assert.deepEqual(state.asked, ['inventory.edit'])
  assert.deepEqual([state.ops, state.activity, state.enqueued], [[], [], []])
})

test('a failed enqueue does not undo the saved buffer; it is logged as a warning', async () => {
  reset()
  state.enqueueThrows = true
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  assert.deepEqual(await saveLocationBuffers('p1', [E('w1', '', '5')], 'why'), { success: true, changed: 1, stale: [] })
  assert.equal(state.fallbackLogs.length, 1)
  assert.equal(state.fallbackLogs[0]!.level, 'WARNING')
})

test('negative and malformed buffers are refused before anything is written', async () => {
  reset()
  const { saveLocationBuffers } = await import('@/app/actions/location-buffer')
  const result = await saveLocationBuffers('p1', [E('w1', '', '-3')], 'why')
  assert.equal(result.success, false)
  assert.deepEqual([state.ops, state.activity, state.enqueued], [[], [], []])
})

test('the buffer editor never touches stock_levels', () => {
  for (const file of ['lib/domain/inventory/location-buffer.ts', 'app/actions/location-buffer.ts']) {
    const src = readFileSync(`${cwd}${file}`, 'utf8')
    assert.ok(!/stockLevel\.(create|upsert|update|delete)/.test(src), `${file} must not write stock rows`)
  }
  assert.ok(!/stockLevel/.test(readFileSync(`${cwd}lib/domain/inventory/location-buffer.ts`, 'utf8')))
})

/**
 * THE FENCE. bufferQty is a channel-availability figure. IMS allocation (which MAY use buffered units: the buffer says what the
 * store may sell, not what the warehouse may ship), on-hand/reserved maths and the Mintsoft alignment pass must keep working on real
 * stock, so none of them may read it. A new reader fails here until it is decided.
 */
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
  assert.ok(!('LocationStockBuffer' in ERASURE_CLASSIFICATION), 'location_stock_buffers is not customer- or order-linked, and carries no text column')
})
