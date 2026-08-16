import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcilePendingShipments } from '@/lib/domain/sales/pending-shipment-reconciliation'

/**
 * o3d-4kfh r4 — the ONE rule, tested directly.
 *
 * Four mutation paths call this (the allocator rewrite, the deallocation teardown, the manual
 * allocation editor and the overallocation rebalancer) and each had its own cleanup before; two of
 * the three round-4 findings were caused by that duplication. The call sites are tested where they
 * live; this file pins the shared rule itself, including the parts no single call site exercises —
 * oldest-first charging between two drafts on the SAME scope, and reading the post-mutation state
 * through the caller's client rather than being told what to conclude.
 */

type Draft = {
  id: string
  warehouseId: string
  trackingNumber?: string | null
  shippingService?: string | null
  createdAt: string
  lines: Array<{ lineId: string; productId: string; qty: number }>
}
type Allocation = { lineId: string; productId: string; warehouseId: string; qty: number }
type Committed = { lineId: string; productId: string; warehouseId: string; qty: number }

function client(fixture: { drafts: Draft[]; allocations: Allocation[]; committed?: Committed[] }) {
  const state = { drafts: [...fixture.drafts] }
  const calls = { orderAllocationReads: 0, committedReads: 0 }
  return {
    calls,
    state,
    client: {
      shipment: {
        findMany: async ({ where }: { where: { orderId: string; status: string } }) => {
          assert.equal(where.status, 'PENDING', 'only PENDING drafts may ever be considered')
          return state.drafts
            .slice()
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
            .map((draft) => ({
              id: draft.id,
              warehouseId: draft.warehouseId,
              trackingNumber: draft.trackingNumber ?? null,
              shippingService: draft.shippingService ?? null,
              lines: draft.lines.map((line) => ({ ...line })),
            }))
        },
        deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          const before = state.drafts.length
          state.drafts = state.drafts.filter((draft) => !where.id.in.includes(draft.id))
          return { count: before - state.drafts.length }
        },
      },
      orderAllocation: {
        findMany: async () => {
          calls.orderAllocationReads += 1
          return fixture.allocations.map((row) => ({ ...row }))
        },
      },
      shipmentLine: {
        findMany: async ({ where }: { where: { shipment: { status: { not: string } } } }) => {
          calls.committedReads += 1
          assert.equal(where.shipment.status.not, 'PENDING', 'the committed set is everything NOT pending')
          return (fixture.committed ?? []).map((row) => ({
            lineId: row.lineId,
            productId: row.productId,
            qty: row.qty,
            shipment: { warehouseId: row.warehouseId },
          }))
        },
      },
    } as never,
  }
}

function draft(id: string, qty: number, overrides: Partial<Draft> = {}): Draft {
  return {
    id,
    warehouseId: 'w1',
    createdAt: '2026-01-01T00:00:00Z',
    lines: [{ lineId: 'line-1', productId: 'p1', qty }],
    ...overrides,
  }
}

test('o3d-4kfh r4: two drafts on the same scope are charged OLDEST-FIRST, so they cannot both claim the same units', async () => {
  // 6 allocated, two 4-unit drafts. Charging without consuming would call BOTH backed (4 <= 6
  // twice) and leave 8 units of draft against 6 units of allocation — an over-commitment the moment
  // either is picked. The older draft takes 4 and the younger finds only 2 left.
  const harness = client({
    allocations: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w1', qty: 6 }],
    drafts: [
      draft('older', 4, { createdAt: '2026-01-01T00:00:00Z' }),
      draft('younger', 4, { createdAt: '2026-02-01T00:00:00Z' }),
    ],
  })

  const result = await reconcilePendingShipments(harness.client, 'order-1')

  assert.deepEqual(result.retired.map((row) => row.id), ['younger'])
  assert.equal(result.retainedCount, 1)
  assert.deepEqual(harness.state.drafts.map((row) => row.id), ['older'])
})

test('o3d-4kfh r4: a DOOMED draft does not consume open quantity on its way out', async () => {
  // The older draft is unbacked (5 against 4 allocated). If its claim were charged anyway, the
  // younger 4-unit draft would find nothing left and be destroyed too — a second, entirely
  // avoidable casualty.
  const harness = client({
    allocations: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w1', qty: 4 }],
    drafts: [
      draft('older', 5, { createdAt: '2026-01-01T00:00:00Z' }),
      draft('younger', 4, { createdAt: '2026-02-01T00:00:00Z' }),
    ],
  })

  const result = await reconcilePendingShipments(harness.client, 'order-1')

  assert.deepEqual(result.retired.map((row) => row.id), ['older'])
  assert.deepEqual(harness.state.drafts.map((row) => row.id), ['younger'])
})

