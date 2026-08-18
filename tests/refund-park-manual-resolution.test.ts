import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-w00 (Codex r1 #3): a QUARANTINED refund park used to be a dead end. The refund was refused
 * deliberately — an undeterminable gross→net basis, or an order that is not uniformly taxed — the money
 * had ALREADY left WooCommerce, and the only button on the row was Retry, which re-runs the same
 * refusal against the same order. The park kept counting in the exception inbox and kept blocking order
 * deletion / store rebinding forever, and an operator who reconciled it by hand had no way to say so.
 *
 * These pin the completion path: the operator supplies the one thing IMS cannot derive — which order
 * lines the money covered and how much NET each took — and that raises the credit note LINE-LINKED (so
 * each line carries its own VAT identity and the uniform-tax refusal does not apply), stamps the
 * WooCommerce refund id so a redelivery dedups instead of double-crediting, and resolves the park.
 */

type ParkRow = { id: string; entityId: string | null; externalId: string | null; status: string; errorMessage: string | null }

const state: {
  park: ParkRow | null
  parkQueryStatus: string | null
  landedRefund: { orderId: string; creditNoteNumber: string | null } | null
  order: { id: string; fxRateToBase: number; lines: { id: string; productId: string | null; description: string }[] } | null
  createRefundCalls: Array<{ orderId: string; lines: unknown[]; reason: string; returnWarehouseId: unknown; options: { externalRefundId?: number } }>
  createRefundResult: { success: boolean; error?: string }
  parkUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>
  activity: Array<Record<string, unknown>>
  syncRefundsCalls: number
} = {
  park: null,
  parkQueryStatus: null,
  landedRefund: null,
  order: null,
  createRefundCalls: [],
  createRefundResult: { success: true },
  parkUpdates: [],
  activity: [],
  syncRefundsCalls: 0,
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      shoppingSyncLog: {
        async findFirst(args: { where?: { id?: string; status?: string | { in?: string[] } } }) {
          const status = args?.where?.status
          // REFUND_PARK_WHERE passes { in: [...] }; the Record-manually query narrows it to the literal
          // 'QUARANTINED'. Both shapes have to be honoured or the narrowing looks like it happened when
          // it did not.
          state.parkQueryStatus = typeof status === 'string' ? status : null
          if (!state.park || args?.where?.id !== state.park.id) return null
          if (typeof status === 'string' && status !== state.park.status) return null
          if (status && typeof status === 'object' && !(status.in ?? []).includes(state.park.status)) return null
          return state.park
        },
        // Filters on the fields the production where-clauses actually use, so a where that does NOT
        // match cannot silently "succeed" — which is the whole point of the restore-quarantine test.
        async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
          state.parkUpdates.push(args)
          const where = args.where as { externalId?: string; entityId?: string; status?: string; errorMessage?: string | null }
          const park = state.park
          const matches = park != null &&
            (where.externalId == null || where.externalId === park.externalId) &&
            (where.entityId == null || where.entityId === park.entityId) &&
            (where.status == null || where.status === park.status) &&
            (where.errorMessage === undefined || where.errorMessage === park.errorMessage)
          if (!matches || !park) return { count: 0 }
          state.park = { ...park, status: String(args.data.status ?? park.status) }
          return { count: 1 }
        },
        async findMany() { return state.park ? [{ id: state.park.id }] : [] },
        async deleteMany() { return { count: 0 } },
      },
      shoppingOrderLink: { async findFirst() { return { externalOrderId: '1001' } } },
      salesOrderRefund: { async findFirst() { return state.landedRefund } },
      salesOrder: { async findUnique() { return state.order } },
    },
  },
})
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'user-1' } }),
    requireFreshPermission: async () => ({ user: { id: 'user-1' } }),
    freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: Record<string, unknown>) => { state.activity.push(entry) } },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/connectors/woocommerce/sync/refund-sync', {
  namedExports: {
    // Stands in for a WooCommerce fetch that FAILS (or omits the refund): syncRefundsForOrder returns 0
    // and nothing re-parks the row, which is exactly the case that used to strand the quarantine.
    syncRefundsForOrder: async () => { state.syncRefundsCalls += 1; return 0 },
  },
})
mock.module('@/app/actions/sales', {
  namedExports: {
    createRefund: async (
      orderId: string,
      lines: unknown[],
      reason: string,
      returnWarehouseId: unknown,
      options: { externalRefundId?: number },
    ) => {
      state.createRefundCalls.push({ orderId, lines, reason, returnWarehouseId, options })
      return state.createRefundResult
    },
  },
})

