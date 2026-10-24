import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { toDecimal } from '../../../lib/domain/math/decimal.ts'

/**
 * END TO END through syncXeroAccountBalanceSnapshots with a mocked xeroGet: the live organisation's rows for
 * 2026-10-23 must be stored as YTD Debit minus YTD Credit, and a row that cannot be read must store NOTHING for
 * its account.
 */

type Persisted = Array<{ accountCode?: string | null; amountBase: unknown; financialYearEnd?: string | null; tenantId?: string | null }>
let persisted: Persisted = []
let persistCalls = 0
let trialBalance: unknown = {}
/** When set, the Xero `Accounts` response (the CURRENT chart) instead of one active account per entry of `chart`. */
let chartOverride: Array<Record<string, unknown>> | null = null
let chartFetchOk = true
/** When set, the SECOND `Accounts` read of a pull (after the Trial Balance) answers this instead: Xero moved something in between. */
let chartAfter: Array<Record<string, unknown>> | null = null
let chartReads = 0
let chartWrites = 0
let orgFields: Record<string, number | undefined> = {}
const chart = [
  { externalAccountId: 'a-310', code: '310', name: 'Cost of Goods Sold' },
  { externalAccountId: 'a-631', code: '631', name: 'Inventory Control' },
  { externalAccountId: 'a-810', code: '810', name: 'Income in Advance' },
]

mock.module('@/lib/db', { namedExports: { db: { accountingAccount: { findMany: async () => chart }, setting: { upsert: async () => undefined } } } })
mock.module('@/lib/connectors/xero/auth', { namedExports: { getGrantedScopes: async () => null } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_inventory_account: '631', xero_allocated_inventory_account: '', xero_cogs_account: '310', xero_transit_account: '', xero_unearned_revenue_account: '810',
    }),
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => path.startsWith('Accounts') && (chartReads += 1) > 0 && !chartFetchOk ? { ok: false, error: 'Xero HTTP 503' } : ({ ok: true, data: path.startsWith('Accounts') ? chartOverride ? { Accounts: chartReads > 1 && chartAfter ? chartAfter : chartOverride } : { Accounts: chart.map((a) => ({ AccountID: a.externalAccountId, Code: a.code, Name: a.name, Type: 'ASSET', TaxType: 'NONE', Status: 'ACTIVE', Class: 'ASSET' })) } : trialBalance }),
    xeroGetCached: async () => ({ ok: true, data: { Organisations: [{ BaseCurrency: 'GBP', ...orgFields }] } }),
  },
})
mock.module('@/lib/connectors/xero/connection-fence', {
  namedExports: {
    captureXeroConnection: async () => ({ tenantId: 'tenant-x', connectionGeneration: 'gen-1' }),
    withXeroConnectionFence: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => ({ ok: true, value: await fn({ accountingAccount: { upsert: async () => { chartWrites += 1 }, updateMany: async () => undefined }, setting: { upsert: async () => undefined } }) }),
  },
})
mock.module('@/lib/domain/accounting/account-balance-snapshots', {
  namedExports: {
    balanceDateString: (d: Date | string) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10)),
    persistAccountingAccountBalanceSnapshots: async (inputs: Persisted) => { persistCalls += 1; persisted = inputs; return { attempted: inputs.length, persisted: inputs.length, snapshots: [] } },
  },
})

const cells = (...values: string[]) => values.map((Value, i) => (i === 0 ? { Value, Attributes: [{ Id: 'account', Value: `a-${/\((\d+)\)/.exec(Value)![1]}` }] } : { Value }))
const LIVE_META = { ReportID: 'TrialBalance', ReportName: 'Trial Balance', ReportType: 'TrialBalance', ReportTitles: ['Trial Balance', 'One Two Enterprises Ltd', 'As at 23 October 2026'], ReportDate: '24 October 2026', UpdatedDateUTC: '/Date(1792884279700)/' }
const header = () => ({ RowType: 'Header', Cells: ['Account', 'Debit', 'Credit', 'YTD Debit', 'YTD Credit'].map((Value) => ({ Value })) })
const realReport = (...extra: unknown[]) => ({
  Reports: [{
    ...LIVE_META,
    ReportName: 'Trial Balance',
    Rows: [
      header(),
      { RowType: 'Section', Title: 'Revenue', Rows: [{ RowType: 'Row', Cells: cells('Income in Advance (810)', '11.88', '', '', '100.81') }] },
      { RowType: 'Section', Title: 'Expenses', Rows: [{ RowType: 'Row', Cells: cells('Cost of Goods Sold (310)', '9171.62', '', '73019.20', '') }] },
      { RowType: 'Section', Title: 'Assets', Rows: [{ RowType: 'Row', Cells: cells('Inventory Control (631)', '', '8164.12', '123639.63', '') }, ...extra] },
    ],
  }],
})

