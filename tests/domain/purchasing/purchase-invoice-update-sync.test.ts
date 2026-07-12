import assert from 'node:assert/strict'
import test from 'node:test'

import {
  maybeQueuePurchaseInvoiceUpdate,
  type PurchaseInvoiceUpdateSyncDeps,
} from '@/lib/domain/purchasing/purchase-invoice-update-sync'

type ActivityLogCreateCall = {
  data: {
    action: string
    level: string
    metadata: {
      invoiceId: string
      accountingInvoiceId: string
      connector: string | null
      idempotencyKey: string
    }
  }
}

function basePayload() {
  return {
    accountingInvoiceId: 'xero-bill-1',
    invoiceNumber: 'PO-1',
    contactName: 'Supplier',
    date: '2026-06-12',
    currency: 'GBP',
    currencyRateToBase: 1,
    lines: [
      {
        description: 'PO PO-1 line',
        quantity: 1,
        unitAmount: 10,
        accountCode: '1400',
      },
    ],
  }
}

function baseParams<Tx extends { activityLog: { create: (input: ActivityLogCreateCall) => Promise<void> } }>(
  tx: Tx,
  deps: PurchaseInvoiceUpdateSyncDeps<Tx>,
) {
  return {
    tx,
    syncEnabled: true,
    invoiceId: 'bill-1',
    poId: 'po-1',
    poReference: 'PO-1',
    accountingInvoiceId: 'xero-bill-1',
    accountingPayload: basePayload(),
    idempotencyKey: 'purchase-invoice-update:hash',
    deps,
  }
}

test('maybeQueuePurchaseInvoiceUpdate queues Xero PURCHASE_INVOICE_UPDATE when enabled', async () => {
  const activityLogCalls: ActivityLogCreateCall[] = []
  const queueCalls: unknown[] = []
  const tx = {
    activityLog: {
      create: async (input: ActivityLogCreateCall) => {
        activityLogCalls.push(input)
      },
    },
  }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero', name: 'Xero' }),
    isAccountingSyncTypeEnabled: async () => true,
    queueAccountingSyncTx: async (_tx, input) => {
      queueCalls.push(input)
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate(baseParams(tx, deps))

  assert.equal(result, 'queued')
  assert.equal(activityLogCalls.length, 0)
  assert.deepEqual(queueCalls, [
    {
      type: 'PURCHASE_INVOICE_UPDATE',
      referenceType: 'PurchaseOrder',
      referenceId: 'po-1',
      payload: basePayload(),
      idempotencyKey: 'purchase-invoice-update:hash',
    },
  ])
})

test('maybeQueuePurchaseInvoiceUpdate logs unsupported connector without queueing', async () => {
  const activityLogCalls: ActivityLogCreateCall[] = []
  const queueCalls: unknown[] = []
  const tx = {
    activityLog: {
      create: async (input: ActivityLogCreateCall) => {
        activityLogCalls.push(input)
      },
    },
  }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    getActiveAccountingConnectorInfo: async () => ({ id: 'quickbooks', name: 'QuickBooks' }),
    isAccountingSyncTypeEnabled: async () => true,
    queueAccountingSyncTx: async (_tx, input) => {
      queueCalls.push(input)
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate(baseParams(tx, deps))

  assert.equal(result, 'skipped-unsupported-connector')
  assert.equal(queueCalls.length, 0)
  assert.equal(activityLogCalls.length, 1)
  assert.equal(activityLogCalls[0]?.data.action, 'purchase_invoice_update_skipped_unsupported_connector')
  assert.equal(activityLogCalls[0]?.data.level, 'WARNING')
  assert.deepEqual(activityLogCalls[0]?.data.metadata, {
    invoiceId: 'bill-1',
    accountingInvoiceId: 'xero-bill-1',
    connector: 'quickbooks',
    idempotencyKey: 'purchase-invoice-update:hash',
  })
})

test('maybeQueuePurchaseInvoiceUpdate skips disabled sync type without warning log', async () => {
  const activityLogCalls: ActivityLogCreateCall[] = []
  const queueCalls: unknown[] = []
  const tx = {
    activityLog: {
      create: async (input: ActivityLogCreateCall) => {
        activityLogCalls.push(input)
      },
    },
  }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero', name: 'Xero' }),
    isAccountingSyncTypeEnabled: async () => false,
    queueAccountingSyncTx: async (_tx, input) => {
      queueCalls.push(input)
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate(baseParams(tx, deps))

  assert.equal(result, 'skipped-disabled')
  assert.equal(queueCalls.length, 0)
  assert.equal(activityLogCalls.length, 0)
})

test('maybeQueuePurchaseInvoiceUpdate skips bills without external accounting id', async () => {
  const activityLogCalls: ActivityLogCreateCall[] = []
  const queueCalls: unknown[] = []
  const tx = {
    activityLog: {
      create: async (input: ActivityLogCreateCall) => {
        activityLogCalls.push(input)
      },
    },
  }
  const deps: PurchaseInvoiceUpdateSyncDeps<typeof tx> = {
    getActiveAccountingConnectorInfo: async () => {
      throw new Error('connector should not be loaded')
    },
    isAccountingSyncTypeEnabled: async () => true,
    queueAccountingSyncTx: async (_tx, input) => {
      queueCalls.push(input)
    },
  }

  const result = await maybeQueuePurchaseInvoiceUpdate({
    ...baseParams(tx, deps),
    accountingInvoiceId: null,
    idempotencyKey: null,
  })

  assert.equal(result, 'skipped-no-external-id')
  assert.equal(queueCalls.length, 0)
  assert.equal(activityLogCalls.length, 0)
})
