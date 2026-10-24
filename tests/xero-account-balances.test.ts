import assert from 'node:assert/strict'
import test from 'node:test'

import { buildXeroAccountBalanceSnapshotInputs, parseXeroTrialBalanceReport, parseXeroTrialBalanceRows } from '@/lib/connectors/xero/account-balances'
import { toDecimal } from '@/lib/domain/math/decimal'

const HEADER = { RowType: 'Header', Cells: ['Account', 'Debit', 'Credit', 'YTD Debit', 'YTD Credit'].map((Value) => ({ Value })) }
const row = (...values: string[]) => ({ RowType: 'Row', Cells: values.map((Value) => ({ Value })) })
const report = (...rows: unknown[]) => ({ Reports: [{ Rows: rows }] }) as Parameters<typeof parseXeroTrialBalanceRows>[0]

// The three rows below are REAL rows from the live organisation (report date 2026-10-23).
const REAL = {
  cogs: row('Cost of Goods Sold (310)', '9171.62', '', '73019.20', ''),
  inventory: row('Inventory Control (631)', '', '8164.12', '123639.63', ''),
  advance: row('Income in Advance (810)', '11.88', '', '', '100.81'),
}

test('the three real organisation rows read YTD Debit minus YTD Credit, never the shifted movement cells', () => {
  const rows = parseXeroTrialBalanceRows(report(HEADER, { RowType: 'Section', Title: 'Mixed', Rows: [REAL.cogs, REAL.inventory, REAL.advance] }))
  assert.deepEqual(rows.map((r) => [r.accountCode, r.amount.toFixed(2)]), [['310', '73019.20'], ['631', '123639.63'], ['810', '-100.81']])
})

test('a row with every cell empty is a genuine zero (not dropped, not misread)', () => {
  const rows = parseXeroTrialBalanceRows(report(HEADER, row('Suspense (900)', '', '', '', '')))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.amount.toFixed(2), '0.00')
})

test('a row with both YTD cells non-zero is debit minus credit, with thousands separators and parentheses', () => {
  const rows = parseXeroTrialBalanceRows(report(HEADER, row('500 - Inventory Asset', '1', '2', '2,000.00', '(125.50)'), row('600 - COGS', '', '', '10', '4')))
  assert.deepEqual(rows.map((r) => r.amount.toFixed(2)), ['2125.50', '6.00'])
})

test('columns are found by NAME: a Header in a different order still reads correctly', () => {
  const header = { RowType: 'Header', Cells: ['Account', 'YTD Credit', 'YTD Debit', 'Credit', 'Debit'].map((Value) => ({ Value })) }
  const rows = parseXeroTrialBalanceRows(report(header, row('Income in Advance (810)', '100.81', '', '', '11.88'), row('Cost of Goods Sold (310)', '', '73019.20', '', '9171.62')))
  assert.deepEqual(rows.map((r) => r.amount.toFixed(2)), ['-100.81', '73019.20'])
})

test('header names match case-insensitively and ignore surrounding spaces', () => {
  const header = { RowType: 'Header', Cells: ['Account', 'Debit', 'Credit', ' ytd debit ', 'YTD CREDIT'].map((Value) => ({ Value })) }
  assert.equal(parseXeroTrialBalanceRows(report(header, row('310 Cost of Goods Sold', '', '', '5', '')))[0]!.amount.toFixed(2), '5.00')
})

test('Xero groups accounts under Sections: rows nested inside Rows are read with the top-level Header', () => {
  const parsed = parseXeroTrialBalanceReport({
    Reports: [{
      ReportName: 'Trial Balance',
      Rows: [
        HEADER,
        { RowType: 'Section', Title: 'Revenue', Rows: [{ ...REAL.advance, Rows: undefined }, { RowType: 'SummaryRow', Cells: [{ Value: 'Total Revenue' }, { Value: '1' }, { Value: '' }] }] },
        { RowType: 'Section', Title: 'Assets', Rows: [{ RowType: 'Section', Title: 'Current', Rows: [REAL.inventory] }, REAL.cogs] },
        { RowType: 'Section', Title: '', Rows: [{ RowType: 'SummaryRow', Cells: ['Total', '1', '2', '3', '4'].map((Value) => ({ Value })) }] },
      ],
    }],
  })
  assert.equal(parsed.reportError, null)
  assert.deepEqual(parsed.refusedRows, [])
  assert.deepEqual(parsed.rows.map((r) => [r.accountCode, r.amount.toFixed(2)]), [['810', '-100.81'], ['631', '123639.63'], ['310', '73019.20']])
})

