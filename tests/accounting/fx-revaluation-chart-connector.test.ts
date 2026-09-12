import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-j625 r2 (Codex MEDIUM 1) — THE FX REVERSAL'S ACCOUNT CODES COME OUT OF A HISTORIC ROW, SO ITS
 * CHART IS THAT ROW'S CONNECTOR AND NOT THE SETTINGS OBJECT BESIDE THE ENQUEUE.
 *
 * `runArApFxRevaluation` reads ONE `getAccountingSettings()` at the top and then does two different
 * things with it:
 *
 *   the REVALUATION enqueue builds its lines from `accounts.controlAccount` /
 *   `accounts.fxGainLossAccount`, which ARE that settings object — so `settings.connector` is the right
 *   chart for it, and that is what r1 wrote;
 *
 *   the REVERSAL enqueue builds its lines from `reverseJournalLines(prior.lines, …)`, and `prior.lines`
 *   was read back out of a previous `AccountingSyncLog.payload`. Those account codes belong to whichever
 *   connector that row was written under, which `getPriorRevaluations` did not even SELECT. r1 attributed
 *   them to `settings.connector` too, so a revaluation posted under QuickBooks and reversed after a
 *   switch to Xero had its reversal routed to XERO carrying QuickBooks's AR/AP control and unrealised-FX
 *   codes — an existing cross-connector row routed into the wrong books, which is the o3d-j625 defect
 *   reached through the one site whose codes are not the adjacent settings read's.
 *
 * WHAT THIS FILE PINS:
 *
 *   1. the reversal is routed by the SOURCE ROW's connector, and the rig can tell the two apart because
 *      the row's connector and the active one deliberately DISAGREE;
 *   2. the REVALUATION half is still routed by the settings object, because that half was never wrong —
 *      a fix that routed everything by the source row would break it, and nothing else would notice;
 *   3. a source row naming a connector this build cannot route is REFUSED and REPORTED, never guessed
 *      at: not `settings.connector` (the mis-attribution) and not `null` (which answers
 *      `not-configured`, the one no-op an obligation ledger may settle with).
 */

/** What the ACTIVE connector is, and therefore what `getAccountingSettings()` answers with. */
const ACTIVE_CONNECTOR = 'xero' as const

const settings = {
  syncEnabled: true,
  connector: ACTIVE_CONNECTOR,
  accountsReceivableAccount: 'X-AR',
  accountsPayableAccount: 'X-AP',
  unrealisedFxGainLossAccount: 'X-UFX',
  realisedFxGainLossAccount: 'X-RFX',
}

/** Every enqueue the run made, with the chart it named. */
const enqueued: Array<{
  type: string
  kind: unknown
  chartConnector: unknown
  accountCodes: string[]
}> = []

/** Activity records the run wrote (the unroutable-source report). */
const activity: Array<{ action: string; description: string; metadata?: Record<string, unknown> }> = []

/**
 * The `accounting_sync_logs` rows this run reads back. Mutated per test.
 *
 * Two rows in the default state: one STRICTLY EARLIER revaluation (the prior to reverse) and one for
 * TODAY. The same-date row is what makes `hasRevaluationForDate` true, which skips the fresh-revaluation
 * half — so tests 1 and 3 observe the reversal enqueue and nothing else, and test 2 removes it to
 * observe the revaluation half instead.
 */
let syncLogRows: Array<{ id: string; connector: string; payload: unknown }> = []

const PRIOR_LINES = [
  { accountCode: 'Q-AR', description: 'Unrealised FX gain on SO-9', debit: 12, credit: 0 },
  { accountCode: 'Q-UFX', description: 'Unrealised FX gain on SO-9', debit: 0, credit: 12 },
]

function priorRevaluation(connector: string) {
  return {
    id: 'reval-prior',
    connector,
    payload: {
      kind: 'revaluation',
      side: 'receivable',
      valuationDate: '2026-06-01',
      lines: PRIOR_LINES,
    },
  }
}

const TODAYS_REVALUATION = {
  id: 'reval-today',
  connector: ACTIVE_CONNECTOR,
  payload: {
    kind: 'revaluation',
    side: 'receivable',
    valuationDate: '2026-06-02',
    lines: [{ accountCode: 'X-AR', description: 'Unrealised FX', debit: 1, credit: 0 }],
  },
}

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettings: async () => settings,
    queueAccountingSync: async (params: {
      type: string
      payload: Record<string, unknown>
      chartConnector: unknown
    }) => {
      const lines = (params.payload.lines ?? []) as Array<{ accountCode?: unknown }>
      enqueued.push({
        type: params.type,
        kind: params.payload.kind,
        chartConnector: params.chartConnector,
        accountCodes: lines.map((line) => String(line.accountCode)),
      })
      return { queued: true, connector: params.chartConnector }
    },
  },
})

mock.module('@/lib/base-currency', {
  namedExports: { getBaseCurrencyCode: async () => 'GBP' },
})

