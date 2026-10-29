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
  /** `kind:side` of enqueues the queue REFUSES (e.g. an unresolved FAILED attempt for the date). */
  refuse: new Set<string>(),
  /** `kind:side` of enqueues that THROW. */
  throwOn: new Set<string>(),
}

type PendingTx = { __pending: Array<Enqueued & { chartConnector: unknown }> }

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({
      syncEnabled: true, connector: 'xero',
      accountsReceivableAccount: 'AR', accountsPayableAccount: 'AP', unrealisedFxGainLossAccount: 'UFX', realisedFxGainLossAccount: 'RFX',
    }),
    queueAccountingSyncTxWithOutcome: async (tx: PendingTx, params: Enqueued & { chartConnector: unknown }) => {
      const key = `${params.payload.kind}:${params.payload.side}`
      if (state.throwOn.has(key)) throw new Error(`boom on ${key}`)
      if (state.refuse.has(key)) return { queued: false, reason: 'refused', connector: params.chartConnector }
      // written inside the caller's transaction: it becomes visible only if that transaction commits
      tx.__pending.push(params)
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
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const tx = {
        __pending: [] as Array<Enqueued & { chartConnector: unknown }>,
        setting: { findMany: async () => [] },
        fxRate: {
          groupBy: async (args: { where: { fetchedAt: { lte: Date } } }) => { state.asOfs.push(args.where.fetchedAt.lte); return fakeFxClient(state.rates).fxRate.groupBy(args as never) },
          findMany: async (args: never) => fakeFxClient(state.rates).fxRate.findMany(args),
        },
        activityLog: { create: async () => ({ id: 'a-1' }) },
        }
        const result = await fn(tx)
        // COMMIT: only now do the queued journals exist, exactly as Postgres would have it
        for (const params of tx.__pending) {
          state.enqueued.push(params)
          state.logs.push({ id: `log-${state.logs.length + 1}`, type: 'UNREALISED_FX_JOURNAL', status: 'PENDING', connector: 'xero', payload: params.payload })
        }
        return result
      },
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
const priorJournal = (id: string, side: 'receivable' | 'payable', documents?: Array<{ documentId: string; reference: string; currency: string; gainLossBase: number; outstandingForeign?: string }>): Row => ({
  id, type: 'UNREALISED_FX_JOURNAL', status: 'SYNCED', connector: 'xero',
  payload: {
    kind: 'revaluation', side, valuationDate: '2026-05-31', ...(documents ? { documents } : {}),
    lines: [
      { accountCode: side === 'receivable' ? 'AR' : 'AP', description: 'Unrealised FX', debit: 9, credit: 0 },
      { accountCode: 'UFX', description: 'Unrealised FX', debit: 0, credit: 9 },
    ],
  },
})
const amounts = (e: Enqueued) => e.payload.lines.flatMap((l) => [l.debit ?? 0, l.credit ?? 0]).filter((n) => n > 0)
const posted = (kind: string, side?: string) => state.enqueued.filter((e) => e.payload.kind === kind && (!side || e.payload.side === side))

async function run(date = DATE) {
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')
  return runArApFxRevaluation({ valuationDate: date })
}

test.beforeEach(() => {
  state.rates = []
  state.receivables = []
  state.payables = []
  state.logs = []
  state.enqueued = []
  state.activity = []
  state.asOfs = []
  state.refuse = new Set()
  state.throwOn = new Set()
})

const USD_OK = () => rate('USD', '1.60', '2026-06-29T12:00:00.000Z')

