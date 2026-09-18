import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-j625 r3 — THE AR/AP FX REVALUATION RUN: TWO FINDINGS IN ONE FUNCTION.
 *
 * Codex HIGH 4 — `hasRevaluationForDate` searched EVERY connector's live revaluation rows. Xero
 * revalues the 2nd; the operator switches to QuickBooks that day; the QuickBooks run reads Xero's row,
 * decides "already revalued", and skips — so QuickBooks' journal, whose lines come from QuickBooks' own
 * accounts and which no Xero row can stand in for, is silently never written. r2 declared this out of
 * scope because it "only decides whether to skip work". The work it skips is the journal.
 *
 * Codex MEDIUM — `reversed += 1` (and `revalued += 1`) after an enqueue whose result was discarded, so a
 * REFUSED reversal was reported as done and the run could announce itself a no-op with postings owed.
 *
 * THE DOUBLE HONOURS `where`. The sibling file (fx-revaluation-chart-connector.test.ts) serves every row
 * for every query, which is fine for what it tests and would make the HIGH 4 test below VACUOUS: a
 * double that ignores the connector filter returns the other connector's row whether the filter exists
 * or not. So this one filters on exactly the fields the code puts in `where`, and the precondition
 * tests prove the rig can see the defect.
 */

type Row = { id: string; type: string; status: string; connector: string; payload: Record<string, unknown> }

const state = {
  connector: 'quickbooks' as 'xero' | 'quickbooks',
  rows: [] as Row[],
  receivables: [] as unknown[],
  /** Which enqueue kinds answer `refused`. */
  refuseKinds: new Set<string>(),
  enqueued: [] as Array<{ kind: unknown; chartConnector: unknown }>,
  /** o3d-j625 r6 (review H4): every enqueue's params, refused or not, so a re-run's posting key can be compared. */
  asked: [] as Array<Record<string, unknown>>,
  queries: [] as Array<Record<string, unknown>>,
}

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => ({
      syncEnabled: true,
      connector: state.connector,
      accountsReceivableAccount: `${state.connector}-AR`,
      accountsPayableAccount: `${state.connector}-AP`,
      unrealisedFxGainLossAccount: `${state.connector}-UFX`,
      realisedFxGainLossAccount: `${state.connector}-RFX`,
    }),
    queueAccountingSync: async (params: { payload: Record<string, unknown>; chartConnector: unknown }) => {
      state.asked.push(params as unknown as Record<string, unknown>)
      const kind = params.payload.kind
      if (state.refuseKinds.has(String(kind))) {
        return { queued: false, reason: 'refused', connector: params.chartConnector }
      }
      state.enqueued.push({ kind, chartConnector: params.chartConnector })
      return { queued: true, connector: params.chartConnector }
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    const value = (row as unknown as Record<string, unknown>)[key]
    if (condition && typeof condition === 'object' && 'in' in (condition as object)) {
      if (!((condition as { in: unknown[] }).in).includes(value)) return false
    } else if (value !== condition) {
      return false
    }
  }
  return true
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          state.queries.push(where)
          return state.rows.filter((row) => matches(row, where))
        },
      },
      salesOrder: { findMany: async () => state.receivables },
      purchaseInvoice: { findMany: async () => [] },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
        fxRate: { findFirst: async () => null },
        activityLog: { create: async () => ({ id: 'a-1' }) },
      }),
    },
  },
})

const VALUATION_DATE = '2026-06-02'

function revaluationRow(id: string, connector: string, valuationDate: string): Row {
  return {
    id,
    type: 'UNREALISED_FX_JOURNAL',
    status: 'SYNCED',
    connector,
    payload: {
      kind: 'revaluation',
      side: 'receivable',
      valuationDate,
      lines: [
        { accountCode: `${connector}-AR`, description: 'Unrealised FX', debit: 5, credit: 0 },
        { accountCode: `${connector}-UFX`, description: 'Unrealised FX', debit: 0, credit: 5 },
      ],
    },
  }
}

const OPEN_USD_RECEIVABLE = {
  id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, invoiceNumber: 'INV-1',
  currency: 'USD', totalForeign: 100, totalBase: 80, fxRateToBase: 0.8, payments: [],
}

function reset(connector: 'xero' | 'quickbooks', rows: Row[]): void {
  state.connector = connector
  state.rows = rows
  state.receivables = [OPEN_USD_RECEIVABLE]
  state.refuseKinds = new Set()
  state.asked = []
  state.enqueued = []
  state.queries = []
}

// ---------------------------------------------------------------------------------------------------
// HIGH 4 — the same-date check is scoped to the connector the run is for
// ---------------------------------------------------------------------------------------------------

test('[o3d-j625 r3 HIGH 4] PRECONDITION: a SAME-connector revaluation for the date does skip the fresh run — the rig can see a skip', async () => {
  reset('quickbooks', [revaluationRow('qbo-today', 'quickbooks', VALUATION_DATE)])
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')

  const result = await runArApFxRevaluation({ valuationDate: VALUATION_DATE })

  assert.equal(result.revalued, 0, 'QuickBooks already revalued this date, so the fresh half is skipped')
  assert.equal(state.enqueued.filter((e) => e.kind === 'revaluation').length, 0)
  assert.equal(result.skipped, true)
})

