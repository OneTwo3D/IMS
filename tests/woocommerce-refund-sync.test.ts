import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { refundIsInIms, refundMayStillReachIms, refundOutcomeFailed, resolveMonetaryRefundVatRate, syncWcRefund, type WcRefundSyncDependencies } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'
import { refundWouldExceedOrderTotal } from '@/lib/domain/sales/o2c-guards'
import { isFullRefundAmount } from '@/lib/domain/sales/refund-thresholds'
import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'

function makeRefund(overrides: Partial<WcRefund> = {}): WcRefund {
  return {
    id: 7001,
    parent_id: 1001,
    date_created: '2026-06-05T10:00:00',
    date_created_gmt: '2026-06-05T10:00:00',
    amount: '12.50',
    reason: 'Damaged item',
    refunded_by: 1,
    refunded_payment: true,
    meta_data: [],
    line_items: [
      {
        id: 501,
        name: 'Widget',
        product_id: 10,
        variation_id: 0,
        quantity: -1,
        tax_class: '',
        subtotal: '-12.50',
        subtotal_tax: '0',
        total: '-12.50',
        total_tax: '0',
        sku: 'WIDGET',
        meta_data: [],
        refund_total: 12.5,
      },
    ],
    ...overrides,
  }
}

function externalRefundIdUniqueError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['externalRefundId'] },
  })
}

/**
 * o3d-w00: the order double MUST be schema-faithful about units, because units are the bug.
 * SalesOrder.taxRatePercent is Decimal(5,4) holding a FRACTION (0.2000 = 20%), and totalBase/taxBase are
 * GROSS/VAT in base currency. The previous double returned `taxRatePercent: 20` — a percentage — which
 * exactly cancelled production's stray `/100` and made the "stored NET, not gross" assertion pass over
 * code that was still storing gross. The default order below is internally COHERENT: net 12.50 + VAT
 * 2.50 @ 0.20 = gross 15.00, matching the 12.50 net order line.
 */
type OrderLineDouble = {
  id: string
  productId: string | null
  externalLineItemId: number | null
  description: string
  qty: number
  totalBase: number
  // o3d-w00 (Codex r1 #1/#2): the per-line tax fields production now reads. A double that OMITS them
  // makes both the zero-rated test ("every line agrees there is no VAT") and the tolerance sizing
  // ("one penny-rounded VAT figure per component") pass vacuously, so they are part of the shape.
  taxBase: number
  taxRate: { rate: number; reverseCharge: boolean } | null
}
type OrderDouble = {
  // o3d-w00 (Codex r6 #1/#2): the order's CURRENCY (which says how coarsely its money figures could
  // have been quantised, and so how much rounding a rate derived from them inherits) and its
  // taxRateName (which RESOLVES the order-default VAT identity an unlinked shipping refund line posts
  // under). A double without them cannot exercise the itemised shipping route at all.
  currency: string
  taxRateName: string | null
  totalBase: number
  taxBase: number
  taxRatePercent: number | null
  shippingBase: number
  taxForeign?: number
  shippingForeign?: number
  lines: OrderLineDouble[]
}
const DEFAULT_ORDER_LINE: OrderLineDouble = {
  id: 'line-1',
  productId: 'product-1',
  externalLineItemId: 501,
  description: 'Widget',
  qty: 1,
  totalBase: 12.5,
  taxBase: 2.5,
  taxRate: { rate: 0.2, reverseCharge: false },
}
const DEFAULT_ORDER_DOUBLE: OrderDouble = {
  currency: 'GBP',
  taxRateName: 'UK Standard Rate',
  totalBase: 15,
  taxBase: 2.5,
  taxRatePercent: 0.2,
  shippingBase: 0,
  lines: [DEFAULT_ORDER_LINE],
}

/**
 * An order double built the way a real imported order is: `grossTotal` is the 2-decimal amount the
 * customer actually paid (WooCommerce's order total), and `taxBase` is the sum of the per-line VAT
 * figures WooCommerce rounded to the penny. The order's NET total is the difference, so the gap the
 * guard reconciles — delta = net x rate - taxBase — is produced the way it is in production, by taxBase
 * drifting off net x rate, NOT by inventing sub-penny grosses that no store ever charges.
 *
 * At 20% a 0.0001 step in taxBase moves delta by 0.00012, which is what makes the tolerance edges below
 * land on exact decimal values rather than approximately.
 *
 * COHERENCE (Codex r2): the lines plus the shipping charge add up to the order's net total, and their
 * VAT figures add up to the order's VAT — because that is the only shape order-import can produce
 * (computeWcOrderForeignTotals sums the line tax and the shipping tax into taxBase) and because the
 * guard now checks each component against its own net. The order's drift from "every component taxed at
 * `rate`" is spread evenly across the components that were penny-rounded, which is where it comes from
 * in a real order; the LAST line absorbs both division remainders so the sums are exact.
 */
function round4(value: number): number {
  return Number(value.toFixed(4))
}

function makeOrder(input: {
  grossTotal: number
  taxBase: number
  rate: number
  lineCount?: number
  shippingBase?: number
  reverseCharge?: boolean
  /** VAT recorded on the shipping leg. Defaults to the shipping charge at `rate`, drift included. */
  shippingTaxBase?: number
  /** Every line's OWN rate, when it differs from the order header's (a mixed-rate order). */
  lineRate?: number
}): OrderDouble {
  const lineCount = input.lineCount ?? 1
  const shippingBase = input.shippingBase ?? 0
  const netTotal = round4(input.grossTotal - input.taxBase)
  const linesNetTotal = round4(netTotal - shippingBase)
  const components = lineCount + (shippingBase > 0 ? 1 : 0)
  const driftPerComponent = (input.taxBase - netTotal * input.rate) / components
  const shippingTaxBase = input.shippingTaxBase
    ?? (shippingBase > 0 ? round4(shippingBase * input.rate + driftPerComponent) : 0)
  const linesTaxTotal = round4(input.taxBase - shippingTaxBase)
  const netPerLine = round4(linesNetTotal / lineCount)
  const taxPerLine = round4(netPerLine * input.rate + driftPerComponent)
  return {
    currency: 'GBP',
    taxRateName: input.rate > 0 ? 'UK Standard Rate' : null,
    totalBase: input.grossTotal,
    taxBase: input.taxBase,
    taxRatePercent: input.rate > 0 ? input.rate : null,
    shippingBase,
    lines: Array.from({ length: lineCount }, (_unused, index) => {
      const isLast = index === lineCount - 1
      return {
        id: `line-${index + 1}`,
        productId: `product-${index + 1}`,
        externalLineItemId: 501 + index,
        description: `Widget ${index + 1}`,
        qty: 1,
        totalBase: isLast ? round4(linesNetTotal - netPerLine * (lineCount - 1)) : netPerLine,
        taxBase: isLast ? round4(linesTaxTotal - taxPerLine * (lineCount - 1)) : taxPerLine,
        taxRate: { rate: input.lineRate ?? input.rate, reverseCharge: input.reverseCharge ?? false },
      }
    }),
  }
}

function makeDependencies(options: {
  alwaysMissExistingRefund?: boolean
  refuseWithQuarantine?: boolean
  order?: Partial<OrderDouble>
} = {}) {
  const refunds: Array<{ id: string; externalRefundId: number; orderId: string }> = []
  const syncLogs: unknown[] = []
  const activityLogs: unknown[] = []
  // o3d-w00 (Codex r7 #1): chargedTaxForeign is the VAT WooCommerce STATED on each refunded line, and
  // it is the only thing this sync now contributes to the posted-VAT fence — a capture that dropped it
  // could not tell a line that states it from one that does not.
  const createRefundLines: Array<{ lineId?: string; productId: string | null; qty?: number; totalForeign?: number | null; totalBase?: number; lineKind?: string; chargedTaxForeign?: number | null }> = []
  let createRefundCalls = 0
  let nextLogId = 1
  // o3d-w00 (Codex r3 #3): what the production query actually asks for. The foreign-currency shipping
  // derivation is dead code unless those columns are selected, and no assertion on the returned double
  // can tell the difference.
  let orderSelect: Record<string, unknown> | null = null
  let orderDeleted = false // o3d-7yf finding 2: simulate the order being deleted before the park is written

  const shoppingSyncLogMock = {
    async findFirst(args: { where?: { externalId?: string; entityType?: string; status?: string | { in?: string[] } } }) {
      const where = args?.where ?? {}
      const statuses = typeof where.status === 'object' ? where.status.in : (where.status != null ? [where.status] : null)
      for (let i = syncLogs.length - 1; i >= 0; i--) {
        const d = (syncLogs[i] as { data?: { externalId?: string; entityType?: string; status?: string; entityId?: string } }).data
        if (
          (where.externalId == null || d?.externalId === where.externalId) &&
          (where.entityType == null || d?.entityType === where.entityType) &&
          (statuses == null || (d?.status != null && statuses.includes(d.status)))
        ) {
          // Project selected columns to the top level (real Prisma does this), keeping .data for assertions.
          return { id: (syncLogs[i] as { id?: string }).id, entityId: d?.entityId, status: d?.status, data: d }
        }
      }
      return null
    },
    async create(args: { data: Record<string, unknown> }) {
      const d = args.data as { externalId?: string; entityType?: string; direction?: string; status?: string }
      const actionable = ['PENDING', 'FAILED', 'QUARANTINED']
      if (d.entityType === 'SalesOrder' && d.direction === 'FROM_CONNECTOR' && actionable.includes(d.status ?? '')) {
        const dup = syncLogs.some((r) => {
          const rd = (r as { data?: typeof d }).data
          return rd?.entityType === 'SalesOrder' && rd?.direction === 'FROM_CONNECTOR' && rd?.externalId === d.externalId && actionable.includes(rd?.status ?? '')
        })
        if (dup) throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target: ['shopping_sync_logs_active_refund_park_uq'] } })
      }
      const row = { id: `log-${nextLogId++}`, data: args.data }
      syncLogs.push(row)
      return row
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const row = syncLogs.find((r) => (r as { id?: string }).id === args.where.id) as { data: Record<string, unknown> } | undefined
      if (row) row.data = { ...row.data, ...args.data }
      return row
    },
    async updateMany(args: { where?: { externalId?: string; entityId?: string; status?: string | { in?: string[] } }; data: Record<string, unknown> }) {
      const where = args?.where ?? {}
      const statuses = typeof where.status === 'object' ? where.status?.in : (where.status != null ? [where.status] : null)
      let count = 0
      for (const r of syncLogs) {
        const d = (r as { data: { externalId?: string; entityId?: string; status?: string } }).data
        if (
          (where.externalId == null || d?.externalId === where.externalId) &&
          (where.entityId == null || d?.entityId === where.entityId) &&
          (statuses == null || (d?.status != null && statuses.includes(d.status)))
        ) {
          (r as { data: Record<string, unknown> }).data = { ...d, ...args.data }
          count += 1
        }
      }
      return { count }
    },
  }

  const dependencies: WcRefundSyncDependencies = {
    db: {
      // o3d-7yf finding 2: upsertRefundPark runs under a transaction that FOR-UPDATE locks + verifies the
      // order. The order row lock returns [] once the order is "deleted", so the park write is skipped.
      async $transaction(cb: (tx: unknown) => unknown) {
        const tx = {
          // o3d-ee9: the per-refund advisory lock (pg_advisory_xact_lock) is a no-op in the mock.
          async $executeRaw() { return 0 },
          async $queryRaw() { return orderDeleted ? [] : [{ id: 'so-1' }] },
          // o3d-ee9: the landed-refund re-read under the lock. Returns a row only when the test seeds one.
          salesOrderRefund: {
            async findFirst(args: { where?: { externalRefundId?: number } }) {
              return refunds.find((r) => r.externalRefundId === args.where?.externalRefundId) ?? null
            },
          },
          shoppingSyncLog: shoppingSyncLogMock,
        }
        return cb(tx)
      },
      salesOrder: {
        async findFirst(args: { select?: Record<string, unknown> }) {
          orderSelect = args?.select ?? null
          return {
            id: 'so-1',
            externalOrderNumber: 'WC-1001',
            fxRateToBase: 1,
            ...DEFAULT_ORDER_DOUBLE,
            ...options.order,
          }
        },
      },
      salesOrderRefund: {
        async findFirst(args: { where?: { externalRefundId?: number } }) {
          if (options.alwaysMissExistingRefund) return null
          return refunds.find((refund) => refund.externalRefundId === args.where?.externalRefundId) ?? null
        },
      },
      warehouse: {
        async findFirst() {
          return { id: 'return-wh' }
        },
      },
      // o3d-w00 (Codex r7 #5): NO taxRate double. The sync no longer reads the tax table at all — the
      // identity an itemised refund line posts under is resolved and priced by the writer, from its own
      // read inside the refund transaction. A double that still offered one would let a regression
      // reintroduce the stale second read here without a single test noticing.
      shoppingSyncLog: shoppingSyncLogMock,
    } as unknown as WcRefundSyncDependencies['db'],
    async createRefund(_orderId, lines, _reason, _returnWarehouseId, createOptions) {
      createRefundCalls += 1
      // Capture the lines. Without this nothing could assert that a refund line was
      // actually LINKED to its IMS order line, which is how the _refunded_item_id bug
      // survived: createRefund was only ever checked for being called.
      createRefundLines.push(...(lines as unknown as typeof createRefundLines))
      if (options.refuseWithQuarantine) {
        // o3d-w00 #2/#5: a monetary-only refund on a non-uniform order is refused for quarantine.
        return { success: false, error: 'not uniformly taxed; parked for manual resolution', quarantine: true }
      }
      refunds.push({ id: `refund-${refunds.length + 1}`, externalRefundId: createOptions?.externalRefundId ?? 0, orderId: 'so-1' })
      return { success: true }
    },
    async logActivity(input) {
      activityLogs.push(input)
    },
  }

  return {
    dependencies,
    refunds,
    syncLogs,
    activityLogs,
    createRefundLines,
    get orderSelect() {
      return orderSelect
    },
    get createRefundCalls() {
      return createRefundCalls
    },
    // Make the order-lock re-verify find the order GONE, so upsertRefundPark skips an orphaned park.
    simulateOrderDeleted() { orderDeleted = true },
  }
}

