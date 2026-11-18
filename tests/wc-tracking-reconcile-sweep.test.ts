import assert from 'node:assert/strict'
import test from 'node:test'

import {
  reconcileWcTrackingPushes,
  WC_TRACKING_RECONCILE_BATCH,
  WC_TRACKING_RECONCILE_SKIP_WC_STATUSES,
  type WcTrackingReconcileDeps,
} from '@/lib/connectors/woocommerce/sync/tracking-reconcile'

// o3d-ekujm. A tracking push lost between a shipment's commit and its post-commit push has nothing that
// retries it. The sweep re-derives the obligation from durable state and goes through the same push as every
// other tracking write (so the outbound hold applies).

const NOW = new Date('2026-11-18T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

type Order = { id: string; shipments: Array<{ updatedAt: Date; trackingNumber: string | null }> }
type Log = { entityId: string; status: 'SYNCED' | 'FAILED'; createdAt: Date }

function harness(orders: Order[], logs: Log[] = [], enabled = true) {
  const pushes: Array<{ orderId: string; skip: readonly string[] }> = []
  const created: Array<Record<string, unknown>> = []
  let pushResult: (orderId: string) => { success: boolean; skipped?: boolean; shadowed?: boolean } | Error = () => ({ success: true })
  const deps: Partial<WcTrackingReconcileDeps> = {
    isEnabled: async () => enabled,
    now: () => NOW,
    pushTracking: async (orderId, options) => {
      pushes.push({ orderId, skip: options.skipWcStatuses })
      const result = pushResult(orderId)
      if (result instanceof Error) throw result
      return result
    },
    db: {
      salesOrder: { findMany: async () => orders },
      shoppingSyncLog: {
        findFirst: async ({ where }: { where: { status: string; entityId: string; createdAt: { gte: Date } } }) =>
          logs.find((l) => l.entityId === where.entityId && l.status === where.status && l.createdAt >= where.createdAt.gte) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data },
      },
    } as never,
  }
  return { deps, pushes, created, setPush: (fn: typeof pushResult) => { pushResult = fn } }
}

const lost = (id: string): Order => ({ id, shipments: [{ updatedAt: minutesAgo(60), trackingNumber: 'TRK1' }] })

test('an order whose tracking was never pushed is re-pushed, and the skip-list is passed', async () => {
  const h = harness([lost('o1')])
  const result = await reconcileWcTrackingPushes(h.deps)
  assert.deepEqual(h.pushes, [{ orderId: 'o1', skip: WC_TRACKING_RECONCILE_SKIP_WC_STATUSES }])
  assert.deepEqual(result, { scanned: 1, pushed: 1, unchanged: 0, held: 0, failed: 0 })
})

test('disabled flag: nothing is scanned or pushed', async () => {
  const h = harness([lost('o1')], [], false)
  assert.deepEqual(await reconcileWcTrackingPushes(h.deps), { skipped: true, reason: 'wc_tracking_reconcile_disabled' })
  assert.equal(h.pushes.length, 0)
})

test('an order with a SYNCED tracking row newer than the shipment change is not pushed again', async () => {
  const h = harness([lost('o1')], [{ entityId: 'o1', status: 'SYNCED', createdAt: minutesAgo(30) }])
  await reconcileWcTrackingPushes(h.deps)
  assert.equal(h.pushes.length, 0)
})

test('a SYNCED row OLDER than the latest shipment change does not cover it', async () => {
  const h = harness([lost('o1')], [{ entityId: 'o1', status: 'SYNCED', createdAt: minutesAgo(120) }])
  await reconcileWcTrackingPushes(h.deps)
  assert.equal(h.pushes.length, 1)
})

test('a recent FAILED attempt backs the order off; an old one does not', async () => {
  const recent = harness([lost('o1')], [{ entityId: 'o1', status: 'FAILED', createdAt: minutesAgo(5) }])
  await reconcileWcTrackingPushes(recent.deps)
  assert.equal(recent.pushes.length, 0)
  const old = harness([lost('o1')], [{ entityId: 'o1', status: 'FAILED', createdAt: minutesAgo(40) }])
  await reconcileWcTrackingPushes(old.deps)
  assert.equal(old.pushes.length, 1)
})

test('shipments without a tracking number are not candidates', async () => {
  const h = harness([{ id: 'o1', shipments: [{ updatedAt: minutesAgo(60), trackingNumber: '  ' }] }])
  await reconcileWcTrackingPushes(h.deps)
  assert.equal(h.pushes.length, 0)
})

test('a held (shadowed) push is counted as held, writes no mark, and is not a failure', async () => {
  const h = harness([lost('o1')])
  h.setPush(() => ({ success: false, shadowed: true }))
  const result = await reconcileWcTrackingPushes(h.deps)
  assert.deepEqual(result, { scanned: 1, pushed: 0, unchanged: 0, held: 1, failed: 0 })
  assert.equal(h.created.length, 0)
})

test('an unchanged push writes a verification mark so the order stops being a candidate', async () => {
  const h = harness([lost('o1')])
  h.setPush(() => ({ success: true, skipped: true }))
  const result = await reconcileWcTrackingPushes(h.deps)
  assert.ok('unchanged' in result && result.unchanged === 1)
  assert.equal(h.created.length, 1)
  assert.equal(h.created[0].status, 'SYNCED')
  assert.equal(h.created[0].entityId, 'o1')
  assert.deepEqual(h.created[0].payload, { meta_key: '_wc_shipment_tracking_items', items: [], reconcileVerified: true })
})

test('failures and throws are counted and do not stop the batch', async () => {
  const h = harness([lost('a'), lost('b'), lost('c')])
  h.setPush((id) => (id === 'a' ? { success: false } : id === 'b' ? new Error('boom') : { success: true }))
  const result = await reconcileWcTrackingPushes(h.deps)
  assert.deepEqual(result, { scanned: 3, pushed: 1, unchanged: 0, held: 0, failed: 2 })
})

test('at most one batch of orders is pushed per run', async () => {
  const h = harness(Array.from({ length: WC_TRACKING_RECONCILE_BATCH + 10 }, (_, i) => lost(`o${i}`)))
  await reconcileWcTrackingPushes(h.deps)
  assert.equal(h.pushes.length, WC_TRACKING_RECONCILE_BATCH)
})

test('the facade pushes through pushOrderDeliveryMetadata (the producer seam / hold), not around it', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('lib/connectors/woocommerce/sync/tracking-reconcile.ts', 'utf8')
  assert.match(source, /pushOrderDeliveryMetadata\(orderId, options\)/)
  assert.doesNotMatch(source, /wcPut\(|wcFetch\(|pushImsTrackingToWc\(/)
  const shopping = readFileSync('lib/shopping.ts', 'utf8')
  assert.match(shopping, /pushImsTrackingToWc\(orderId, options\)/)
})
