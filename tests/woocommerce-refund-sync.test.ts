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

function makeDependencies(options: { alwaysMissExistingRefund?: boolean } = {}) {
  const refunds: Array<{ id: string; externalRefundId: number }> = []
  const syncLogs: unknown[] = []
  const activityLogs: unknown[] = []
  let createRefundCalls = 0

  const dependencies: WcRefundSyncDependencies = {
    db: {
      salesOrder: {
        async findFirst() {
          return {
            id: 'so-1',
            externalOrderNumber: 'WC-1001',
            fxRateToBase: 1,
            totalBase: 12.5,
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
        async create(args: unknown) {
          syncLogs.push(args)
          return args
        },
      },
    } as unknown as WcRefundSyncDependencies['db'],
    async createRefund(_orderId, _lines, _reason, _returnWarehouseId, createOptions) {
      createRefundCalls += 1
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