test('syncWcRefund treats repeated WooCommerce refund delivery as already processed', async () => {
  const state = makeDependencies()
  const first = await syncWcRefund(1001, makeRefund(), state.dependencies)
  const second = await syncWcRefund(1001, makeRefund(), state.dependencies)

  // o3d-xnwu r4: the two deliveries are NOT the same ending, and the type now says which is which —
  // the first APPLIES the refund, the second finds it already there.
  assert.deepEqual(first, { outcome: 'applied' })
  assert.deepEqual(second, { outcome: 'already-applied' })
  assert.equal(state.refunds.length, 1)
  assert.equal(state.syncLogs.length, 1)
  assert.equal(state.activityLogs.length, 1)
  assert.equal(state.createRefundCalls, 1)
})

test('syncWcRefund reconciles a VAT line refund on the gross basis (amount includes tax)', async () => {
  // WooCommerce reports line `total` ex-tax with `total_tax` separate, while the
  // refund `amount` is gross. A tax-exclusive order line of 19.66 + 3.93 VAT must
  // not be rejected as an "amount mismatch" against the gross 23.59 amount.
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  const refund = makeRefund({
    id: 7002,
    amount: '23.59',
    line_items: [
      {
        id: 501,
        name: 'Widget',
        product_id: 10,
        variation_id: 0,
        quantity: -1,
        tax_class: '',
        subtotal: '-19.66',
        subtotal_tax: '-3.93',
        total: '-19.66',
        total_tax: '-3.93',
        sku: 'WIDGET',
        meta_data: [],
        refund_total: 23.59,
      },
    ],
  })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.deepEqual(result, { outcome: 'applied' })
  assert.equal(state.createRefundCalls, 1)
  // No PENDING amount-mismatch log should have been written
  assert.equal(
    state.syncLogs.some((log) => /amount mismatch/.test(String((log as { data?: { errorMessage?: string } }).data?.errorMessage ?? ''))),
    false,
  )
})

test('a monetary-only WooCommerce refund is stored NET, not gross (o3d-w00)', async () => {
  // The money returned to the customer is GROSS (£12 incl. 20% VAT). Every refund line is stored NET now,
  // so the credit note grosses it back up via the snapshotted tax type. If it were stored gross, the
  // credit note would re-gross it (£12 -> £14.40). A monetary-only refund has no line_items/shipping.
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  const refund = makeRefund({ amount: '12.00', line_items: [], shipping_lines: [] })

  await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(state.createRefundCalls, 1)
  assert.equal(state.createRefundLines.length, 1)
  // 12.00 gross / 1.20 = 10.00 net.
  assert.equal(state.createRefundLines[0].totalForeign, 10)
})

// ---------------------------------------------------------------------------
// o3d-w00: monetary-only gross -> net conversion basis.
//
// SalesOrder.taxRatePercent is a FRACTION (Decimal(5,4), 0.2000 = 20%). Production divided it by a
// further 100, so the "net" it stored was gross/1.002 — still gross — while the writer stamped the row
// totalsBasis='NET'. Because the cumulative ceiling and the FULL/PARTIAL classification both compare
// against the order's NET total, that gross figure can never sum to the net total: a full refund is
// refused by the ceiling and the order stays PARTIALLY_REFUNDED forever.
// ---------------------------------------------------------------------------

// A £120 gross order: net 100 + VAT 20 @ 0.20.
const TAXABLE_ORDER: Partial<OrderDouble> = makeOrder({ grossTotal: 120, taxBase: 20, rate: 0.2 })
const TAXABLE_ORDER_NET_TOTAL = 100

test('a monetary-only refund converts gross to net at the FRACTIONAL tax rate, not rate/100 (o3d-w00)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true, order: TAXABLE_ORDER })
  const refund = makeRefund({ amount: '120.00', line_items: [], shipping_lines: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundIsInIms(result.outcome), true)
  assert.equal(state.createRefundLines.length, 1)
  // 120.00 gross / 1.20 = 100.00 net. Reading taxRatePercent as a percentage gave 120/1.002 = 119.7605.
  assert.equal(state.createRefundLines[0].totalBase, 100, 'the stored NET total is the order net, not the gross')
  assert.equal(state.createRefundLines[0].totalForeign, 100)
})

test('a FULL monetary-only refund of a taxable order reaches REFUNDED (o3d-w00)', async () => {
  // The bug this issue names, end to end over the real comparison helpers: the whole gross amount comes
  // back from WooCommerce, the net figure refund-sync hands to createRefund must clear the NET ceiling
  // and satisfy the FULL classification. With a gross figure it did neither.
  const state = makeDependencies({ alwaysMissExistingRefund: true, order: TAXABLE_ORDER })
  const refund = makeRefund({ amount: '120.00', line_items: [], shipping_lines: [] })

  await syncWcRefund(1001, refund, state.dependencies)
  const storedNet = state.createRefundLines[0].totalBase ?? 0

  assert.equal(
    refundWouldExceedOrderTotal(storedNet, 0, TAXABLE_ORDER_NET_TOTAL),
    false,
    'a full refund must not trip the cumulative NET ceiling (a gross figure does, so the refund is refused outright)',
  )
  assert.equal(
    isFullRefundAmount(storedNet, TAXABLE_ORDER_NET_TOTAL),
    true,
    'a full refund of a taxable order classifies FULL/REFUNDED, not PARTIALLY_REFUNDED',
  )
})

test('a genuinely PARTIAL monetary-only refund still does not reach REFUNDED, and leaves room for the rest (o3d-w00)', async () => {
  // The other direction: half the gross back is half the net, which stays PARTIAL — and critically the
  // remaining half must still fit under the ceiling, so the customer's second refund can complete the
  // order. Reading the rate as a percentage stored 59.88 twice: the second refund exceeded the 100 net
  // ceiling and was refused, which is exactly how an order gets stuck at PARTIALLY_REFUNDED.
  const state = makeDependencies({ alwaysMissExistingRefund: true, order: TAXABLE_ORDER })
  const refund = makeRefund({ amount: '60.00', line_items: [], shipping_lines: [] })

  await syncWcRefund(1001, refund, state.dependencies)
  const storedNet = state.createRefundLines[0].totalBase ?? 0

  assert.equal(storedNet, 50, '60.00 gross / 1.20 = 50.00 net')
  assert.equal(
    isFullRefundAmount(storedNet, TAXABLE_ORDER_NET_TOTAL),
    false,
    'a half refund must NOT be classified FULL',
  )
  assert.equal(
    refundWouldExceedOrderTotal(storedNet, storedNet, TAXABLE_ORDER_NET_TOTAL),
    false,
    'the second half must still fit under the ceiling so the refund can complete',
  )
  assert.equal(
    isFullRefundAmount(storedNet + storedNet, TAXABLE_ORDER_NET_TOTAL),
    true,
    'the two halves together reach FULL',
  )
})

