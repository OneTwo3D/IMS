import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * o3d-j625 r3 (Codex HIGH 2) — THE BILL_PAYMENT SITE, DRIVEN THROUGH THE REAL SERVER ACTION.
 *
 * r2 threaded `chartConnector: bankAccountChartConnector` into `markBillPaid` and left the site with no
 * behavioural test. The finding: that chart proves `bankAccountId` (it was validated against that
 * connector's own bank-account list) and proves NOTHING about `invoice.accountingInvoiceId`, which is
 * retained across a connector switch. So after a switch the chart check passes and the bill is committed
 * PAID while a payment is queued against the other ledger's invoice id.
 *
 * WHAT THIS FILE PINS, AND WHAT IT LEAVES TO ITS SIBLING. The enqueue is a double here, so the RULE
 * ("a document id whose provenance disagrees with the chart is refused") is not tested in this file — it
 * is tested against the REAL enqueue in document-id-provenance-routing.test.ts. What only this file can
 * test is the SITE's half:
 *
 *   1. it hands the enqueue the bill's RECORDED provenance (`accountingInvoiceConnector`), `null` when
 *      nothing was recorded — never the chart, never the active connector;
 *   2. when the enqueue REFUSES, the paid transition ROLLS BACK (the double commits a transaction's writes
 *      only if its callback resolves, as Postgres does), and the operator is given the REFUSED wording —
 *      not r2's "posting for this sync type is switched off", a remedy that cannot work.
 */

const state = {
  invoice: {
    id: 'inv-1', poId: 'po-1', invoiceNumber: 'BILL-1', totalForeign: new Prisma.Decimal('50'), totalBase: new Prisma.Decimal('50'),
    fxRateToBase: new Prisma.Decimal('1'), paidAt: null as Date | null, accountingInvoiceId: 'XERO-BILL-1',
    accountingInvoiceConnector: 'xero' as string | null,
    po: { reference: 'PO-1', currency: 'GBP' },
  },
  chart: 'quickbooks' as 'xero' | 'quickbooks',
  enqueueAnswer: { queued: true, connector: 'quickbooks' } as { queued: boolean; reason?: 'refused' | 'not-configured'; connector: string | null },
  enqueued: [] as Array<{ type: string; chartConnector: unknown; documentConnector: unknown; payload: Record<string, unknown> }>,
  committedPaid: [] as unknown[],
  activity: [] as Array<{ action: string; metadata?: Record<string, unknown> }>,
  activeSettingsReads: 0,
  settingsForReads: [] as Array<string | null>,
}

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'ADMIN', supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; metadata?: Record<string, unknown> }) => { state.activity.push(entry) },
    logActivityPersisted: async () => true,
  },
})
mock.module('@/lib/accounting', {
  namedExports: {
    listAccountingBankAccountsWithChart: async () => ({ connector: state.chart, accounts: [{ id: 'BANK-1', code: null, name: 'Bank' }] }),
    listAccountingBankAccounts: async () => [],
    getAccountingSettings: async () => { state.activeSettingsReads++; return { syncEnabled: false, connector: state.chart } },
    // o3d-j625 r4 (SWEEP 1): the realised-FX read after the payment is asked FOR the bank account's chart.
    getAccountingSettingsFor: async (connector: string | null) => { state.settingsForReads.push(connector); return { syncEnabled: false, connector } },
    getActiveAccountingConnectorInfo: async () => ({ id: state.chart, name: state.chart }),
    isAccountingSyncTypeEnabled: async () => true,
    asRoutableAccountingConnector: (value: string | null | undefined) => (value === 'xero' || value === 'quickbooks' ? value : null),
    queueAccountingSync: async () => ({ queued: true, connector: state.chart }),
    queueAccountingSyncTx: async (
      _tx: unknown,
      params: { type: string; chartConnector: unknown; documentConnector?: unknown; payload: Record<string, unknown>; reportOutcome?: (o: unknown) => void },
    ) => {
      state.enqueued.push({ type: params.type, chartConnector: params.chartConnector, documentConnector: params.documentConnector, payload: params.payload })
      params.reportOutcome?.(state.enqueueAnswer)
      return state.enqueueAnswer.queued
    },
  },
})

function transactionClient(pending: Array<() => void>) {
  return {
    accountingSyncLog: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    purchaseInvoice: {
      updateMany: async (args: { data?: unknown }) => { pending.push(() => state.committedPaid.push(args.data)); return { count: 1 } },
    },
    fxRate: { findFirst: async () => null },
    activityLog: { create: async () => ({ id: 'a-1' }) },
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      purchaseInvoice: { findUnique: async () => state.invoice },
      // COMMIT ONLY ON SUCCESS. A double that applied writes as they happened could not tell a rollback
      // from a committed PAID bill, and the whole finding is about which of the two a refusal produces.
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const pending: Array<() => void> = []
        const result = await fn(transactionClient(pending))
        for (const apply of pending) apply()
        return result
      },
    },
  },
})

