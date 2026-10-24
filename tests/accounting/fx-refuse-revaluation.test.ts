import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { fakeFxClient, type FakeFxRow } from '../helpers/fx-fake-client'

/**
 * o3d-q0x56.4 / .16 - THE AR/AP REVALUATION RUN (the month-end cron) when a document's currency has no rate.
 *
 * Every open document's rate is resolved FIRST. If ANY document on a side (AR or AP) has no usable rate, that side is
 * WITHHELD AS A WHOLE: its prior journal is not reversed (the prior valuation stays in force), no new journal is
 * posted for it, and nothing is queued, so a rerun after the rate is added does the side. The other side proceeds.
 */

type Row = Record<string, unknown>
type Enqueued = { payload: { kind: string; side: string; sourceEntryId?: string; lines: Array<{ accountCode: string; description: string; debit?: number; credit?: number }>; documentCount: number } }

const state = {
  rates: [] as FakeFxRow[],
  receivables: [] as Row[],
  payables: [] as Row[],
  logs: [] as Row[],
  enqueued: [] as Enqueued[],
  activity: [] as Array<{ action: string; level: string; entityId?: string; metadata?: Record<string, unknown> }>,
  asOfs: [] as Date[],
}

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({
      syncEnabled: true, connector: 'xero',
      accountsReceivableAccount: 'AR', accountsPayableAccount: 'AP', unrealisedFxGainLossAccount: 'UFX', realisedFxGainLossAccount: 'RFX',
    }),
    queueAccountingSync: async (params: Enqueued & { chartConnector: unknown }) => {
      state.enqueued.push(params)
      // a queued journal is a live work-slot row, exactly what the next run's reads see
      state.logs.push({ id: `log-${state.logs.length + 1}`, type: 'UNREALISED_FX_JOURNAL', status: 'PENDING', connector: 'xero', payload: params.payload })
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
      accountingSyncLog: { findMany: async () => state.logs },
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
const priorJournal = (id: string, side: 'receivable' | 'payable'): Row => ({
  id, type: 'UNREALISED_FX_JOURNAL', status: 'SYNCED', connector: 'xero',
  payload: {
    kind: 'revaluation', side, valuationDate: '2026-05-31',
    lines: [
      { accountCode: side === 'receivable' ? 'AR' : 'AP', description: 'Unrealised FX', debit: 9, credit: 0 },
      { accountCode: 'UFX', description: 'Unrealised FX', debit: 0, credit: 9 },
    ],
  },
})
const amounts = (e: Enqueued) => e.payload.lines.flatMap((l) => [l.debit ?? 0, l.credit ?? 0]).filter((n) => n > 0)
const posted = (kind: string, side?: string) => state.enqueued.filter((e) => e.payload.kind === kind && (!side || e.payload.side === side))

async function run() {
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')
  return runArApFxRevaluation({ valuationDate: DATE })
}

test.beforeEach(() => {
  state.rates = []
  state.receivables = []
  state.payables = []
  state.logs = []
  state.enqueued = []
  state.activity = []
  state.asOfs = []
})

const USD_OK = () => rate('USD', '1.60', '2026-06-29T12:00:00.000Z')

test('[R1 HIGH] a prior AR journal + one AR document now missing a rate: no reversal, no new AR journal, AP still posts', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD'), order('so-chf', 'INV-CHF', 'CHF')]
  state.payables = [bill('b-usd', 'BILL-USD', 'USD')]
  const result = await run()

  assert.equal(result.success, true)
  assert.equal(posted('reversal').length, 0, 'the prior AR valuation is NOT backed out: we cannot replace it')
  assert.equal(posted('revaluation', 'receivable').length, 0, 'and no partial AR journal (the USD order alone) is posted')
  assert.equal(posted('revaluation', 'payable').length, 1, 'the other side proceeds normally')
  assert.deepEqual(amounts(posted('revaluation', 'payable')[0]), [17.5, 17.5])
  assert.deepEqual(result.withheldSides.map((w) => [w.side, w.reason, w.skipped.map((s) => s.reference)]), [['receivable', 'side_withheld_missing_rate', ['INV-CHF']]])
  assert.deepEqual(result.skippedNoRate.map((s) => [s.documentId, s.currency, s.reason, s.side]), [['so-chf', 'CHF', 'no_rate', 'receivable']])
  assert.equal(result.reversed, 0)
  assert.equal(result.revalued, 1)
  assert.match(String(result.reason), /WITHHELD as a whole/)
  assert.match(String(result.reason), /INV-CHF CHF: no_rate/)
  const side = state.activity.filter((a) => a.action === 'unrealised_fx_side_withheld_missing_rate')
  assert.equal(side.length, 1)
  assert.equal(side[0].level, 'WARNING')
  assert.equal(side[0].metadata?.side, 'receivable')
  assert.equal(side[0].metadata?.reason, 'side_withheld_missing_rate')
  assert.equal(state.activity.filter((a) => a.action === 'unrealised_fx_document_skipped_no_rate').length, 1)
})