async function pull() {
  persisted = []; persistCalls = 0; chartWrites = 0; chartReads = 0
  const { syncXeroAccountBalanceSnapshots } = await import('../../../lib/connectors/xero/account-balances.ts')
  return syncXeroAccountBalanceSnapshots({ balanceDate: '2026-10-23', syncRunId: 'run-1' })
}
const stored = () => Object.fromEntries(persisted.map((s) => [s.accountCode, toDecimal(s.amountBase as string).toFixed(2)]))

test('the live 2026-10-23 report stores 73019.20 / 123639.63 / -100.81', async () => {
  trialBalance = realReport()
  const result = await pull()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(stored(), { '310': '73019.20', '631': '123639.63', '810': '-100.81' })
})

test('a configured account whose row has a non-money YTD cell stores NOTHING and errors by name; the others store', async () => {
  trialBalance = realReport()
  ;(trialBalance as { Reports: Array<{ Rows: Array<{ Rows?: Array<{ Cells: Array<{ Value: string }> }> }> }> }).Reports[0]!.Rows[2]!.Rows![0]!.Cells[3]!.Value = 'N/A'
  const result = await pull()
  assert.deepEqual(stored(), { '631': '123639.63', '810': '-100.81' })
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0]!, /310.*TB_NON_MONEY_CELL/)
})

test('a report with no Header stores nothing at all and errors by name', async () => {
  trialBalance = realReport()
  ;(trialBalance as { Reports: Array<{ Rows: unknown[] }> }).Reports[0]!.Rows.shift()
  const result = await pull()
  assert.equal(persistCalls, 0)
  assert.equal(result.persisted, 0)
  assert.match(result.errors[0]!, /^TB_NO_HEADER/)
})

test('a Header with no YTD columns stores nothing at all and errors by name', async () => {
  trialBalance = realReport()
  ;(trialBalance as { Reports: Array<{ Rows: Array<{ Cells: Array<{ Value: string }> }> }> }).Reports[0]!.Rows[0]!.Cells.length = 3
  const result = await pull()
  assert.equal(persistCalls, 0)
  assert.match(result.errors[0]!, /^TB_NO_YTD_COLUMNS/)
})

test('a short row for a configured account is refused and not stored', async () => {
  trialBalance = realReport()
  ;(trialBalance as { Reports: Array<{ Rows: Array<{ Rows?: Array<{ Cells: unknown[] }> }> }> }).Reports[0]!.Rows[1]!.Rows![0]!.Cells.pop()
  const result = await pull()
  assert.deepEqual(stored(), { '310': '73019.20', '631': '123639.63' })
  assert.match(result.errors[0]!, /810.*TB_ROW_CELL_COUNT/)
})

test('a refused row for an account that is NOT configured does not block the configured ones', async () => {
  trialBalance = realReport({ RowType: 'Row', Cells: cells('Bank (090)', 'x', 'y') })
  const result = await pull()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(stored(), { '310': '73019.20', '631': '123639.63', '810': '-100.81' })
})

test('the organisation financial-year end is stored WITH each snapshot, with the tenant', async () => {
  trialBalance = realReport()
  orgFields = { FinancialYearEndMonth: 3, FinancialYearEndDay: 31 }
  const result = await pull()
  orgFields = {}
  assert.deepEqual(result.errors, [])
  assert.deepEqual(persisted.map((s) => [s.accountCode, s.financialYearEnd, s.tenantId]).sort(), [['310', '03-31', 'tenant-x'], ['631', '03-31', 'tenant-x'], ['810', '03-31', 'tenant-x']])
})

