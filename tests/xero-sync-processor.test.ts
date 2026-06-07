import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findInvoicePaymentsBlockedByEarlierLiveLogs,
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
