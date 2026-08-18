import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-w00 (Codex r1 #3): a QUARANTINED refund park used to be a dead end. The refund was refused
 * deliberately — an undeterminable gross→net basis, or an order that is not uniformly taxed — the money
 * had ALREADY left WooCommerce, and the only button on the row was Retry, which re-runs the same
 * refusal against the same order. The park kept counting in the exception inbox and kept blocking order
 * deletion / store rebinding forever, and an operator who reconciled it by hand had no way to say so.
 *
 * These pin the completion path: the operator supplies the one thing IMS cannot derive — which parts of
 * the order the money covered and how much of it each took — and that raises the credit note LINE-LINKED
 * (so each line carries its own VAT identity and the uniform-tax refusal does not apply), stamps the
 * WooCommerce refund id so a redelivery dedups instead of double-crediting, and resolves the park.
 *
 * Codex r2 #2: the allocation is now RECONCILED to the parked refund. Amounts are GROSS and must add up
 * to what the storefront returned — otherwise this path was itself a way to book a figure nobody checked
 * (£1 against a £100 refund cleared the exception forever and left the ledger £99 short).
 *
 * Codex r2 #3: SHIPPING is an allocation target. A refund that included postage previously could not be
 * expressed at all, so the operator's only options were to leave the park open or to push shipping money
 * onto a goods line — wrong account, wrong VAT.
 */

type ParkRow = { id: string; entityId: string | null; externalId: string | null; status: string; errorMessage: string | null; payload: unknown }

/**
 * A COHERENT non-uniformly-taxed order — the commonest quarantine cause. Goods £10 @ 20% + £20 @ 0% +
 * £5 shipping @ the order default 20%: net 35.00, VAT 3.00, gross 38.00. Gross per part: 12.00, 20.00
 * and 6.00. Every fixture below allocates against these, so the amounts add up to a real order.
 */
const ORDER = {
  id: 'so-1',
  currency: 'GBP',
  fxRateToBase: 1,
  taxRatePercent: 0.2,
  shippingForeign: 5,
  lines: [
    { id: 'line-1', productId: 'product-1', description: 'Widget @ 20%', totalForeign: 10, taxRate: { rate: 0.2, reverseCharge: false } },
    { id: 'line-2', productId: 'product-2', description: 'Book @ 0%', totalForeign: 20, taxRate: { rate: 0, reverseCharge: false } },
  ],
}
/** The parked WooCommerce refund: one 20% widget (12.00 gross) plus the postage (6.00 gross). */
const PARKED_GROSS = '18.00'

const state: {
  park: ParkRow | null
  parkQueryStatus: string | null
  landedRefund: { orderId: string; creditNoteNumber: string | null } | null
  order: typeof ORDER | null
  priorRefundLines: Array<{ salesOrderLineId: string | null; lineKind: string | null; totalForeign: number }>
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
  priorRefundLines: [],
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
      // What each part of the order has already been credited — the balance the new allocation is capped
      // against, so one line cannot absorb money that came off another. Scoped by orderId the way the
      // production query is, so a query that forgot to scope would return another order's refunds here
      // too rather than silently passing.
      salesOrderRefundLine: {
        async findMany(args: { where?: { refund?: { orderId?: string } } }) {
          if (args?.where?.refund?.orderId !== 'so-1') return []
          return state.priorRefundLines.map((line) => ({ ...line, refund: { orderId: 'so-1' } }))
        },
      },
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

type Allocation = { lineId: string | null; lineKind: 'sale' | 'shipping'; grossAmountForeign: number }
type Record_ = (parkId: string, allocations: Allocation[], reason: string) => Promise<{ success: boolean; error?: string }>
let action: Record_ | null = null
const recordRefundParkManually: Record_ = async (...args) => {
  if (!action) {
    const module_ = await import('@/app/actions/sync-exceptions')
    action = module_.recordRefundParkManually as unknown as Record_
  }
  return action(...args)
}

const line = (lineId: string, grossAmountForeign: number): Allocation => ({ lineId, lineKind: 'sale', grossAmountForeign })
const shipping = (grossAmountForeign: number): Allocation => ({ lineId: null, lineKind: 'shipping', grossAmountForeign })
/** The allocation that actually settles the parked refund: 12.00 of widget + 6.00 of postage. */
const SETTLING_ALLOCATION: Allocation[] = [line('line-1', 12), shipping(6)]

const QUARANTINE_MESSAGE = 'basis undeterminable — record it manually'
const QUARANTINED_PARK: ParkRow = {
  id: 'park-1',
  entityId: 'so-1',
  externalId: '7101',
  status: 'QUARANTINED',
  errorMessage: QUARANTINE_MESSAGE,
  payload: { id: 7101, amount: PARKED_GROSS, reason: 'Damaged item' },
}

test('the order fixture is a coherent order (o3d-w00)', () => {
  // Lines plus shipping add up to the net, and the VAT is what those parts imply at their own rates —
  // so an allocation that "settles" the parked refund settles a refund that could really have happened.
  const linesNet = ORDER.lines.reduce((sum, orderLine) => sum + orderLine.totalForeign, 0)
  const vat = ORDER.lines.reduce((sum, orderLine) => sum + orderLine.totalForeign * orderLine.taxRate.rate, 0)
    + ORDER.shippingForeign * ORDER.taxRatePercent
  assert.equal(linesNet + ORDER.shippingForeign, 35, 'net 35.00')
  assert.equal(vat, 3, 'VAT 3.00 — 20% on the widget and on the postage, nothing on the book')
  // The parked refund is one 20% widget (12.00 gross) plus the postage (6.00 gross).
  assert.equal(Number(PARKED_GROSS), ORDER.lines[0].totalForeign * 1.2 + ORDER.shippingForeign * 1.2)
})

test.beforeEach(() => {
  state.park = { ...QUARANTINED_PARK }
  state.parkQueryStatus = null
  state.landedRefund = null
  state.order = { ...ORDER }
  state.priorRefundLines = []
  state.createRefundCalls = []
  state.createRefundResult = { success: true }
  state.parkUpdates = []
  state.activity = []
  state.syncRefundsCalls = 0
})

test('recording a quarantined refund raises a LINE-LINKED credit note carrying the WooCommerce refund id (o3d-w00 Codex r1 #3)', async () => {
  const result = await recordRefundParkManually(
    'park-1',
    SETTLING_ALLOCATION,
    'WC refund 7101 — 1 widget at 20%, plus the postage',
  )

  assert.equal(result.success, true)
  assert.equal(state.createRefundCalls.length, 1)
  const call = state.createRefundCalls[0]
  // The LINK is the whole point: an unlinked monetary line is what both quarantine refusals reject, and
  // a linked one carries its own line's VAT rate so no header rate has to be guessed. The GROSS the
  // operator entered is converted at that same rate, so 12.00 gross at 20% stores 10.00 net.
  assert.deepEqual(
    (call.lines as Array<{ lineId?: string | null; qty: number; totalBase: number; lineKind?: string }>).map((refundLine) => ({
      lineId: refundLine.lineId, qty: refundLine.qty, totalBase: refundLine.totalBase, lineKind: refundLine.lineKind,
    })),
    [
      { lineId: 'line-1', qty: 0, totalBase: 10, lineKind: 'sale' },
      { lineId: null, qty: 0, totalBase: 5, lineKind: 'shipping' },
    ],
  )
  // Stamped with the Woo refund id, so a later redelivery dedups on it instead of raising a second
  // credit note — the globally unique externalRefundId is the replay key.
  assert.equal(call.options.externalRefundId, 7101)
  // No return warehouse: a hand-recorded monetary refund must not invent an inventory movement.
  assert.equal(call.returnWarehouseId, undefined)
})

test('a refund that included SHIPPING can be expressed, and posts as a shipping line (o3d-w00 Codex r2 #3)', async () => {
  // The defect: the dialog offered order lines only and the action hard-coded lineKind 'sale', so a
  // refund covering postage could not be described at all — leave the park open, or misattribute the
  // money to a goods line at that line's account and VAT. Shipping is now its own target, posted as the
  // unlinked shipping line a chargeback uses, grossed at the ORDER-DEFAULT identity the invoice charged
  // it under (20% here, even though line-2 is zero-rated).
  const result = await recordRefundParkManually('park-1', [shipping(6), line('line-1', 12)], 'postage refunded too')

  assert.equal(result.success, true)
  const lines = state.createRefundCalls[0].lines as Array<{ lineId?: string | null; productId: string | null; lineKind?: string; totalForeign?: number; totalBase: number }>
  const shippingLine = lines.find((refundLine) => refundLine.lineKind === 'shipping')
  assert.ok(shippingLine, 'the shipping allocation reaches the ledger as a shipping line')
  assert.equal(shippingLine?.lineId, null, 'shipping is not on an order line, so it is unlinked')
  assert.equal(shippingLine?.productId, null)
  assert.equal(shippingLine?.totalBase, 5, '6.00 gross at the order default 20% is 5.00 net')
  // And it is recorded as shipping in the audit trail, not buried inside a goods allocation.
  const logged = state.activity[0] as { metadata?: { allocations?: Array<{ lineKind?: string; grossForeign?: number }> } }
  assert.deepEqual(
    logged?.metadata?.allocations?.map((allocation) => ({ lineKind: allocation.lineKind, grossForeign: allocation.grossForeign })),
    [{ lineKind: 'shipping', grossForeign: 6 }, { lineKind: 'sale', grossForeign: 12 }],
  )
})

test('a shipping allocation on an order with no shipping charge is refused (o3d-w00 Codex r2 #3)', async () => {
  state.order = { ...ORDER, shippingForeign: 0 }
  const result = await recordRefundParkManually('park-1', [shipping(18)], 'x')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /carries no shipping charge/)
  assert.equal(state.createRefundCalls.length, 0)
})

test('an allocation that does not settle the parked refund is REFUSED, in both directions (o3d-w00 Codex r2 #2)', async () => {
  // The defect: the action read neither the parked payload nor its amount, so any positive allocation
  // whose lines belonged to the order cleared the park permanently. £1 against an £18 storefront refund
  // marked the exception SYNCED and left the ledger £17 short, with nothing to notice it.
  const under = await recordRefundParkManually('park-1', [line('line-1', 1)], 'under-allocated')
  assert.equal(under.success, false)
  assert.match(under.error ?? '', /comes to 1\.00 gross but WooCommerce refunded 18\.00/)

  const over = await recordRefundParkManually('park-1', [line('line-1', 12), line('line-2', 20), shipping(6)], 'over-allocated')
  assert.equal(over.success, false)
  assert.match(over.error ?? '', /comes to 38\.00 gross but WooCommerce refunded 18\.00/)

  assert.equal(state.createRefundCalls.length, 0, 'no credit note is raised for an amount nobody checked')
  assert.equal(state.parkUpdates.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

test('the reconciliation is on the GROSS the credit note will come to, not the net stored (o3d-w00 Codex r2 #2)', async () => {
  // 15.00 of net across these targets (10.00 + 5.00) IS the settling split — but entered as if the
  // amounts were net it comes to 15.00 gross, £3 short of the refund. The check is what makes the two
  // bases impossible to confuse.
  const asIfNet = await recordRefundParkManually('park-1', [line('line-1', 10), shipping(5)], 'entered net by mistake')
  assert.equal(asIfNet.success, false)
  assert.match(asIfNet.error ?? '', /comes to 15\.00 gross but WooCommerce refunded 18\.00/)
  assert.match(asIfNet.error ?? '', /GROSS/)
})

test('a park with no stored WooCommerce refund cannot be recorded, and names the way to open it (o3d-w00 Codex r2 #2)', async () => {
  // Nothing to reconcile against — so recording is closed. Not a dead end though: Retry re-reads the
  // refund from WooCommerce and re-parks it WITH the payload (restoring the quarantine if that fetch
  // fails), after which this path works.
  state.park = { ...QUARANTINED_PARK, payload: null }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /does not carry the WooCommerce refund/)
  assert.match(result.error ?? '', /Retry/)
  assert.equal(state.createRefundCalls.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

test('one part of the order cannot absorb money that came off another (o3d-w00 Codex r2 #2)', async () => {
  // The order total cap in createSalesOrderRefund would let 18.00 gross land entirely on line-1 — the
  // total reconciles, but the credit posts to the wrong account at the wrong VAT. Each target is capped
  // at what it has left.
  const overLine = await recordRefundParkManually('park-1', [line('line-1', 18)], 'all on one line')
  assert.equal(overLine.success, false)
  assert.match(overLine.error ?? '', /Widget @ 20%/)
  assert.match(overLine.error ?? '', /more than it has left to refund/)

  // And earlier refunds count: 6.00 of line-1's 10.00 net is already credited, so the settling 12.00
  // gross (10.00 net) no longer fits.
  state.priorRefundLines = [{ salesOrderLineId: 'line-1', lineKind: 'sale', totalForeign: 6 }]
  const afterPrior = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')
  assert.equal(afterPrior.success, false)
  assert.match(afterPrior.error ?? '', /after earlier refunds/)

  assert.equal(state.createRefundCalls.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

test('the same target may not be allocated twice (o3d-w00 Codex r2 #2)', async () => {
  // Two rows for one target each pass their own balance check and together exceed it, and the audit
  // record stops saying where the money went.
  const duplicated = await recordRefundParkManually(
    'park-1',
    [line('line-1', 6), line('line-1', 6), shipping(6)],
    'split across two rows',
  )
  assert.equal(duplicated.success, false)
  assert.match(duplicated.error ?? '', /only once/)
  assert.equal(state.createRefundCalls.length, 0)
})

test('recording a quarantined refund RESOLVES the park so it stops blocking deletion and the inbox (o3d-w00 Codex r1 #3)', async () => {
  await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'reconciled by hand')

  assert.equal(state.parkUpdates.length, 1)
  assert.equal(state.parkUpdates[0].data.status, 'SYNCED')
  assert.equal(state.parkUpdates[0].data.errorMessage, null)
  // Scoped to this refund AND this order — never to the external id alone, which is shared with any
  // park another order might hold.
  assert.equal(state.parkUpdates[0].where.externalId, '7101')
  assert.equal(state.parkUpdates[0].where.entityId, 'so-1')
  // The evidence an auditor needs: who, which refund, what it was checked against, and exactly what was
  // attributed where — gross as entered and net as stored.
  const logged = state.activity[0] as { action?: string; metadata?: { externalRefundId?: number; allocations?: unknown[]; userId?: string; parkedGrossForeign?: string } }
  assert.equal(logged?.action, 'wc_refund_park_recorded_manually')
  assert.equal(logged?.metadata?.externalRefundId, 7101)
  assert.equal(logged?.metadata?.userId, 'user-1')
  assert.equal(logged?.metadata?.parkedGrossForeign, '18.00')
  assert.deepEqual(logged?.metadata?.allocations, [
    { lineId: 'line-1', lineKind: 'sale', grossForeign: 12, totalForeign: 10, totalBase: 10 },
    { lineId: null, lineKind: 'shipping', grossForeign: 6, totalForeign: 5, totalBase: 5 },
  ])
})

test('only a QUARANTINED park can be hand-recorded — a retryable one is left to Retry (o3d-w00 Codex r1 #3)', async () => {
  state.park = { ...QUARANTINED_PARK, status: 'FAILED' }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /no longer quarantined/)
  // A PENDING/FAILED park is an ordinary retryable failure; hand-recording one would race the retry
  // into a duplicate credit note.
  assert.equal(state.parkQueryStatus, 'QUARANTINED')
  assert.equal(state.createRefundCalls.length, 0)
})

test('a refund that has since LANDED is never credited twice (o3d-w00 Codex r1 #3)', async () => {
  state.landedRefund = { orderId: 'so-1', creditNoteNumber: 'CN-1' }
  const sameOrder = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')
  assert.equal(sameOrder.success, false)
  assert.match(sameOrder.error ?? '', /already been recorded \(credit note CN-1\)/)

  state.landedRefund = { orderId: 'so-OTHER', creditNoteNumber: 'CN-2' }
  const otherOrder = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'x')
  assert.equal(otherOrder.success, false)
  assert.match(otherOrder.error ?? '', /already exists on a different order/)

  assert.equal(state.createRefundCalls.length, 0)
})

test('an unattributable or empty allocation is refused, and the park stays open (o3d-w00 Codex r1 #3)', async () => {
  // Deliberately NOT a dismiss button: resolving without a credit note would leave the ledger short by
  // the refunded amount, which is the silent mis-posting this whole fix is about.
  const empty = await recordRefundParkManually('park-1', [line('line-1', 0)], 'x')
  assert.equal(empty.success, false)
  assert.match(empty.error ?? '', /at least one order line or the shipping charge/)

  const noReason = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, '   ')
  assert.equal(noReason.success, false)
  assert.match(noReason.error ?? '', /reason is required/)

  const foreign = await recordRefundParkManually('park-1', [line('line-999', 18)], 'x')
  assert.equal(foreign.success, false)
  assert.match(foreign.error ?? '', /is not on this order/)

  assert.equal(state.createRefundCalls.length, 0)
  assert.equal(state.parkUpdates.length, 0)
  assert.equal(state.park?.status, 'QUARANTINED')
})

test('a refund the ledger refuses leaves the park QUARANTINED and visible (o3d-w00 Codex r1 #3)', async () => {
  state.createRefundResult = { success: false, error: 'Refund total would exceed order total' }
  const result = await recordRefundParkManually('park-1', SETTLING_ALLOCATION, 'ledger says no')

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