test('a monetary-only refund whose gross->net basis CANNOT be determined is refused and QUARANTINED, never concluded fully refunded (o3d-w00)', async () => {
  // The order carries VAT but has no recorded tax rate, so the gross amount cannot be converted to net.
  // Storing it anyway would stamp a gross figure totalsBasis='NET'. Fail closed instead.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: { ...makeOrder({ grossTotal: 120, taxBase: 20, rate: 0.2 }), taxRatePercent: null },
  })
  const refund = makeRefund({ id: 7101, amount: '120.00', line_items: [], shipping_lines: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true, 'refused rather than recorded on an undetermined basis')
  assert.match(result.error ?? '', /cannot be converted from gross to net/)
  assert.equal(state.createRefundCalls, 0, 'no refund is created')
  const park = state.syncLogs.at(-1) as { data?: { status?: string; externalId?: string } }
  assert.equal(park?.data?.status, 'QUARANTINED', 'parked as a deliberate refusal, not a retryable failure')
  assert.equal(park?.data?.externalId, '7101')
})

test('a monetary-only refund is refused when the order total cannot be reproduced at its own tax rate (o3d-w00)', async () => {
  // Everything the order SAYS agrees — one 20% line, a 20% header, no shipping — but the order total is
  // £10 below its lines plus their VAT, i.e. money WooCommerce took off outside the lines and outside
  // shipping (an unmodelled order-level coupon). Gross is then no longer net x 1.20, so dividing the
  // refund by 1.20 would not return the net the customer was actually charged. This is the aggregate
  // reconciliation doing the job the per-component checks cannot: they only see components.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: { ...makeOrder({ grossTotal: 120, taxBase: 20, rate: 0.2 }), totalBase: 110 },
  })
  const refund = makeRefund({ id: 7102, amount: '110.00', line_items: [], shipping_lines: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true)
  assert.match(result.error ?? '', /does not reconcile with its VAT/)
  assert.equal(state.createRefundCalls, 0)
})

test('a monetary-only refund on a NON-taxable order still stores the gross amount unchanged (o3d-w00)', async () => {
  // The fail-closed guard must not block the case where no conversion is owed: with no VAT, net IS gross,
  // and the ceiling/status comparison degenerates to the same basis.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: makeOrder({ grossTotal: 100, taxBase: 0, rate: 0 }),
  })
  const refund = makeRefund({ id: 7103, amount: '100.00', line_items: [], shipping_lines: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundIsInIms(result.outcome), true, 'an untaxed order needs no rate and must not be quarantined')
  assert.equal(state.createRefundLines[0].totalBase, 100)
})

test('resolveMonetaryRefundVatRate reads taxRatePercent as a fraction and fails closed otherwise (o3d-w00)', async () => {
  // Unit-level pin on the basis resolver itself, so the units cannot regress behind the sync harness.
  const order = makeOrder({ grossTotal: 120, taxBase: 20, rate: 0.2 })
  const taxed = resolveMonetaryRefundVatRate(order)
  assert.equal(taxed.ok, true)
  assert.equal(taxed.ok === true && taxed.vatRate.toNumber(), 0.2, 'the fraction is used as-is')

  // The same order with the rate expressed as a percentage is NOT silently accepted.
  assert.equal(resolveMonetaryRefundVatRate({ ...order, taxRatePercent: 20 }).ok, false)
  assert.equal(resolveMonetaryRefundVatRate({ ...order, taxRatePercent: null }).ok, false)
  assert.equal(resolveMonetaryRefundVatRate({ ...order, taxRatePercent: 0 }).ok, false)

  // Codex r2 #1: a taxed order with no lines has nothing that SAYS what rate it was taxed at — "every
  // line agrees" is vacuously true of no lines, and a vacuous truth must never establish a basis.
  const noLines = resolveMonetaryRefundVatRate({ totalBase: 120, taxBase: 20, taxRatePercent: 0.2, shippingBase: 0, lines: [] })
  assert.equal(noLines.ok, false)
  assert.match(noLines.ok === false ? noLines.error : '', /no lines to establish which rate/)

  const untaxed = resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 100, taxBase: 0, rate: 0 }))
  assert.equal(untaxed.ok, true)
  assert.equal(untaxed.ok === true && untaxed.vatRate.toNumber(), 0)
})

// ---------------------------------------------------------------------------
// o3d-w00 Codex r1 #1: zero-rated must be decided by something that SAYS it is zero-rated, never by the
// tax figure being small. The shortcut used to be `abs(taxBase) <= 0.02`, so a real £0.02 of VAT was
// treated as no VAT at all — and its gross refund was then stored under totalsBasis='NET', which is the
// original bug with a smaller number on it.
// ---------------------------------------------------------------------------

test('a REAL but tiny VAT figure is taxable, not zero-rated — at 0.02, 0.01 and 0.0001 (o3d-w00 Codex r1 #1)', () => {
  // Each of these sat inside the old |taxBase| <= 0.02 shortcut, which returned rate 0 ("gross IS net").
  // 2p, 1p and a hundredth of a penny of genuine VAT, each on a coherent 20% order.
  for (const [grossTotal, taxBase] of [[0.12, 0.02], [0.06, 0.01], [0.0006, 0.0001]] as const) {
    const basis = resolveMonetaryRefundVatRate(makeOrder({ grossTotal, taxBase, rate: 0.2 }))
    assert.equal(basis.ok, true, `${taxBase} of VAT should resolve`)
    assert.equal(
      basis.ok === true && basis.vatRate.toNumber(),
      0.2,
      `${taxBase} is real VAT and must convert at 20%, not be called zero-rated`,
    )
  }
})

test('a tiny VAT figure with NO recorded rate is refused, not silently zero-rated (o3d-w00 Codex r1 #1)', () => {
  // The dangerous half of the old shortcut: 2p of genuine VAT and no rate to convert it with. Assuming
  // zero-rated stored the gross amount as NET; the answer is to refuse.
  const basis = resolveMonetaryRefundVatRate({ ...makeOrder({ grossTotal: 0.12, taxBase: 0.02, rate: 0.2 }), taxRatePercent: null })
  assert.equal(basis.ok, false)
  assert.match(basis.ok === false ? basis.error : '', /no recorded tax rate/)
})

test('zero-rated is read off the order lines, so a zero HEADER VAT does not override a taxed line (o3d-w00 Codex r1 #1)', () => {
  // Header says no tax and no rate, but a line carries VAT — the signals disagree, so nothing here
  // "says" zero-rated. Fail closed rather than pick the convenient reading.
  const taxedLines = makeOrder({ grossTotal: 120, taxBase: 20, rate: 0.2 }).lines
  const basis = resolveMonetaryRefundVatRate({ totalBase: 100, taxBase: 0, taxRatePercent: null, shippingBase: 0, lines: taxedLines })
  assert.equal(basis.ok, false, 'a line carrying VAT is not a zero-rated order')
})

test('a genuinely zero-rated order still needs no conversion (o3d-w00)', () => {
  const basis = resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 100, taxBase: 0, rate: 0 }))
  assert.equal(basis.ok, true)
  assert.equal(basis.ok === true && basis.vatRate.toNumber(), 0)
})

test('a fully reverse-charged order is zero-rated on the FLAG, not on the rate value (o3d-w00 Codex r1 #1)', () => {
  // Under reverse charge the seller charges no VAT, so gross IS net — even if the rate row it points at
  // still carries a face value of 20%. The explicit flag is the signal that says so; without it this
  // order would be refused for a rate that cannot reproduce its (zero) tax.
  const order = makeOrder({ grossTotal: 120, taxBase: 20, rate: 0.2, reverseCharge: true })
  const reverseCharged = {
    ...order,
    taxBase: 0,
    totalBase: 100,
    lines: order.lines.map((line) => ({ ...line, taxBase: 0 })),
  }
  const basis = resolveMonetaryRefundVatRate(reverseCharged)
  assert.equal(basis.ok, true)
  assert.equal(basis.ok === true && basis.vatRate.toNumber(), 0)
})

// ---------------------------------------------------------------------------
// o3d-w00 Codex r1 #2: the reconciliation tolerance. It used to be 0.02 + 0.2% of net, which on a
// £10,000 net order accepted ±£20.02 — wide enough to admit the very mis-scaling the guard exists to
// catch. It is now the minimum of three DERIVED bounds: this order's actual penny-rounding exposure
// (0.005 per component), the cumulative-refund ceiling (REFUND_TOTAL_EPSILON x (1+rate)), and the FULL
// classification ((1 - FULL_REFUND_RATIO) x net x (1+rate)).
// ---------------------------------------------------------------------------

test('the tolerance no longer admits the mis-scaled rate the old one did (o3d-w00 Codex r1 #2)', () => {
  // Codex's case: £10,000 net / £2,000 VAT. 19.8% and 20.2% both fitted inside the old £20.02 tolerance,
  // and a full refund converted at them came out £16.69 over the ceiling / £16.64 short of FULL.
  for (const rate of [0.198, 0.202]) {
    const basis = resolveMonetaryRefundVatRate({ ...makeOrder({ grossTotal: 12000, taxBase: 2000, rate: 0.2, lineCount: 13 }), taxRatePercent: rate })
    assert.equal(basis.ok, false, `a header rate of ${rate} against 20% of recorded VAT must be refused`)
  }
  // On that 13-component order the rounding exposure would be £0.0652, but the cumulative-refund ceiling
  // caps it at 0.011 x 1.2 = £0.0132. So the smallest mis-scaling now rejected is a rate off by
  // 0.0132/10000 = 0.00000132 — 19.999868% instead of 20% — where the old tolerance was £20.02.
  assert.equal(
    resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 12000, taxBase: 1999.989, rate: 0.2, lineCount: 13 })).ok,
    true,
    'delta of exactly 0.0132 is the largest accepted',
  )
  assert.equal(
    resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 12000, taxBase: 1999.9889, rate: 0.2, lineCount: 13 })).ok,
    false,
    'delta of 0.01332 — one 0.0001 step of taxBase further — is refused',
  )
})

test('the tolerance is sized to this order’s own penny rounding, in BOTH directions (o3d-w00 Codex r1 #2)', () => {
  // ONE taxable component: WooCommerce rounded exactly one VAT figure to the penny, so the largest
  // legitimate gap is half a penny (plus 0.0002 for the two Decimal(18,4) conversions under net).
  // Tolerance = 0.005 x 1 + 0.0002 = 0.0052. On a £120.00 gross order, taxBase 19.9957 gives delta
  // +0.00516 and 19.9956 gives +0.00528; 20.0043 / 20.0044 are the same two steps the other way.
  for (const [inside, outside] of [[19.9957, 19.9956], [20.0043, 20.0044]] as const) {
    assert.equal(
      resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 120, taxBase: inside, rate: 0.2 })).ok,
      true,
      `taxBase ${inside}: within one component's penny rounding is legitimate`,
    )
    assert.equal(
      resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 120, taxBase: outside, rate: 0.2 })).ok,
      false,
      `taxBase ${outside}: beyond one component's penny rounding is not`,
    )
  }
})