test('o3d-4kfh r4: COMMITTED quantity is subtracted before any draft is charged', async () => {
  // The row claims 10 but 6 are already committed to a PICKING shipment, so only 4 are open. A
  // draft of 6 is not backed, even though 6 <= 10.
  const harness = client({
    allocations: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w1', qty: 10 }],
    committed: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w1', qty: 6 }],
    drafts: [draft('d1', 6)],
  })

  const result = await reconcilePendingShipments(harness.client, 'order-1')

  assert.deepEqual(result.retired.map((row) => row.id), ['d1'])
})

test('o3d-4kfh r4: a MULTI-LINE draft is retired WHOLE when any one line is short', async () => {
  // Trimming it instead would silently ship less than the operator confirmed, and a kit trimmed on
  // one component is no longer a kit at all.
  const harness = client({
    allocations: [
      { lineId: 'line-1', productId: 'comp-a', warehouseId: 'w1', qty: 2 },
      { lineId: 'line-1', productId: 'comp-b', warehouseId: 'w1', qty: 0 },
    ],
    drafts: [{
      id: 'd1',
      warehouseId: 'w1',
      createdAt: '2026-01-01T00:00:00Z',
      trackingNumber: 'TRACK-1',
      shippingService: 'DPD',
      lines: [
        // The SHORT line first on purpose: with a `break` on the first shortfall the reported
        // totalQty would be 1 rather than the 3 that actually disappeared, and a fixture whose
        // short line came last could not tell the two apart.
        { lineId: 'line-1', productId: 'comp-b', qty: 1 },
        { lineId: 'line-1', productId: 'comp-a', qty: 2 },
      ],
    }],
  })

  const result = await reconcilePendingShipments(harness.client, 'order-1')

  assert.deepEqual(result.retired, [{
    id: 'd1',
    warehouseId: 'w1',
    trackingNumber: 'TRACK-1',
    shippingService: 'DPD',
    lineCount: 2,
    // The WHOLE draft is measured even once it is known to be doomed, so the operator is told what
    // actually disappeared rather than what had been counted before the first short line.
    totalQty: 3,
  }])
})

test('o3d-4kfh r4: an allocation in a DIFFERENT warehouse does not back a draft', async () => {
  // Scope is (line, warehouse, product). The warehouse half is what makes a move invalidate a draft
  // without any quantity changing at all.
  const harness = client({
    allocations: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w2', qty: 10 }],
    drafts: [draft('d1', 4, { warehouseId: 'w1' })],
  })

  const result = await reconcilePendingShipments(harness.client, 'order-1')

  assert.deepEqual(result.retired.map((row) => row.id), ['d1'])
})

test('o3d-4kfh r4: no drafts means no reads and no writes at all', async () => {
  // The cheap path matters: this runs on every allocation rewrite, including the 15-minute sweep.
  const harness = client({ allocations: [], drafts: [] })

  const result = await reconcilePendingShipments(harness.client, 'order-1')

  assert.deepEqual(result, { retired: [], retainedCount: 0 })
  assert.equal(harness.calls.orderAllocationReads, 0, 'nothing is loaded when there is nothing to judge')
  assert.equal(harness.calls.committedReads, 0)
})

test('o3d-4kfh r4: supplied rows are used verbatim, and then nothing is read', async () => {
  // The in-memory shortcut the allocator uses (it has just written the rows itself). Same rule —
  // this asserts it really is the same rule, and that supplying rows does not ALSO trigger a read
  // that could disagree with them.
  const harness = client({
    allocations: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w1', qty: 99 }],
    drafts: [draft('d1', 4)],
  })

  const result = await reconcilePendingShipments(harness.client, 'order-1', {
    allocations: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w1', qty: 1 }],
    committedShipmentLines: [],
  })

  assert.deepEqual(result.retired.map((row) => row.id), ['d1'], 'judged against the SUPPLIED rows, not the fixture\'s 99')
  assert.equal(harness.calls.orderAllocationReads, 0)
  assert.equal(harness.calls.committedReads, 0)
})