test('[R1 HIGH, fallback: prior journal with NO per-document record] a prior AR journal + one AR document now missing a rate: no reversal, no new AR journal, AP still posts', async () => {
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

test('an unusable (zero) stored rate is reported by its own reason (nothing prior to carry, so nothing posts)', async () => {
  state.rates = [rate('USD', '0', '2026-06-29T12:00:00.000Z')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.equal(result.skippedNoRate[0]?.reason, 'non_positive_rate')
  assert.equal(result.skippedNoRate[0]?.treatment, 'excluded_not_in_prior')
})

test('[q0x56.16] the valuation date is a business day: a rate fetched at 09:00 on it is the valuation rate', async () => {
  state.rates = [rate('USD', '1.25', '2026-06-29T09:00:00.000Z'), rate('USD', '1.60', '2026-06-30T09:00:00.000Z'), rate('USD', '2.00', '2026-07-01T00:00:00.000Z')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  const result = await run()
  assert.equal(result.skippedNoRate.length, 0)
  assert.equal(state.asOfs[0].toISOString(), '2026-06-30T23:59:59.999Z')
  assert.deepEqual(amounts(state.enqueued[0]), [17.5, 17.5], 'the 09:00 same-day rate (1.60), neither the previous day nor the next')
})

test('[R2 HIGH] the replacement is REFUSED (unresolved FAILED attempt for today): neither the reversal nor the replacement is queued for that side; the other side proceeds', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable'), priorJournal('prior-ap', 'payable')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  state.payables = [bill('b-usd', 'BILL-USD', 'USD')]
  state.refuse.add('revaluation:receivable')
  const result = await run()

  assert.deepEqual(posted('reversal').map((e) => [e.payload.side, e.payload.sourceEntryId]), [['payable', 'prior-ap']], 'the AR reversal was queued then ROLLED BACK with the refused replacement')
  assert.equal(posted('revaluation', 'receivable').length, 0)
  assert.equal(posted('revaluation', 'payable').length, 1, 'AP is untouched by the AR refusal')
  assert.equal(result.refused, 1)
  assert.equal(result.reversed, 1)
  assert.equal(result.revalued, 1)
  assert.deepEqual(result.withheldSides.map((w) => [w.side, w.reason]), [['receivable', 'side_blocked_enqueue_refused']])
  assert.match(String(result.withheldSides[0].detail), /NOTHING was queued for the receivables \(AR\) side/)
  const logged = state.activity.filter((a) => a.action === 'unrealised_fx_side_blocked_enqueue_refused')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].metadata?.side, 'receivable')
  assert.equal(logged[0].metadata?.enqueueReason, 'refused')
  assert.equal(state.activity.filter((a) => a.action === 'unrealised_fx_journal_not_queued').length, 1, 'and the owed posting is recorded OUTSIDE the rolled-back unit')
})

test('[R2 HIGH] a REFUSED reversal blocks its side too: no replacement is posted beside an un-reversed prior', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  state.refuse.add('reversal:receivable')
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.equal(result.refused, 1)
  assert.equal(result.withheldSides[0].reason, 'side_blocked_enqueue_refused')
})

test('[R2 HIGH] a replacement that THROWS mid-way rolls the reversal back, and the run fails loudly', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  state.throwOn.add('revaluation:receivable')
  await assert.rejects(run(), /boom on revaluation:receivable/)
  assert.equal(state.enqueued.length, 0, 'the reversal that was queued first did not survive the failed unit')
})

test('[R2 HIGH] a blocked side is picked up by a rerun once the queue admits it (nothing was recorded as done)', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable')]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  state.refuse.add('revaluation:receivable')
  await run()
  assert.equal(state.enqueued.length, 0)
  state.refuse.clear()
  const rerun = await run()
  assert.deepEqual(posted('reversal').map((e) => e.payload.sourceEntryId), ['prior-ar'])
  assert.equal(posted('revaluation', 'receivable').length, 1)
  assert.deepEqual(rerun.withheldSides, [])
})

const DOC = (documentId: string, reference: string, currency: string, gainLossBase: number, outstandingForeign: string | null = '100') => ({ documentId, reference, currency, gainLossBase, ...(outstandingForeign !== null ? { outstandingForeign } : {}) })