test('account identity still comes from the label cell and its Attributes', () => {
  const labelled = { RowType: 'Row', Cells: [{ Value: '500 - Inventory Asset', Attributes: [{ Id: 'account', Value: 'xero-account-500' }, { Id: 'accountCode', Value: '500' }] }, ...['', '', '150.25', ''].map((Value) => ({ Value }))] }
  const [r] = parseXeroTrialBalanceRows(report(HEADER, labelled))
  assert.equal(r!.externalAccountId, 'xero-account-500')
  assert.equal(r!.accountCode, '500')
  assert.equal(r!.accountName, 'Inventory Asset')
  assert.equal(r!.amount.toFixed(6), '150.250000')
})

test('a non-money cell in a YTD column refuses THAT row by name; the other rows are still read', () => {
  const parsed = parseXeroTrialBalanceReport(report(HEADER, row('Bad (100)', '', '', 'n/a', ''), row('Dash (101)', '', '', '-', ''), row('Good (102)', '', '', '1', '')))
  assert.deepEqual(parsed.rows.map((r) => r.accountCode), ['102'])
  assert.deepEqual(parsed.refusedRows.map((r) => [r.code, r.accountCode]), [['TB_NON_MONEY_CELL', '100'], ['TB_NON_MONEY_CELL', '101']])
  assert.match(parsed.refusedRows[0]!.message, /^TB_NON_MONEY_CELL: .*"Bad \(100\)".*YTD Debit/)
})

test('a null or missing cell value is not an empty string: the row is refused', () => {
  const nullish = { RowType: 'Row', Cells: [{ Value: 'Null (103)' }, { Value: '' }, { Value: '' }, { Value: null }, { Value: '' }] }
  assert.equal(parseXeroTrialBalanceReport(report(HEADER, nullish)).refusedRows[0]!.code, 'TB_NON_MONEY_CELL')
})

test('a non-money cell in a movement column is irrelevant: only the YTD cells are read', () => {
  assert.equal(parseXeroTrialBalanceReport(report(HEADER, row('Odd (104)', 'x', 'y', '3', ''))).rows[0]!.amount.toFixed(2), '3.00')
})

test('a row whose cell count differs from the Header is refused, even if the YTD positions exist', () => {
  const parsed = parseXeroTrialBalanceReport(report(HEADER, row('Short (105)', '1', '2', '3'), row('Long (106)', '', '', '3', '', '9')))
  assert.deepEqual(parsed.rows, [])
  assert.deepEqual(parsed.refusedRows.map((r) => r.code), ['TB_ROW_CELL_COUNT', 'TB_ROW_CELL_COUNT'])
})

test('a report with no Header row is refused as a whole, by name, with no rows', () => {
  const parsed = parseXeroTrialBalanceReport(report({ RowType: 'Section', Rows: [REAL.cogs] }))
  assert.deepEqual(parsed.rows, [])
  assert.match(parsed.reportError ?? '', /^TB_NO_HEADER/)
  assert.throws(() => parseXeroTrialBalanceRows(report(REAL.cogs)), /TB_NO_HEADER/)
})

test('a Header without YTD columns is refused; the movement columns are never a balance', () => {
  const header = { RowType: 'Header', Cells: ['Account', 'Debit', 'Credit'].map((Value) => ({ Value })) }
  const parsed = parseXeroTrialBalanceReport(report(header, row('Cost of Goods Sold (310)', '9171.62', '')))
  assert.deepEqual(parsed.rows, [])
  assert.match(parsed.reportError ?? '', /^TB_NO_YTD_COLUMNS/)
  const onlyOne = { RowType: 'Header', Cells: ['Account', 'YTD Debit'].map((Value) => ({ Value })) }
  assert.match(parseXeroTrialBalanceReport(report(onlyOne, row('X (1)', '1'))).reportError ?? '', /^TB_NO_YTD_COLUMNS/)
})

test('a Header that repeats a YTD column is ambiguous and refused', () => {
  const header = { RowType: 'Header', Cells: ['Account', 'YTD Debit', 'YTD Debit', 'YTD Credit'].map((Value) => ({ Value })) }
  assert.match(parseXeroTrialBalanceReport(report(header, row('X (1)', '1', '2', '3'))).reportError ?? '', /^TB_AMBIGUOUS_COLUMNS/)
})

