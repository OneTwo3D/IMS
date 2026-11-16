import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-hqvrp.368 (Codex HIGH): fetchMintsoftOrderStatus deliberately reads Part 1 of a split order, so the
// persisted `dispatched` was Part 1's decision alone. Part 2 despatching first left a `false` snapshot that the
// align-down in-flight gate released on. The sweep must persist an AGGREGATE for a split order: true when any
// part is despatched, false only when every part was read and none is despatched, otherwise null (unknown).
// All HTTP is mocked: the connector below is a stub and nothing reaches Mintsoft.

type Snapshot = { orderId: string; dispatched: boolean | null; lastError: string | null; fetchedAt?: Date }
/** When the mocked status GET resolved: the stored read time must not be later than this (o3d-hqvrp.368 R2). */
let getResolvedAt = 0
type Part = { externalId: string; partNumber: number; status: string; dispatched: boolean; tracking: never[] }

const upserts: Snapshot[] = []
let statusOverrides: Record<string, unknown> = {}
let parts: Part[] | Error = []
let hasParts = true
let partsCalls = 0

mock.module('@/lib/integration-plugins', { namedExports: { getIntegrationPluginState: async () => ({ mintsoft: true }) } })
mock.module('@/lib/connectors/wms/types', { namedExports: { WMS_CONNECTOR_IDS: ['mintsoft'] } })
mock.module('@/lib/connectors/wms/order-lookup', {
  namedExports: { resolveWmsOrderLookupConnector: async () => ({ kind: 'one', connector: 'woocommerce' }) },
})
mock.module('@/lib/connectors/wms/registry', {
  namedExports: {
    getWmsConnectorDef: () => ({ label: 'Mintsoft' }),
    getWmsConnector: () => ({
      fetchOrderStatus: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        getResolvedAt = Date.now()
        if (statusOverrides.__throw) throw new Error('Mintsoft 503')
        return {
        externalOrderId: 'ext-1', externalOrderNumber: 'SO-1', status: 'NEW', statusLabel: 'NEW',
        isSplit: true, partCount: 2, isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null,
        tracking: [], dispatched: false, raw: {}, ...statusOverrides,
        }
      },
      ...(hasParts
        ? {
          fetchOrderParts: async () => {
            partsCalls += 1
            if (parts instanceof Error) throw parts
            return parts
          },
        }
        : {}),
    }),
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async function (this: unknown, fn: (tx: unknown) => Promise<unknown>) { return fn(this) },
      $queryRaw: async () => [],
      setting: { upsert: async () => ({}) },
      salesOrder: {
        findUnique: async () => ({ erasedAt: null }),
        count: async () => 0,
        findMany: async () => [{ id: 'order-1', orderNumber: 'SO-1', externalOrderNumber: 'SO-1', shoppingLinks: [{ externalOrderNumber: 'SO-1' }] }],
      },
      wmsOrderStatusSnapshot: {
        findUnique: async () => null,
        upsert: async ({ create }: { create: Snapshot }) => { upserts.push(create); return create },
      },
    },
  },
})

const part = (partNumber: number, dispatched: boolean): Part => ({ externalId: `p${partNumber}`, partNumber, status: dispatched ? 'DESPATCHED' : 'NEW', dispatched, tracking: [] })
/** What fetchMintsoftOrderParts returns for an unresolvable OrderStatusId: a blank status and dispatched=false. */
const unknownPart = (partNumber: number): Part => ({ externalId: `p${partNumber}`, partNumber, status: '', dispatched: false, tracking: [] })

async function snapshotFor(): Promise<Snapshot | undefined> {
  upserts.length = 0
  partsCalls = 0
  const { runWmsOrderStatusSweep } = await import('@/lib/domain/wms/order-status-sweep')
  await runWmsOrderStatusSweep()
  return upserts[0]
}

test('Part 2 despatched while Part 1 is not: the snapshot records dispatched=true', async () => {
  statusOverrides = {}; hasParts = true
  parts = [part(1, false), part(2, true)]
  assert.equal((await snapshotFor())?.dispatched, true)
})

test('every part read and none despatched: dispatched=false', async () => {
  statusOverrides = {}; hasParts = true
  parts = [part(1, false), part(2, false)]
  assert.equal((await snapshotFor())?.dispatched, false)
})

