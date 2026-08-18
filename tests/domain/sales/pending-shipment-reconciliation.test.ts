import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
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
  const activity: Array<Record<string, unknown>> = []
  // o3d-4kfh r5 (finding 7): the audit row and the delete must land in ONE transaction, in that
  // order. Recording the interleaving is the only way a double can tell "written first" from
  // "written afterwards, when the rows it describes are already gone".
  const writeOrder: string[] = []
  return {
    calls,
    state,
    activity,
    writeOrder,
    client: {
      salesOrder: {
        findUnique: async () => ({ orderNumber: 'SO-1', externalOrderNumber: null }),
      },
      activityLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          activity.push(data)
          writeOrder.push('activityLog.create')
          return data
        },
      },
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
          writeOrder.push('shipment.deleteMany')
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

  const result = await reconcilePendingShipments(harness.client, 'order-1', { cause: 'a test mutation' })

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

  const result = await reconcilePendingShipments(harness.client, 'order-1', { cause: 'a test mutation' })

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

  const result = await reconcilePendingShipments(harness.client, 'order-1', { cause: 'a test mutation' })

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

  const result = await reconcilePendingShipments(harness.client, 'order-1', { cause: 'a test mutation' })

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

  const result = await reconcilePendingShipments(harness.client, 'order-1', { cause: 'a test mutation' })

  assert.deepEqual(result.retired.map((row) => row.id), ['d1'])
})

test('o3d-4kfh r4: no drafts means no reads and no writes at all', async () => {
  // The cheap path matters: this runs on every allocation rewrite, including the 15-minute sweep.
  const harness = client({ allocations: [], drafts: [] })

  const result = await reconcilePendingShipments(harness.client, 'order-1', { cause: 'a test mutation' })

  assert.deepEqual(result, { retired: [], retainedCount: 0 })
  assert.equal(harness.calls.orderAllocationReads, 0, 'nothing is loaded when there is nothing to judge')
  assert.equal(harness.calls.committedReads, 0)
})


// ---------------------------------------------------------------------------
// o3d-4kfh r5 (Codex finding 3) — the rows are ALWAYS re-read; there is no supplied-rows shortcut.
// ---------------------------------------------------------------------------

test('o3d-4kfh r5: drafts are judged against the rows the CLIENT returns, at the persisted precision', async () => {
  // The removed shortcut let `allocateSalesOrder` supply its in-memory, unrounded computation
  // instead. OrderAllocation.qty is Decimal(12,4): a computed 0.33338 persists as 0.3334, and the
  // draft holds the persisted 0.3334 because confirmSalesOrderShipments builds it from the row.
  // Judged against 0.33338 the draft showed a 0.00002 shortage — twenty epsilons — and was deleted.
  // Judged against what the client actually holds, it is backed exactly.
  const harness = client({
    allocations: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w1', qty: 0.3334 }],
    drafts: [draft('d1', 0.3334, { trackingNumber: 'TRACK-1' })],
  })

  const result = await reconcilePendingShipments(harness.client, 'order-1', { cause: 'a re-allocation' })

  assert.deepEqual(result.retired, [], 'the stored row backs the draft to the digit')
  assert.equal(result.retainedCount, 1)
  assert.equal(harness.calls.orderAllocationReads, 1, 'read, never told')
  assert.equal(harness.calls.committedReads, 1)
  assert.deepEqual(harness.state.drafts.map((row) => row.id), ['d1'])
})

// ---------------------------------------------------------------------------
// o3d-4kfh r5 (Codex finding 7) — the retirement audit is durable with the deletion.
// ---------------------------------------------------------------------------

test('o3d-4kfh r5: the audit row is written on the SAME client, BEFORE the drafts are deleted', async () => {
  const harness = client({
    allocations: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w1', qty: 1 }],
    drafts: [draft('d1', 4, { trackingNumber: 'TRACK-9', shippingService: 'DPD' })],
  })

  const result = await reconcilePendingShipments(harness.client, 'order-1', {
    cause: 'a manual allocation edit',
    auditMetadata: { source: 'stock_adjustment' },
    userId: 'user-1',
  })

  assert.deepEqual(result.retired.map((row) => row.id), ['d1'])
  assert.deepEqual(
    harness.writeOrder,
    ['activityLog.create', 'shipment.deleteMany'],
    'evidence first: a crash after the delete must not be able to lose the label id',
  )
  assert.equal(harness.activity.length, 1)
  const entry = harness.activity[0] as {
    userId: string | null
    action: string
    level: string
    description: string
    metadata: {
      cause: string
      source: string
      retiredTrackingNumbers: string[]
      retiredShipments: Array<{ shipmentId: string; trackingNumber: string | null }>
    }
  }
  assert.equal(entry.action, 'pending_shipments_retired')
  assert.equal(entry.level, 'WARNING')
  assert.equal(entry.userId, 'user-1')
  assert.equal(entry.metadata.cause, 'a manual allocation edit')
  assert.equal(entry.metadata.source, 'stock_adjustment', 'caller context is merged, not dropped')
  assert.deepEqual(entry.metadata.retiredTrackingNumbers, ['TRACK-9'])
  assert.deepEqual(entry.metadata.retiredShipments, [{
    shipmentId: 'd1',
    warehouseId: 'w1',
    trackingNumber: 'TRACK-9',
    shippingService: 'DPD',
    lineCount: 1,
    totalQty: 4,
  }])
  assert.match(entry.description, /TRACK-9/, 'the operator can find the purchased label from the entry alone')
})

test('o3d-4kfh r5: nothing retired means no audit row at all', async () => {
  const harness = client({
    allocations: [{ lineId: 'line-1', productId: 'p1', warehouseId: 'w1', qty: 10 }],
    drafts: [draft('d1', 4)],
  })

  const result = await reconcilePendingShipments(harness.client, 'order-1', { cause: 'a re-allocation' })

  assert.equal(result.retainedCount, 1)
  assert.deepEqual(harness.activity, [])
  assert.deepEqual(harness.writeOrder, [], 'no delete and no record — the run changed nothing')
})

test('o3d-4kfh r5: the caller-supplied allocation shortcut is GONE from both the module and the allocator', async () => {
  // The behavioural half of finding 3 lives where the rounding happens — see
  // "a fractional KIT draft backed by its ROUNDED row survives the rewrite" in
  // tests/domain/sales/allocation-service.test.ts, which is the test that goes red if the shortcut
  // comes back. This pins the shortcut's ABSENCE at its own seam, because the defect was not a wrong
  // rule but an extra parameter that let one caller bypass the persisted state.
  const moduleSource = await readFile(
    path.join(process.cwd(), 'lib/domain/sales/pending-shipment-reconciliation.ts'),
    'utf8',
  )
  const allocatorSource = await readFile(
    path.join(process.cwd(), 'lib/domain/sales/allocation-service.ts'),
    'utf8',
  )

  assert.doesNotMatch(
    moduleSource,
    /options\.allocations|options\.committedShipmentLines/,
    'the reconciler must read the rows, never be told them',
  )
  assert.doesNotMatch(
    allocatorSource,
    /allocations: persistedAllocations/,
    'and the allocator must not hand over its unrounded in-memory computation',
  )
})