test('more penny-rounded components buy more tolerance, until the refund ceiling caps it (o3d-w00 Codex r1 #2)', () => {
  // 2 components => 0.005 x 2 + 0.0002 = 0.0102, under the ceiling cap of 0.011 x 1.2 = 0.0132.
  // taxBase 19.9915 is delta 0.0102 exactly; 19.9914 is 0.01032. The 1-component order above refused
  // both of these, so the component count is what changed the answer.
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 120, taxBase: 19.9915, rate: 0.2, lineCount: 2 })).ok, true)
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 120, taxBase: 19.9914, rate: 0.2, lineCount: 2 })).ok, false)
  // 3 components would allow 0.0152 on rounding alone, but the ceiling cap binds first at 0.0132: past
  // that, a full monetary refund converted at the accepted rate could exceed the order's net total.
  // taxBase 19.989 is delta 0.0132 exactly; 19.9889 is 0.01332 — and 40 components cannot buy it back.
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 120, taxBase: 19.989, rate: 0.2, lineCount: 3 })).ok, true)
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 120, taxBase: 19.9889, rate: 0.2, lineCount: 3 })).ok, false)
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 120, taxBase: 19.9889, rate: 0.2, lineCount: 40 })).ok, false)
})

test('shipping counts as a penny-rounded component when it was charged (o3d-w00 Codex r1 #2)', () => {
  // The same drift is legitimate with a shipping charge (2 components) and is not without one — so the
  // component count is doing real work rather than being decorative.
  // taxBase 19.99375 on a £120.00 gross order is delta 0.0075: past one component's 0.0052, inside two
  // components' 0.0102.
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 120, taxBase: 19.99375, rate: 0.2 })).ok, false)
  assert.equal(
    resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 120, taxBase: 19.99375, rate: 0.2, shippingBase: 10 })).ok,
    true,
  )
})

test('the FULL-classification bound is what caps a SMALL order (o3d-w00 Codex r1 #2)', () => {
  // On £5 net, (1 - 0.999) x 5 x 1.2 = 0.006 is tighter than both the 3-component rounding exposure
  // (0.0152) and the ceiling cap (0.0132). Beyond it a full monetary refund would land under 99.9% of
  // the net total and the order would stay PARTIALLY_REFUNDED — the exact symptom o3d-w00 is about.
  // £6.00 gross / £5.00 net. taxBase 0.995 is delta +0.006 exactly; 0.9949 is +0.00612.
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 6, taxBase: 0.995, rate: 0.2, lineCount: 3 })).ok, true)
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 6, taxBase: 0.9949, rate: 0.2, lineCount: 3 })).ok, false)
  // The cap is (1 - 0.999) x NET x 1.2, and net moves with taxBase, so the other side lands one step
  // earlier: taxBase 1.0049 is delta -0.00588 against a cap of 0.00599; 1.005 is -0.006 against 0.005994.
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 6, taxBase: 1.0049, rate: 0.2, lineCount: 3 })).ok, true)
  assert.equal(resolveMonetaryRefundVatRate(makeOrder({ grossTotal: 6, taxBase: 1.005, rate: 0.2, lineCount: 3 })).ok, false)
})

test('every basis the guard accepts survives BOTH downstream refund thresholds (o3d-w00 Codex r1 #2)', async () => {
  // Codex's closing ask: prove the accepted band is COMPATIBLE with the ceiling and the FULL test, not
  // merely narrower than before. Each shape sits at exactly its tolerance edge, in both directions, and
  // the refund is the whole gross the customer paid — the case that has to reach REFUNDED.
  const shapes = [
    // 1 component, +/-0.00516 — the rounding-exposure edge
    { grossTotal: 120, taxBase: 19.9957, rate: 0.2, lineCount: 1 },
    { grossTotal: 120, taxBase: 20.0043, rate: 0.2, lineCount: 1 },
    // 3 components, +/-0.0132 — the cumulative-refund ceiling cap
    { grossTotal: 120, taxBase: 19.989, rate: 0.2, lineCount: 3 },
    { grossTotal: 120, taxBase: 20.011, rate: 0.2, lineCount: 3 },
    // a small order, +/-0.006 — the FULL-classification cap
    { grossTotal: 6, taxBase: 0.995, rate: 0.2, lineCount: 3 },
    { grossTotal: 6, taxBase: 1.0049, rate: 0.2, lineCount: 3 },
    // Codex's high-value order at the cap
    { grossTotal: 12000, taxBase: 1999.989, rate: 0.2, lineCount: 13 },
    { grossTotal: 12000, taxBase: 2000.011, rate: 0.2, lineCount: 13 },
  ]
  for (const shape of shapes) {
    const order = makeOrder(shape)
    assert.equal(resolveMonetaryRefundVatRate(order).ok, true, `${JSON.stringify(shape)} should be accepted`)

    const state = makeDependencies({ alwaysMissExistingRefund: true, order })
    await syncWcRefund(
      1001,
      makeRefund({ id: 7200, amount: order.totalBase.toFixed(2), line_items: [], shipping_lines: [] }),
      state.dependencies,
    )
    const storedNet = state.createRefundLines[0]?.totalBase ?? 0
    const netOrderTotal = order.totalBase - order.taxBase

    assert.equal(
      refundWouldExceedOrderTotal(storedNet, 0, netOrderTotal),
      false,
      `${JSON.stringify(shape)}: a full refund on an accepted basis must not trip the cumulative NET ceiling`,
    )
    assert.equal(
      isFullRefundAmount(storedNet, netOrderTotal),
      true,
      `${JSON.stringify(shape)}: a full refund on an accepted basis must classify FULL, not stay PARTIAL`,
    )
  }

  // And the converse, which is what the old tolerance got wrong: a rate it ADMITTED breaks both
  // thresholds. £10,000 net / £2,000 VAT with a header of 19.8% fitted inside the old ±£20.02, and the
  // £12,000 full refund it produced is £9,983.36 net — £16.64 short of FULL, so the order stays
  // PARTIALLY_REFUNDED. At 20.2% it is £10,016.69, which the ceiling refuses outright.
  for (const [rate, storedNet] of [[0.198, 12000 / 1.198], [0.202, 12000 / 1.202]] as const) {
    assert.equal(
      resolveMonetaryRefundVatRate({ ...makeOrder({ grossTotal: 12000, taxBase: 2000, rate: 0.2, lineCount: 13 }), taxRatePercent: rate }).ok,
      false,
      `a header of ${rate} must be refused`,
    )
    const brokenDownstream =
      refundWouldExceedOrderTotal(storedNet, 0, 10000) || !isFullRefundAmount(storedNet, 10000)
    assert.equal(brokenDownstream, true, `${rate} is exactly the drift that breaks the refund thresholds`)
  }
})

// ---------------------------------------------------------------------------
// o3d-w00 Codex r2 #1: SHIPPING is a taxed component like any other, and it can carry ALL of an order's
// VAT. `taxRatePercent` is the order DEFAULT — order-import picks the "standard"-named (or highest)
// rate among the order's WooCommerce tax lines — so on zero-rated goods with standard-rated postage the
// header reads 20% while every goods line is 0%. Numeric proximity alone could not tell that apart from
// a genuinely 20% order, and the credit note posts the unlinked line at the GOODS identity, so the
// difference walked straight out of the ledger.
// ---------------------------------------------------------------------------

/**
 * Codex's order, coherent: £0.05 of zero-rated goods + a £10 shipping charge carrying £2.00 of VAT.
 * Lines + shipping = £10.05 net, line VAT + shipping VAT = £2.00, gross £12.05 — exactly what
 * order-import would store, header rate and all.
 */
function shippingOnlyTaxOrder(): OrderDouble {
  return makeOrder({ grossTotal: 12.05, taxBase: 2, rate: 0.2, shippingBase: 10, shippingTaxBase: 2, lineRate: 0 })
}

test('VAT that sits on SHIPPING does not make the goods 20% — the basis is refused (o3d-w00 Codex r2 #1)', () => {
  const order = shippingOnlyTaxOrder()
  // The fixture is a real order, not a contrivance: its parts add up.
  assert.equal(order.lines.reduce((sum, line) => sum + line.totalBase, 0) + order.shippingBase, order.totalBase - order.taxBase)
  assert.equal(order.lines.reduce((sum, line) => sum + line.taxBase, 0), 0)

  // It passes the AGGREGATE check — net 10.05 x 0.20 = 2.01 against 2.00 recorded is 0.01, inside the
  // 0.0102 two-component tolerance — which is precisely why aggregate proximity may not decide this.
  const netOrderBase = order.totalBase - order.taxBase
  assert.ok(Math.abs(netOrderBase * 0.2 - order.taxBase) < 0.0102, 'the aggregate reconciliation alone would accept 20%')

  const basis = resolveMonetaryRefundVatRate(order)
  assert.equal(basis.ok, false, 'but the goods were zero-rated, so 20% is not the rate this refund converts at')
  assert.match(basis.ok === false ? basis.error : '', /not the rate its goods were taxed at/)
})