test('[R4 HIGH] A closed, B has no rate: the replacement is B\'s PREVIOUS amount only; A\'s is gone; the prior is fully reversed', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-a', 'INV-A', 'USD', -9), DOC('so-b', 'INV-B', 'CHF', 4)])]
  state.receivables = [order('so-b', 'INV-B', 'CHF')] // A is no longer open
  const result = await run()

  assert.deepEqual(posted('reversal').map((e) => [e.payload.side, e.payload.sourceEntryId]), [['receivable', 'prior-ar']], 'the whole prior journal is reversed')
  const replacement = posted('revaluation', 'receivable')
  assert.equal(replacement.length, 1)
  assert.deepEqual(amounts(replacement[0]), [4, 4], 'B\'s previous 4.00 only: A\'s 9.00 no longer sits on the books')
  assert.match(replacement[0].payload.lines[0].description, /carried forward on INV-B/)
  // the carried amount is a GAIN of 4: debit the control account, as when it was first posted
  assert.deepEqual(replacement[0].payload.lines.map((l) => [l.accountCode, l.debit, l.credit]), [['AR', 4, 0], ['UFX', 0, 4]])
  assert.deepEqual((replacement[0].payload as unknown as { documents: unknown }).documents, [{ documentId: 'so-b', reference: 'INV-B', currency: 'CHF', gainLossBase: 4, outstandingForeign: '100', carriedForward: true }])
  assert.deepEqual(result.withheldSides, [])
  assert.deepEqual(result.skippedNoRate.map((s) => [s.reference, s.treatment, s.carriedGainLossBase]), [['INV-B', 'carried_forward', 4]])
  assert.equal(result.reversed, 1)
  assert.equal(result.revalued, 1)
  assert.match(String(result.reason), /Carried forward unchanged from the previous journal: INV-B/)
  const logged = state.activity.filter((a) => a.action === 'unrealised_fx_document_skipped_no_rate')
  assert.equal(logged.length, 1)
  assert.equal(logged[0].metadata?.treatment, 'carried_forward')
})

test('[R4 HIGH] a rated document is revalued while an unrated one is carried: the replacement is the sum of both', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-usd', 'INV-USD', 'USD', -1), DOC('so-b', 'INV-B', 'CHF', 4)])]
  state.receivables = [order('so-usd', 'INV-USD', 'USD'), order('so-b', 'INV-B', 'CHF')]
  await run()
  const replacement = posted('revaluation', 'receivable')[0]
  assert.deepEqual(amounts(replacement).sort((x, y) => x - y), [4, 4, 17.5, 17.5], 'USD at today\'s rate (17.50 loss) + CHF carried (4.00 gain)')
  const docs = (replacement.payload as unknown as { documents: Array<{ documentId: string; gainLossBase: number; carriedForward?: boolean }> }).documents
  assert.deepEqual(docs.map((d) => [d.documentId, d.gainLossBase, d.carriedForward ?? false]), [['so-usd', -17.5, false], ['so-b', 4, true]])
})

test('[R4 HIGH] a skipped document that was NOT in the previous journal contributes nothing and is reported', async () => {
  state.rates = [USD_OK()]
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-usd', 'INV-USD', 'USD', -1)])]
  state.receivables = [order('so-usd', 'INV-USD', 'USD'), order('so-new', 'INV-NEW', 'CHF')]
  const result = await run()
  assert.deepEqual(amounts(posted('revaluation', 'receivable')[0]), [17.5, 17.5])
  assert.deepEqual(result.skippedNoRate.map((s) => [s.reference, s.treatment]), [['INV-NEW', 'excluded_not_in_prior']])
  assert.match(String(result.reason), /left out \(not in the previous journal\): INV-NEW/)
})

