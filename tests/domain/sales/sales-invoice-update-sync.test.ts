import test from 'node:test'
import assert from 'node:assert/strict'

import {
  queueSalesInvoiceUpdateForExistingAccountingInvoice,
  type QueueSalesInvoiceUpdateDeps,
} from '@/lib/domain/sales/sales-invoice-update-sync'

function makeDeps(options: {
  connector: Awaited<ReturnType<QueueSalesInvoiceUpdateDeps['getActiveAccountingConnectorInfo']>>
  enabled: boolean
}) {
  const queued: unknown[] = []
  const activity: unknown[] = []
  const deps: QueueSalesInvoiceUpdateDeps = {
    async getActiveAccountingConnectorInfo() {
      return options.connector
    },
    async isAccountingSyncTypeEnabled(type) {
      assert.equal(type, 'SALES_INVOICE_UPDATE')
      return options.enabled
    },
    async queueXeroSync(input) {
      queued.push(input)
    },
    async logActivity(input) {
      activity.push(input)
    },
  }
  return { deps, queued, activity }
}

const baseParams = {
  salesOrderId: 'so-1',
  orderNumber: 'SO-1001',
  accountingInvoiceId: 'xero-invoice-1',
  payload: {
    invoiceNumber: 'INV-SO-1001',
    accountingInvoiceId: 'xero-invoice-1',
    lines: [{ itemCode: 'SKU-1', quantity: 1 }],
  },
  idempotencyKey: 'sales-invoice-update:so-1:xero-invoice-1:abc123',
}

test('queueSalesInvoiceUpdateForExistingAccountingInvoice queues Xero update with idempotency key', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: true,
  })

  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)

  assert.equal(queued.length, 1)
  assert.deepEqual(queued[0], {
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    payload: baseParams.payload,
    idempotencyKey: baseParams.idempotencyKey,
  })
  assert.equal(activity.length, 1)
  assert.deepEqual(activity[0], {
    entityType: 'SALES_ORDER',
    entityId: 'so-1',
    action: 'sales_invoice_update_queued',
    tag: 'accounting',
    level: 'INFO',
    description: 'Queued sales invoice update for SO-1001 against accounting invoice xero-invoice-1',
    metadata: {
      accountingInvoiceId: 'xero-invoice-1',
      orderNumber: 'SO-1001',
      idempotencyKey: baseParams.idempotencyKey,
    },
  })
})

test('queueSalesInvoiceUpdateForExistingAccountingInvoice skips non-Xero connectors with warning activity', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'quickbooks', name: 'QuickBooks' },
    enabled: true,
  })

  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)

  assert.equal(queued.length, 0)
  assert.equal(activity.length, 1)
  assert.deepEqual(activity[0], {
    entityType: 'SALES_ORDER',
    entityId: 'so-1',
    action: 'sales_invoice_update_skipped_unsupported_connector',
    tag: 'accounting',
    level: 'WARNING',
    description: 'Sales invoice update for SO-1001 was not queued because QuickBooks invoice updates are not supported yet',
    metadata: {
      accountingInvoiceId: 'xero-invoice-1',
      orderNumber: 'SO-1001',
      connector: 'quickbooks',
      idempotencyKey: baseParams.idempotencyKey,
    },
  })
})

test('queueSalesInvoiceUpdateForExistingAccountingInvoice silently skips disabled update sync type', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: false,
  })

  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)

  assert.equal(queued.length, 0)
  assert.equal(activity.length, 0)
})