test('[R1 HIGH] a withheld side does not shield the other side from its own reversal', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable'), priorJournal('prior-ap', 'payable')]
  state.receivables = [order('so-chf', 'INV-CHF', 'CHF')]
  state.payables = [bill('b-usd', 'BILL-USD', 'USD')]
  await run()
  assert.deepEqual(posted('reversal').map((e) => [e.payload.side, e.payload.sourceEntryId]), [['payable', 'prior-ap']])
  assert.equal(posted('revaluation', 'payable').length, 1)
  assert.equal(posted('revaluation', 'receivable').length, 0)
})

test('all rates present: the prior journal is reversed and the replacement posts, as before', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  const result = await run()
  assert.deepEqual(posted('reversal').map((e) => [e.payload.side, e.payload.sourceEntryId]), [['receivable', 'prior-ar']])
  assert.equal(posted('revaluation', 'receivable').length, 1)
  assert.deepEqual(amounts(posted('revaluation', 'receivable')[0]), [17.5, 17.5])
  assert.deepEqual(result.withheldSides, [])
  assert.deepEqual(result.skippedNoRate, [])
  assert.equal(result.reversed, 1)
  assert.equal(result.revalued, 1)
  assert.doesNotMatch(String(result.reason ?? ''), /WITHHELD/)
  assert.equal(state.activity.filter((a) => a.action.startsWith('unrealised_fx_side') || a.action.startsWith('unrealised_fx_document')).length, 0)
})

test('a withheld side is NOT recorded as done: a same-day rerun does it once the rate is added, without redoing the other side', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD'), order('so-chf', 'INV-CHF', 'CHF')]
  state.payables = [bill('b-usd', 'BILL-USD', 'USD')]
  await run()
  assert.equal(posted('revaluation', 'payable').length, 1)
  assert.equal(posted('revaluation', 'receivable').length, 0)

  state.rates.push(rate('CHF', '1.10', '2026-06-30T09:00:00.000Z'))
  state.enqueued = []
  const rerun = await run()
  assert.deepEqual(rerun.withheldSides, [])
  assert.equal(posted('revaluation', 'receivable').length, 1, 'AR is done by the rerun')
  assert.equal(posted('revaluation', 'receivable')[0].payload.documentCount, 2, 'with BOTH documents')
  assert.equal(posted('revaluation', 'payable').length, 0, 'AP, already posted for the date, is not posted twice')
  assert.deepEqual(posted('reversal').map((e) => e.payload.sourceEntryId), ['prior-ar'], 'and the AR prior is reversed now that it can be replaced')

  // a third run has nothing left to do
  state.enqueued = []
  const third = await run()
  assert.equal(state.enqueued.length, 0)
  assert.equal(third.skipped, true)
})

test('a side whose only document has no rate posts no journal at all (not a zero one) and keeps its prior valuation', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable')]
  state.receivables = [order('so-chf', 'INV-CHF', 'CHF')]
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.equal(result.revalued, 0)
  assert.equal(result.reversed, 0)
  assert.equal(result.documents, 0)
  assert.equal(result.skippedNoRate.length, 1)
  assert.equal(result.success, true)
})

test('nothing is posted at 1: a missing-rate document that would have shown a 20.00 movement adds no line anywhere', async () => {
  state.rates = [USD_OK()]
  state.receivables = [order('so-chf', 'INV-CHF', 'CHF')]
  state.payables = [bill('b-usd', 'BILL-USD', 'USD')]
  await run()
  assert.equal(state.enqueued.flatMap(amounts).includes(20), false)
})

test('an unusable (zero) stored rate withholds the side by its own reason', async () => {
  state.rates = [rate('USD', '0', '2026-06-29T12:00:00.000Z')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.equal(result.skippedNoRate[0]?.reason, 'non_positive_rate')
  assert.equal(result.withheldSides[0]?.side, 'receivable')
})

test('[q0x56.16] the valuation date is a business day: a rate fetched at 09:00 on it is the valuation rate', async () => {
  state.rates = [rate('USD', '1.25', '2026-06-29T09:00:00.000Z'), rate('USD', '1.60', '2026-06-30T09:00:00.000Z'), rate('USD', '2.00', '2026-07-01T00:00:00.000Z')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  const result = await run()
  assert.equal(result.skippedNoRate.length, 0)
  assert.equal(state.asOfs[0].toISOString(), '2026-06-30T23:59:59.999Z')
  assert.deepEqual(amounts(state.enqueued[0]), [17.5, 17.5], 'the 09:00 same-day rate (1.60), neither the previous day nor the next')
})