test('a shipping-taxed order is QUARANTINED instead of being credited short (o3d-w00 Codex r2 #1)', async () => {
  const order = shippingOnlyTaxOrder()
  const state = makeDependencies({ alwaysMissExistingRefund: true, order })
  const refund = makeRefund({ id: 7301, amount: '12.05', line_items: [], shipping_lines: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true)
  assert.equal(state.createRefundCalls, 0, 'no credit note is raised on a rate the order did not charge')
  const park = state.syncLogs.at(-1) as { data?: { status?: string; payload?: unknown } }
  assert.equal(park?.data?.status, 'QUARANTINED')
  assert.ok(park?.data?.payload, 'the payload is kept so the operator can reconcile against the gross')
  // What the old guard did instead: 12.05 / 1.20 = 10.0417 stored as NET, then re-grossed at the goods
  // lines' 0% identity — £10.04 of credit for a £12.05 refund, and it still classified FULL.
  assert.equal(state.createRefundLines.length, 0)
})

test('goods taxed but the shipping leg untaxed is refused the same way (o3d-w00 Codex r2 #1)', () => {
  // The mirror image: £100 of 20% goods + £10 of shipping that carried no VAT. An unattributed refund
  // could be either, and converting shipping money at 20% over-credits it.
  const order = makeOrder({ grossTotal: 130, taxBase: 20, rate: 0.2, shippingBase: 10, shippingTaxBase: 0 })
  assert.equal(order.lines[0].totalBase, 100)
  assert.equal(order.lines[0].taxBase, 20)

  const basis = resolveMonetaryRefundVatRate(order)
  assert.equal(basis.ok, false)
  assert.match(basis.ok === false ? basis.error : '', /shipping is not taxed at that rate/)
})

test('one rate across goods AND shipping still converts — the guard bans mixing, not shipping (o3d-w00 Codex r2 #1)', async () => {
  // £100 of 20% goods + £10 of 20% shipping = £132.00 gross. Every component agrees, so the basis is
  // established and a full refund converts to the order's net total.
  const order = makeOrder({ grossTotal: 132, taxBase: 22, rate: 0.2, shippingBase: 10 })
  assert.equal(order.lines[0].taxBase, 20, 'the goods carry their own 20%')

  const basis = resolveMonetaryRefundVatRate(order)
  assert.equal(basis.ok, true)
  assert.equal(basis.ok === true && basis.vatRate.toNumber(), 0.2)

  const state = makeDependencies({ alwaysMissExistingRefund: true, order })
  await syncWcRefund(1001, makeRefund({ id: 7302, amount: '132.00', line_items: [], shipping_lines: [] }), state.dependencies)
  assert.equal(state.createRefundLines[0]?.totalBase, 110, 'stored NET, and it is the whole net order total')
  assert.equal(isFullRefundAmount(110, order.totalBase - order.taxBase), true)
})

test('a header rate that is not the goods rate is refused before any arithmetic (o3d-w00 Codex r2 #1)', () => {
  // 5% recorded on an order whose lines are all 20%. Previously this only failed because the numbers
  // happened not to reconcile; now the disagreement itself is the refusal, so it cannot be rescued by
  // an order shape where the numbers coincidentally line up.
  const basis = resolveMonetaryRefundVatRate({ ...makeOrder({ grossTotal: 120, taxBase: 20, rate: 0.2 }), taxRatePercent: 0.05 })
  assert.equal(basis.ok, false)
  assert.match(basis.ok === false ? basis.error : '', /not the rate its goods were taxed at/)
})

test('a line whose recorded VAT contradicts its own rate is not evidence of anything (o3d-w00 Codex r2 #1)', () => {
  // The line SAYS 20% and the header agrees, but the line carries no VAT — so "20%" is a claim the
  // order's own money does not support. Half a penny per component is rounding; this is not.
  const order = makeOrder({ grossTotal: 120, taxBase: 20, rate: 0.2, lineCount: 2 })
  const contradictory = {
    ...order,
    lines: [
      { ...order.lines[0], taxBase: 0 },
      { ...order.lines[1], taxBase: 20 },
    ],
  }
  const basis = resolveMonetaryRefundVatRate(contradictory)
  assert.equal(basis.ok, false)
  assert.match(basis.ok === false ? basis.error : '', /which is not 0\.2 of it/)
})

// ---------------------------------------------------------------------------
// o3d-w00 Codex r2 #4: reverse charge is a per-line fact, not an all-or-nothing order fact. The zero
// test used to demand that EVERY line be reverse-charged before it would believe a 20% header charged
// no VAT, so a partially reverse-charged order — RC line plus a genuinely zero-rated line, no VAT
// anywhere — was measured against a rate it never charged and refused for "not reconciling".
// ---------------------------------------------------------------------------

test('a PARTIALLY reverse-charged order charged no VAT, so gross IS net (o3d-w00 Codex r2 #4)', () => {
  // One £100 line reverse-charged at a 20% face rate, one £50 zero-rated line. Recorded VAT is zero
  // everywhere and every line says WHY, so no conversion is owed.
  const order = makeOrder({ grossTotal: 150, taxBase: 0, rate: 0.2, lineCount: 2 })
  const partiallyReverseCharged: OrderDouble = {
    ...order,
    lines: [
      { ...order.lines[0], totalBase: 100, taxBase: 0, taxRate: { rate: 0.2, reverseCharge: true } },
      { ...order.lines[1], totalBase: 50, taxBase: 0, taxRate: { rate: 0, reverseCharge: false } },
    ],
  }
  assert.equal(
    partiallyReverseCharged.lines.reduce((sum, line) => sum + line.totalBase, 0),
    partiallyReverseCharged.totalBase - partiallyReverseCharged.taxBase,
    'the fixture is a coherent order',
  )

  const basis = resolveMonetaryRefundVatRate(partiallyReverseCharged)
  assert.equal(basis.ok, true, 'nothing here is undeterminable — the order charged no VAT')
  assert.equal(basis.ok === true && basis.vatRate.toNumber(), 0)
})

test('a reverse-charged line NEXT TO a VAT-bearing one is refused, and says why (o3d-w00 Codex r2 #4)', () => {
  // The case the all-or-nothing test was reaching for: RC (no VAT charged) mixed with a line that DID
  // charge VAT. One rate cannot convert an amount that could belong to either.
  const order = makeOrder({ grossTotal: 220, taxBase: 20, rate: 0.2, lineCount: 2 })
  const mixed: OrderDouble = {
    ...order,
    lines: [
      { ...order.lines[0], totalBase: 100, taxBase: 0, taxRate: { rate: 0.2, reverseCharge: true } },
      { ...order.lines[1], totalBase: 100, taxBase: 20, taxRate: { rate: 0.2, reverseCharge: false } },
    ],
  }
  const basis = resolveMonetaryRefundVatRate(mixed)
  assert.equal(basis.ok, false)
  assert.match(basis.ok === false ? basis.error : '', /mixes reverse-charged supplies/)
})

// ---------------------------------------------------------------------------
// o3d-w00 Codex r3 #3: the shipping leg's VAT is DERIVED (order tax − line tax), and that subtraction
// is only exact in the currency the order was taxed in. order-import converts the AGGREGATE foreign tax
// once into SalesOrder.taxBase and every line's tax INDEPENDENTLY into SalesOrderLine.taxBase, so the
// base-currency difference carries one Decimal(18,4) residue per line plus one for the aggregate — none
// of which is shipping VAT.
// ---------------------------------------------------------------------------

/**
 * An imported multi-currency order, built the way order-import builds one: the foreign figures are what
 * WooCommerce charged (exact 2dp), and every base figure is that foreign figure converted at /fx and
 * rounded to Decimal(18,4) — the aggregate and each line SEPARATELY, which is where the residue is born.
 * No shipping at all, so the derived "shipping tax" is PURE conversion residue.
 */
function makeConvertedOrder(input: { lineCount: number; lineNetForeign: string; lineTaxForeign: string; fxRateToBase: string; rate: number }) {
  const toBase = (foreign: Decimal) => Number(roundQuantity(foreign.div(toDecimal(input.fxRateToBase)), 4).toFixed(4))
  const lineNet = toDecimal(input.lineNetForeign)
  const lineTax = toDecimal(input.lineTaxForeign)
  const netForeign = lineNet.mul(input.lineCount)
  const taxForeign = lineTax.mul(input.lineCount)
  return {
    totalBase: toBase(netForeign.add(taxForeign)),
    taxBase: toBase(taxForeign),
    taxRatePercent: input.rate,
    shippingBase: 0,
    taxForeign: Number(taxForeign.toFixed(4)),
    shippingForeign: 0,
    lines: Array.from({ length: input.lineCount }, () => ({
      totalBase: toBase(lineNet),
      taxBase: toBase(lineTax),
      taxForeign: Number(lineTax.toFixed(4)),
      taxRate: { rate: input.rate, reverseCharge: false },
    })),
  }
}

test('a multi-currency order with NO shipping is not refused for its FX conversion residue (o3d-w00 Codex r3 #3)', () => {
  // 150 lines of 0.05 foreign net + 0.01 foreign VAT at 20%, converted at 1.6. Every line and the
  // aggregate reconcile; the order charged no shipping at all. Derived in BASE currency the "shipping
  // tax" comes to -0.0075 — past the single component's 0.0052 — and the refund was quarantined for
  // "its shipping is not taxed at that rate" on an order with no shipping.
  const order = makeConvertedOrder({ lineCount: 150, lineNetForeign: '0.05', lineTaxForeign: '0.01', fxRateToBase: '1.6', rate: 0.2 })

  // The residue is real and large enough to have tripped the old check — otherwise this proves nothing.
  const baseDerived = toDecimal(order.taxBase).sub(order.lines.reduce((sum, line) => sum.add(toDecimal(line.taxBase)), toDecimal(0)))
  assert.equal(baseDerived.toFixed(4), '-0.0075')
  assert.ok(baseDerived.abs().toNumber() > 0.0052, 'the base derivation exceeds one component of rounding')
  // In the order's OWN currency the same subtraction is exact — that is why it is done there.
  const foreignDerived = toDecimal(order.taxForeign).sub(order.lines.reduce((sum, line) => sum.add(toDecimal(line.taxForeign)), toDecimal(0)))
  assert.equal(foreignDerived.toFixed(4), '0.0000')

  assert.equal(resolveMonetaryRefundVatRate(order).ok, true, 'accepted: there is no shipping discrepancy, only FX rounding')
})

test('the base-currency fallback admits the conversion residue explicitly, not as slack (o3d-w00 Codex r3 #3)', () => {
  // An order shape carrying no foreign figures still has to be judged. There the residue is admitted as
  // what it is — one half-unit per independently converted figure — and REAL shipping VAT is still
  // caught: on the same order, moving 0.05 of VAT off the lines is a discrepancy no rounding explains.
  const order = makeConvertedOrder({ lineCount: 150, lineNetForeign: '0.05', lineTaxForeign: '0.01', fxRateToBase: '1.6', rate: 0.2 })
  const withoutForeign = {
    ...order,
    taxForeign: undefined,
    shippingForeign: undefined,
    lines: order.lines.map((line) => ({ ...line, taxForeign: undefined })),
  }
  assert.equal(resolveMonetaryRefundVatRate(withoutForeign).ok, true, 'the residue alone is admitted')

  const withRealShippingVat = {
    ...withoutForeign,
    taxBase: Number((withoutForeign.taxBase + 0.05).toFixed(4)),
    totalBase: Number((withoutForeign.totalBase + 0.05).toFixed(4)),
  }
  const refused = resolveMonetaryRefundVatRate(withRealShippingVat)
  assert.equal(refused.ok, false, 'VAT that no shipping charge explains is still refused')
  assert.match(refused.ok === false ? refused.error : '', /shipping is not taxed at that rate/)
})

test('standard-rated shipping on zero-rated goods is STILL refused (o3d-w00 Codex r2 #1, guarded at r3 #3)', () => {
  // The check the FX fix must not weaken: goods at 0% with the header at 20% because postage was
  // standard-rated. Derived in the order's own currency the shipping VAT is real, not residue.
  const zeroRatedGoodsStandardPostage = {
    totalBase: 12.05, taxBase: 2, taxRatePercent: 0.2, shippingBase: 10,
    taxForeign: 2, shippingForeign: 10,
    lines: [{ totalBase: 0.05, taxBase: 0, taxForeign: 0, taxRate: { rate: 0, reverseCharge: false } }],
  }
  const basis = resolveMonetaryRefundVatRate(zeroRatedGoodsStandardPostage)
  assert.equal(basis.ok, false)
  // It fails on the per-line rate corroboration first — the goods were never taxed at the header rate.
  assert.match(basis.ok === false ? basis.error : '', /is not the rate its goods were taxed at/)
})

test('the sync READS the order-currency tax figures the derivation needs (o3d-w00 Codex r3 #3)', async () => {
  // Without these columns in the select the foreign derivation silently falls back to base currency, and
  // no assertion on a hand-built order double would notice.
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  await syncWcRefund(1001, makeRefund({ id: 7301, amount: '15.00', line_items: [], shipping_lines: [] }), state.dependencies)

  const select = state.orderSelect as { taxForeign?: boolean; shippingForeign?: boolean; lines?: { select?: { taxForeign?: boolean } } }
  assert.equal(select?.taxForeign, true, 'the order-currency VAT total')
  assert.equal(select?.shippingForeign, true, 'the order-currency shipping charge')
  assert.equal(select?.lines?.select?.taxForeign, true, "each line's order-currency VAT")
})

// ---------------------------------------------------------------------------
// o3d-w00 Codex r1 #3: the quarantine has to point at something an operator can actually do.
// ---------------------------------------------------------------------------

test('an undeterminable-basis quarantine names the completion path that exists (o3d-w00 Codex r1 #3)', async () => {
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: { ...makeOrder({ grossTotal: 120, taxBase: 20, rate: 0.2 }), taxRatePercent: null },
  })
  const result = await syncWcRefund(1001, makeRefund({ id: 7104, amount: '120.00', line_items: [], shipping_lines: [] }), state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true)
  const message = result.error ?? ''
  // The remedy is the Record-manually action on the exception inbox — recordRefundParkManually — and it
  // takes a NET allocation across the order's lines. Naming anything else would be naming a screen that
  // does not exist, which is the defect Codex reported.
  assert.match(message, /Sync → Exceptions/)
  assert.match(message, /Record manually/)
  // Codex r2 #2/#3: GROSS amounts that add up to the storefront refund, across the lines AND shipping.
  // Saying NET here would be an instruction the dialog no longer accepts.
  assert.match(message, /GROSS \(tax-inclusive\) amounts that add up to the refund/)
  assert.match(message, /shipping charge/)
  // And it must say plainly that retrying is NOT the way out, because retry re-runs the same refusal.
  assert.match(message, /Retry cannot clear it/)
  // The gross figure the operator has to account for is in the message, and so is the warning that the
  // money has already gone.
  assert.match(message, /120\.00 gross/)
  assert.match(message, /do NOT issue another WooCommerce refund/)
  const park = state.syncLogs.at(-1) as { data?: { status?: string; payload?: unknown } }
  assert.equal(park?.data?.status, 'QUARANTINED')
  // The payload is retained: the Record-manually dialog shows the operator the gross amount from it.
  assert.ok(park?.data?.payload, 'the parked WooCommerce refund payload is kept for the manual recording')
})

