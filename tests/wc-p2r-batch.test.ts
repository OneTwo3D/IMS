import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * P2 batch R (WooCommerce inbound): per-event claim stamp, SKU matching, admission-queue expiry.
 * Everything is in memory; nothing touches the network or a database.
 */

type Row = Record<string, unknown> & { id: string }

const logged: Array<Record<string, unknown>> = []
const products: Array<{ id: string; sku: string; externalProductId: bigint | null }> = []
let findManyWhere: unknown = null
let syncLogs: Row[] = []
let live: 'gone' | 'failed' = 'gone'

mock.module('@/lib/activity-log', { namedExports: { logActivity: async (e: Record<string, unknown>) => { logged.push(e) } } })
mock.module('@/lib/db', {
  namedExports: {
    db: {
      product: {
        findMany: async ({ where }: { where: unknown }) => {
          findManyWhere = where
          // Emulates Postgres: `equals` + mode insensitive, or an externalProductId in-list.
          const or = (where as { OR: Array<{ sku?: { equals: string }; externalProductId?: { in: bigint[] } }> }).OR
          return products.filter((p) => or.some((c) => {
            if (c.sku) return p.sku.toLowerCase() === String(c.sku.equals).toLowerCase()
            if (c.externalProductId) return p.externalProductId !== null && c.externalProductId.in.includes(p.externalProductId)
            return false
          }))
        },
      },
      shoppingSyncLog: {
        findMany: async () => syncLogs.filter((r) => r.status === 'PENDING'),
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = syncLogs.find((r) => r.id === where.id)!
          Object.assign(row, data)
          return row
        },
      },
    },
  },
})
mock.module('@/lib/connectors/woocommerce/api', {
  namedExports: { wcFetch: async () => (live === 'gone' ? { data: null, error: 'HTTP 404 not found' } : { data: null, error: 'HTTP 503' }) },
})
mock.module('@/lib/connectors/woocommerce/sync/order-import', { namedExports: { importWcOrder: async () => ({ success: false }) } })
mock.module('@/lib/connectors/woocommerce/sync/withdrawal', { namedExports: { importWcOrderGuarded: async () => ({ outcome: 'unresolved' }) } })

const line = (over: Record<string, unknown>) => ({
  id: 1, name: 'x', product_id: 10, variation_id: 0, quantity: 1, tax_class: '', subtotal: '10', subtotal_tax: '0',
  total: '10', total_tax: '0', taxes: [], meta_data: [], sku: '', price: 10, ...over,
})

test('o3d-hqvrp.90: SKU is matched trimmed and case-insensitively', async () => {
  const { mapWcLineItems } = await import('../lib/connectors/woocommerce/sync/field-mapping.ts')
  products.length = 0
  products.push({ id: 'p-abc', sku: 'ABC-01', externalProductId: null })
  const [mapped] = await mapWcLineItems([line({ sku: ' abc-01 ' }) as never], 1)
  assert.equal(mapped.productId, 'p-abc')
  assert.equal(mapped.sku, 'abc-01')
  assert.ok(findManyWhere)
})

test('o3d-hqvrp.90: two IMS SKUs differing only by case never bind by folding', async () => {
  const { mapWcLineItems } = await import('../lib/connectors/woocommerce/sync/field-mapping.ts')
  products.length = 0
  products.push({ id: 'p-upper', sku: 'ABC-01', externalProductId: BigInt(5) }, { id: 'p-lower', sku: 'abc-01', externalProductId: BigInt(6) })
  logged.length = 0
  const mapped = await mapWcLineItems([
    line({ id: 1, sku: 'Abc-01', product_id: 5 }) as never, // ambiguous: not bound, even though the WC id names p-upper
    line({ id: 2, sku: 'abc-01' }) as never, // exact hit wins
    line({ id: 3, sku: 'ABC-01' }) as never,
  ], 1)
  assert.equal(mapped[0].productId, null)
  assert.equal(mapped[1].productId, 'p-lower')
  assert.equal(mapped[2].productId, 'p-upper')
  assert.equal(logged.length, 1)
  assert.match(String(logged[0].description), /Ambiguous.*Abc-01/)
})

test('o3d-hqvrp.90: no SKU or an unknown SKU falls back to the WooCommerce id (variation first)', async () => {
  const { mapWcLineItems } = await import('../lib/connectors/woocommerce/sync/field-mapping.ts')
  products.length = 0
  products.push({ id: 'p-parent', sku: 'PARENT', externalProductId: BigInt(10) }, { id: 'p-var', sku: 'VAR', externalProductId: BigInt(11) })
  logged.length = 0
  const mapped = await mapWcLineItems([
    line({ id: 1, sku: '', product_id: 10, variation_id: 11 }) as never,
    line({ id: 2, sku: 'RENAMED-IN-WC', product_id: 10 }) as never,
    line({ id: 3, sku: 'NOPE', product_id: 99 }) as never,
  ], 1)
  assert.deepEqual(mapped.map((m) => m.productId), ['p-var', 'p-parent', null])
  assert.equal(logged.length, 1, 'the unmatched line is flagged at import')
})

