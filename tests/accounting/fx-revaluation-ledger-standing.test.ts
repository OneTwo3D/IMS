import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createSyncLogStore, matchesWhere, syncLogRow, type SyncLogRow } from '@/tests/fixtures/accounting-sync-log-store'

/**
 * o3d-3la07 (M10, D2) - "HAS THIS UNREALISED-FX JOURNAL BEEN POSTED?" IS AN EXISTENCE QUESTION.
 *
 * `hasRevaluationForDate` (skip the fresh revaluation) and `getPriorRevaluations` (reverse the earlier
 * one, and the earlier one's reversal) read UNREALISED_FX_JOURNAL rows. An operator-typed document id
 * (SYNCED + OPERATOR_ASSERTION + id = ASSERTED_POSTED) counts: the journal is claimed to exist, and the
 * alternative is posting it a second time. D2 says that count is never silent, so each such row is
 * REPORTED (one WARNING per row, per read). CONFIRMED rows and live work are not reported.
 *
 * The double evaluates the code's own `where` against real rows (matchesWhere throws on an operator it
 * does not implement), so a read whose status clause were wrong would return the wrong rows.
 */

const VALUATION_DATE = '2026-06-02'
const PRIOR_DATE = '2026-06-01'

let store = createSyncLogStore([])
const enqueued: Array<{ kind: unknown; chartConnector: unknown }> = []
const activity: Array<Record<string, unknown>> = []

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({
      syncEnabled: true,
      connector: 'xero',
      accountsReceivableAccount: 'xero-AR',
      accountsPayableAccount: 'xero-AP',
      unrealisedFxGainLossAccount: 'xero-UFX',
      realisedFxGainLossAccount: 'xero-RFX',
    }),
    queueAccountingSync: async (params: { payload: Record<string, unknown>; chartConnector: unknown }) => {
      enqueued.push({ kind: params.payload.kind, chartConnector: params.chartConnector })
      return { queued: true, connector: params.chartConnector }
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (params: Record<string, unknown>) => { activity.push(params) } },
})
function journal(id: string, valuationDate: string, over: Partial<SyncLogRow>, kind: 'revaluation' | 'reversal' = 'revaluation', extra: Record<string, unknown> = {}): SyncLogRow {
  return syncLogRow({
    id,
    connector: 'xero',
    type: 'UNREALISED_FX_JOURNAL',
    referenceType: 'FxRevaluation',
    referenceId: `fx-${id}`,
    payload: {
      kind,
      side: 'receivable',
      valuationDate,
      lines: [
        { accountCode: 'xero-AR', description: 'Unrealised FX', debit: 5, credit: 0 },
        { accountCode: 'xero-UFX', description: 'Unrealised FX', debit: 0, credit: 5 },
      ],
      ...extra,
    },
    ...over,
  })
}

/** One row per standing, as a SAME-DATE revaluation. `skips`: does the same-date check count it? */
const SAME_DATE_CASES: Array<{ standing: string; over: Partial<SyncLogRow>; skips: boolean; reported: boolean }> = [
  { standing: 'CONFIRMED_POSTED', over: { status: 'SYNCED', externalTransactionId: 'JNL-1', settlementBasis: null }, skips: true, reported: false },
  { standing: 'ASSERTED_POSTED', over: { status: 'SYNCED', externalTransactionId: 'TYPED-1', settlementBasis: 'OPERATOR_ASSERTION' }, skips: true, reported: true },
  // The existence question is "was a journal posted?"; an ASSERTED_NOT_POSTED row (CANCELLED) is not a
  // counted row, and the enqueue itself refuses to raise a second posting under the same key while
  // that row stands (prior-posting-evidence BLOCKED slot), so the run is not the guard here.
  { standing: 'ASSERTED_NOT_POSTED', over: { status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'OPERATOR_ASSERTION' }, skips: false, reported: false },
  { standing: 'PROVEN_NOT_POSTED', over: { status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'VERIFIED_REVERSAL' }, skips: false, reported: false },
  { standing: 'UNKNOWN', over: { status: 'FAILED', externalTransactionId: null, settlementBasis: null }, skips: false, reported: false },
  { standing: 'LIVE_WORK', over: { status: 'PENDING', externalTransactionId: null, settlementBasis: null }, skips: true, reported: false },
]

function relianceReports(): Array<Record<string, unknown>> {
  return activity.filter((entry) => entry.action === 'unrealised_fx_relied_on_operator_assertion')
}

async function run(rows: SyncLogRow[]) {
  store = createSyncLogStore(rows)
  enqueued.length = 0
  activity.length = 0
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')
  return runArApFxRevaluation({ valuationDate: VALUATION_DATE })
}

// A receivable to revalue, so the fresh half has something to do when it is NOT skipped.
mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => store.rows.filter((row) => matchesWhere(row, where)),
      },
      salesOrder: {
        findMany: async () => [{
          id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, invoiceNumber: 'INV-1',
          currency: 'USD', totalForeign: 100, totalBase: 80, fxRateToBase: 0.8, payments: [],
        }],
      },
      purchaseInvoice: { findMany: async () => [] },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
        fxRate: { findFirst: async () => null },
        activityLog: { create: async () => ({ id: 'a-1' }) },
      }),
    },
  },
})

test('PRECONDITION: with no UNREALISED_FX_JOURNAL row the fresh revaluation IS raised (the rig can see a non-skip)', async () => {
  const result = await run([])
  assert.equal(enqueued.filter((e) => e.kind === 'revaluation').length, 1)
  assert.equal(result.revalued, 1)
  assert.equal(relianceReports().length, 0)
  console.log('precondition cases: 1 (no rows) -> 1 revaluation enqueued')
})