test('syncWcRefund still rejects a genuine amount mismatch', async () => {
  // Mapped gross (10.00 + 1.00 tax = 11.00) is far from the claimed 99.00 amount.
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  const refund = makeRefund({
    id: 7003,
    amount: '99.00',
    line_items: [
      {
        id: 501,
        name: 'Widget',
        product_id: 10,
        variation_id: 0,
        quantity: -1,
        tax_class: '',
        subtotal: '-10.00',
        subtotal_tax: '-1.00',
        total: '-10.00',
        total_tax: '-1.00',
        sku: 'WIDGET',
        meta_data: [],
        refund_total: 11,
      },
    ],
  })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true)
  assert.match(result.error ?? '', /amount mismatch/)
  assert.equal(state.createRefundCalls, 0)
})

test('repeated deliveries of the same mismatched refund keep ONE park, not an unbounded pile (o3d-7yf)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  const refund = makeRefund({
    id: 7009, amount: '99.00',
    line_items: [{ id: 501, name: 'Widget', product_id: 10, variation_id: 0, quantity: -1, tax_class: '', subtotal: '-10.00', subtotal_tax: '-1.00', total: '-10.00', total_tax: '-1.00', sku: 'WIDGET', meta_data: [], refund_total: 11 }],
  })

  await syncWcRefund(1001, refund, state.dependencies)
  await syncWcRefund(1001, refund, state.dependencies)
  await syncWcRefund(1001, refund, state.dependencies)

  const parksForRefund = state.syncLogs.filter((log) => (log as { data?: { externalId?: string } }).data?.externalId === '7009')
  assert.equal(parksForRefund.length, 1, 'three deliveries produce exactly one park row (updated in place), not three')
  assert.equal((parksForRefund[0] as { data: { status: string } }).data.status, 'PENDING')
})


test('a park is NOT written for an order deleted during processing — no orphaned park (o3d-7yf #2)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  const refund = makeRefund({
    id: 7011, amount: '99.00',
    line_items: [{ id: 501, name: 'Widget', product_id: 10, variation_id: 0, quantity: -1, tax_class: '', subtotal: '-10.00', subtotal_tax: '-1.00', total: '-10.00', total_tax: '-1.00', sku: 'WIDGET', meta_data: [], refund_total: 11 }],
  })
  // The order is deleted concurrently: upsertRefundPark's FOR UPDATE re-verify finds it gone, so it must
  // NOT insert an actionable park that retryRefundSyncPark could never resolve.
  state.simulateOrderDeleted()
  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true, 'the mismatch still surfaces')
  const parks = state.syncLogs.filter((log) => (log as { data?: { externalId?: string } }).data?.externalId === '7011')
  assert.equal(parks.length, 0, 'no orphaned park was written for the deleted order')
})

test('syncWcRefund treats external refund unique conflicts as idempotent races', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.dependencies.createRefund = async () => {
    throw externalRefundIdUniqueError()
  }

  const result = await syncWcRefund(1001, makeRefund(), state.dependencies)

  // The race's WINNER is this same order's row, verified under the lock — so the refund IS in IMS,
  // it just was not this call that put it there.
  assert.deepEqual(result, { outcome: 'already-applied' })
  assert.equal(state.syncLogs.length, 1)
  assert.deepEqual((state.syncLogs[0] as { data: unknown }).data, {
    direction: 'FROM_CONNECTOR',
    status: 'SYNCED',
    entityType: 'SalesOrder',
    entityId: 'so-1',
    externalId: '7001',
    errorMessage: 'Duplicate WooCommerce refund delivery deduped by external refund id',
    syncedAt: (state.syncLogs[0] as { data: { syncedAt: Date } }).data.syncedAt,
  })
  assert.equal(state.activityLogs.length, 1)
  assert.deepEqual(state.activityLogs[0], {
    entityType: 'SALES_ORDER',
    entityId: 'so-1',
    action: 'refund_sync_deduped',
    tag: 'sync',
    level: 'INFO',
    description: 'WC refund 7001 already synced; duplicate delivery was deduped',
    metadata: { externalRefundId: 7001, parentOrderId: 1001 },
    resolveUser: false,
  })
})

test('syncWcRefund links a refund line to its IMS order line via _refunded_item_id, not the refund line id', async () => {
  // REGRESSION (o3d-w2m). WooCommerce mints a NEW order-item id for every refund line,
  // and records the ORDER line it refunds in the _refunded_item_id meta. Measured on a
  // live store: order line 92771 -> refund line 92774, meta _refunded_item_id "92771".
  //
  // The old code matched `l.externalLineItemId === rl.id`, which can never be true for a
  // real refund. The line link was silently lost, createRefund rejected the refund for
  // having no shipped stock source, and the whole Woo refund path failed with no error
  // recorded anywhere.
  //
  // The other fixtures in this file give the refund line id 501 — the SAME id as the
  // order line — which no real store does. That is precisely why the bug survived: the
  // fixture encoded the broken premise.
  const harness = makeDependencies()
  const refund = makeRefund({
    line_items: [
      {
        id: 504, // the refund line's OWN id — deliberately different from the order line
        name: 'Widget',
        product_id: 10,
        variation_id: 0,
        quantity: -1,
        tax_class: '',
        subtotal: '-12.50',
        subtotal_tax: '0',
        total: '-12.50',
        total_tax: '0',
        sku: 'WIDGET',
        meta_data: [{ id: 1, key: '_refunded_item_id', value: '501' }],
        refund_total: 12.5,
      },
    ],
  })

  const result = await syncWcRefund(1001, refund, harness.dependencies)

  assert.equal(refundIsInIms(result.outcome), true, result.error)
  assert.equal(harness.createRefundLines.length, 1)
  assert.equal(
    harness.createRefundLines[0].lineId,
    'line-1',
    'the refund line must resolve to the IMS order line via _refunded_item_id; an unlinked line (undefined) is later rejected for having no shipped stock source',
  )
  assert.equal(harness.createRefundLines[0].productId, 'product-1')
})

test('syncWcRefund falls back to the refund line id when _refunded_item_id is absent', async () => {
  // Defensive: a store or stub that does not emit the meta should behave as before
  // rather than lose the link entirely.
  const harness = makeDependencies()
  const result = await syncWcRefund(1001, makeRefund(), harness.dependencies)

  assert.equal(refundIsInIms(result.outcome), true, result.error)
  assert.equal(harness.createRefundLines[0].lineId, 'line-1')
})

test('a refused monetary-only refund is QUARANTINED and not re-attempted on the next delivery (o3d-w00 #2/#5, o3d-iup)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true, refuseWithQuarantine: true })

  const first = await syncWcRefund(1001, makeRefund(), state.dependencies)
  assert.equal(refundOutcomeFailed(first.outcome), true, 'the refusal surfaces as a failed sync')

  // It is parked as QUARANTINED (distinct from FAILED), keyed by the WC refund id.
  const parked = state.syncLogs.find((log) => {
    const data = (log as { data?: { status?: string; externalId?: string } }).data
    return data?.status === 'QUARANTINED'
  }) as { data?: { externalId?: string } } | undefined
  assert.ok(parked, 'a QUARANTINED log was written')
  assert.equal(parked?.data?.externalId, String(makeRefund().id), 'keyed by the WC refund id')
  // Codex r2 #2: the WooCommerce refund is KEPT on this park too, not just on the basis refusal. The
  // Record-manually completion path reconciles the credit note it raises against this payload's gross
  // amount, so a park without it advertises a remedy that cannot run — and this non-uniform-tax refusal
  // is the commonest quarantine there is.
  assert.ok(
    (parked as { data?: { payload?: { amount?: string } } })?.data?.payload,
    'the parked WooCommerce refund payload is retained for the manual completion path',
  )
  assert.equal((parked as { data?: { payload?: { amount?: string } } })?.data?.payload?.amount, '12.50')

  const callsAfterFirst = state.createRefundCalls
  // A duplicate delivery must be skipped by the parked-log dedup — no re-refusal loop.
  const second = await syncWcRefund(1001, makeRefund(), state.dependencies)
  // o3d-xnwu r4: HANDLED, AND NOT APPLIED — and those are now two different things. This ending used
  // to return the same `success: true` the applied endings did, so the sweep counted a refund sitting
  // in the exception inbox as one that is in IMS.
  // o3d-xnwu r5: and RESOLVABLE — the half of "handled" that says an operator can still make this a
  // SalesOrderRefund, which is what makes holding a delivery for it worth something. The other half
  // (a chargeback-suppressed refund) can never be applied and must not hold anything.
  assert.equal(second.outcome, 'handled-unapplied-resolvable', 'the parked refund is treated as handled, not retried')
  assert.equal(refundIsInIms(second.outcome), false, 'and nothing about it is in IMS')
  assert.equal(refundMayStillReachIms(second.outcome), true, 'but an operator resolving the park still lands it')
  assert.equal(state.createRefundCalls, callsAfterFirst, 'createRefund was NOT called again for a parked refund')
})

