import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { fakeFxClient, type FakeFxRow } from '../helpers/fx-fake-client'

/**
 * o3d-q0x56.4 / .16 - markBillPaid (the bill-payment caller of the settlement resolver), driven through the REAL
 * server action.
 *
 *  - a foreign bill whose currency has no rate REFUSES before any write (the paid transition, the retirement and the
 *    BILL_PAYMENT enqueue all share one transaction that is never opened), with a named error;
 *  - a base-currency bill is still 1 and never reads the table;
 *  - `paymentDate` is a YYYY-MM-DD business day: a rate fetched at 09:00 on that day is the one used.
 */

const state = {
  invoiceCurrency: 'USD',
  rates: [] as FakeFxRow[],
  committedPaid: [] as unknown[],
  enqueuedTx: [] as unknown[],
  fxJournals: [] as Array<{ payload: Record<string, unknown> }>,
  activity: [] as Array<{ action: string; metadata?: Record<string, unknown> }>,
  transactions: 0,
  rateReads: 0,
}

mock.module('@/lib/auth', {
  namedExports: {
    auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: 'ADMIN', supplierId: null, sessionInvalidReason: null, totpEnabled: false, totpVerified: false } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP', resolveBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (entry: { action: string; metadata?: Record<string, unknown> }) => { state.activity.push(entry) },
    logActivityPersisted: async () => true,
  },
})
const settings = { syncEnabled: true, connector: 'xero', accountsPayableAccount: '800', realisedFxGainLossAccount: '810', unrealisedFxGainLossAccount: '811' }
mock.module('@/lib/accounting', {
  namedExports: {
    listAccountingBankAccountsWithChart: async () => ({ connector: 'xero', accounts: [{ id: 'BANK-1', code: null, name: 'Bank' }] }),
    listAccountingBankAccounts: async () => [],
    getAccountingSettings: async () => settings,
    getAccountingSettingsFor: async () => settings,
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero', name: 'xero' }),
    isAccountingSyncTypeEnabled: async () => true,
    asRoutableAccountingConnector: (value: string | null | undefined) => (value === 'xero' || value === 'quickbooks' ? value : null),
    queueAccountingSync: async (params: { type: string; payload: Record<string, unknown> }) => {
      if (params.type === 'REALISED_FX_JOURNAL') state.fxJournals.push(params)
      return { queued: true, connector: 'xero' }
    },
    queueAccountingSyncTx: async (_tx: unknown, params: unknown) => { state.enqueuedTx.push(params); return true },
  },
})

function transactionClient(pending: Array<() => void>) {
  const fx = fakeFxClient(state.rates)
  return {
    accountingSyncLog: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    purchaseInvoice: {
      updateMany: async (args: { data?: unknown }) => { pending.push(() => state.committedPaid.push(args.data)); return { count: 1 } },
    },
    fxRate: {
      groupBy: async (args: never) => { state.rateReads++; return fx.fxRate.groupBy(args) },
      findMany: async (args: never) => fx.fxRate.findMany(args),
    },
    activityLog: { create: async () => ({ id: 'a-1' }) },
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      purchaseInvoice: {
        findUnique: async () => ({
          id: 'inv-1', poId: 'po-1', invoiceNumber: 'BILL-1', totalForeign: new Prisma.Decimal('100'), totalBase: new Prisma.Decimal('80'),
          fxRateToBase: new Prisma.Decimal('1.25'), paidAt: null, accountingInvoiceId: 'XERO-BILL-1', accountingInvoiceConnector: 'xero',
          po: { reference: 'PO-1', currency: state.invoiceCurrency },
        }),
      },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        state.transactions++
        const pending: Array<() => void> = []
        const result = await fn(transactionClient(pending))
        for (const apply of pending) apply()
        return result
      },
    },
  },
})

async function pay(paymentDate = '2026-08-20') {
  const { markBillPaid } = await import('@/app/actions/purchase-orders')
  return markBillPaid('inv-1', { bankAccountId: 'BANK-1', paymentDate })
}

test.beforeEach(() => {
  state.invoiceCurrency = 'USD'
  state.rates = []
  state.committedPaid = []
  state.enqueuedTx = []
  state.fxJournals = []
  state.activity = []
  state.transactions = 0
  state.rateReads = 0
})

const usd = (rate: string, at: string): FakeFxRow => ({ fromCurrency: 'GBP', toCurrency: 'USD', rate, fetchedAt: new Date(at) })

test('a foreign bill with NO rate is refused before any write, by name, and tells the operator what to do', async () => {
  const result = await pay()
  assert.equal(result.success, false)
  assert.match(String(result.error), /Bill not marked as paid/)
  assert.match(String(result.error), /Missing GBP FX rate for USD/)
  assert.match(String(result.error), /Settings -> Currencies/)
  assert.equal(state.committedPaid.length, 0, 'the bill is NOT marked paid')
  assert.equal(state.enqueuedTx.length, 0, 'no BILL_PAYMENT enqueued')
  assert.equal(state.fxJournals.length, 0, 'no realised-FX journal')
  assert.equal(state.transactions, 1, 'only the read-only rate transaction was opened; the paid-transition transaction never started')
  const logged = state.activity.find((a) => a.action === 'bill_payment_refused_missing_fx_rate')
  assert.equal(logged?.metadata?.reason, 'no_rate')
})

test('a rate that exists only AFTER the payment date is still missing (the lookup is as of the payment day)', async () => {
  state.rates = [usd('1.30', '2026-08-21T00:00:00.000Z')]
  const result = await pay('2026-08-20')
  assert.equal(result.success, false)
  assert.equal(state.committedPaid.length, 0)
})

test('an unusable stored rate (zero) refuses too, by its own reason', async () => {
  state.rates = [usd('0', '2026-08-19T00:00:00.000Z')]
  const result = await pay()
  assert.equal(result.success, false)
  assert.match(String(result.error), /not a positive number/)
  assert.equal(state.committedPaid.length, 0)
})

test('a BASE-currency bill is still paid, at 1, without reading the rate table', async () => {
  state.invoiceCurrency = 'GBP'
  const result = await pay()
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(state.committedPaid.length, 1)
  assert.equal(state.rateReads, 0)
  assert.equal(state.fxJournals.length, 0, 'no FX exposure in the base currency')
})

test('[q0x56.16] a rate fetched at 09:00 ON the payment date is the settlement rate for a date-only paymentDate', async () => {
  // new Date('2026-08-20') is midnight, which is BEFORE 09:00, so the pre-fix lookup could not see this row.
  state.rates = [usd('1.25', '2026-08-19T09:00:00.000Z'), usd('1.60', '2026-08-20T09:00:00.000Z')]
  const result = await pay('2026-08-20')
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(state.fxJournals.length, 1)
  assert.equal(state.fxJournals[0].payload.settlementRateToBase, 1.6, 'the same-day 09:00 rate, not the previous day')
  assert.equal(state.committedPaid.length, 1)
})

test('[q0x56.16] a rate fetched the NEXT day never leaks into a date-only payment', async () => {
  state.rates = [usd('1.30', '2026-08-19T09:00:00.000Z'), usd('1.99', '2026-08-21T00:00:00.000Z')]
  const result = await pay('2026-08-20')
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(state.fxJournals[0].payload.settlementRateToBase, 1.3)
})