test('an Organisation without a valid year end stores null on every snapshot (the previous value is never carried over)', async () => {
  for (const fields of [{} as Record<string, number>, { FinancialYearEndMonth: 2, FinancialYearEndDay: 30 }, { FinancialYearEndMonth: 0, FinancialYearEndDay: 1 }]) {
    trialBalance = realReport()
    orgFields = fields
    await pull()
    assert.deepEqual(persisted.map((s) => s.financialYearEnd), [null, null, null], JSON.stringify(fields))
  }
  orgFields = {}
})

test('a year end that changes between two pulls is stored as it was at each pull', async () => {
  trialBalance = realReport()
  orgFields = { FinancialYearEndMonth: 12, FinancialYearEndDay: 31 }
  await pull()
  const first = persisted.map((s) => s.financialYearEnd)
  orgFields = { FinancialYearEndMonth: 3, FinancialYearEndDay: 31 }
  await pull()
  orgFields = {}
  assert.deepEqual([first[0], persisted[0]!.financialYearEnd], ['12-31', '03-31'])
})

test('a blank-label row carrying a configured account id and a balance stores nothing for that account (not a zero) and errors by name', async () => {
  const blank = { RowType: 'Row', Cells: [{ Value: '', Attributes: [{ Id: 'account', Value: 'a-631' }] }, ...['', '', '5000', ''].map((Value) => ({ Value }))] }
  trialBalance = realReport()
  const rows = (trialBalance as { Reports: Array<{ Rows: Array<{ Rows?: unknown[] }> }> }).Reports[0]!.Rows[3]!.Rows!
  rows.splice(0, 1, blank)
  const result = await pull()
  assert.deepEqual(stored(), { '310': '73019.20', '810': '-100.81' })
  assert.match(result.errors[0]!, /631.*TB_BLANK_LABEL/)
})

const acct = (id: string, code: string, status = 'ACTIVE') => ({ AccountID: id, Code: code, Name: `acct ${code}`, Type: 'ASSET', TaxType: 'NONE', Status: status, Class: 'ASSET' })
const idless = (label: string, ytdDebit: string) => ({ RowType: 'Row', Cells: [{ Value: label }, ...['', '', ytdDebit, ''].map((Value) => ({ Value }))] })
const withChart = async (accounts: Array<Record<string, unknown>> | null, run: () => Promise<void>) => { chartOverride = accounts; try { await run() } finally { chartOverride = null; chartAfter = null; chartFetchOk = true } }
const reportWith = (...rows: unknown[]) => ({ Reports: [{ ...LIVE_META, Rows: [header(), { RowType: 'Section', Rows: rows }] }] })

test('CURRENT CHART: a code Xero moved to another account is stored under the NEW account\'s id (id-less row), never the stale local one', async () => {
  trialBalance = reportWith(idless('Inventory Control (631)', '500'), idless('Cost of Goods Sold (310)', '5'), idless('Income in Advance (810)', '1'))
  await withChart([acct('a-NEW', '631'), acct('a-310', '310'), acct('a-810', '810'), acct('a-631', '631', 'ARCHIVED')], async () => {
    const result = await pull()
    // 631 now has an archived duplicate: the id-less row cannot be told apart, so it is refused for 631 and 310/810 (unique) store.
    assert.deepEqual(stored(), { '310': '5.00', '810': '1.00' })
    assert.match(result.errors.join(' '), /TB_CODE_NOT_UNIQUE/)
  })
})

test('CURRENT CHART: an id-less row is read by code when the fresh chart has exactly one account with that code', async () => {
  trialBalance = reportWith(idless('Inventory Control (631)', '500'), idless('Cost of Goods Sold (310)', '5'), idless('Income in Advance (810)', '1'))
  await withChart([acct('a-NEW', '631'), acct('a-310', '310'), acct('a-810', '810')], async () => {
    const result = await pull()
    assert.deepEqual(result.errors, [])
    assert.deepEqual(persisted.map((s) => [s.accountCode, (s as { externalAccountId?: string }).externalAccountId]).sort(), [['310', 'a-310'], ['631', 'a-NEW'], ['810', 'a-810']])
  })
})