async function pay() {
  const { markBillPaid } = await import('@/app/actions/purchase-orders')
  return markBillPaid('inv-1', { bankAccountId: 'BANK-1', paymentDate: '2026-08-20' })
}

test.beforeEach(() => {
  state.invoice.accountingInvoiceConnector = 'xero'
  state.chart = 'quickbooks'
  state.enqueueAnswer = { queued: true, connector: 'quickbooks' }
  state.enqueued = []
  state.committedPaid = []
  state.activity = []
  state.activeSettingsReads = 0
  state.settingsForReads = []
})

test('[o3d-j625 r3 HIGH 2] PRECONDITION: an agreeing bill is paid, and the enqueue is handed the bill’s recorded provenance', async () => {
  state.chart = 'xero'
  state.enqueueAnswer = { queued: true, connector: 'xero' }
  const result = await pay()
  assert.equal(result.success, true, `the control succeeds: ${JSON.stringify(result)}`)
  assert.equal(state.enqueued.length, 1)
  assert.equal(state.enqueued[0].type, 'BILL_PAYMENT')
  assert.equal(state.enqueued[0].payload.accountingInvoiceId, 'XERO-BILL-1')
  assert.equal(state.enqueued[0].documentConnector, 'xero')
  assert.equal(state.committedPaid.length, 1, 'the paid transition committed')
})

test('[o3d-j625 r3 HIGH 2] after a switch the site hands the enqueue the INVOICE’s connector, not the bank account’s chart', async () => {
  // The bank account list is QuickBooks' (the connector now active); the bill was linked under Xero.
  state.enqueueAnswer = { queued: false, reason: 'refused', connector: 'quickbooks' }
  await pay()
  assert.equal(state.enqueued.length, 1, 'PRECONDITION: the enqueue was reached')
  assert.equal(state.enqueued[0].chartConnector, 'quickbooks', 'the chart is the bank account’s')
  assert.equal(state.enqueued[0].documentConnector, 'xero', 'and the document provenance is the BILL’s — the two disagree, which is what the enqueue refuses')
})

test('[o3d-j625 r3 HIGH 2] an unrecorded provenance is handed over as null — fail closed, never the active connector', async () => {
  state.invoice.accountingInvoiceConnector = null
  state.enqueueAnswer = { queued: false, reason: 'refused', connector: 'quickbooks' }
  await pay()
  assert.equal(state.enqueued[0].documentConnector, null)
})

test('[o3d-j625 r3 HIGH 2] a REFUSED bill payment rolls the paid transition back and says REFUSED, not "switched off"', async () => {
  state.enqueueAnswer = { queued: false, reason: 'refused', connector: 'quickbooks' }
  const result = await pay()
  assert.equal(result.success, false)
  assert.equal(state.committedPaid.length, 0, 'the bill must NOT be committed PAID with a payment refused')
  assert.match(String(result.error), /cannot establish that the connector now selected is the one holding it/)
  assert.doesNotMatch(String(result.error), /switched off/)
  const record = state.activity.find((a) => a.action === 'bill_payment_enqueue_declined')
  assert.equal(record?.metadata?.declineReason, 'refused')
  assert.equal(record?.metadata?.accountingInvoiceConnector, 'xero')
  assert.equal(record?.metadata?.bankAccountChartConnector, 'quickbooks')
})

test('[o3d-j625 r3 HIGH 2] a NOT-CONFIGURED decline still gets the settings wording — the two are told apart, not merged', async () => {
  state.chart = 'xero'
  state.enqueueAnswer = { queued: false, reason: 'not-configured', connector: null }
  const result = await pay()
  assert.equal(result.success, false)
  assert.equal(state.committedPaid.length, 0)
  assert.match(String(result.error), /switched off/)
})

test('[o3d-j625 r4 SWEEP 1] the realised-FX journal after a bill payment reads the BANK ACCOUNT’S chart, not the active connector’s', async () => {
  state.chart = 'xero'
  state.enqueueAnswer = { queued: true, connector: 'xero' }
  const result = await pay()
  assert.equal(result.success, true, 'PRECONDITION: the payment was recorded, so the FX step was reached')
  assert.deepEqual(state.settingsForReads, ['xero'], 'the FX chart is read FOR the connector the payment was committed under')
  assert.equal(state.activeSettingsReads, 0, 'and not re-resolved')
})