type Record_ = (
  parkId: string,
  allocations: { lineId: string; netAmountForeign: number }[],
  reason: string,
) => Promise<{ success: boolean; error?: string }>
let action: Record_ | null = null
const recordRefundParkManually: Record_ = async (...args) => {
  if (!action) {
    const module_ = await import('@/app/actions/sync-exceptions')
    action = module_.recordRefundParkManually as unknown as Record_
  }
  return action(...args)
}

const QUARANTINE_MESSAGE = 'basis undeterminable — record it manually'
const QUARANTINED_PARK: ParkRow = { id: 'park-1', entityId: 'so-1', externalId: '7101', status: 'QUARANTINED', errorMessage: QUARANTINE_MESSAGE }
const ORDER = {
  id: 'so-1',
  fxRateToBase: 1,
  lines: [
    { id: 'line-1', productId: 'product-1', description: 'Widget @ 20%' },
    { id: 'line-2', productId: 'product-2', description: 'Book @ 0%' },
  ],
}

test.beforeEach(() => {
  state.park = { ...QUARANTINED_PARK }
  state.parkQueryStatus = null
  state.landedRefund = null
  state.order = { ...ORDER }
  state.createRefundCalls = []
  state.createRefundResult = { success: true }
  state.parkUpdates = []
  state.activity = []
  state.syncRefundsCalls = 0
})

test('recording a quarantined refund raises a LINE-LINKED credit note carrying the WooCommerce refund id (o3d-w00 Codex r1 #3)', async () => {
  const result = await recordRefundParkManually(
    'park-1',
    [{ lineId: 'line-1', netAmountForeign: 8 }, { lineId: 'line-2', netAmountForeign: 3.5 }],
    'WC refund 7101 — 1 widget at 20%, 1 book zero-rated',
  )

  assert.equal(result.success, true)
  assert.equal(state.createRefundCalls.length, 1)
  const call = state.createRefundCalls[0]
  // The LINK is the whole point: an unlinked monetary line is what both quarantine refusals reject, and
  // a linked one carries its own line's VAT rate so no header rate has to be guessed.
  assert.deepEqual(
    (call.lines as Array<{ lineId?: string; qty: number; totalBase: number; lineKind?: string }>).map((line) => ({
      lineId: line.lineId, qty: line.qty, totalBase: line.totalBase, lineKind: line.lineKind,
    })),
    [
      { lineId: 'line-1', qty: 0, totalBase: 8, lineKind: 'sale' },
      { lineId: 'line-2', qty: 0, totalBase: 3.5, lineKind: 'sale' },
    ],
  )
  // Stamped with the Woo refund id, so a later redelivery dedups on it instead of raising a second
  // credit note — the globally unique externalRefundId is the replay key.
  assert.equal(call.options.externalRefundId, 7101)
  // No return warehouse: a hand-recorded monetary refund must not invent an inventory movement.
  assert.equal(call.returnWarehouseId, undefined)
})

test('recording a quarantined refund RESOLVES the park so it stops blocking deletion and the inbox (o3d-w00 Codex r1 #3)', async () => {
  await recordRefundParkManually('park-1', [{ lineId: 'line-1', netAmountForeign: 11.5 }], 'reconciled by hand')

  assert.equal(state.parkUpdates.length, 1)
  assert.equal(state.parkUpdates[0].data.status, 'SYNCED')
  assert.equal(state.parkUpdates[0].data.errorMessage, null)
  // Scoped to this refund AND this order — never to the external id alone, which is shared with any
  // park another order might hold.
  assert.equal(state.parkUpdates[0].where.externalId, '7101')
  assert.equal(state.parkUpdates[0].where.entityId, 'so-1')
  // The evidence an auditor needs: who, which refund, and exactly what was attributed where.
  const logged = state.activity[0] as { action?: string; metadata?: { externalRefundId?: number; allocations?: unknown[]; userId?: string } }
  assert.equal(logged?.action, 'wc_refund_park_recorded_manually')
  assert.equal(logged?.metadata?.externalRefundId, 7101)
  assert.equal(logged?.metadata?.userId, 'user-1')
  assert.deepEqual(logged?.metadata?.allocations, [{ lineId: 'line-1', totalForeign: 11.5, totalBase: 11.5 }])
})