test('a refund id already parked for a DIFFERENT order fails closed, not silently moved (o3d-7yf)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  // Order A already has an actionable park for refund 7012.
  state.syncLogs.push({ id: 'log-seed', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-other', externalId: '7012', status: 'FAILED' } })

  // The same refund id 7012 now arrives for order B (resolves to so-1) and would need to be parked.
  const refund = makeRefund({
    id: 7012, amount: '99.00',
    line_items: [{ id: 501, name: 'Widget', product_id: 10, variation_id: 0, quantity: -1, tax_class: '', subtotal: '-10.00', subtotal_tax: '-1.00', total: '-10.00', total_tax: '-1.00', sku: 'WIDGET', meta_data: [], refund_total: 11 }],
  })
  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true)
  assert.match(result.error ?? '', /already parked for a different order/i, 'failed closed on the cross-order collision')
  // Order A's park is untouched — still entityId so-other.
  const seed = state.syncLogs.find((log) => (log as { id?: string }).id === 'log-seed') as { data: { entityId: string } }
  assert.equal(seed.data.entityId, 'so-other', "A's park was not moved to B")
})

test('a QUARANTINED park for a DIFFERENT order does not mark this order handled (o3d-7yf)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  // Refund 7013 is QUARANTINED for order A (so-other). The unscoped pre-skip used to return handled for ANY
  // order sharing the refund id — so order B (so-1) would silently get neither a refund nor a failure.
  state.syncLogs.push({ id: 'log-q', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-other', externalId: '7013', status: 'QUARANTINED' } })

  const refund = makeRefund({
    id: 7013, amount: '99.00',
    line_items: [{ id: 501, name: 'Widget', product_id: 10, variation_id: 0, quantity: -1, tax_class: '', subtotal: '-10.00', subtotal_tax: '-1.00', total: '-10.00', total_tax: '-1.00', sku: 'WIDGET', meta_data: [], refund_total: 11 }],
  })
  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true, 'B is NOT silently treated as handled by A\'s quarantined park')
  assert.match(result.error ?? '', /different order/i, 'the cross-order quarantine is surfaced, not swallowed')
})

test('an existing refund for a DIFFERENT order fails closed, not reported as already-synced (o3d-7yf)', async () => {
  const state = makeDependencies()
  // A refund with external id 7014 already exists — but on order so-other, not this order (so-1).
  state.refunds.push({ id: 'refund-x', externalRefundId: 7014, orderId: 'so-other' })

  const result = await syncWcRefund(1001, makeRefund({ id: 7014 }), state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true, 'not silently treated as already-synced for this order')
  assert.match(result.error ?? '', /different order/i, 'the cross-order existing refund is surfaced')
  assert.equal(state.createRefundCalls, 0, 'no refund was created on this order')
})

test('a PENDING park for a DIFFERENT order blocks applying the same refund here (o3d-7yf)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.syncLogs.push({ id: 'log-p', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-other', externalId: '7015', status: 'PENDING' } })

  const result = await syncWcRefund(1001, makeRefund({ id: 7015 }), state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true, 'a PENDING park owned by another order fails closed too')
  assert.match(result.error ?? '', /different order/i)
  assert.equal(state.createRefundCalls, 0, 'no refund created on this order while another order holds the park')
})

// ---------------------------------------------------------------------------
// o3d-xnwu ROUND 6 (Codex HIGH) — THE TWO CROSS-ORDER REFUSALS ARE NOT THE SAME KIND.
//
// Both used to return `permanent-failure`, and a caller deciding whether to WAIT read that as "no
// operator act inside IMS can ever change this". True of one of them, false of the other:
//
//   a PARK on another order is exactly what o3d-54p's "Wrong order" recovery moves (merged, PR
//   #640). It asks WooCommerce whether the refund is on the named order right now and, if it is,
//   reassigns the park as PENDING — the one actionable status this sync does not treat as handled —
//   after which the refund is retryable there.
//
//   a SalesOrderRefund that ALREADY EXISTS on another order is a created record. There is no park
//   to move, a WooCommerce refund id maps to one order, and nothing in IMS makes it this order's.
//
// The refusals themselves are unchanged — failing closed automatically is right in both cases, and
// `refundOutcomeFailed` is still true of both. What changed is only which of them
// `refundMayStillReachIms` answers TRUE for.
// ---------------------------------------------------------------------------