test('[R4 HIGH] B gains a rate on the NEXT run: it is revalued normally, and the carried journal is reversed', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 4)])]
  state.receivables = [order('so-b', 'INV-B', 'CHF')]
  await run() // carries B forward on 2026-06-30
  state.rates = [rate('CHF', '1.60', '2026-07-01T09:00:00.000Z')]
  state.enqueued = []
  const next = await run('2026-07-01')
  assert.deepEqual(next.skippedNoRate, [])
  const reversals = posted('reversal', 'receivable').map((e) => e.payload.sourceEntryId)
  assert.equal(reversals.length, 1, 'only the carried-forward journal of the 30th is still in force (the original was reversed on the 30th)')
  assert.notEqual(reversals[0], 'prior-ar')
  assert.deepEqual(amounts(posted('revaluation', 'receivable')[0]), [17.5, 17.5], 'B at its own new rate')
  const docs = (posted('revaluation', 'receivable')[0].payload as unknown as { documents: Array<{ carriedForward?: boolean }> }).documents
  assert.equal(docs[0].carriedForward, undefined)
})

test('[R4 HIGH] a prior with a document record but an UNROUTABLE source connector cannot be carried: the side is withheld', async () => {
  const prior = priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 4)])
  prior.connector = 'quickbooks'
  state.logs = [prior]
  state.receivables = [order('so-b', 'INV-B', 'CHF')]
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.equal(result.withheldSides[0]?.reason, 'side_withheld_missing_rate')
})

test('[R4 HIGH] every revaluation records its per-document amounts in its payload', async () => {
  state.rates = [USD_OK()]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  await run()
  const docs = (posted('revaluation', 'receivable')[0].payload as unknown as { documents: unknown }).documents
  assert.deepEqual(docs, [{ documentId: 'so-usd', reference: 'INV-USD', currency: 'USD', gainLossBase: -17.5, outstandingForeign: '100' }])
})

test('[R4 HIGH] with two journals still in force the document is carried from the LATEST one that names it', async () => {
  const older = priorJournal('prior-old', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 4)])
  const newer = priorJournal('prior-new', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 6)])
  ;(older.payload as { valuationDate: string }).valuationDate = '2026-04-30'
  ;(newer.payload as { valuationDate: string }).valuationDate = '2026-05-31'
  state.logs = [older, newer]
  state.receivables = [order('so-b', 'INV-B', 'CHF')]
  await run()
  assert.deepEqual(posted('reversal').map((e) => e.payload.sourceEntryId).sort(), ['prior-new', 'prior-old'])
  assert.deepEqual(amounts(posted('revaluation', 'receivable')[0]), [6, 6])
})

const withOutstanding = (ref: string, currency: string, outstanding: number): Row => ({ ...order(`so-${ref}`, `INV-${ref}`, currency), totalForeign: outstanding, totalBase: outstanding * 0.8 })

test('[R5 HIGH] half paid: exactly HALF of the previous amount is carried (Decimal, 2dp half-up), and the paid half is not posted again', async () => {
  // previous: 20.00 gain on 100 outstanding; now 50 outstanding and no rate
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 20, '100')])]
  state.receivables = [withOutstanding('B', 'CHF', 50)]
  state.receivables[0].id = 'so-b'
  const result = await run()
  assert.deepEqual(amounts(posted('revaluation', 'receivable')[0]), [10, 10])
  const doc = (posted('revaluation', 'receivable')[0].payload as unknown as { documents: Array<Record<string, unknown>> }).documents[0]
  assert.deepEqual(doc, { documentId: 'so-b', reference: 'INV-B', currency: 'CHF', gainLossBase: 10, outstandingForeign: '50', carriedForward: true }, 'the carried record is struck on the NEW balance, so a further part-payment scales again')
  assert.equal(result.skippedNoRate[0].carriedGainLossBase, 10)
  assert.deepEqual(result.withheldSides, [])
})

test('[R5 HIGH] the share is rounded half-up to 2dp: 10.01 x 1/3 -> 3.34 (not truncated)', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 10.01, '90')])]
  state.receivables = [withOutstanding('B', 'CHF', 30)]
  state.receivables[0].id = 'so-b'
  await run()
  assert.deepEqual(amounts(posted('revaluation', 'receivable')[0]), [3.34, 3.34])
})