test('only a QUARANTINED park can be hand-recorded — a retryable one is left to Retry (o3d-w00 Codex r1 #3)', async () => {
  state.park = { ...QUARANTINED_PARK, status: 'FAILED' }
  const result = await recordRefundParkManually('park-1', [{ lineId: 'line-1', netAmountForeign: 11.5 }], 'x')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /no longer quarantined/)
  // A PENDING/FAILED park is an ordinary retryable failure; hand-recording one would race the retry
  // into a duplicate credit note.
  assert.equal(state.parkQueryStatus, 'QUARANTINED')
  assert.equal(state.createRefundCalls.length, 0)
})

test('a refund that has since LANDED is never credited twice (o3d-w00 Codex r1 #3)', async () => {
  state.landedRefund = { orderId: 'so-1', creditNoteNumber: 'CN-1' }
  const sameOrder = await recordRefundParkManually('park-1', [{ lineId: 'line-1', netAmountForeign: 11.5 }], 'x')
  assert.equal(sameOrder.success, false)
  assert.match(sameOrder.error ?? '', /already been recorded \(credit note CN-1\)/)

  state.landedRefund = { orderId: 'so-OTHER', creditNoteNumber: 'CN-2' }
  const otherOrder = await recordRefundParkManually('park-1', [{ lineId: 'line-1', netAmountForeign: 11.5 }], 'x')
  assert.equal(otherOrder.success, false)
  assert.match(otherOrder.error ?? '', /already exists on a different order/)

  assert.equal(state.createRefundCalls.length, 0)
})

test('an unattributable or empty allocation is refused, and the park stays open (o3d-w00 Codex r1 #3)', async () => {
  // Deliberately NOT a dismiss button: resolving without a credit note would leave the ledger short by
  // the refunded amount, which is the silent mis-posting this whole fix is about.
  const empty = await recordRefundParkManually('park-1', [{ lineId: 'line-1', netAmountForeign: 0 }], 'x')
  assert.equal(empty.success, false)
  assert.match(empty.error ?? '', /at least one order line/)

  const noReason = await recordRefundParkManually('park-1', [{ lineId: 'line-1', netAmountForeign: 5 }], '   ')
  assert.equal(noReason.success, false)
  assert.match(noReason.error ?? '', /reason is required/)

  const foreign = await recordRefundParkManually('park-1', [{ lineId: 'line-999', netAmountForeign: 5 }], 'x')
  assert.equal(foreign.success, false)
  assert.match(foreign.error ?? '', /is not on this order/)

  assert.equal(state.createRefundCalls.length, 0)
  assert.equal(state.parkUpdates.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

test('a refund the ledger refuses leaves the park QUARANTINED and visible (o3d-w00 Codex r1 #3)', async () => {
  state.createRefundResult = { success: false, error: 'Refund total would exceed order total' }
  const result = await recordRefundParkManually('park-1', [{ lineId: 'line-1', netAmountForeign: 999 }], 'over-allocated')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /exceed order total/)
  // Nothing was resolved: the operator fixes the split and tries again on the same row.
  assert.equal(state.parkUpdates.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

let retry: ((id: string) => Promise<{ success: boolean; error?: string; synced?: boolean }>) | null = null
const retryRefundSyncPark = async (id: string) => {
  if (!retry) {
    const module_ = await import('@/app/actions/sync-exceptions')
    retry = module_.retryRefundSyncPark as unknown as typeof retry
  }
  return retry!(id)
}

test('a retry that never reaches the refund RESTORES the quarantine instead of stranding it as PENDING (o3d-w00 Codex r1 #3)', async () => {
  // Retry deliberately transitions QUARANTINED -> PENDING so the sweep dedup stops skipping the refund.
  // When the WooCommerce fetch fails, nothing re-parks the row: it kept the original refusal message but
  // was no longer QUARANTINED, so the Record-manually action — the only thing that CAN resolve it —
  // disappeared from the row. That turned a retry into a one-way trip to a dead end.
  await retryRefundSyncPark('park-1')

  assert.equal(state.syncRefundsCalls, 1, 'the re-fetch was attempted')
  assert.equal(state.park?.status, 'QUARANTINED', 'the quarantine is restored, so Record manually stays available')
  assert.equal(state.park?.errorMessage, QUARANTINE_MESSAGE, 'and it still says why it was refused')
})