test('[o3d-j625 r3 HIGH 4] ANOTHER connector’s revaluation for the same date does NOT skip this connector’s journal', async () => {
  // Xero revalued the 2nd; the operator switched to QuickBooks the same day.
  reset('quickbooks', [revaluationRow('xero-today', 'xero', VALUATION_DATE)])
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')

  const result = await runArApFxRevaluation({ valuationDate: VALUATION_DATE })

  const revaluations = state.enqueued.filter((e) => e.kind === 'revaluation')
  assert.equal(revaluations.length, 1, `QuickBooks' own revaluation must be written. Enqueued: ${JSON.stringify(state.enqueued)}`)
  assert.equal(revaluations[0].chartConnector, 'quickbooks')
  assert.equal(result.revalued, 1)
  assert.notEqual(result.skipped, true, 'and the run must not call itself a no-op')
})

test('[o3d-j625 r3 HIGH 4] the same-date read names the connector in its WHERE — not a post-filter that a double could hide', async () => {
  reset('xero', [])
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')
  await runArApFxRevaluation({ valuationDate: VALUATION_DATE })

  const scoped = state.queries.filter((where) => where.connector === 'xero')
  assert.equal(scoped.length, 1, `exactly the same-date read is connector-scoped. Queries: ${JSON.stringify(state.queries)}`)
  // And the PRIOR-revaluation read deliberately is NOT: a retired connector's revaluation must still
  // be found so it can be reversed in its own books.
  assert.equal(state.queries.filter((where) => !('connector' in where)).length, 1, 'the prior read spans every connector')
})

// ---------------------------------------------------------------------------------------------------
// MEDIUM — a refusal is neither a reversal nor a revaluation, and it is not a no-op
// ---------------------------------------------------------------------------------------------------

test('[o3d-j625 r3 MEDIUM] a REFUSED reversal is not counted as reversed, and is counted as owed', async () => {
  // A prior QuickBooks revaluation, plus today's QuickBooks row so the fresh half is skipped and the
  // counts below are attributable to the reversal alone.
  reset('quickbooks', [
    revaluationRow('qbo-prior', 'quickbooks', '2026-06-01'),
    revaluationRow('qbo-today', 'quickbooks', VALUATION_DATE),
  ])
  state.refuseKinds.add('reversal')
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')

  const result = await runArApFxRevaluation({ valuationDate: VALUATION_DATE })

  assert.equal(result.reversed, 0, 'nothing was reversed: the enqueue refused')
  assert.equal(result.refused, 1, 'and the reversal that is still owed is reported')
  assert.notEqual(result.skipped, true, 'a run with a posting owed is NOT "already queued for this date"')
  assert.match(String(result.reason), /could not be queued/)
})

test('[o3d-j625 r3 MEDIUM] PRECONDITION: the same reversal, NOT refused, IS counted — the refusal is what changed the count', async () => {
  reset('quickbooks', [
    revaluationRow('qbo-prior', 'quickbooks', '2026-06-01'),
    revaluationRow('qbo-today', 'quickbooks', VALUATION_DATE),
  ])
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')

  const result = await runArApFxRevaluation({ valuationDate: VALUATION_DATE })

  assert.equal(result.reversed, 1)
  assert.equal(result.refused, 0)
})

test('[o3d-j625 r3 MEDIUM] a REFUSED revaluation is not counted as revalued either', async () => {
  reset('quickbooks', [])
  state.refuseKinds.add('revaluation')
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')

  const result = await runArApFxRevaluation({ valuationDate: VALUATION_DATE })

  assert.equal(result.revalued, 0)
  assert.equal(result.refused, 1)
})

// o3d-j625 r6 (review H4) — `unrealised_fx_journal` IS AN AUTO-CLEARING KIND, and this is the path that
// clears it: running the revaluation for the same date again raises the SAME posting (same key), and the
// row that run creates clears the refusal (createAccountingSyncLogRow). Driven through the real run twice.
test('[o3d-j625 r6 H4] a refused revaluation is raised again, under the SAME posting key, by re-running the date', async () => {
  const { accountingPostingKey } = await import('@/lib/accounting/posting-key')
  reset('quickbooks', [])
  state.refuseKinds.add('revaluation')
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')
  await runArApFxRevaluation({ valuationDate: VALUATION_DATE })
  const refused = state.asked.filter((p) => (p.payload as { kind?: string }).kind === 'revaluation')
  assert.equal(refused.length, 1, 'PRECONDITION: the first run asked for the revaluation and was refused')

  state.refuseKinds = new Set()
  state.asked = []
  await runArApFxRevaluation({ valuationDate: VALUATION_DATE })
  const rerun = state.asked.filter((p) => (p.payload as { kind?: string }).kind === 'revaluation')
  assert.equal(rerun.length, 1, 'PRECONDITION: the re-run asked again')
  assert.deepEqual(accountingPostingKey(rerun[0] as never), accountingPostingKey(refused[0] as never),
    'the re-run names the same posting, so the row it creates clears the refusal')
})
