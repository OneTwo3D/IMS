import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  syncWcRefund,
  WC_REFUND_SUPPRESSED_BY_CHARGEBACK,
  type WcRefundSyncDependencies,
} from '@/lib/connectors/woocommerce/sync/refund-sync'
import type { WcRefund } from '@/lib/connectors/woocommerce/sync/types'
import { adapterUniqueViolation } from '@/tests/helpers/prisma-unique-error'

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

// o3d-5od: the REAL @prisma/adapter-pg shape (no meta.target, quoted column).
function externalRefundIdUniqueError() {
  return adapterUniqueViolation(['externalRefundId'], {
    modelName: 'SalesOrderRefund',
    constraintName: 'sales_order_refunds_externalRefundId_key',
  })
}

function makeDependencies(options: { alwaysMissExistingRefund?: boolean; refuseWithQuarantine?: boolean } = {}) {
  const refunds: Array<{ id: string; externalRefundId: number }> = []
  const syncLogs: unknown[] = []
  const activityLogs: unknown[] = []
  const createRefundLines: Array<{ lineId?: string; productId: string | null; totalForeign?: number | null; totalBase?: number }> = []
  let createRefundCalls = 0
  let nextLogId = 1

  const dependencies: WcRefundSyncDependencies = {
    db: {
      salesOrder: {
        async findFirst() {
          return {
            id: 'so-1',
            externalOrderNumber: 'WC-1001',
            fxRateToBase: 1,
            totalBase: 12.5,
            taxRatePercent: 20,
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
      shoppingSyncLog: {
        async findFirst(args: { where?: { externalId?: string; entityType?: string; status?: string | { in?: string[] } } }) {
          const where = args?.where ?? {}
          const statuses = typeof where.status === 'object' ? where.status.in : (where.status != null ? [where.status] : null)
          // Newest-first (orderBy createdAt desc) — scan from the end.
          for (let i = syncLogs.length - 1; i >= 0; i--) {
            const d = (syncLogs[i] as { data?: { externalId?: string; entityType?: string; status?: string } }).data
            if (
              (where.externalId == null || d?.externalId === where.externalId) &&
              (where.entityType == null || d?.entityType === where.entityType) &&
              (statuses == null || (d?.status != null && statuses.includes(d.status)))
            ) {
              return syncLogs[i]
            }
          }
          return null
        },
        async create(args: { data: Record<string, unknown> }) {
          const row = { id: `log-${nextLogId++}`, data: args.data }
          syncLogs.push(row)
          return row
        },
        async update(args: { where: { id: string }; data: Record<string, unknown> }) {
          const row = syncLogs.find((r) => (r as { id?: string }).id === args.where.id) as { data: Record<string, unknown> } | undefined
          if (row) row.data = { ...row.data, ...args.data }
          return row
        },
        // o3d-6oyu.18: the chargeback-suppression path dedups its warning on the marker
        // message, so `order.updated` re-runs don't re-log it forever.
        async findFirst(args: { where?: { externalId?: string; errorMessage?: string } }) {
          const match = (syncLogs as Array<{ data: { externalId?: string; errorMessage?: string } }>).find((log) => (
            (args.where?.externalId === undefined || log.data.externalId === args.where.externalId) &&
            (args.where?.errorMessage === undefined || log.data.errorMessage === args.where.errorMessage)
          ))
          return match ? { id: 'sync-log-1' } : null
        },
      },
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

test('o3d-6oyu.18: a WC refund refused because the order was already charged back is handled, not dead-lettered', async () => {
  // The reverse ordering of the concurrent double-reversal race: the payment poller's
  // chargeback committed first, so the refund transaction refuses this credit note with
  // conflict: 'prior-chargeback'. A FAILED sync log here would dead-letter the delivery
  // into the exceptions inbox and retry it forever against a condition that never clears.
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.dependencies.createRefund = async () => ({
    success: false,
    conflict: 'prior-chargeback' as const,
    error: 'Order was already charged back (credit note CN-0009) — a second credit note would double-reverse it; reconcile this refund manually.',
  })

  const result = await syncWcRefund(1001, makeRefund(), state.dependencies)

  assert.deepEqual(result, { success: true })
  assert.equal(state.syncLogs.length, 1)
  const logged = state.syncLogs[0] as { data: { status: string; errorMessage: string } }
  assert.equal(logged.data.status, 'SYNCED', 'not FAILED — this must not dead-letter')
  assert.equal(logged.data.errorMessage, WC_REFUND_SUPPRESSED_BY_CHARGEBACK)
  assert.equal(state.activityLogs.length, 1)
  const activity = state.activityLogs[0] as { action: string; level: string; description: string }
  assert.equal(activity.action, 'refund_sync_suppressed_by_chargeback')
  // o3d-1sc3: this fixture's refund carries a QUANTITY line, so goods came back and an
  // inventory movement is owed — that is an ERROR needing action, not a WARNING recording
  // what happened. A monetary-only suppression stays WARNING (covered below).
  assert.equal(activity.level, 'ERROR', 'operator-visible: stock is owed and not yet back on hand')
  assert.match(activity.description, /CN-0009/)
})

test('o3d-6oyu.18: the chargeback-suppression warning is logged once, not on every order.updated re-run', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.dependencies.createRefund = async () => ({
    success: false,
    conflict: 'prior-chargeback' as const,
    error: 'Order was already charged back (credit note CN-0009).',
  })

  await syncWcRefund(1001, makeRefund(), state.dependencies)
  await syncWcRefund(1001, makeRefund(), state.dependencies)
  await syncWcRefund(1001, makeRefund(), state.dependencies)

  assert.equal(state.syncLogs.length, 1)
  assert.equal(state.activityLogs.length, 1)
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

// ---------------------------------------------------------------------------
// o3d-1sc3 — a chargeback suppresses the CREDIT NOTE, never the STOCK RETURN.
//
// The chargeback path performs no restock because it assumes the customer kept the
// goods. A WooCommerce refund carrying QUANTITY lines says the opposite. Marking the
// whole delivery SYNCED on the strength of the financial conflict therefore absorbed a
// real inventory movement: stock stayed understated permanently while webhook retries
// and the exceptions inbox both considered it handled.
// ---------------------------------------------------------------------------

test('o3d-1sc3: a suppressed refund covering units escalates to ERROR and names the stock owed', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.dependencies.createRefund = async () => ({
    success: false,
    conflict: 'prior-chargeback' as const,
    error: 'Order was already charged back (credit note CN-0009).',
  })

  const result = await syncWcRefund(1001, makeRefund(), state.dependencies)

  assert.deepEqual(result, { success: true }, 'still not dead-lettered')

  const activity = state.activityLogs[0] as {
    level: string
    description: string
    metadata: Record<string, unknown>
  }
  // The chargeback path performs no restock, so a quantity-bearing refund may owe an
  // inventory movement nothing else will make. That needs action, not a note.
  assert.equal(activity.level, 'ERROR')
  assert.equal(activity.metadata.refundedUnits, 1)
  assert.match(activity.description, /1 unit\(s\)/)
  assert.match(activity.description, /NOT on hand in IMS/)
  assert.match(activity.description, /Verify and adjust stock manually/)
  // It must NOT assert the goods physically came back: a WooCommerce refund line carries a
  // refunded quantity and no received/restocked signal.
  assert.doesNotMatch(activity.description, /returns inbox/)
})

test('o3d-1sc3: a monetary-only suppression stays a WARNING and claims no stock is owed', async () => {
  const state = makeDependencies({ alwaysMissExistingRefund: true })
  state.dependencies.createRefund = async () => ({
    success: false,
    conflict: 'prior-chargeback' as const,
    error: 'Order was already charged back (credit note CN-0009).',
  })

  const monetaryOnly = { ...makeRefund(), line_items: [] }
  const result = await syncWcRefund(1001, monetaryOnly, state.dependencies)

  assert.deepEqual(result, { success: true })
  const activity = state.activityLogs[0] as { level: string; description: string }
  assert.equal(activity.level, 'WARNING', 'nothing returned, nothing owed operationally')
  assert.doesNotMatch(activity.description, /unit\(s\)/)

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
