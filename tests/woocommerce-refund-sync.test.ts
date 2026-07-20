import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { syncWcRefund, type WcRefundSyncDependencies } from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'

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

function makeDependencies(options: {
  alwaysMissExistingRefund?: boolean
  order?: { totalBase?: number; taxBase?: number; taxRateName?: string | null }
  /** Extra order lines, used to model a MIXED-rate order. */
  extraLines?: Array<{ id: string; taxRateId: string | null; taxBase: number; totalBase: number }>
  /** Model a store whose Woo tax rates never mapped: lines keep tax amounts but no taxRateId. */
  unmappedTaxRates?: boolean
  /** Force the primary line's NET, so value can be left OUTSIDE the lines (e.g. shipping). */
  lineNetOverride?: number
} = {}) {
  const refunds: Array<{ id: string; externalRefundId: number }> = []
  const syncLogs: unknown[] = []
  const activityLogs: unknown[] = []
  const createRefundLines: Array<{ lineId?: string; productId: string | null; totalBase?: number; qty?: number }> = []
  let createRefundCalls = 0

  const dependencies: WcRefundSyncDependencies = {
    db: {
      salesOrder: {
        async findFirst() {
          return {
            id: 'so-1',
            externalOrderNumber: 'WC-1001',
            fxRateToBase: 1,
            totalBase: options.order?.totalBase ?? 12.5,
            taxBase: options.order?.taxBase ?? 0,
            taxRateName: options.order?.taxRateName !== undefined
              ? options.order.taxRateName
              : ((options.order?.taxBase ?? 0) > 0 ? 'Standard' : null),
            lines: [
              {
                id: 'line-1',
                productId: 'product-1',
                externalLineItemId: 501,
                description: 'Widget',
                qty: 1,
                // Line NET + line tax must account for the whole order gross, or the uniform-tax guard
                // (correctly) refuses: value outside the lines has its own unknown tax treatment.
                totalBase: options.lineNetOverride ?? (options.order ? (options.order.totalBase ?? 0) - (options.order.taxBase ?? 0) - (options.extraLines ?? []).reduce((s, l) => s + l.totalBase, 0) : 12.5),
                // Line tax mirrors the order's, so a taxed order reads as uniformly single-rate.
                taxRateId: options.unmappedTaxRates ? null : ((options.order?.taxBase ?? 0) > 0 ? 'rate-standard' : null),
                taxBase: options.order?.taxBase ?? 0,
                taxRate: options.unmappedTaxRates || (options.order?.taxBase ?? 0) === 0 ? null : { name: 'Standard' },
              },
              ...(options.extraLines ?? []).map((line) => ({
                id: line.id,
                productId: 'product-2',
                externalLineItemId: 502,
                description: 'Other',
                qty: 1,
                totalBase: line.totalBase,
                taxRateId: line.taxRateId,
                taxBase: line.taxBase,
                taxRate: line.taxRateId ? { name: line.taxRateId === 'rate-standard' ? 'Standard' : 'Zero' } : null,
              })),
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
      shoppingSyncLog: {
        async create(args: unknown) {
          syncLogs.push(args)
          return args
        },
      },
    } as unknown as WcRefundSyncDependencies['db'],
    async createRefund(_orderId, lines, _reason, _returnWarehouseId, createOptions) {
      createRefundCalls += 1
      // Capture the lines. Without this nothing could assert that a refund line was
      // actually LINKED to its IMS order line, which is how the _refunded_item_id bug
      // survived: createRefund was only ever checked for being called.
      createRefundLines.push(...(lines as unknown as Array<{ lineId?: string; productId: string | null }>))
      refunds.push({ id: `refund-${refunds.length + 1}`, externalRefundId: createOptions?.externalRefundId ?? 0 })
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

test('syncWcRefund normalises a monetary-only refund to the NET basis on a taxable order (o3d-w00)', async () => {
  // A goodwill refund with no line breakdown: wcRefund.amount is the money actually returned to the
  // customer, i.e. TAX-INCLUSIVE. Every other refund line is stored NET, and the credit note re-applies
  // VAT (lineAmountsIncludeTax: false), so storing the gross here both broke the disposition basis and
  // grossed the amount up a SECOND time — £120 posting as £120 + £24 VAT = £144.
  // Order: £120 gross = £100 net + £20 VAT -> net ratio 100/120.
  const state = makeDependencies({ alwaysMissExistingRefund: true, order: { totalBase: 120, taxBase: 20 } })
  const refund = makeRefund({ amount: '120.00', line_items: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, true)
  assert.equal(state.createRefundLines.length, 1)
  // £120 gross -> £100 net, so the credit note re-grosses to exactly the £120 refunded.
  assert.ok(
    Math.abs((state.createRefundLines[0].totalBase ?? 0) - 100) < 0.01,
    `expected the monetary-only line to be stored NET (100), got ${state.createRefundLines[0].totalBase}`,
  )
})

test('syncWcRefund leaves a monetary-only refund unchanged on a zero-tax order (o3d-w00)', async () => {
  // taxBase 0 -> net ratio 1, so the normalisation is a no-op and the full amount is still recorded.
  const state = makeDependencies({ alwaysMissExistingRefund: true, order: { totalBase: 120, taxBase: 0 } })
  const refund = makeRefund({ amount: '120.00', line_items: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, true)
  assert.ok(
    Math.abs((state.createRefundLines[0].totalBase ?? 0) - 120) < 0.01,
    `expected no change on an untaxed order (120), got ${state.createRefundLines[0].totalBase}`,
  )
})

test('syncWcRefund REFUSES a monetary-only refund on a mixed-rate order (o3d-w00)', async () => {
  // £100 @20% + £100 zero-rated = £220 gross. A bare £110 amount carries no VAT breakdown, and the
  // credit note would post an unmapped line under ONE order-level tax type — so a blended ratio invents
  // a split that is wrong in the ledger AND depends on refund ordering. There is nothing safe to infer,
  // so the sync refuses and asks for line detail rather than guessing.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: { totalBase: 220, taxBase: 20 },
    extraLines: [{ id: 'line-2', taxRateId: 'rate-zero', taxBase: 0, totalBase: 100 }],
  })
  const refund = makeRefund({ amount: '110.00', line_items: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, false)
  assert.match(String(result.error), /tax treatment is not uniform/i)
  // The message must NEVER tell an operator to re-refund: the customer has already been paid, so
  // "re-issue the refund" would pay them twice.
  assert.match(String(result.error), /DO NOT issue another WooCommerce refund/i)
  // Nothing was recorded: no refund created, and the refusal is surfaced for a human.
  assert.equal(state.createRefundCalls, 0)
})

test('syncWcRefund REFUSES a monetary-only refund when tax rates are unmapped (o3d-w00)', async () => {
  // Woo can retain a monetary tax amount on a line whose rate never mapped (taxRateId null). Several
  // null-rate lines are NOT evidence of one uniform rate — they are evidence that we do not know the
  // rates at all, so a mixed-rate order could otherwise slip through and be blended. Fail closed.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: { totalBase: 220, taxBase: 20 },
    unmappedTaxRates: true,
    extraLines: [{ id: 'line-2', taxRateId: null, taxBase: 0, totalBase: 100 }],
  })
  const refund = makeRefund({ amount: '110.00', line_items: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, false)
  assert.match(String(result.error), /tax treatment is not uniform/i)
  assert.equal(state.createRefundCalls, 0)
})

test('syncWcRefund REFUSES a monetary-only refund when untaxed value sits outside the lines (o3d-w00)', async () => {
  // £120 taxable goods (£100 net + £20 VAT) plus £10 ZERO-RATED shipping = £130 gross. Order tax still
  // equals the line tax, so a tax-only reconciliation would call this uniform — but the goods:gross ratio
  // it implies (110/130) would store a £130 refund as £110 net, which the 20% credit-note type re-grosses
  // to £132. Reconciling the whole GROSS against the lines is what catches it.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: { totalBase: 130, taxBase: 20 },
    // Lines cover only the goods (net 100 + tax 20 = 120); the £10 shipping sits outside them.
    lineNetOverride: 100,
  })
  const refund = makeRefund({ amount: '130.00', line_items: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, false)
  assert.match(String(result.error), /tax treatment is not uniform/i)
  assert.equal(state.createRefundCalls, 0)
})

test('syncWcRefund REFUSES when the order default tax rate differs from the lines (o3d-w00)', async () => {
  // A wholly ZERO-RATED order whose order-level default is still standard VAT. The lines are uniform and
  // untaxed, so the ratio is 1 and the full amount would be stored — but the credit note resolves an
  // unmapped line's tax type from the ORDER's taxRateName, so it would add 20% to money that never
  // carried VAT. The rate the credit note WILL use must be the rate we validated, or we refuse.
  const state = makeDependencies({
    alwaysMissExistingRefund: true,
    order: { totalBase: 120, taxBase: 0, taxRateName: 'Standard' },
  })
  const refund = makeRefund({ amount: '120.00', line_items: [] })

  const result = await syncWcRefund(1001, refund, state.dependencies)

  assert.equal(result.success, false)
  assert.match(String(result.error), /tax treatment is not uniform/i)
  assert.equal(state.createRefundCalls, 0)
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

test('syncWcRefund treats external refund unique conflicts as idempotent races', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.dependencies.createRefund = async () => {
    throw externalRefundIdUniqueError()
  }

  const result = await syncWcRefund(1001, makeRefund(), state.dependencies)

  assert.deepEqual(result, { success: true })
  assert.equal(state.syncLogs.length, 1)
  assert.deepEqual(state.syncLogs[0], {
    data: {
      direction: 'FROM_CONNECTOR',
      status: 'SYNCED',
      entityType: 'SalesOrder',
      entityId: 'so-1',
      externalId: '7001',
      errorMessage: 'Duplicate WooCommerce refund delivery deduped by external refund id',
      syncedAt: (state.syncLogs[0] as { data: { syncedAt: Date } }).data.syncedAt,
    },
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