mock.module('@/lib/activity-log', {
  namedExports: {
    logActivity: async (params: { action: string; description: string; metadata?: Record<string, unknown> }) => {
      activity.push({ action: params.action, description: params.description, metadata: params.metadata })
    },
  },
})

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: { findMany: async () => syncLogRows },
      // No open foreign-currency balances: the revaluation half has nothing to value unless a test
      // supplies one, which keeps each test's enqueue list attributable to one half of the run.
      salesOrder: { findMany: async () => openReceivables },
      purchaseInvoice: { findMany: async () => [] },
      // `buildRevaluationLines` resolves a settlement rate per balance through this transaction, and
      // `resolveSettlementFxRateToBase` reads `fxRate` on it. `null` makes it fall back to the balance's
      // own booked rate, which is all this file needs.
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({
        fxRate: { findFirst: async () => null },
        // ...and it records a WARNING when it falls back, through the same transaction.
        activityLog: { create: async () => ({ id: 'activity-1' }) },
      }),
    },
  },
})

/** Open receivables for the revaluation half. Empty by default. */
let openReceivables: unknown[] = []

function reset(rows: Array<{ id: string; connector: string; payload: unknown }>): void {
  syncLogRows = rows
  openReceivables = []
  enqueued.length = 0
  activity.length = 0
}

test('[o3d-j625 r2] the reversal is routed by the SOURCE ROW’s connector, not by the active chart', async () => {
  // The prior revaluation was posted under QUICKBOOKS. The active connector is XERO, so
  // `settings.connector` — what r1 passed — would say 'xero'. The two deliberately disagree; without
  // that disagreement this test could not tell the fix from the defect.
  reset([priorRevaluation('quickbooks'), TODAYS_REVALUATION])
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')

  const result = await runArApFxRevaluation({ valuationDate: '2026-06-02' })

  assert.equal(result.success, true)
  assert.equal(result.reversed, 1, 'precondition: the prior revaluation was selected and reversed')
  const reversals = enqueued.filter((row) => row.kind === 'reversal')
  assert.equal(reversals.length, 1, `precondition: one reversal was enqueued. Got ${JSON.stringify(enqueued)}`)
  // THE ACCOUNT CODES ON IT ARE THE HISTORIC ROW'S, which is the whole reason its chart is that row's.
  assert.deepEqual(
    reversals[0].accountCodes.sort(),
    ['Q-AR', 'Q-UFX'],
    'the reversal’s lines come from the PRIOR journal’s payload, not from this run’s settings',
  )
  assert.equal(
    reversals[0].chartConnector,
    'quickbooks',
    'and it must be routed by the connector those codes belong to. `settings.connector` here is '
    + '‘xero’, which is what r1 passed — it would post a reversal of QuickBooks’s journal into Xero.',
  )
})

test('[o3d-j625 r2] the REVALUATION half is still routed by the settings object — that half was never wrong', async () => {
  // No same-date revaluation, so the fresh half runs; no prior, so nothing is reversed. A fix that
  // routed every enqueue in this file by a source row would break this and nothing else would notice.
  reset([])
  openReceivables = [{
    id: 'so-1',
    orderNumber: 'SO-1',
    externalOrderNumber: null,
    invoiceNumber: 'INV-1',
    currency: 'USD',
    totalForeign: 100,
    totalBase: 80,
    fxRateToBase: 0.8,
    payments: [],
  }]
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')

  const result = await runArApFxRevaluation({ valuationDate: '2026-06-02' })

  assert.equal(result.success, true)
  assert.equal(result.reversed, 0, 'precondition: no prior, so this test is about the fresh half only')
  const revaluations = enqueued.filter((row) => row.kind === 'revaluation')
  assert.ok(revaluations.length >= 1, `precondition: a revaluation was enqueued. Got ${JSON.stringify(enqueued)}`)
  for (const row of revaluations) {
    assert.equal(
      row.chartConnector,
      ACTIVE_CONNECTOR,
      'the revaluation’s codes ARE this settings object’s (`accounts.controlAccount` / '
      + '`accounts.fxGainLossAccount`), so its chart is `settings.connector`',
    )
    assert.ok(
      row.accountCodes.every((code) => code.startsWith('X-')),
      `and they really are this chart’s codes: ${row.accountCodes.join(', ')}`,
    )
  }
})

test('[o3d-j625 r2] a source row naming a connector this build cannot route is REFUSED and REPORTED', async () => {
  // Not a hypothetical: PR #680 removed a connector from this build, and the column is a plain string
  // with a default. Neither substitute is available — `settings.connector` is the mis-attribution, and
  // `null` answers `not-configured`, which is the one no-op an obligation ledger may settle with.
  reset([priorRevaluation('some-retired-connector'), TODAYS_REVALUATION])
  const { runArApFxRevaluation } = await import('@/lib/accounting-fx-revaluation')

  const result = await runArApFxRevaluation({ valuationDate: '2026-06-02' })

  assert.equal(result.success, true)
  assert.deepEqual(
    enqueued.filter((row) => row.kind === 'reversal'),
    [],
    'nothing may be queued for a reversal whose books cannot be identified',
  )
  assert.equal(result.reversed, 0, 'and it must not be counted as reversed')
  const reports = activity.filter((entry) => entry.action === 'unrealised_fx_reversal_unroutable_source_connector')
  assert.equal(reports.length, 1, `the refusal must leave a record. Activity: ${JSON.stringify(activity)}`)
  assert.match(reports[0].description, /NOTHING WAS QUEUED/)
  assert.match(reports[0].description, /still OUTSTANDING/)
  assert.match(reports[0].description, /some-retired-connector/)
  assert.equal(reports[0].metadata?.sourceConnector, 'some-retired-connector')
  assert.equal(reports[0].metadata?.sourceEntryId, 'reval-prior')
})