test('CURRENT CHART: the old account\'s row (carrying its id) is not stored under the code\'s new holder', async () => {
  trialBalance = reportWith({ RowType: 'Row', Cells: cells('Inventory Control (631)', '', '', '777', '') }, idless('Cost of Goods Sold (310)', '5'), idless('Income in Advance (810)', '1'))
  await withChart([acct('a-NEW', '631'), acct('a-310', '310'), acct('a-810', '810')], async () => {
    const result = await pull()
    assert.deepEqual(stored(), { '310': '5.00', '810': '1.00' })
    assert.match(result.errors.join(' '), /TB_ACCOUNT_ID_CONFLICT/)
  })
})

test('CURRENT CHART: a configured code held by two ACTIVE accounts, or by none, stores nothing for it and errors by name', async () => {
  trialBalance = realReport()
  await withChart([acct('a-631', '631'), acct('a-631b', '631'), acct('a-310', '310')], async () => {
    const result = await pull()
    assert.deepEqual(stored(), { '310': '73019.20' })
    assert.equal(result.errors.filter((e) => /^TB_CHART_CODE_UNRESOLVED/.test(e)).length, 2, 'two active holders of 631, no 810')
  })
})

test('CURRENT CHART: the chart fetch is GET-only, failing it stores nothing, and a good pull refreshes the local chart in the same transaction', async () => {
  trialBalance = realReport()
  chartFetchOk = false
  const failed = await pull()
  chartFetchOk = true
  assert.equal(persistCalls, 0)
  assert.equal(chartWrites, 0)
  assert.match(failed.errors[0]!, /current Xero chart/)
  await pull()
  assert.equal(chartWrites, 3, 'the fetched chart was written inside the fenced transaction')
})

// ---- end to end: absent-means-zero needs completeness evidence; duplicate rows ----------------------------------------------
const totalRowE2E = (debit: string, credit: string) => ({ RowType: 'SummaryRow', Cells: ['Total', '', '', debit, credit].map((Value) => ({ Value })) })
const completeReport = (total: unknown) => ({
  Reports: [{
    ...LIVE_META,
    Rows: [
      header(),
      { RowType: 'Section', Title: 'Revenue', Rows: [{ RowType: 'Row', Cells: cells('Income in Advance (810)', '11.88', '', '', '100.81') }] },
      { RowType: 'Section', Title: 'Expenses', Rows: [{ RowType: 'Row', Cells: cells('Cost of Goods Sold (310)', '9171.62', '', '73019.20', '') }] },
      // 631 is ABSENT from the rows; the equity row makes the report balance without it.
      { RowType: 'Section', Title: 'Equity', Rows: [{ RowType: 'Row', Cells: cells('Owner Funds (970)', '', '', '', '72918.39') }, total] },
    ],
  }],
})

test('COMPLETE report (rows add up to the Total) with 631 absent: 631 is stored as zero', async () => {
  trialBalance = completeReport(totalRowE2E('73019.20', '73019.20'))
  const result = await pull()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(stored(), { '310': '73019.20', '631': '0.00', '810': '-100.81' })
})

test('PARTIAL report (Total counts more than the rows) with 631 absent: 631 withheld by name, the others stored, no stamp', async () => {
  trialBalance = completeReport(totalRowE2E('196658.83', '196658.83'))
  const result = await pull()
  assert.deepEqual(stored(), { '310': '73019.20', '810': '-100.81' })
  assert.match(result.errors[0]!, /TB_COMPLETENESS_UNPROVEN.*631/)
})

test('no Total row, or one the rows do not reach: 631 withheld', async () => {
  for (const total of [{ RowType: 'Section', Rows: [] }, totalRowE2E('73019.20', '73000.00')]) {
    trialBalance = completeReport(total)
    const result = await pull()
    assert.deepEqual(stored(), { '310': '73019.20', '810': '-100.81' })
    assert.match(result.errors[0]!, /TB_COMPLETENESS_UNPROVEN/)
  }
})

test('two rows for one configured account: that account is refused, not the first row taken', async () => {
  trialBalance = realReport()
  const rows = (trialBalance as { Reports: Array<{ Rows: Array<{ Rows?: unknown[] }> }> }).Reports[0]!.Rows[3]!.Rows!
  rows.push({ RowType: 'Row', Cells: cells('Inventory Control (631)', '', '', '1', '') })
  const result = await pull()
  assert.deepEqual(stored(), { '310': '73019.20', '810': '-100.81' })
  assert.match(result.errors[0]!, /TB_DUPLICATE_ACCOUNT_ROW/)
})

