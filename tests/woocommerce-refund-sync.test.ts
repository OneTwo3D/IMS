import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { resolveMonetaryRefundVatRate, syncWcRefund, type WcRefundSyncDependencies } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'
import { refundWouldExceedOrderTotal } from '@/lib/domain/sales/o2c-guards'
import { isFullRefundAmount } from '@/lib/domain/sales/refund-thresholds'

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
type OrderDouble = { totalBase: number; taxBase: number; taxRatePercent: number | null }
const DEFAULT_ORDER_DOUBLE: OrderDouble = { totalBase: 15, taxBase: 2.5, taxRatePercent: 0.2 }

function makeDependencies(options: {
  alwaysMissExistingRefund?: boolean
  refuseWithQuarantine?: boolean
  order?: Partial<OrderDouble>
} = {}) {
  const refunds: Array<{ id: string; externalRefundId: number; orderId: string }> = []
  const syncLogs: unknown[] = []
  const activityLogs: unknown[] = []
  const createRefundLines: Array<{ lineId?: string; productId: string | null; totalForeign?: number | null; totalBase?: number }> = []
  let createRefundCalls = 0
  let nextLogId = 1
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
        async findFirst() {
          return {
            id: 'so-1',
            externalOrderNumber: 'WC-1001',
            fxRateToBase: 1,
            ...DEFAULT_ORDER_DOUBLE,
            ...options.order,
            lines: [
              {
                id: 'line-1',
                productId: 'product-1',
                externalLineItemId: 501,
                description: 'Widget',
                qty: 1,
                totalBase: 12.5,
              },
            ],
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
      shoppingSyncLog: shoppingSyncLogMock,
    } as unknown as WcRefundSyncDependencies['db'],
    async createRefund(_orderId, lines, _reason, _returnWarehouseId, createOptions) {
      createRefundCalls += 1
      // Capture the lines. Without this nothing could assert that a refund line was
      // actually LINKED to its IMS order line, which is how the _refunded_item_id bug
      // survived: createRefund was only ever checked for being called.
      createRefundLines.push(...(lines as unknown as Array<{ lineId?: string; productId: string | null; totalForeign?: number | null; totalBase?: number }>))
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

  assert.deepEqual(first, { success: true })
  assert.deepEqual(second, { success: true })
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

  assert.deepEqual(result, { success: true })
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
const TAXABLE_ORDER: Partial<OrderDouble> = { totalBase: 120, taxBase: 20, taxRatePercent: 0.2 }
const TAXABLE_ORDER_NET_TOTAL = 100

test('a monetary-only refund converts gross to net at the FRACTIONAL tax rate, not rate/100 (o3d-w00)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true, order: TAXABLE_ORDER })
  const refund = makeRefund({ amount: '120.00', line_items: [], shipping_lines: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, true)
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
    order: { totalBase: 120, taxBase: 20, taxRatePercent: null },
  })
  const refund = makeRefund({ id: 7101, amount: '120.00', line_items: [], shipping_lines: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, false, 'refused rather than recorded on an undetermined basis')
  assert.match(result.error ?? '', /cannot be converted from gross to net/)
  assert.equal(state.createRefundCalls, 0, 'no refund is created')
  const park = state.syncLogs.at(-1) as { data?: { status?: string; externalId?: string } }
  assert.equal(park?.data?.status, 'QUARANTINED', 'parked as a deliberate refusal, not a retryable failure')
  assert.equal(park?.data?.externalId, '7101')
})

test('a monetary-only refund is refused when the header tax rate does not reconcile with the order VAT (o3d-w00)', async () => {
  // A rate that cannot reproduce the order's own tax (5% against 20 VAT on a 100 net order) is not the
  // rate the credit note will re-gross at, so re-grossing the stored net would not return the amount the
  // customer received. This check is also what independently catches a mis-scaled rate.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: { totalBase: 120, taxBase: 20, taxRatePercent: 0.05 },
  })
  const refund = makeRefund({ id: 7102, amount: '120.00', line_items: [], shipping_lines: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /does not reconcile with its VAT/)
  assert.equal(state.createRefundCalls, 0)
})

test('a monetary-only refund on a NON-taxable order still stores the gross amount unchanged (o3d-w00)', async () => {
  // The fail-closed guard must not block the case where no conversion is owed: with no VAT, net IS gross,
  // and the ceiling/status comparison degenerates to the same basis.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: { totalBase: 100, taxBase: 0, taxRatePercent: null },
  })
  const refund = makeRefund({ id: 7103, amount: '100.00', line_items: [], shipping_lines: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, true, 'an untaxed order needs no rate and must not be quarantined')
  assert.equal(state.createRefundLines[0].totalBase, 100)
})

