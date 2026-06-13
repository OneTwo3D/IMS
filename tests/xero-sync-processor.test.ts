import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findInvoicePaymentsBlockedByEarlierLiveLogs,
  findInvoiceUpdatesBlockedByPendingCreate,
  isXeroAccountingOutboxEnabled,
} from '@/lib/connectors/xero/sync-processor'

test('Xero accounting outbox processor feature flag defaults on', () => {
  assert.equal(isXeroAccountingOutboxEnabled(undefined), true)
  assert.equal(isXeroAccountingOutboxEnabled(''), true)
  assert.equal(isXeroAccountingOutboxEnabled('true'), true)
})

test('Xero accounting outbox processor feature flag accepts rollback values', () => {
  assert.equal(isXeroAccountingOutboxEnabled('false'), false)
  assert.equal(isXeroAccountingOutboxEnabled('0'), false)
  assert.equal(isXeroAccountingOutboxEnabled(' off '), false)
})

test('out-of-order INVOICE_PAYMENT entries are blocked by older live logs in one batched lookup', async () => {
  const t1 = new Date('2026-01-01T09:00:00.000Z')
  const t2 = new Date('2026-01-01T10:00:00.000Z')
  const t3 = new Date('2026-01-01T11:00:00.000Z')
  const findManyCalls: unknown[] = []
  const client = {
    accountingSyncLog: {
      findMany: async (args: unknown) => {
        findManyCalls.push(args)
        return [
          { id: 'payment-1', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t1 },
          { id: 'payment-2', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t2 },
          { id: 'payment-3', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t3 },
        ]
      },
    },
  }

  const blocked = await findInvoicePaymentsBlockedByEarlierLiveLogs(client as never, [
    { id: 'payment-3', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t3 },
    { id: 'payment-1', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t1 },
    { id: 'payment-2', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: t2 },
  ])

  assert.deepEqual([...blocked].sort(), ['payment-2', 'payment-3'])
  assert.equal(findManyCalls.length, 1)
  assert.deepEqual(findManyCalls[0], {
    where: {
      connector: 'xero',
      type: 'INVOICE_PAYMENT',
      status: { in: ['PENDING', 'PROCESSING'] },
      OR: [{ referenceType: 'SalesOrder', referenceId: 'order-1' }],
    },
    select: { id: true, referenceType: true, referenceId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
})

test('audit-H5: SALES_INVOICE_UPDATE is deferred while its SALES_INVOICE CREATE is still live', async () => {
  const tCreate = new Date('2026-02-01T09:00:00.000Z')
  const tUpdate = new Date('2026-02-01T10:00:00.000Z')
  const findManyCalls: unknown[] = []
  const client = {
    accountingSyncLog: {
      findMany: async (args: unknown) => {
        findManyCalls.push(args)
        // A live (PENDING) CREATE for the same SalesOrder.
        return [
          { id: 'create-1', type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: tCreate },
        ]
      },
    },
  }

  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'update-1', type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: tUpdate },
  ])
  assert.deepEqual([...blocked], ['update-1'])
  // One batched lookup for the matching CREATE type/reference.
  assert.equal(findManyCalls.length, 1)
  assert.deepEqual(findManyCalls[0], {
    where: {
      connector: 'xero',
      status: { in: ['PENDING', 'PROCESSING'] },
      OR: [{ type: 'SALES_INVOICE', referenceType: 'SalesOrder', referenceId: 'order-1' }],
    },
    select: { id: true, type: true, referenceType: true, referenceId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
})

test('audit-H5: PURCHASE_INVOICE_UPDATE is NOT deferred once its CREATE has posted (no live CREATE)', async () => {
  const client = {
    accountingSyncLog: {
      findMany: async () => [] as unknown[], // CREATE already SYNCED → not live
    },
  }
  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'update-2', type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', referenceId: 'po-1', createdAt: new Date('2026-02-02T10:00:00.000Z') },
  ])
  assert.equal(blocked.size, 0)
})

test('audit-H5: an UPDATE is not blocked by a CREATE for a different document', async () => {
  const client = {
    accountingSyncLog: {
      // Query is OR-filtered by reference, so a CREATE for another order is never returned.
      findMany: async () => [] as unknown[],
    },
  }
  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'update-3', type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'order-9', createdAt: new Date('2026-02-03T10:00:00.000Z') },
  ])
  assert.equal(blocked.size, 0)
})

test('audit-H5: non-update entries are ignored (no lookup)', async () => {
  let called = false
  const client = { accountingSyncLog: { findMany: async () => { called = true; return [] } } }
  const blocked = await findInvoiceUpdatesBlockedByPendingCreate(client as never, [
    { id: 'pay-1', type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', referenceId: 'order-1', createdAt: new Date() },
  ])
  assert.equal(blocked.size, 0)
  assert.equal(called, false)
})
