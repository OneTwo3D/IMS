import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectRejectedAccountingDocumentUpdateWarnings,
  mapRejectedAccountingDocumentUpdateWarning,
  type AccountingSyncWarningClient,
} from '@/lib/domain/accounting/rejected-sync-warnings'

test('collectRejectedAccountingDocumentUpdateWarnings selects failed invoice update rows without payload data', async () => {
  let capturedArgs: unknown
  const client: AccountingSyncWarningClient = {
    accountingSyncLog: {
      async findMany(args) {
        capturedArgs = args
        return [{
          id: 'sync-1',
          connector: 'xero',
          type: 'SALES_INVOICE_UPDATE',
          referenceType: 'SalesOrder',
          referenceId: 'so-1',
          errorMessage: 'Invoice cannot be edited because it is paid in Xero.',
          retryCount: 2,
          createdAt: new Date('2026-06-12T10:00:00.000Z'),
        }]
      },
    },
  }

  const warnings = await collectRejectedAccountingDocumentUpdateWarnings(client, [
    { referenceType: 'SalesOrder', referenceId: 'so-1' },
    { referenceType: 'SalesOrder', referenceId: 'so-1' },
    { referenceType: ' ', referenceId: 'ignored' },
  ])

  assert.deepEqual(warnings, [{
    id: 'sync-1',
    connector: 'xero',
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    errorMessage: 'Invoice cannot be edited because it is paid in Xero.',
    retryCount: 2,
    createdAt: '2026-06-12T10:00:00.000Z',
  }])
  assert.deepEqual(capturedArgs, {
    where: {
      status: 'FAILED',
      type: { in: ['SALES_INVOICE_UPDATE', 'PURCHASE_INVOICE_UPDATE'] },
      OR: [{ referenceType: 'SalesOrder', referenceId: 'so-1' }],
    },
    select: {
      id: true,
      connector: true,
      type: true,
      referenceType: true,
      referenceId: true,
      errorMessage: true,
      retryCount: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
})

test('mapRejectedAccountingDocumentUpdateWarning falls back and truncates error text', () => {
  const warning = mapRejectedAccountingDocumentUpdateWarning({
    id: 'sync-2',
    connector: 'xero',
    type: 'PURCHASE_INVOICE_UPDATE',
    referenceType: 'PurchaseInvoice',
    referenceId: 'pi-1',
    errorMessage: `${'x'.repeat(700)} payload-secret`,
    retryCount: 0,
    createdAt: '2026-06-12T11:00:00.000Z',
  })

  assert.equal(warning.errorMessage.length, 600)
  assert.equal(warning.errorMessage.endsWith('...'), true)
  assert.equal(warning.errorMessage.includes('payload-secret'), false)

  const fallback = mapRejectedAccountingDocumentUpdateWarning({
    id: 'sync-3',
    connector: 'xero',
    type: 'SALES_INVOICE_UPDATE',
    referenceType: 'SalesOrder',
    referenceId: 'so-1',
    errorMessage: null,
    retryCount: 0,
    createdAt: '2026-06-12T11:00:00.000Z',
  })
  assert.equal(fallback.errorMessage, 'The accounting connector rejected this invoice update.')
})
