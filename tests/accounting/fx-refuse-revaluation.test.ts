import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { fakeFxClient, type FakeFxRow } from '../helpers/fx-fake-client'

/**
 * o3d-q0x56.4 / .16 - THE AR/AP REVALUATION RUN (the month-end cron) when a document's currency has no rate.
 *
 * A document with no usable rate is SKIPPED with a named reason, in the run result and in the activity log. It
 * contributes no journal line (so nothing is posted at 1 or at its booked rate), the other documents still post, and
 * a side whose only document was skipped posts no journal at all (not a zero one).
 */

type Row = Record<string, unknown>

const state = {
  rates: [] as FakeFxRow[],
  receivables: [] as Row[],
  payables: [] as Row[],
  enqueued: [] as Array<{ payload: { kind: string; side: string; lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }>; documentCount: number } }>,
  activity: [] as Array<{ action: string; level: string; entityId?: string; metadata?: Record<string, unknown> }>,
  asOfs: [] as Date[],
}

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({
      syncEnabled: true, connector: 'quickbooks',
      accountsReceivableAccount: 'AR', accountsPayableAccount: 'AP', unrealisedFxGainLossAccount: 'UFX', realisedFxGainLossAccount: 'RFX',
    }),
    queueAccountingSync: async (params: { payload: never; chartConnector: unknown }) => {
      state.enqueued.push(params as never)
      return { queued: true, connector: params.chartConnector }
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: { action: string; level: string }) => { state.activity.push(entry as never) } },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: { findMany: async () => [] },
      salesOrder: { findMany: async () => state.receivables },
      purchaseInvoice: { findMany: async () => state.payables },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
        fxRate: {
          groupBy: async (args: { where: { fetchedAt: { lte: Date } } }) => { state.asOfs.push(args.where.fetchedAt.lte); return fakeFxClient(state.rates).fxRate.groupBy(args as never) },
          findMany: async (args: never) => fakeFxClient(state.rates).fxRate.findMany(args),
        },
        activityLog: { create: async () => ({ id: 'a-1' }) },
      }),
    },
  },
})

const DATE = '2026-06-30'
const rate = (currency: string, value: string, at: string): FakeFxRow => ({ fromCurrency: 'GBP', toCurrency: currency, rate: value, fetchedAt: new Date(at) })
const order = (id: string, ref: string, currency: string): Row => ({
  id, orderNumber: ref, externalOrderNumber: null, invoiceNumber: ref, currency,
  totalForeign: 100, totalBase: 80, fxRateToBase: 1.25, payments: [],
})
const bill = (id: string, ref: string, currency: string): Row => ({
  id, invoiceNumber: ref, totalForeign: 100, totalBase: 80, fxRateToBase: 1.25, po: { reference: `PO-${ref}`, currency },
})

async function run() {
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')
  return runArApFxRevaluation({ valuationDate: DATE })
}

test.beforeEach(() => {
  state.rates = []
  state.receivables = []
  state.payables = []
  state.enqueued = []
  state.activity = []
  state.asOfs = []
})

test('one foreign document missing a rate is skipped with its reason while the others post', async () => {
  state.rates = [rate('USD', '1.60', '2026-06-29T12:00:00.000Z')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD'), order('so-chf', 'INV-CHF', 'CHF')]
  const result = await run()

  assert.equal(result.success, true)
  const receivable = state.enqueued.find((e) => e.payload.kind === 'revaluation' && e.payload.side === 'receivable')
  assert.ok(receivable, 'the USD document still posts')
  assert.equal(receivable.payload.documentCount, 1)
  const described = receivable.payload.lines.map((l) => l.description).join(' | ')
  assert.match(described, /INV-USD/)
  assert.doesNotMatch(described, /INV-CHF/, 'the skipped document contributes no journal line')
  // 100 USD booked at 80, now worth 100/1.60 = 62.50: a 17.50 loss, and ONLY that amount is posted
  const amounts = receivable.payload.lines.flatMap((l) => [l.debit ?? 0, l.credit ?? 0]).filter((n) => n > 0)
  assert.deepEqual(amounts, [17.5, 17.5])
  assert.deepEqual(result.skippedNoRate.map((s) => [s.documentId, s.reference, s.currency, s.reason, s.side]), [['so-chf', 'INV-CHF', 'CHF', 'no_rate', 'receivable']])
  assert.match(String(result.reason), /NOT revalued/)
  assert.match(String(result.reason), /INV-CHF CHF: no_rate/)
  const logged = state.activity.filter((a) => a.action === 'unrealised_fx_document_skipped_no_rate')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].level, 'WARNING')
  assert.equal(logged[0].entityId, 'so-chf')
  assert.equal(logged[0].metadata?.reason, 'no_rate')
})

test('nothing is posted at 1: a missing-rate document that would have shown a 20.00 gain at 1 adds no line', async () => {
  // at 1: 100 foreign = 100 base vs 80 booked -> a 20.00 movement. It must not appear anywhere.
  state.receivables = [order('so-chf', 'INV-CHF', 'CHF')]
  const result = await run()
  assert.equal(state.enqueued.length, 0, 'a side whose only document was skipped posts NO journal (not a zero one)')
  assert.equal(result.revalued, 0)
  assert.equal(result.documents, 0)
  assert.equal(result.skippedNoRate.length, 1)
  assert.equal(result.success, true)
})

test('the payable side skips independently of the receivable side', async () => {
  state.rates = [rate('USD', '1.60', '2026-06-29T12:00:00.000Z')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  state.payables = [bill('b-chf', 'BILL-CHF', 'CHF')]
  const result = await run()
  assert.deepEqual(state.enqueued.map((e) => e.payload.side), ['receivable'])
  assert.deepEqual(result.skippedNoRate.map((s) => [s.side, s.reference]), [['payable', 'BILL-CHF']])
})

test('an unusable (zero) stored rate is skipped by its own reason, not valued', async () => {
  state.rates = [rate('USD', '0', '2026-06-29T12:00:00.000Z')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.equal(result.skippedNoRate[0]?.reason, 'non_positive_rate')
})

test('[q0x56.16] the valuation date is a business day: a rate fetched at 09:00 on it is the valuation rate', async () => {
  // new Date('2026-06-30') is midnight, BEFORE 09:00, so the pre-fix lookup used the 29th's 1.25 (no movement at all).
  state.rates = [rate('USD', '1.25', '2026-06-29T09:00:00.000Z'), rate('USD', '1.60', '2026-06-30T09:00:00.000Z'), rate('USD', '2.00', '2026-07-01T00:00:00.000Z')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  const result = await run()
  assert.equal(result.skippedNoRate.length, 0)
  assert.equal(state.asOfs[0].toISOString(), '2026-06-30T23:59:59.999Z')
  const amounts = state.enqueued[0].payload.lines.flatMap((l) => [l.debit ?? 0, l.credit ?? 0]).filter((n) => n > 0)
  assert.deepEqual(amounts, [17.5, 17.5], 'the 09:00 same-day rate (1.60), neither the previous day nor the next')
})

test('a fully-rated run reports no skips and logs nothing', async () => {
  state.rates = [rate('USD', '1.60', '2026-06-29T12:00:00.000Z')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  const result = await run()
  assert.deepEqual(result.skippedNoRate, [])
  assert.doesNotMatch(String(result.reason ?? ''), /NOT revalued/)
  assert.equal(state.activity.filter((a) => a.action === 'unrealised_fx_document_skipped_no_rate').length, 0)
})