test('o3d-xnwu r6: a park owned by another order is RESOLVABLE, not terminal', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.syncLogs.push({ id: 'log-r6', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-other', externalId: '7061', status: 'FAILED' } })

  const result = await syncWcRefund(1001, makeRefund({ id: 7061 }), state.dependencies)

  assert.equal(result.outcome, 'cross-order-park-resolvable')
  assert.equal(refundOutcomeFailed(result.outcome), true, 'still a failure the caller reports — that half is unchanged')
  assert.equal(refundIsInIms(result.outcome), false, 'and nothing is in IMS: the coverage predicate is NOT widened')
  assert.equal(
    refundMayStillReachIms(result.outcome),
    true,
    'THE POINT: the "Wrong order" recovery moves this park, so waiting for it buys something',
  )
  assert.match(result.error ?? '', /Wrong order/, 'and the refusal names the recovery an operator can use')
  assert.equal(state.createRefundCalls, 0, 'the refusal itself is unchanged — nothing is created here')
})

test('o3d-xnwu r6: a QUARANTINED park owned by another order is resolvable too', async () => {
  // Every actionable status is recoverable — RECOVERABLE_REFUND_PARK_STATUSES is exactly the set this
  // guard queries — so the classification must not depend on which one the foreign park happens to be.
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.syncLogs.push({ id: 'log-r6q', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-other', externalId: '7062', status: 'QUARANTINED' } })

  const result = await syncWcRefund(1001, makeRefund({ id: 7062 }), state.dependencies)

  assert.equal(result.outcome, 'cross-order-park-resolvable')
  assert.equal(refundMayStillReachIms(result.outcome), true)
})

test('o3d-xnwu r6: an existing refund on another order stays TERMINAL', async () => {
  // THE FENCE. Without it the change reads as "nothing is ever terminal", which reinstates the
  // endless retry o3d-bx9 removed.
  //
  // (Targeted mutation that fails this: make the `existing.orderId !== so.id` branch return
  // 'cross-order-park-resolvable'.)
  const state = makeDependencies()
  state.refunds.push({ id: 'refund-r6', externalRefundId: 7063, orderId: 'so-other' })

  const result = await syncWcRefund(1001, makeRefund({ id: 7063 }), state.dependencies)

  assert.equal(result.outcome, 'permanent-failure')
  assert.equal(refundOutcomeFailed(result.outcome), true)
  assert.equal(refundIsInIms(result.outcome), false)
  assert.equal(
    refundMayStillReachIms(result.outcome),
    false,
    'there is no park to move and no act inside IMS that makes this refund this order\'s',
  )
})

test('a successful retry RESOLVES this order\'s lingering actionable park (o3d-7yf)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  // This order (so-1) has a FAILED park for refund 7016 from an earlier transient failure.
  state.syncLogs.push({ id: 'log-f', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-1', externalId: '7016', status: 'FAILED' } })

  // The refund now lands (createRefund succeeds — makeDependencies default doesn't refuse).
  const result = await syncWcRefund(1001, makeRefund({ id: 7016 }), state.dependencies)

  assert.equal(refundIsInIms(result.outcome), true, 'the refund landed')
  const park = state.syncLogs.find((log) => (log as { id?: string }).id === 'log-f') as { data: { status: string } }
  assert.equal(park.data.status, 'SYNCED', 'the lingering FAILED park was resolved, not left actionable')
})

test('an already-synced same-order refund resolves its lingering park but leaves QUARANTINED + other orders alone (o3d-7yf)', async () => {
  const state = makeDependencies() // createRefund succeeds by default, but we seed an existing refund directly
  // Refund 7017 already exists on THIS order, with a leftover FAILED park (post-commit step had failed once).
  state.refunds.push({ id: 'refund-e', externalRefundId: 7017, orderId: 'so-1' })
  state.syncLogs.push({ id: 'p-mine', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-1', externalId: '7017', status: 'FAILED' } })
  // Unrelated parks that MUST stay untouched: a QUARANTINED for the same refund on another order, and a
  // different refund's FAILED park on another order.
  state.syncLogs.push({ id: 'p-q-other', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-other', externalId: '7017', status: 'QUARANTINED' } })
  state.syncLogs.push({ id: 'p-other', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-other', externalId: '9999', status: 'FAILED' } })

  const result = await syncWcRefund(1001, makeRefund({ id: 7017 }), state.dependencies)

  assert.equal(refundIsInIms(result.outcome), true, 'already-synced same-order refund reports success')
  assert.equal(state.createRefundCalls, 0, 'no new refund created for the already-synced id')
  const byId = (id: string) => (state.syncLogs.find((l) => (l as { id?: string }).id === id) as { data: { status: string } }).data.status
  assert.equal(byId('p-mine'), 'SYNCED', 'this order\'s lingering FAILED park was resolved')
  assert.equal(byId('p-q-other'), 'QUARANTINED', 'the other order\'s QUARANTINED park is untouched')
  assert.equal(byId('p-other'), 'FAILED', 'an unrelated refund\'s park on another order is untouched')
})

test('a refund that LANDS concurrently (seen under the per-refund lock) is not also parked (o3d-ee9)', async () => {
  // alwaysMissExistingRefund makes the PREFLIGHT existing-refund check miss (as if the refund had not yet
  // committed when we read it), while the in-transaction re-read under the per-refund advisory lock DOES see
  // it — simulating a refund CREATE committing on the order between preflight and the park write.
  const state = makeDependencies({ alwaysMissExistingRefund: true, refuseWithQuarantine: true })
  state.refunds.push({ id: 'refund-c', externalRefundId: 7018, orderId: 'so-1' })

  const result = await syncWcRefund(1001, makeRefund({ id: 7018 }), state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true, 'the refusal still surfaces')
  const parks = state.syncLogs.filter((log) => (log as { data?: { externalId?: string } }).data?.externalId === '7018')
  assert.equal(parks.length, 0, 'no park was written because the refund had already landed under the lock')
})

// ---------------------------------------------------------------------------
// o3d-w00 Codex r6 #1: an ITEMISED WooCommerce shipping refund.
//
// This is the route a storefront shipping refund actually arrives by, and it is NOT the monetary-only
// route the basis checks above guard. The amount is already NET here — WooCommerce reports
// `shipping_lines[].total` ex-tax with `total_tax` beside it — so no gross->net conversion draws
// attention to the rate, and the divergence lands entirely on the credit note's TOTAL: the line is
// unlinked, so createSalesOrderRefund posts it under the ORDER-DEFAULT VAT identity and the connector
// grosses the stored net up by whatever that code carries.
// ---------------------------------------------------------------------------

/**
 * An order whose SHIPPING was taxed unlike BOTH its goods and its header default — the only shape in
 * which the three figures can be told apart, and the one the earlier fixtures on this branch could not
 * express because they taxed shipping at the header rate.
 *
 * £50.00 of 20% goods bearing £10.00 of VAT, and £10.00 of postage bearing NOTHING (zero-rated
 * delivery). Net 60.00 + VAT 10.00 = 70.00 gross, and the order's VAT is its lines' VAT exactly,
 * because the postage carried none. `taxRateName` is "UK Standard Rate" — order-import names the order
 * after the standard rate among its tax lines whether or not the postage bore it — so the credit note
 * for that postage would post under OUTPUT2 at 20%.
 */
const ZERO_RATED_POSTAGE_ORDER: OrderDouble = {
  currency: 'GBP',
  taxRateName: 'UK Standard Rate',
  totalBase: 70,
  taxBase: 10,
  taxRatePercent: 0.2,
  shippingBase: 10,
  shippingForeign: 10,
  taxForeign: 10,
  lines: [{
    id: 'line-1',
    productId: 'product-1',
    externalLineItemId: 501,
    description: 'Widget',
    qty: 1,
    totalBase: 50,
    taxBase: 10,
    taxRate: { rate: 0.2, reverseCharge: false },
  }],
}

/** The mirror: £50.00 of ZERO-rated goods and £10.00 of postage that DID bear 20% (£2.00). */
const TAXED_POSTAGE_ORDER: OrderDouble = {
  currency: 'GBP',
  taxRateName: 'UK Standard Rate',
  totalBase: 62,
  taxBase: 2,
  taxRatePercent: 0.2,
  shippingBase: 10,
  shippingForeign: 10,
  taxForeign: 2,
  lines: [{
    id: 'line-1',
    productId: 'product-1',
    externalLineItemId: 501,
    description: 'Book',
    qty: 1,
    totalBase: 50,
    taxBase: 0,
    taxRate: { rate: 0, reverseCharge: false },
  }],
}

function shippingRefundLine(total: string, totalTax: string) {
  return { id: 9001, method_title: 'Royal Mail', method_id: 'flat_rate', total, total_tax: totalTax, taxes: [] }
}

test('the fixtures tax shipping unlike the goods AND unlike the header (o3d-w00 Codex r6 #1)', () => {
  // A fixture where the header rate, the goods rate and the shipping rate are the same number cannot
  // tell which of the three production read — every earlier order double on this branch was that
  // fixture. In each of these shipping is taxed unlike the goods; ACROSS the pair the two shipping
  // rates differ while the header rate is the same 20% in both, so no reading of the header (and none
  // of the goods) could produce the opposite verdicts the two refund tests below assert.
  const shippingRateOf = (order: OrderDouble) => {
    const linesNet = order.lines.reduce((sum, line) => sum + line.totalBase, 0)
    const linesVat = order.lines.reduce((sum, line) => sum + line.taxBase, 0)
    assert.equal(linesNet + order.shippingBase + order.taxBase, order.totalBase, 'the money adds up')
    assert.notEqual((order.taxBase - linesVat) / order.shippingBase, order.lines[0].taxRate!.rate, 'shipping is taxed unlike the goods')
    return (order.taxBase - linesVat) / order.shippingBase
  }

  assert.equal(shippingRateOf(ZERO_RATED_POSTAGE_ORDER), 0, 'postage bearing nothing on 20% goods')
  assert.equal(shippingRateOf(TAXED_POSTAGE_ORDER), 0.2, 'postage bearing 20% on zero-rated goods')
  assert.equal(ZERO_RATED_POSTAGE_ORDER.taxRatePercent, TAXED_POSTAGE_ORDER.taxRatePercent, 'one header rate, two shipping rates')
  assert.equal(ZERO_RATED_POSTAGE_ORDER.taxRateName, TAXED_POSTAGE_ORDER.taxRateName, 'and one order-default identity')
})

test('an itemised refund states the VAT WooCommerce returned on EVERY line (o3d-w00 Codex r7 #1/#5)', async () => {
  // £50.00 of goods + £10.00 of VAT on them, and the £10.00 of postage that bore none: £70.00 returned.
  // What this sync owes the writer's posted-VAT fence is the one fact only WooCommerce has — the VAT it
  // states it returned on each refunded line — and it owes it for the SALE line as much as the shipping
  // one. r6 stated it for shipping alone, so a zero-rated GOODS line falling back to a 20% order default
  // went to the ledger with nothing to check it against, which is the identical defect one column over.
  const state = makeDependencies({ alwaysMissExistingRefund: true, order: ZERO_RATED_POSTAGE_ORDER })
  const refund = makeRefund({
    id: 7401,
    amount: '70.00',
    line_items: [{
      id: 601, name: 'Widget', product_id: 10, variation_id: 0, quantity: -1, tax_class: '',
      subtotal: '-50.00', subtotal_tax: '-10.00', total: '-50.00', total_tax: '-10.00', sku: 'WIDGET',
      meta_data: [{ id: 1, key: '_refunded_item_id', value: '501' }], refund_total: 50,
    }],
    shipping_lines: [shippingRefundLine('-10.00', '0.00')],
  })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.deepEqual(result, { outcome: 'applied' })
  assert.deepEqual(
    state.createRefundLines.map((line) => ({
      lineKind: line.lineKind,
      totalForeign: line.totalForeign,
      chargedTaxForeign: line.chargedTaxForeign,
    })),
    [
      // The goods: £50.00 net bearing the £10.00 of VAT WooCommerce returned with it.
      { lineKind: 'sale', totalForeign: 50, chargedTaxForeign: 10 },
      // The postage: £10.00 net that bore NOTHING. Stating the zero is the whole point — an absent
      // figure would leave the fence deriving the rate from the order's residue instead, and a stated
      // zero is what makes "this money bore no VAT" a fact rather than a missing read.
      { lineKind: 'shipping', totalForeign: 10, chargedTaxForeign: 0 },
    ],
  )
})

test('an itemised shipping refund at the rate its credit will post at is recorded (o3d-w00 Codex r6 #1)', async () => {
  // The mirror image, and the one a check reading the order's GOODS would have refused for nothing:
  // zero-rated goods with standard-rated postage. WooCommerce returned £10.00 of postage plus the
  // £2.00 of VAT it bore; the credit note posts under OUTPUT2 at 20% and comes to exactly that.
  const state = makeDependencies({ alwaysMissExistingRefund: true, order: TAXED_POSTAGE_ORDER })
  const refund = makeRefund({
    id: 7402,
    amount: '12.00',
    line_items: [],
    shipping_lines: [shippingRefundLine('-10.00', '-2.00')],
  })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.deepEqual(result, { outcome: 'applied' })
  assert.equal(state.createRefundCalls, 1)
  // Stored NET, as an unlinked shipping line — the shape the credit note re-grosses.
  assert.deepEqual(
    state.createRefundLines.map((line) => ({ productId: line.productId, totalForeign: line.totalForeign })),
    [{ productId: null, totalForeign: 10 }],
  )
})

test("the writer's posted-VAT refusal is QUARANTINED, and says the units are not back (o3d-w00 Codex r7 #3/#5)", async () => {
  // The refusal itself now belongs to createSalesOrderRefund (it is the operation, not this caller), so
  // what this sync is responsible for is what it does with one: park it QUARANTINED rather than FAILED
  // (a retry re-runs the identical decision), keep the payload the Record-manually path reconciles
  // against, and say what became of the GOODS. The money is on the storefront and reconciles; the units
  // are simply not on hand, and nothing else in the system will ever mention them.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: ZERO_RATED_POSTAGE_ORDER,
    refuseWithQuarantine: true,
  })
  const refund = makeRefund({
    id: 7403,
    amount: '70.00',
    line_items: [{
      id: 601, name: 'Widget', product_id: 10, variation_id: 0, quantity: -2, tax_class: '',
      subtotal: '-50.00', subtotal_tax: '-10.00', total: '-50.00', total_tax: '-10.00', sku: 'WIDGET',
      meta_data: [{ id: 1, key: '_refunded_item_id', value: '501' }], refund_total: 50,
    }],
    shipping_lines: [shippingRefundLine('-10.00', '0.00')],
  })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(refundOutcomeFailed(result.outcome), true)
  const park = state.syncLogs.map((log) => (log as { data: Record<string, unknown> }).data).at(-1)
  assert.equal(park?.status, 'QUARANTINED')
  assert.equal(park?.externalId, '7403')
  assert.equal((park?.payload as { id?: number })?.id, 7403)
  // The units, counted from the refund's own SALE lines — shipping carries none and must not inflate it.
  assert.match(String(park?.errorMessage), /returned 2 unit\(s\), which are NOT back on hand/)
  assert.match(String(park?.errorMessage), /recording it manually restocks them/)
  assert.match(result.error ?? '', /returned 2 unit\(s\), which are NOT back on hand/)
})

test('a monetary-only quarantine claims no units (o3d-w00 Codex r7 #3)', async () => {
  // The counterpart that keeps the sentence honest: a refund with no quantity lines returns no goods, so
  // the park must not tell an operator to expect a restock that nothing will perform.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: ZERO_RATED_POSTAGE_ORDER,
    refuseWithQuarantine: true,
  })
  const refund = makeRefund({ id: 7405, amount: '10.00', line_items: [], shipping_lines: [shippingRefundLine('-10.00', '0.00')] })

  await syncWcRefund(1001, refund, state.dependencies)

  const park = state.syncLogs.map((log) => (log as { data: Record<string, unknown> }).data).at(-1)
  assert.equal(park?.status, 'QUARANTINED')
  assert.doesNotMatch(String(park?.errorMessage), /unit\(s\)/)
})