test('summary and section rows are not account rows', () => {
  const rows = parseXeroTrialBalanceRows(report(HEADER, { RowType: 'Section', Cells: ['Total Assets', '', '', '10000', ''].map((Value) => ({ Value })), Rows: [{ RowType: 'SummaryRow', Cells: ['Total Inventory', '', '', '5000', ''].map((Value) => ({ Value })) }] }, row('500 - Inventory Asset', '', '', '125.50', '')))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.accountCode, '500')
})

test('buildXeroAccountBalanceSnapshotInputs: a configured account whose row was refused gets a named error and NO snapshot; others are stored', () => {
  const parsed = parseXeroTrialBalanceReport(report(HEADER, row('Inventory Control (631)', '', '', 'n/a', ''), row('Cost of Goods Sold (310)', '', '', '5', '')))
  const result = buildXeroAccountBalanceSnapshotInputs({
    balanceDate: '2026-10-23',
    baseCurrency: 'GBP',
    accounts: [{ externalAccountId: 'a-631', code: '631', name: 'Inventory Control' }, { externalAccountId: 'a-310', code: '310', name: 'Cost of Goods Sold' }],
    parsedRows: parsed.rows,
    refusedRows: parsed.refusedRows,
  })
  assert.deepEqual(result.snapshots.map((s) => s.accountCode), ['310'])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0]!, /631.*TB_NON_MONEY_CELL/)
})

test('a refused row alone (nothing else parsed) still gives the refusal error, not a stored zero and not the generic no-match error', () => {
  const parsed = parseXeroTrialBalanceReport(report(HEADER, row('Inventory Control (631)', '1')))
  const result = buildXeroAccountBalanceSnapshotInputs({
    balanceDate: '2026-10-23', baseCurrency: 'GBP',
    accounts: [{ externalAccountId: 'a-631', code: '631', name: 'Inventory Control' }],
    parsedRows: parsed.rows, refusedRows: parsed.refusedRows,
  })
  assert.deepEqual(result.snapshots, [])
  assert.match(result.errors[0]!, /TB_ROW_CELL_COUNT/)
})

test('buildXeroAccountBalanceSnapshotInputs synthesizes a zero snapshot for a configured account omitted from a non-empty Trial Balance, and prefers external id', () => {
  const result = buildXeroAccountBalanceSnapshotInputs({
    balanceDate: '2026-06-01',
    baseCurrency: 'GBP',
    accounts: [
      { externalAccountId: 'account-x', code: '500', name: 'Inventory Asset' },
      { externalAccountId: 'account-missing', code: '600', name: 'Allocated Inventory' },
    ],
    parsedRows: [
      { externalAccountId: 'other-account', accountCode: '500', accountName: 'Archived Inventory', amount: toDecimal('999') },
      { externalAccountId: 'account-x', accountCode: null, accountName: 'Inventory Asset', amount: toDecimal('123') },
    ],
  })

  // account-x matches by external id (not the 500-coded archived row).
  const inventory = result.snapshots.find((s) => s.externalAccountId === 'account-x')
  assert.ok(inventory)
  assert.equal(toDecimal(inventory.amountBase).toString(), '123')

  // The omitted account is a real chart account Xero left out because it is
  // zero — synthesize a zero snapshot rather than failing the whole sync (scjz.60c-1).
  const allocated = result.snapshots.find((s) => s.externalAccountId === 'account-missing')
  assert.ok(allocated)
  assert.equal(toDecimal(allocated.amountBase).toString(), '0')
  assert.deepEqual(result.errors, [])
})

test('buildXeroAccountBalanceSnapshotInputs still errors when the Trial Balance parsed no rows at all (fetch/parse failure, not a genuine zero)', () => {
  const result = buildXeroAccountBalanceSnapshotInputs({
    balanceDate: '2026-06-01',
    baseCurrency: 'GBP',
    accounts: [{ externalAccountId: 'account-x', code: '500', name: 'Inventory Asset' }],
    parsedRows: [],
  })

  assert.equal(result.snapshots.length, 0)
  assert.deepEqual(result.errors, ['No Trial Balance row matched configured account 500 (Inventory Asset).'])
})