test('fewer parts returned than the order declares: unknown (null), never false', async () => {
  statusOverrides = {}; hasParts = true
  parts = [part(1, false)]
  assert.equal((await snapshotFor())?.dispatched, null)
})

test('the part read fails: unknown (null), the snapshot itself is still written', async () => {
  statusOverrides = {}; hasParts = true
  parts = new Error('Mintsoft 429')
  const snapshot = await snapshotFor()
  assert.equal(snapshot?.dispatched, null)
  assert.equal(snapshot?.lastError, null)
})

test('a connector with no per-part read cannot vouch for a split order: null', async () => {
  statusOverrides = {}; hasParts = false
  assert.equal((await snapshotFor())?.dispatched, null)
})

test('Part 1 already despatched needs no part read', async () => {
  statusOverrides = { dispatched: true }; hasParts = true
  parts = []
  assert.equal((await snapshotFor())?.dispatched, true)
  assert.equal(partsCalls, 0)
})

test('an unsplit order keeps the connector decision and makes no part read', async () => {
  statusOverrides = { isSplit: false, partCount: null, dispatched: false }; hasParts = true
  parts = []
  assert.equal((await snapshotFor())?.dispatched, false)
  assert.equal(partsCalls, 0)
})

// The align-down gate's own refresh (o3d-hqvrp.368) goes through the same aggregate and writes only a successful read.
async function refreshOnce(): Promise<{ result: { attempted: number; refreshed: number }; written: Snapshot[] }> {
  upserts.length = 0
  partsCalls = 0
  const { refreshWmsOrderStatusSnapshots } = await import('@/lib/domain/wms/order-status-sweep')
  const result = await refreshWmsOrderStatusSnapshots(['order-1'])
  return { result, written: [...upserts] }
}

test('gate refresh of a split order persists the aggregate over every part (Part 2 despatched => true)', async () => {
  statusOverrides = {}; hasParts = true
  parts = [part(1, false), part(2, true)]
  const { result, written } = await refreshOnce()
  assert.deepEqual(result, { attempted: 1, refreshed: 1 })
  assert.equal(written[0]?.dispatched, true)
})

test('gate refresh of a split order with every part not despatched persists false', async () => {
  statusOverrides = {}; hasParts = true
  parts = [part(1, false), part(2, false)]
  assert.equal((await refreshOnce()).written[0]?.dispatched, false)
})

test('gate refresh whose part read fails persists null, never false', async () => {
  statusOverrides = {}; hasParts = true
  parts = new Error('Mintsoft 500')
  assert.equal((await refreshOnce()).written[0]?.dispatched, null)
})

test('gate refresh whose status read throws writes nothing and does not throw', async () => {
  statusOverrides = { __throw: true }; hasParts = true
  parts = []
  const { result, written } = await refreshOnce()
  assert.deepEqual(result, { attempted: 1, refreshed: 0 })
  assert.equal(written.length, 0)
  statusOverrides = {}
})

test('the stored read time is when the status request BEGAN, not when the snapshot was written (sweep and gate refresh)', async () => {
  statusOverrides = {}; hasParts = true
  parts = [part(1, false), part(2, false)]
  const swept = await snapshotFor()
  assert.ok(swept?.fetchedAt instanceof Date, 'the sweep persists an explicit read time')
  assert.ok(swept.fetchedAt.getTime() < getResolvedAt, 'read time precedes the end of the status GET')
  const { written } = await refreshOnce()
  assert.ok(written[0]?.fetchedAt instanceof Date)
  assert.ok(written[0].fetchedAt.getTime() < getResolvedAt, 'the gate refresh stamps request start too')
})

test('Part 1 pending and Part 2 with an unresolved (blank) status: null, never false', async () => {
  statusOverrides = {}; hasParts = true
  parts = [part(1, false), unknownPart(2)]
  assert.equal((await snapshotFor())?.dispatched, null)
  assert.equal((await refreshOnce()).written[0]?.dispatched, null, 'the gate refresh takes the same rule')
})

test('every part resolved and pending: false (an unknown part is the only thing that withholds it)', async () => {
  statusOverrides = {}; hasParts = true
  parts = [part(1, false), part(2, false)]
  assert.equal((await snapshotFor())?.dispatched, false)
})

test('an unresolved part does not hide a despatched one: still true', async () => {
  statusOverrides = {}; hasParts = true
  parts = [unknownPart(1), part(2, true)]
  assert.equal((await snapshotFor())?.dispatched, true)
})