test('resolveMonetaryRefundVatRate reads taxRatePercent as a fraction and fails closed otherwise (o3d-w00)', async () => {
  // Unit-level pin on the basis resolver itself, so the units cannot regress behind the sync harness.
  const taxed = resolveMonetaryRefundVatRate({ totalBase: 120, taxBase: 20, taxRatePercent: 0.2 })
  assert.equal(taxed.ok, true)
  assert.equal(taxed.ok === true && taxed.vatRate.toNumber(), 0.2, 'the fraction is used as-is')

  // The same order with the rate expressed as a percentage is NOT silently accepted.
  assert.equal(resolveMonetaryRefundVatRate({ totalBase: 120, taxBase: 20, taxRatePercent: 20 }).ok, false)
  assert.equal(resolveMonetaryRefundVatRate({ totalBase: 120, taxBase: 20, taxRatePercent: null }).ok, false)
  assert.equal(resolveMonetaryRefundVatRate({ totalBase: 120, taxBase: 20, taxRatePercent: 0 }).ok, false)

  const untaxed = resolveMonetaryRefundVatRate({ totalBase: 100, taxBase: 0, taxRatePercent: null })
  assert.equal(untaxed.ok, true)
  assert.equal(untaxed.ok === true && untaxed.vatRate.toNumber(), 0)
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

  assert.equal(result.success, false)
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

  assert.equal(result.success, false, 'the mismatch still surfaces')
  const parks = state.syncLogs.filter((log) => (log as { data?: { externalId?: string } }).data?.externalId === '7011')
  assert.equal(parks.length, 0, 'no orphaned park was written for the deleted order')
})

test('syncWcRefund treats external refund unique conflicts as idempotent races', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.dependencies.createRefund = async () => {
    throw externalRefundIdUniqueError()
  }

  const result = await syncWcRefund(1001, makeRefund(), state.dependencies)

  assert.deepEqual(result, { success: true })
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

  assert.equal(result.success, true, result.error)
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

  assert.equal(result.success, true, result.error)
  assert.equal(harness.createRefundLines[0].lineId, 'line-1')
})

test('a refused monetary-only refund is QUARANTINED and not re-attempted on the next delivery (o3d-w00 #2/#5, o3d-iup)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true, refuseWithQuarantine: true })

  const first = await syncWcRefund(1001, makeRefund(), state.dependencies)
  assert.equal(first.success, false, 'the refusal surfaces as a failed sync')

  // It is parked as QUARANTINED (distinct from FAILED), keyed by the WC refund id.
  const parked = state.syncLogs.find((log) => {
    const data = (log as { data?: { status?: string; externalId?: string } }).data
    return data?.status === 'QUARANTINED'
  }) as { data?: { externalId?: string } } | undefined
  assert.ok(parked, 'a QUARANTINED log was written')
  assert.equal(parked?.data?.externalId, String(makeRefund().id), 'keyed by the WC refund id')

  const callsAfterFirst = state.createRefundCalls
  // A duplicate delivery must be skipped by the parked-log dedup — no re-refusal loop.
  const second = await syncWcRefund(1001, makeRefund(), state.dependencies)
  assert.equal(second.success, true, 'the parked refund is treated as handled, not retried')
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

  assert.equal(result.success, false)
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

  assert.equal(result.success, false, 'B is NOT silently treated as handled by A\'s quarantined park')
  assert.match(result.error ?? '', /different order/i, 'the cross-order quarantine is surfaced, not swallowed')
})

test('an existing refund for a DIFFERENT order fails closed, not reported as already-synced (o3d-7yf)', async () => {
  const state = makeDependencies()
  // A refund with external id 7014 already exists — but on order so-other, not this order (so-1).
  state.refunds.push({ id: 'refund-x', externalRefundId: 7014, orderId: 'so-other' })

  const result = await syncWcRefund(1001, makeRefund({ id: 7014 }), state.dependencies)

  assert.equal(result.success, false, 'not silently treated as already-synced for this order')
  assert.match(result.error ?? '', /different order/i, 'the cross-order existing refund is surfaced')
  assert.equal(state.createRefundCalls, 0, 'no refund was created on this order')
})

test('a PENDING park for a DIFFERENT order blocks applying the same refund here (o3d-7yf)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.syncLogs.push({ id: 'log-p', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-other', externalId: '7015', status: 'PENDING' } })

  const result = await syncWcRefund(1001, makeRefund({ id: 7015 }), state.dependencies)

  assert.equal(result.success, false, 'a PENDING park owned by another order fails closed too')
  assert.match(result.error ?? '', /different order/i)
  assert.equal(state.createRefundCalls, 0, 'no refund created on this order while another order holds the park')
})

test('a successful retry RESOLVES this order\'s lingering actionable park (o3d-7yf)', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  // This order (so-1) has a FAILED park for refund 7016 from an earlier transient failure.
  state.syncLogs.push({ id: 'log-f', data: { connector: 'woocommerce', direction: 'FROM_CONNECTOR', entityType: 'SalesOrder', entityId: 'so-1', externalId: '7016', status: 'FAILED' } })

  // The refund now lands (createRefund succeeds — makeDependencies default doesn't refuse).
  const result = await syncWcRefund(1001, makeRefund({ id: 7016 }), state.dependencies)

  assert.equal(result.success, true, 'the refund landed')
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

  assert.equal(result.success, true, 'already-synced same-order refund reports success')
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

  assert.equal(result.success, false, 'the refusal still surfaces')
  const parks = state.syncLogs.filter((log) => (log as { data?: { externalId?: string } }).data?.externalId === '7018')
  assert.equal(parks.length, 0, 'no park was written because the refund had already landed under the lock')
})
