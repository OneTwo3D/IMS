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
  // o3d-j625: whose chart the account codes in `payload` came from.
  chartConnector: 'xero' as const,
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

  // o3d-j625: the chart AGREES with the active connector here, so the refusal under test is the
  // unsupported-connector one and not the chart mismatch. A QuickBooks-charted payload offered while
  // QuickBooks is active is exactly the case this test is about.
  await queueSalesInvoiceUpdateForExistingAccountingInvoice({ ...baseParams, chartConnector: 'quickbooks' }, deps)

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

/**
 * o3d-j625 — THE UPDATE'S ACCOUNT CODES AND ITS ROW MUST COME FROM ONE RESOLUTION.
 *
 * `queueSalesInvoiceForOrder` reads `getAccountingSettings()` — which resolves the active connector
 * internally and returns THAT connector's chart — builds the update payload out of those codes, and then
 * calls this helper, which resolved the active connector AGAIN and handed the payload to `queueXeroSync`.
 * Two independent reads: with QuickBooks active the payload is composed with QuickBooks
 * `salesAccount`/`shippingAccount`/`discountAccount`, a switch to Xero commits, and this queued that
 * document as a XERO invoice update. Xero then rejects it, or posts the order's revenue against
 * whatever those codes happen to name in its own chart.
 *
 * Nothing is written on a mismatch, and it is RECORDED: an invoice update is re-derivable from the
 * order, so refusing costs a re-save and writing the wrong one costs a wrong document in a live ledger.
 */

test('[o3d-j625] a payload built from QuickBooks’s chart is NOT queued as a Xero invoice update', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: true,
  })

  // The window: the chart was read while QuickBooks was active, the switch to Xero committed during the
  // payload build, and Xero is what this helper resolves.
  await queueSalesInvoiceUpdateForExistingAccountingInvoice(
    { ...baseParams, chartConnector: 'quickbooks' },
    deps,
  )

  assert.equal(queued.length, 0, 'a QuickBooks-charted document must not be queued to Xero')
  assert.equal(activity.length, 1)
  const refusal = activity[0] as { action: string; description: string; metadata: Record<string, unknown> }
  assert.equal(refusal.action, 'sales_invoice_update_refused_retired_chart')
  assert.match(refusal.description, /NOTHING WAS QUEUED/)
  assert.match(refusal.description, /still OUTSTANDING/)
  assert.equal(refusal.metadata.chartConnector, 'quickbooks')
  assert.equal(refusal.metadata.connector, 'xero')
})

test('[o3d-j625] a payload built while NO connector was active is not queued either', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: true,
  })

  // `chartConnector: null` means the chart read found nothing switched on, so every account code in the
  // payload is the empty-string default. Queueing it would post a document with no accounts on it.
  await queueSalesInvoiceUpdateForExistingAccountingInvoice(
    { ...baseParams, chartConnector: null },
    deps,
  )

  assert.equal(queued.length, 0)
  assert.equal(activity.length, 1)
  assert.equal((activity[0] as { action: string }).action, 'sales_invoice_update_refused_retired_chart')
})

test('[o3d-j625] the refusal is a MISMATCH check, not a new reason to skip Xero: an agreeing chart still queues', async () => {
  const { deps, queued, activity } = makeDeps({
    connector: { id: 'xero', name: 'Xero' },
    enabled: true,
  })

  await queueSalesInvoiceUpdateForExistingAccountingInvoice(baseParams, deps)

  assert.equal(queued.length, 1, 'an Xero-charted update, with Xero active, is queued exactly as before')
  assert.equal((activity[0] as { action: string }).action, 'sales_invoice_update_queued')
})