test('a Header that Xero nests inside a wrapper Row is still found', () => {
  const rows = parseXeroTrialBalanceRows(report({ RowType: 'Section', Rows: [HEADER, REAL.cogs] }))
  assert.equal(rows[0]!.amount.toFixed(2), '73019.20')
})

const ACCOUNT_631 = { externalAccountId: 'a-631', code: '631', name: 'Inventory Control' }
const buildFor = (accounts: Array<{ externalAccountId: string; code: string | null; name: string }>, rows: unknown[]) => {
  const parsed = parseXeroTrialBalanceReport(report(HEADER, ...rows))
  return buildXeroAccountBalanceSnapshotInputs({ balanceDate: '2026-10-23', baseCurrency: 'GBP', accounts, parsedRows: parsed.rows, refusedRows: parsed.refusedRows })
}

test('a trailing currency suffix after the code does not hide the code', () => {
  const [r] = parseXeroTrialBalanceRows(report(HEADER, row('Inventory Control (631) (GBP)', '', '', '5', '')))
  assert.equal(r!.accountCode, '631')
  assert.equal(r!.accountName, 'Inventory Control')
  const [legacy] = parseXeroTrialBalanceRows(report(HEADER, row('500 Inventory Asset (GBP)', '', '', '5', '')))
  assert.equal(legacy!.accountCode, '500')
  assert.equal(legacy!.accountName, 'Inventory Asset')
})

test('a refused row that cannot be tied to any account refuses the WHOLE report: no absent account becomes a stored zero', () => {
  // No code (no digit anywhere), no id, refused for its YTD cell; another row parses fine.
  const result = buildFor([ACCOUNT_631], [row('Mystery Inventory', '', '', 'N/A', ''), row('Cost of Goods Sold (310)', '', '', '5', '')])
  assert.deepEqual(result.snapshots, [])
  assert.match(result.errors[0]!, /^TB_UNIDENTIFIED_REFUSED_ROW/)
})

test('the same row WITH its code is attributed to its account, so the report is not wholly refused', () => {
  const result = buildFor([ACCOUNT_631, { externalAccountId: 'a-310', code: '310', name: 'COGS' }], [row('Inventory Control (631) (GBP)', '', '', 'N/A', ''), row('Cost of Goods Sold (310)', '', '', '5', '')])
  assert.deepEqual(result.snapshots.map((s) => s.accountCode), ['310'])
  assert.match(result.errors[0]!, /631.*TB_NON_MONEY_CELL/)
})

const withId = (label: string, id: string, ytdDebit: string) => ({ RowType: 'Row', Cells: [{ Value: label, Attributes: [{ Id: 'account', Value: id }] }, ...['', '', ytdDebit, ''].map((Value) => ({ Value }))] })

test('a row whose account id differs from the configured account is never stored under it, even if the code matches', () => {
  const result = buildFor([ACCOUNT_631], [withId('Other Account (631)', 'a-OTHER', '777'), row('Cost of Goods Sold (310)', '', '', '5', '')])
  assert.deepEqual(result.snapshots, [])
  assert.match(result.errors[0]!, /^TB_ACCOUNT_ID_CONFLICT/)
})

test('the configured account\'s own id row wins over a different-id row with the same code', () => {
  const result = buildFor([ACCOUNT_631], [withId('Other Account (631)', 'a-OTHER', '777'), withId('Inventory Control (631)', 'a-631', '123')])
  assert.deepEqual(result.snapshots.map((s) => String(s.amountBase)), ['123'])
  assert.deepEqual(result.errors, [])
})

test('the code fallback still applies to a row that carries no id', () => {
  const result = buildFor([ACCOUNT_631], [row('Inventory Control (631)', '', '', '9', '')])
  assert.deepEqual(result.snapshots.map((s) => String(s.amountBase)), ['9'])
})

test('a refused row with a different id and the same code is a conflict too, not a zero for the configured account', () => {
  const result = buildFor([ACCOUNT_631], [{ RowType: 'Row', Cells: [{ Value: 'Other (631)', Attributes: [{ Id: 'account', Value: 'a-OTHER' }] }, ...['', '', 'N/A', ''].map((Value) => ({ Value }))] }, row('Cost of Goods Sold (310)', '', '', '5', '')])
  assert.deepEqual(result.snapshots, [])
  assert.match(result.errors[0]!, /TB_ACCOUNT_ID_CONFLICT/)
})