test('[R5 HIGH] fully paid (nothing outstanding): contributes nothing', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 20)])]
  state.receivables = []
  const result = await run()
  assert.deepEqual(posted('reversal').length, 1)
  assert.equal(posted('revaluation', 'receivable').length, 0)
  assert.deepEqual(result.skippedNoRate, [])
})

test('[R5 HIGH] unchanged outstanding: the FULL previous amount is carried', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 20, '100')])]
  state.receivables = [withOutstanding('B', 'CHF', 100)]
  state.receivables[0].id = 'so-b'
  await run()
  assert.deepEqual(amounts(posted('revaluation', 'receivable')[0]), [20, 20])
})

test('[R5 HIGH] outstanding GREW (an amendment): the side is withheld, naming the document', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 20, '100')])]
  state.receivables = [withOutstanding('B', 'CHF', 120)]
  state.receivables[0].id = 'so-b'
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.equal(result.withheldSides[0]?.reason, 'side_withheld_missing_rate')
  assert.match(String(result.withheldSides[0]?.detail), /INV-B: its outstanding balance GREW/)
  assert.equal(result.skippedNoRate[0]?.treatment, 'side_withheld')
})

test('[R5 HIGH] a prior record WITHOUT the outstanding balance (posted before it was recorded): the side is withheld', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 20, null)])]
  state.receivables = [withOutstanding('B', 'CHF', 100)]
  state.receivables[0].id = 'so-b'
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.match(String(result.withheldSides[0]?.detail), /did not record its outstanding balance/)
})

test('[R5 HIGH] a prior outstanding of zero is unusable: the side is withheld', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 20, '0')])]
  state.receivables = [withOutstanding('B', 'CHF', 10)]
  state.receivables[0].id = 'so-b'
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.match(String(result.withheldSides[0]?.detail), /zero or negative/)
})

test('[R5 HIGH] a changed currency is unusable: the side is withheld', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'EUR', 20, '100')])]
  state.receivables = [withOutstanding('B', 'CHF', 100)]
  state.receivables[0].id = 'so-b'
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.match(String(result.withheldSides[0]?.detail), /currency changed/)
})

test('[R5 HIGH] one unsafe document withholds the side even when another could be carried', async () => {
  state.logs = [priorJournal('prior-ar', 'receivable', [DOC('so-b', 'INV-B', 'CHF', 20, '100'), DOC('so-c', 'INV-C', 'CHF', 8, null)])]
  const b = withOutstanding('B', 'CHF', 100); b.id = 'so-b'
  const c = withOutstanding('C', 'CHF', 100); c.id = 'so-c'
  state.receivables = [b, c]
  const result = await run()
  assert.equal(state.enqueued.length, 0)
  assert.match(String(result.withheldSides[0]?.detail), /INV-C/)
})

test('[R5 HIGH] every valuation records the outstanding foreign balance it was struck on', async () => {
  state.rates = [USD_OK()]
  state.receivables = [order('so-usd', 'INV-USD', 'USD')]
  await run()
  const doc = (posted('revaluation', 'receivable')[0].payload as unknown as { documents: Array<Record<string, unknown>> }).documents[0]
  assert.equal(doc.outstandingForeign, '100')
})

test('[R5 HIGH] a document read with nothing outstanding is closed: it contributes nothing and is not carried', async () => {
  state.logs = [priorJournal('prior-ap', 'payable', [DOC('b-b', 'BILL-B', 'CHF', 20, '100')])]
  state.payables = [{ ...bill('b-b', 'BILL-B', 'CHF'), totalForeign: 0 }]
  const result = await run()
  assert.equal(posted('reversal').length, 1)
  assert.equal(posted('revaluation', 'payable').length, 0)
  assert.equal(result.skippedNoRate[0]?.treatment, 'excluded_closed')
})
