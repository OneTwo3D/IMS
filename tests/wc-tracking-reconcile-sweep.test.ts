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

type Order = { id: string; shipments: Array<{ updatedAt?: Date; trackingNumber: string | null; shippingService?: string | null; shippedAt?: Date | null }> }
type Log = { entityId: string; status: 'SYNCED' | 'FAILED'; createdAt: Date; payload?: unknown }

function harness(orders: Order[], logs: Log[] = [], enabled = true) {
  const pushes: Array<{ orderId: string; skip: readonly string[] }> = []
  const created: Array<Record<string, unknown>> = []
  const pages: Array<{ cursor: string | null; take: number }> = []
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
      salesOrder: {
        findMany: async ({ where, take }: { where: { id?: { gt: string } }; take: number }) => {
          pages.push({ cursor: where.id?.gt ?? null, take })
          return [...orders].sort((x, y) => (x.id < y.id ? -1 : 1)).filter((o) => !where.id || o.id > where.id.gt).slice(0, take)
        },
      },
      shoppingSyncLog: {
        findMany: async ({ where }: { where: { status: string; entityId: { in: string[] }; createdAt: { gte: Date } } }) =>
          logs
            .filter((l) => where.entityId.in.includes(l.entityId) && l.status === where.status && l.createdAt >= where.createdAt.gte)
            .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()),
        create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data },
      },
    } as never,
  }
  return { deps, pushes, created, pages, setPush: (fn: typeof pushResult) => { pushResult = fn } }
}

const synced = (entityId: string, minutes: number, ...numbers: string[]): Log => ({
  entityId, status: 'SYNCED', createdAt: minutesAgo(minutes), payload: { meta_key: '_wc_shipment_tracking_items', items: numbers.map((n) => ({ tracking_number: n })) },
})

const lost = (id: string, tracking = 'TRK1'): Order => ({ id, shipments: [{ trackingNumber: tracking }] })

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

test('an order whose latest SYNCED push carries exactly the current tracking is covered', async () => {
  const h = harness([lost('o1')], [synced('o1', 30, 'trk1')])
  await reconcileWcTrackingPushes(h.deps)
  assert.equal(h.pushes.length, 0)
})

test('a late log for OLD tracking does not hide a newer lost update (content, not timestamps)', async () => {
  // Shipment now carries TRK2 (the edit whose push was lost); an older push of TRK1 logged AFTER the edit committed.
  const h = harness([lost('o1', 'TRK2')], [synced('o1', 1, 'TRK1')])
  await reconcileWcTrackingPushes(h.deps)
  assert.equal(h.pushes.length, 1)
})

test('the LATEST synced row decides: an older matching row does not cover a newer different one', async () => {
  const h = harness([lost('o1', 'TRK2')], [synced('o1', 50, 'TRK2'), synced('o1', 10, 'TRK1')])
  await reconcileWcTrackingPushes(h.deps)
  assert.equal(h.pushes.length, 1)
})

test('a carrier or date edit whose push was lost is retried (items compared, not only numbers)', async () => {
  const shippedAt = new Date('2026-11-17T10:00:00Z')
  const epoch = String(Math.floor(shippedAt.getTime() / 1000))
  const order: Order = { id: 'o1', shipments: [{ trackingNumber: 'TRK1', shippingService: 'DPD', shippedAt }] }
  const log = (provider: string, date: string): Log => ({
    entityId: 'o1', status: 'SYNCED', createdAt: minutesAgo(30),
    payload: { meta_key: '_wc_shipment_tracking_items', items: [{ tracking_number: 'TRK1', tracking_provider: provider, custom_tracking_provider: provider, date_shipped: date }] },
  })
  const same = harness([order], [log('DPD', epoch)])
  await reconcileWcTrackingPushes(same.deps)
  assert.equal(same.pushes.length, 0, 'identical item is covered')
  const carrierEdit = harness([order], [log('Royal Mail', epoch)])
  await reconcileWcTrackingPushes(carrierEdit.deps)
  assert.equal(carrierEdit.pushes.length, 1, 'carrier changed, same number')
  const dateEdit = harness([order], [log('DPD', String(Number(epoch) - 86400))])
  await reconcileWcTrackingPushes(dateEdit.deps)
  assert.equal(dateEdit.pushes.length, 1, 'date changed, same number')
})

test('a verification mark covers the order by its recorded tracking numbers', async () => {
  const mark: Log = { entityId: 'o1', status: 'SYNCED', createdAt: minutesAgo(5), payload: { meta_key: '_wc_shipment_tracking_items', items: [], reconcileVerified: true, reconcileTrackingItems: [{ number: 'trk1', provider: 'custom', dateShipped: '' }] } }
  const covered = harness([lost('o1')], [mark])
  await reconcileWcTrackingPushes(covered.deps)
  assert.equal(covered.pushes.length, 0)
  const stale = harness([lost('o1', 'TRK9')], [mark])
  await reconcileWcTrackingPushes(stale.deps)
  assert.equal(stale.pushes.length, 1)
})

test('a large covered backlog cannot starve a later order: every eligible order is paged through', async () => {
  const covered = Array.from({ length: 450 }, (_, i) => lost(`a${String(i).padStart(4, '0')}`))
  const logs = covered.map((o) => synced(o.id, 30, 'TRK1'))
  const h = harness([...covered, lost('z-late-lost')], logs)
  await reconcileWcTrackingPushes(h.deps)
  assert.deepEqual(h.pushes.map((p) => p.orderId), ['z-late-lost'])
  assert.ok(h.pages.length >= 3, 'more than one page was read')
  assert.equal(h.pages[1].cursor, 'a0199', 'the cursor is a keyset on id')
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
  const h = harness([{ id: 'o1', shipments: [{ trackingNumber: '  ' }] }])
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
  assert.deepEqual(h.created[0].payload, { meta_key: '_wc_shipment_tracking_items', items: [], reconcileVerified: true, reconcileTrackingItems: [{ number: 'trk1', provider: 'custom', dateShipped: '' }] })
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