for (const testCase of SAME_DATE_CASES) {
  test(`[same-date check] ${testCase.standing}: ${testCase.skips ? 'counts as an existing revaluation (skip)' : 'does not count (revalues)'}; ${testCase.reported ? 'REPORTED' : 'not reported'}`, async () => {
    const result = await run([journal(`same-${testCase.standing}`, VALUATION_DATE, testCase.over)])
    const revaluations = enqueued.filter((e) => e.kind === 'revaluation').length
    assert.equal(revaluations, testCase.skips ? 0 : 1, `standing ${testCase.standing}`)
    assert.equal(result.skipped === true, testCase.skips)
    const reports = relianceReports().filter((entry) => (entry.metadata as { read?: string }).read === 'same-date-check')
    assert.equal(reports.length, testCase.reported ? 1 : 0, `standing ${testCase.standing} report count`)
    if (testCase.reported) {
      assert.equal((reports[0].metadata as { syncLogId?: string }).syncLogId, `same-${testCase.standing}`)
      assert.equal(reports[0].level, 'WARNING')
    }
    console.log(`same-date ${testCase.standing}: revaluations=${revaluations} reports=${reports.length}`)
  })
}

/** An EARLIER revaluation: is it reversed? (today's row is present so the fresh half is out of the picture). */
const TODAY_ROW = () => journal('today', VALUATION_DATE, { status: 'SYNCED', externalTransactionId: 'JNL-TODAY', settlementBasis: null })

const PRIOR_CASES: Array<{ standing: string; over: Partial<SyncLogRow>; reversed: boolean; reported: boolean }> = [
  { standing: 'CONFIRMED_POSTED', over: { status: 'SYNCED', externalTransactionId: 'JNL-P', settlementBasis: null }, reversed: true, reported: false },
  { standing: 'ASSERTED_POSTED', over: { status: 'SYNCED', externalTransactionId: 'TYPED-P', settlementBasis: 'OPERATOR_ASSERTION' }, reversed: true, reported: true },
  { standing: 'ASSERTED_NOT_POSTED', over: { status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'OPERATOR_ASSERTION' }, reversed: false, reported: false },
  { standing: 'PROVEN_NOT_POSTED', over: { status: 'CANCELLED', externalTransactionId: null, settlementBasis: 'VERIFIED_REVERSAL' }, reversed: false, reported: false },
  { standing: 'UNKNOWN', over: { status: 'FAILED', externalTransactionId: null, settlementBasis: null }, reversed: false, reported: false },
  { standing: 'LIVE_WORK', over: { status: 'PROCESSING', externalTransactionId: null, settlementBasis: null }, reversed: true, reported: false },
]

for (const testCase of PRIOR_CASES) {
  test(`[prior-revaluation read] ${testCase.standing}: ${testCase.reversed ? 'is reversed' : 'is not reversed'}; ${testCase.reported ? 'REPORTED' : 'not reported'}`, async () => {
    const result = await run([TODAY_ROW(), journal(`prior-${testCase.standing}`, PRIOR_DATE, testCase.over)])
    const reversals = enqueued.filter((e) => e.kind === 'reversal').length
    assert.equal(reversals, testCase.reversed ? 1 : 0, `standing ${testCase.standing}`)
    assert.equal(result.reversed, testCase.reversed ? 1 : 0)
    const reports = relianceReports().filter((entry) => (entry.metadata as { read?: string }).read === 'prior-revaluation-read'
      && (entry.metadata as { syncLogId?: string }).syncLogId === `prior-${testCase.standing}`)
    assert.equal(reports.length, testCase.reported ? 1 : 0, `standing ${testCase.standing} report count`)
    console.log(`prior ${testCase.standing}: reversals=${reversals} reports=${reports.length}`)
  })
}

test('[prior-revaluation read] an ASSERTED_POSTED REVERSAL covers its source (no second reversal) and is REPORTED', async () => {
  const rows = [
    TODAY_ROW(),
    journal('prior-src', PRIOR_DATE, { status: 'SYNCED', externalTransactionId: 'JNL-SRC', settlementBasis: null }),
    journal('rev-of-src', VALUATION_DATE, { status: 'SYNCED', externalTransactionId: 'TYPED-REV', settlementBasis: 'OPERATOR_ASSERTION' }, 'reversal', { sourceEntryId: 'prior-src' }),
  ]
  await run(rows)
  assert.equal(enqueued.filter((e) => e.kind === 'reversal').length, 0, 'the asserted reversal counts as existing: the source is not reversed again')
  const reports = relianceReports().filter((entry) => (entry.metadata as { syncLogId?: string }).syncLogId === 'rev-of-src')
  assert.equal(reports.length, 1, 'and the run says it relied on that assertion')
  console.log('asserted reversal: source not re-reversed, 1 report')
})

test('[isolating arm] two asserted rows are two reports, and a confirmed neighbour is never named', async () => {
  await run([
    TODAY_ROW(),
    journal('a1', PRIOR_DATE, { status: 'SYNCED', externalTransactionId: 'T1', settlementBasis: 'OPERATOR_ASSERTION' }),
    journal('a2', '2026-05-31', { status: 'SYNCED', externalTransactionId: 'T2', settlementBasis: 'OPERATOR_ASSERTION' }),
    journal('c1', '2026-05-30', { status: 'SYNCED', externalTransactionId: 'JNL-C', settlementBasis: null }),
  ])
  const ids = relianceReports()
    .filter((entry) => (entry.metadata as { read?: string }).read === 'prior-revaluation-read')
    .map((entry) => (entry.metadata as { syncLogId: string }).syncLogId)
    .sort()
  assert.deepEqual(ids, ['a1', 'a2'])
  console.log(`isolating arm: reported ${ids.join(',')}`)
})
