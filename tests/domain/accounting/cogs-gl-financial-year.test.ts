import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { formatFinancialYearEnd, parseFinancialYearEnd, windowCrossesFinancialYearStart } from '../../../lib/domain/accounting/financial-year.ts'

/**
 * COGS is a profit-and-loss account: its Trial Balance figure is year-to-date and restarts at the financial-year start, so the
 * GL COGS reconciliation must be WITHHELD (by name) for a window that crosses it, through the real movement reader.
 */
let accountType: string | null = 'DIRECTCOSTS'
let openingYearEnd: string | null = '12-31'
let closingYearEnd: string | null = '12-31'
let closingDate = '2027-01-02'

const snap = (id: string, date: string, amount: string) => ({
  id, connector: 'xero', externalAccountId: 'a-310', accountCode: '310', accountName: 'COGS', balanceDate: new Date(`${date}T00:00:00.000Z`),
  currency: 'GBP', amountForeign: amount, amountBase: amount, sourcePayloadRef: null, tenantId: 't1', financialYearEnd: openingYearEnd, syncRunId: null, fetchedAt: new Date(),
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingAccountBalanceSnapshot: {
        findFirst: async ({ where }: { where: { balanceDate: { lte: Date } } }) => {
          const d = where.balanceDate.lte.toISOString().slice(0, 10)
          return d >= closingDate ? { ...snap('c', closingDate, '40'), financialYearEnd: closingYearEnd } : snap('o', '2026-12-31', '900')
        },
      },
      accountingAccount: { findFirst: async () => (accountType === null ? null : { type: accountType }) },
      setting: { findUnique: async () => ({ value: '2026-01-01' }) },
      cogsSubledgerMovement: { aggregate: async () => ({ _sum: { baseDelta: 40 } }) },
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/accounting', {
  namedExports: {
    getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }),
    getAccountingSettingsFor: async () => ({ cogsAccount: '310' }),
    getAccountingSettings: async () => ({ cogsAccount: '310' }),
  },
})

async function reconcile() {
  const { loadCogsGlReconciliation } = await import('../../../lib/domain/accounting/cogs-gl-reconciliation.ts')
  return loadCogsGlReconciliation({ now: new Date(`${closingDate}T12:00:00.000Z`) })
}

test('the GL COGS reconciliation is withheld by name when the window crosses the financial-year start', async () => {
  accountType = 'DIRECTCOSTS'; openingYearEnd = '12-31'; closingYearEnd = '12-31'; closingDate = '2027-01-01'
  // opening is the day before the closing date: 2026-12-31, closing 2027-01-01 (YTD restarted).
  const result = await reconcile()
  assert.deepEqual(result, { available: false, reason: 'financial_year_boundary' })
})

test('a year end that changed between the two balances withholds a profit-and-loss account', async () => {
  accountType = 'EXPENSE'; openingYearEnd = '12-31'; closingYearEnd = '03-31'; closingDate = '2026-12-31'
  assert.deepEqual(await reconcile(), { available: false, reason: 'financial_year_boundary' })
})

test('financial-year helpers: 29 Feb year end, validation and the first-day rule', () => {
  assert.equal(formatFinancialYearEnd(2, 29), '02-29')
  assert.equal(formatFinancialYearEnd(2, 30), null)
  assert.equal(formatFinancialYearEnd(13, 1), null)
  assert.equal(formatFinancialYearEnd('3', 31), null)
  assert.equal(parseFinancialYearEnd('03-31')?.month, 3)
  assert.equal(parseFinancialYearEnd('3-31'), null)
  // year end 29 Feb: in 2027 (non-leap) the year ends 28 Feb, so 1 Mar is the start.
  assert.equal(windowCrossesFinancialYearStart('2027-02-28', '2027-03-01', { month: 2, day: 29 }), true)
  assert.equal(windowCrossesFinancialYearStart('2027-03-01', '2027-03-02', { month: 2, day: 29 }), false)
  // (opening, closing]: the opening day itself being the start is not crossing.
  assert.equal(windowCrossesFinancialYearStart('2027-01-01', '2027-01-05', { month: 12, day: 31 }), false)
  assert.equal(windowCrossesFinancialYearStart('2026-12-31', '2027-01-01', { month: 12, day: 31 }), true)
  // a long window spanning several years
  assert.equal(windowCrossesFinancialYearStart('2024-06-01', '2026-06-01', { month: 12, day: 31 }), true)
})
