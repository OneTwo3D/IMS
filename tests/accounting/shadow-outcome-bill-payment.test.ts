import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'

/**
 * A SHADOWED BILL-PAYMENT ENQUEUE IS NOT A QUEUED PAYMENT, AND IS NOT A DECLINE EITHER.
 *
 * DRIVEN THROUGH THE REAL `markBillPaid` ACTION; the enqueue is a double that answers what the real one answers for a
 * producer-side shadow (`queued: false, reason: 'shadowed'`, asserted against the real enqueue in the DB tier).
 *
 * The bill is marked paid in IMS (nothing is owed, so there is no rollback), the activity log says the payment was NOT
 * queued, and `paymentQueued` is false. Before, the shadow answered `queued: true` and the log claimed a queued payment.
 */

const state = {
  invoice: {
    id: 'inv-1', poId: 'po-1', invoiceNumber: 'BILL-1', totalForeign: new Prisma.Decimal('50'), totalBase: new Prisma.Decimal('50'),
    fxRateToBase: new Prisma.Decimal('1'), paidAt: null as Date | null, accountingInvoiceId: 'XERO-BILL-1',
    accountingInvoiceConnector: 'xero' as string | null,
    po: { reference: 'PO-1', currency: 'GBP' },
  },
  chart: 'quickbooks' as 'xero' | 'quickbooks',
  enqueueAnswer: { queued: true, connector: 'quickbooks' } as { queued: boolean; reason?: 'refused' | 'not-configured' | 'shadowed'; connector: string | null },
  enqueued: [] as Array<{ type: string; chartConnector: unknown; documentConnector: unknown; payload: Record<string, unknown> }>,
  committedPaid: [] as unknown[],
  activity: [] as Array<{ action: string; description?: string; metadata?: Record<string, unknown> }>,
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
    logActivity: async (entry: { action: string; description?: string; metadata?: Record<string, unknown> }) => { state.activity.push(entry) },
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
    fxRate: { groupBy: async () => [], findMany: async () => [] },
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
  state.chart = 'xero'
  state.enqueueAnswer = { queued: true, connector: 'xero' }
  state.enqueued = []
  state.committedPaid = []
  state.activity = []
  state.activeSettingsReads = 0
  state.settingsForReads = []
})

test('CONTROL: a queued payment marks the bill paid and the log says paymentQueued', async () => {
  const result = await pay()
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(state.committedPaid.length, 1)
  const record = state.activity.find((a) => a.action === 'bill_paid')
  assert.equal(record?.metadata?.paymentQueued, true)
  assert.equal(record?.metadata?.paymentShadowed, false)
})

test('THE FINDING: a SHADOWED payment registration marks the bill paid in IMS but is NOT reported as queued, and is not a rollback', async () => {
  state.enqueueAnswer = { queued: false, reason: 'shadowed', connector: 'xero' }
  const result = await pay()
  assert.equal(result.success, true, `a shadow owes nothing, so it is not refused: ${JSON.stringify(result)}`)
  assert.equal(state.committedPaid.length, 1, 'the paid transition commits')
  const record = state.activity.find((a) => a.action === 'bill_paid')
  assert.equal(record?.metadata?.paymentQueued, false, 'no payment is on the queue')
  assert.equal(record?.metadata?.paymentShadowed, true)
  assert.match(String(record?.description), /IMS ONLY/)
  assert.equal(state.activity.some((a) => a.action === 'bill_payment_enqueue_declined'), false)
})

test('CONTROL: a genuine decline still rolls the paid transition back (a shadow is not a refusal, and a refusal is not a shadow)', async () => {
  state.enqueueAnswer = { queued: false, reason: 'not-configured', connector: 'xero' }
  const result = await pay()
  assert.equal(result.success, false)
  assert.equal(state.committedPaid.length, 0)
})
