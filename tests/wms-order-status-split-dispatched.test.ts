import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// o3d-hqvrp.368 (Codex HIGH): fetchMintsoftOrderStatus deliberately reads Part 1 of a split order, so the
// persisted `dispatched` was Part 1's decision alone. Part 2 despatching first left a `false` snapshot that the
// align-down in-flight gate released on. The sweep must persist an AGGREGATE for a split order: true when any
// part is despatched, false only when every part was read and none is despatched, otherwise null (unknown).
// All HTTP is mocked: the connector below is a stub and nothing reaches Mintsoft.

type Snapshot = { orderId: string; dispatched: boolean | null; lastError: string | null }
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
      fetchOrderStatus: async () => ({
        externalOrderId: 'ext-1', externalOrderNumber: 'SO-1', status: 'NEW', statusLabel: 'NEW',
        isSplit: true, partCount: 2, isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null,
        tracking: [], dispatched: false, raw: {}, ...statusOverrides,
      }),
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