function refusalRow(id: string, over: { reason?: string; refusedAt: string; attempts?: number }): Row {
  return {
    id, status: 'PENDING', externalId: id,
    payload: {
      queue: 'wc_admission_refusal', connector: 'woocommerce', externalOrderId: id, externalOrderNumber: id,
      status: 'pending', configured: ['processing'], currency: 'GBP', reason: over.reason ?? 'status_not_admitted',
      refusedAt: over.refusedAt, attempts: over.attempts ?? 0,
    },
  }
}

test('o3d-hqvrp.93: expired status-only refusals are retired without a WooCommerce read; guard blocks are kept', async () => {
  const { drainWcOrderAdmissionRefusals, WC_ADMISSION_REFUSAL_QUEUE } = await import('../lib/connectors/woocommerce/sync/order-admission.ts')
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
  const fresh = new Date(Date.now() - 1 * 86_400_000).toISOString()
  syncLogs = [
    refusalRow('old-status', { refusedAt: old }),
    refusalRow('old-guard', { refusedAt: old, reason: 'tax_rate_unmapped' }),
    refusalRow('fresh-status', { refusedAt: fresh }),
  ]
  for (const r of syncLogs) (r.payload as Record<string, unknown>).queue = WC_ADMISSION_REFUSAL_QUEUE
  live = 'failed'
  const result = await drainWcOrderAdmissionRefusals(50)
  assert.equal(syncLogs.find((r) => r.id === 'old-status')!.status, 'SYNCED')
  assert.equal(syncLogs.find((r) => r.id === 'old-guard')!.status, 'PENDING')
  assert.equal(syncLogs.find((r) => r.id === 'fresh-status')!.status, 'PENDING')
  assert.equal(result.retired, 1)
  assert.equal(result.failed, 2, 'only the two live rows cost a read')
})

test('o3d-hqvrp.93: an order deleted in WooCommerce is retired on its third 404, not rotated for ever', async () => {
  const { drainWcOrderAdmissionRefusals, WC_ADMISSION_REFUSAL_QUEUE } = await import('../lib/connectors/woocommerce/sync/order-admission.ts')
  const now = new Date().toISOString()
  syncLogs = [refusalRow('gone-1', { refusedAt: now, attempts: 0 })]
  ;(syncLogs[0].payload as Record<string, unknown>).queue = WC_ADMISSION_REFUSAL_QUEUE
  live = 'gone'
  for (let run = 0; run < 2; run++) await drainWcOrderAdmissionRefusals(50)
  assert.equal(syncLogs[0].status, 'PENDING')
  const third = await drainWcOrderAdmissionRefusals(50)
  assert.equal(syncLogs[0].status, 'SYNCED')
  assert.equal(third.retired, 1)
})

test('o3d-hqvrp.93: rows past the live-read budget are not touched', async () => {
  const { drainWcOrderAdmissionRefusals, WC_ADMISSION_REFUSAL_QUEUE } = await import('../lib/connectors/woocommerce/sync/order-admission.ts')
  const now = new Date().toISOString()
  syncLogs = ['a', 'b', 'c'].map((id) => refusalRow(id, { refusedAt: now }))
  for (const r of syncLogs) (r.payload as Record<string, unknown>).queue = WC_ADMISSION_REFUSAL_QUEUE
  live = 'failed'
  const result = await drainWcOrderAdmissionRefusals(2)
  assert.equal(result.scanned, 2)
  assert.equal(result.failed, 2)
})

test('o3d-hqvrp.86: each event in a batch is claimed with its own clock, not the batch start', async () => {
  const { processPendingShoppingWebhookEvents } = await import('../lib/jobs/shopping/process-shopping-webhook-events.ts')
  const claims: Array<{ now: number; stale: number }> = []
  const rows = ['e1', 'e2'].map((id) => ({
    id, connector: 'woocommerce', resource: 'orders', externalEventId: null, topic: 'order.updated', payloadHash: id,
    payloadJson: {}, originAttestation: 'unproven:not-applicable', status: 'pending', attempts: 1, claimGeneration: 1,
    nextAttemptAt: null, processedAt: null, lastError: null, receivedAt: new Date(), updatedAt: new Date(),
  }))
  const repository = {
    findDueEvents: async () => rows.map((r) => ({ id: r.id })),
    claimEvent: async (id: string, now: Date, stale: Date) => {
      claims.push({ now: now.getTime(), stale: stale.getTime() })
      return rows.find((r) => r.id === id)!
    },
    markProcessed: async () => true,
    markFailed: async () => true,
    markDeadLetter: async () => true,
  }
  await processPendingShoppingWebhookEvents({
    repository: repository as never,
    connector: 'woocommerce',
    connectorLabel: 'WooCommerce',
    logPrefix: '[test]',
    processPayload: async () => {
      await new Promise((r) => setTimeout(r, 40)) // the first event is slow
      return Response.json({ ok: true })
    },
  } as never)
  assert.equal(claims.length, 2)
  assert.ok(claims[1].now - claims[0].now >= 30, 'the second claim is stamped when it happens')
  assert.equal(claims[1].stale - claims[0].stale, claims[1].now - claims[0].now, 'and its stale cutoff moves with it')
})