test('RACE: a code Xero moves to another account between the chart read and the Trial Balance read stores nothing for that code', async () => {
  trialBalance = reportWith(idless('Inventory Control (631)', '500'), idless('Cost of Goods Sold (310)', '5'), idless('Income in Advance (810)', '1'))
  await withChart([acct('a-631', '631'), acct('a-310', '310'), acct('a-810', '810')], async () => {
    chartAfter = [acct('a-NEW', '631'), acct('a-310', '310'), acct('a-810', '810')]
    const result = await pull()
    assert.deepEqual(stored(), { '310': '5.00', '810': '1.00' })
    assert.match(result.errors.join(' '), /TB_CHART_CHANGED_DURING_PULL.*631/)
    assert.equal(chartReads, 2, 'chart before, chart after')
  })
})

test('RACE: the code gaining a second holder in between also refuses it (uniqueness is compared too)', async () => {
  trialBalance = reportWith(idless('Inventory Control (631)', '500'), idless('Cost of Goods Sold (310)', '5'), idless('Income in Advance (810)', '1'))
  await withChart([acct('a-631', '631'), acct('a-310', '310'), acct('a-810', '810')], async () => {
    chartAfter = [acct('a-631', '631'), acct('a-OLD', '631', 'ARCHIVED'), acct('a-310', '310'), acct('a-810', '810')]
    const result = await pull()
    assert.deepEqual(stored(), { '310': '5.00', '810': '1.00' })
    assert.match(result.errors.join(' '), /TB_CHART_CHANGED_DURING_PULL.*631/)
  })
})

test('RACE: an unchanged chart across both reads stores everything and the pull reads the chart twice', async () => {
  trialBalance = realReport()
  const result = await pull()
  assert.deepEqual(result.errors, [])
  assert.equal(chartReads, 2)
})

// ---- the report must be AS AT the requested date (ReportDate is the generation date and is not read) -----------------------
const withMeta = (change: (entry: Record<string, unknown>) => void) => {
  trialBalance = realReport()
  change((trialBalance as { Reports: Array<Record<string, unknown>> }).Reports[0]!)
}

test('LIVE SHAPE: ReportDate is the day AFTER the as-at date (generation date) and does not cause a refusal', async () => {
  withMeta((entry) => { assert.equal(entry.ReportDate, '24 October 2026') })
  const result = await pull()
  assert.deepEqual(result.errors, [])
  assert.equal(persisted.length, 3)
})

test('DATE: a report as at a different day is refused whole, whatever its other fields say', async () => {
  withMeta((entry) => { entry.ReportTitles = ['Trial Balance', 'Org', 'As at 22 October 2026'] })
  const result = await pull()
  assert.equal(persistCalls, 0)
  assert.match(result.errors[0]!, /^TB_REPORT_DATE_MISMATCH.*as at 2026-10-22/)
})

test('DATE: titles without an "As at" line, two of them, or an unreadable one, are refused', async () => {
  for (const titles of [['Trial Balance', 'Org'], ['Trial Balance', 'As at 23 October 2026', 'As at 23 October 2026'], ['As at 2026-10-23'], ['As at 31 February 2026'], ['As at 23 Octob 2026'], undefined]) {
    withMeta((entry) => { entry.ReportTitles = titles })
    const result = await pull()
    assert.equal(persistCalls, 0, JSON.stringify(titles))
    assert.match(result.errors[0]!, /^TB_REPORT_DATE_MISMATCH/, JSON.stringify(titles))
  }
})

test('DATE: a report that is not a TrialBalance is refused', async () => {
  withMeta((entry) => { entry.ReportType = 'ProfitAndLoss' })
  assert.match((await pull()).errors[0]!, /^TB_REPORT_DATE_MISMATCH.*ProfitAndLoss/)
})

test('DATE: ReportDate matching the request does NOT stand in for a missing or different As-at title', async () => {
  withMeta((entry) => { entry.ReportDate = '23 October 2026'; entry.ReportTitles = ['Trial Balance', 'Org', 'As at 24 October 2026'] })
  const result = await pull()
  assert.equal(persistCalls, 0)
  assert.match(result.errors[0]!, /^TB_REPORT_DATE_MISMATCH/)
})
