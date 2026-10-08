import test from 'node:test'
import assert from 'node:assert/strict'

import { ledgerStanding, type LedgerStanding } from '@/lib/domain/accounting/ledger-standing'
import {
  failedUpdateStandingNote,
  collectRejectedAccountingDocumentUpdateWarnings,
  mapRejectedAccountingDocumentUpdateWarning,
  type AccountingSyncWarningClient,
} from '@/lib/domain/accounting/rejected-sync-warnings'

const FAILED_NOTHING_ELSE = { status: 'FAILED', externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: null }

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
          status: 'FAILED',
          externalTransactionId: null,
          settlementBasis: null,
          abandonedBeforeRemoteCall: null,
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
    standing: 'UNKNOWN',
    standingNote: failedUpdateStandingNote('UNKNOWN'),
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
      status: true,
      externalTransactionId: true,
      settlementBasis: true,
      abandonedBeforeRemoteCall: true,
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
    ...FAILED_NOTHING_ELSE,
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
    ...FAILED_NOTHING_ELSE,
  })
  // o3d-1e7sl (D13): no recorded reason is not a recorded REJECTION.
  assert.equal(fallback.errorMessage, 'This invoice update failed and no reason was recorded.')
  assert.doesNotMatch(fallback.errorMessage, /rejected/)
})

test('[o3d-1e7sl D13] a failed update warning carries its STANDING and a note that never says nothing was applied - one row per standing', () => {
  const base = {
    id: 'sync-9', connector: 'xero', type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', referenceId: 'so-1',
    errorMessage: 'boom', retryCount: 1, createdAt: '2026-06-12T11:00:00.000Z',
  }
  const cases: Array<{ standing: LedgerStanding; row: { status: string; externalTransactionId: string | null; settlementBasis: string | null; abandonedBeforeRemoteCall: boolean | null }; says: RegExp }> = [
    { standing: 'UNKNOWN', row: { status: 'FAILED', externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: null }, says: /does not prove nothing was applied/ },
    { standing: 'CONFIRMED_POSTED', row: { status: 'FAILED', externalTransactionId: 'INV-1', settlementBasis: null, abandonedBeforeRemoteCall: null }, says: /already names an accounting document[\s\S]*partly applied/ },
    { standing: 'ASSERTED_POSTED', row: { status: 'FAILED', externalTransactionId: 'INV-2', settlementBasis: 'OPERATOR_ASSERTION', abandonedBeforeRemoteCall: null }, says: /already names an accounting document/ },
    { standing: 'ASSERTED_NOT_POSTED', row: { status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'OPERATOR_ASSERTION', abandonedBeforeRemoteCall: null }, says: /does not prove nothing was applied/ },
    { standing: 'PROVEN_NOT_POSTED', row: { status: 'CANCELLED', externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: true }, says: /does not prove nothing was applied/ },
    { standing: 'LIVE_WORK', row: { status: 'PENDING', externalTransactionId: null, settlementBasis: null, abandonedBeforeRemoteCall: null }, says: /does not prove nothing was applied/ },
  ]
  for (const c of cases) {
    assert.equal(ledgerStanding(c.row), c.standing, `precondition: ${c.standing}`)
    const warning = mapRejectedAccountingDocumentUpdateWarning({ ...base, ...c.row })
    console.log(`# D13 precondition: ${c.standing} => note "${warning.standingNote.slice(0, 48)}..."`)
    assert.equal(warning.standing, c.standing)
    assert.match(warning.standingNote, c.says, c.standing)
    // The one sentence a FAILED row can never support, in any standing.
    assert.doesNotMatch(warning.standingNote, /nothing was posted|was not applied|never reached/i, c.standing)
  }
})
