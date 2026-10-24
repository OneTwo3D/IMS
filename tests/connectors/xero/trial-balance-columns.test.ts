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
    xeroGet: async () => ({ ok: true, data: trialBalance }),
    xeroGetCached: async () => ({ ok: true, data: { Organisations: [{ BaseCurrency: 'GBP', ...orgFields }] } }),
  },
})
mock.module('@/lib/connectors/xero/connection-fence', {
  namedExports: {
    captureXeroConnection: async () => ({ tenantId: 'tenant-x', connectionGeneration: 'gen-1' }),
    withXeroConnectionFence: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => ({ ok: true, value: await fn({ setting: { upsert: async () => undefined } }) }),
  },
})
mock.module('@/lib/domain/accounting/account-balance-snapshots', {
  namedExports: {
    balanceDateString: (d: Date | string) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10)),
    persistAccountingAccountBalanceSnapshots: async (inputs: Persisted) => { persistCalls += 1; persisted = inputs; return { attempted: inputs.length, persisted: inputs.length, snapshots: [] } },
  },
})

const cells = (...values: string[]) => values.map((Value, i) => (i === 0 ? { Value, Attributes: [{ Id: 'account', Value: `a-${/\((\d+)\)/.exec(Value)![1]}` }] } : { Value }))
const header = () => ({ RowType: 'Header', Cells: ['Account', 'Debit', 'Credit', 'YTD Debit', 'YTD Credit'].map((Value) => ({ Value })) })
const realReport = (...extra: unknown[]) => ({
  Reports: [{
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
  persisted = []; persistCalls = 0
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
