import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING } from '../../lib/ops/read-sync-liveness-constants.ts'
import { toDecimal } from '../../lib/domain/math/decimal.ts'

/**
 * UNEARNED REVENUE IN THE XERO BALANCE PULL, and the label on a zero the pull invents.
 *
 * The pull makes ONE Trial Balance GET (and one Organisation lookup). Adding an account to the list must not add a
 * request, so the request count with and without the new account is compared, not assumed.
 */

type Persisted = Array<{ accountCode?: string | null; amountBase: unknown; sourcePayloadRef?: string | null; tenantId?: string | null }>
let getCalls: string[] = []
let cachedCalls: string[] = []
let persisted: Persisted = []
let stamps: string[] = []
let unearnedCode = '260'
let chart: Array<{ externalAccountId: string; code: string | null; name: string }> = []
let trialBalance: unknown = {}

mock.module('@/lib/db', { namedExports: { db: { accountingAccount: { findMany: async () => chart }, setting: { upsert: async () => { throw new Error('outside the fence') } } } } })
mock.module('@/lib/connectors/xero/auth', { namedExports: { getGrantedScopes: async () => null } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_inventory_account: '630', xero_allocated_inventory_account: '631', xero_cogs_account: '500', xero_transit_account: '632', xero_unearned_revenue_account: unearnedCode,
    }),
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => { getCalls.push(path); return { ok: true, data: path.startsWith('Accounts') ? { Accounts: chart.map((a) => ({ AccountID: a.externalAccountId, Code: a.code, Name: a.name, Type: 'ASSET', TaxType: 'NONE', Status: 'ACTIVE', Class: 'ASSET' })) } : trialBalance } },
    xeroGetCached: async (path: string) => { cachedCalls.push(path); return { ok: true, data: { Organisations: [{ BaseCurrency: 'GBP' }] } } },
  },
})
mock.module('@/lib/connectors/xero/connection-fence', {
  namedExports: {
    captureXeroConnection: async () => ({ tenantId: 'tenant-x', connectionGeneration: 'gen-1' }),
    withXeroConnectionFence: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      const tx = { accountingAccount: { upsert: async () => undefined, updateMany: async () => undefined }, setting: { upsert: async ({ where }: { where: { key: string } }) => { stamps.push(where.key) } }, snapshots: [] as Persisted }
      const value = await fn(tx)
      return { ok: true, value }
    },
  },
})
mock.module('@/lib/domain/accounting/account-balance-snapshots', {
  namedExports: {
    balanceDateString: (d: Date | string) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10)),
    persistAccountingAccountBalanceSnapshots: async (inputs: Persisted) => { persisted = inputs; return { attempted: inputs.length, persisted: inputs.length, snapshots: [] } },
  },
})

const LIVE_META = { ReportID: 'TrialBalance', ReportName: 'Trial Balance', ReportType: 'TrialBalance', ReportTitles: ['Trial Balance', 'One Two Enterprises Ltd', 'As at 19 October 2026'], ReportDate: '20 October 2026' }
const row = (id: string, label: string, debit: string, credit = '0') => ({ RowType: 'Row', Cells: [{ Value: label, Attributes: [{ Id: 'account', Value: id }] }, { Value: '0' }, { Value: '0' }, { Value: debit }, { Value: credit }] })
const TB_HEADER = { RowType: 'Header', Cells: ['Account', 'Debit', 'Credit', 'YTD Debit', 'YTD Credit'].map((Value) => ({ Value })) }
const FULL_CHART = [
  { externalAccountId: 'a-630', code: '630', name: 'Inventory' },
  { externalAccountId: 'a-631', code: '631', name: 'Allocated' },
  { externalAccountId: 'a-632', code: '632', name: 'Transit' },
  { externalAccountId: 'a-500', code: '500', name: 'COGS' },
  { externalAccountId: 'a-260', code: '260', name: 'Unearned Revenue' },
]

function reset() {
  getCalls = []; cachedCalls = []; persisted = []; stamps = []; unearnedCode = '260'
  chart = FULL_CHART
  trialBalance = { Reports: [{ ...LIVE_META, Rows: [TB_HEADER, { RowType: 'Section', Rows: [row('a-630', '630 - Inventory', '1000'), row('a-631', '631 - Allocated', '200'), row('a-632', '632 - Transit', '50'), row('a-500', '500 - COGS', '75'), row('a-260', '260 - Unearned Revenue', '0', '300')] }] }] }
}

async function pull() {
  const { syncXeroAccountBalanceSnapshots } = await import('../../lib/connectors/xero/account-balances.ts')
  return syncXeroAccountBalanceSnapshots({ balanceDate: '2026-10-19', syncRunId: 'run-1', recordScheduledPullSuccess: true })
}

test('configuredAccountCodes lists Unearned Revenue as the fifth account, trimmed, and drops a blank one', async () => {
  const { configuredAccountCodes } = await import('../../lib/connectors/xero/account-balances.ts')
  const base = { xero_inventory_account: ' 630 ', xero_allocated_inventory_account: '631', xero_cogs_account: '500', xero_transit_account: '632', xero_unearned_revenue_account: ' 260 ' }
  assert.deepEqual(configuredAccountCodes(base), ['630', '631', '500', '632', '260'])
  assert.deepEqual(configuredAccountCodes({ ...base, xero_unearned_revenue_account: '   ' }), ['630', '631', '500', '632'])
  assert.deepEqual(configuredAccountCodes({ ...base, xero_unearned_revenue_account: '' }), ['630', '631', '500', '632'])
})

// [mutation: unearned removed from configuredAccountCodes]
test('the pull stores an Unearned Revenue balance from the SAME Trial Balance response, signed debit minus credit', async () => {
  reset()
  const result = await pull()
  assert.deepEqual(result.errors, [])
  assert.equal(result.persisted, 5)
  const unearned = persisted.find((snapshot) => snapshot.accountCode === '260')
  assert.ok(unearned, 'the Unearned Revenue snapshot is stored')
  assert.equal(toDecimal(unearned.amountBase as string).toFixed(2), '-300.00')
  assert.equal(unearned.sourcePayloadRef, 'xero:trial-balance:2026-10-19')
  assert.deepEqual(stamps, [XERO_BALANCE_SNAPSHOT_LAST_SUCCESS_SETTING], 'a clean pull of all five advances the stamp')
})

// [mutation: a second request made for the new account]
test('ZERO EXTRA CALLS: the request count is identical with and without Unearned Revenue configured', async () => {
  reset()
  await pull()
  const withUnearned = { gets: [...getCalls], cached: [...cachedCalls] }
  reset()
  unearnedCode = ''
  chart = FULL_CHART.filter((account) => account.code !== '260')
  await pull()
  assert.deepEqual({ gets: getCalls, cached: cachedCalls }, withUnearned)
  // Three GETs: the pull brackets the Trial Balance with two reads of the CURRENT chart (Accounts), so a code Xero moves while the
  // report is in flight is caught; adding an account to the list still adds none.
  assert.equal(withUnearned.gets.length, 3)
  assert.equal(withUnearned.gets[0], 'Accounts')
  assert.match(withUnearned.gets[1]!, /^Reports\/TrialBalance\?date=2026-10-19$/)
  assert.equal(withUnearned.gets[2], 'Accounts')
  assert.equal(withUnearned.cached.length, 1)
})

test('an Unearned Revenue account that is configured but not in the chart stops the stamp: the pull did not store every configured account', async () => {
  reset()
  chart = FULL_CHART.filter((account) => account.code !== '260')
  const result = await pull()
  assert.equal(result.persisted, 4)
  assert.deepEqual(stamps, [], 'no success stamp, so the stream goes stale rather than looking current')
})

// [mutation: the absent suffix removed]
test('a configured account that a COMPLETE Trial Balance omits is stored as a zero labelled absent-from-complete-tb (the proof); a reported zero is not', async () => {
  reset()
  // Complete by its own evidence: the rows add up to the Total row (the offsetting credit is on an unconfigured equity account).
  trialBalance = { Reports: [{ ...LIVE_META, Rows: [TB_HEADER, { RowType: 'Section', Rows: [row('a-630', '630 - Inventory', '1000'), row('a-631', '631 - Allocated', '0', '0'), row('a-500', '500 - COGS', '75'), row('a-999', '999 - Equity', '0', '1075')] }, { RowType: 'Section', Rows: [{ RowType: 'SummaryRow', Cells: ['Total', '0', '0', '1075', '1075'].map((Value) => ({ Value })) }] }] }] }
  await pull()
  const byCode = new Map(persisted.map((snapshot) => [snapshot.accountCode, snapshot]))
  assert.equal(byCode.get('630')!.sourcePayloadRef, 'xero:trial-balance:2026-10-19')
  assert.equal(byCode.get('631')!.sourcePayloadRef, 'xero:trial-balance:2026-10-19', 'Xero reported 631 at zero: an explicit zero')
  for (const code of ['632', '260']) {
    assert.equal(toDecimal(byCode.get(code)!.amountBase as string).toFixed(2), '0.00', code)
    assert.equal(byCode.get(code)!.sourcePayloadRef, 'xero:trial-balance:2026-10-19:absent-from-complete-tb', code)
  }
  assert.ok(persisted.every((snapshot) => !String(snapshot.sourcePayloadRef).endsWith(':absent-from-tb')), 'the unproven label is never written')
})

// [mutation: the proven label written whatever the completeness]
test('an absent account of a Trial Balance that does NOT prove itself complete is stored under NO label (refused), never the proven one', async () => {
  reset()
  // Rows do not add up to the Total row: 1000 + 75 debit against a Total of 2000.
  trialBalance = { Reports: [{ ...LIVE_META, Rows: [TB_HEADER, { RowType: 'Section', Rows: [row('a-630', '630 - Inventory', '1000'), row('a-500', '500 - COGS', '75')] }, { RowType: 'Section', Rows: [{ RowType: 'SummaryRow', Cells: ['Total', '0', '0', '2000', '2000'].map((Value) => ({ Value })) }] }] }] }
  const result = await pull()
  assert.ok(result.errors.some((e) => e.includes('TB_COMPLETENESS_UNPROVEN')))
  assert.ok(persisted.every((snapshot) => snapshot.sourcePayloadRef === 'xero:trial-balance:2026-10-19'), 'only reported rows are stored; no absent zero of either label')
})

test('an EMPTY Trial Balance synthesises nothing: it is an error, not a set of zeros', async () => {
  reset()
  trialBalance = { Reports: [{ ...LIVE_META, Rows: [] }] }
  const result = await pull()
  assert.equal(persisted.length, 0)
  assert.equal(result.persisted, 0)
  assert.ok(result.errors.length >= 1)
  assert.deepEqual(stamps, [])
})

// [mutation: tenantId not passed from the captured connection]
test('every stored balance records the organisation of the connection the trial balance was fetched under', async () => {
  reset()
  await pull()
  assert.equal(persisted.length, 5)
  for (const snapshot of persisted) assert.equal(snapshot.tenantId, 'tenant-x')
})

const withTotal = (rows: unknown[], totalDebit: string, totalCredit: string) => ({ Reports: [{ ...LIVE_META, Rows: [TB_HEADER, { RowType: 'Section', Rows: rows }, { RowType: 'Section', Rows: [{ RowType: 'SummaryRow', Cells: ['Total', '0', '0', totalDebit, totalCredit].map((Value) => ({ Value })) }] }] }] })
const proven = () => persisted.filter((snapshot) => String(snapshot.sourcePayloadRef).endsWith(':absent-from-complete-tb'))

// [mutation: the sums compared through toFixed(2) with no decimal-place refusal]
test('COMPLETENESS IS EXACT: rows summing 100.000 against a Total of 100.004 prove nothing; no proven-absent ref is written', async () => {
  reset()
  trialBalance = withTotal([row('a-630', '630 - Inventory', '100.000'), row('a-999', '999 - Equity', '0', '100.000')], '100.004', '100.000')
  const result = await pull()
  assert.deepEqual(proven(), [])
  assert.ok(result.errors.some((e) => e.includes('TB_COMPLETENESS_UNPROVEN')))
})

test('COMPLETENESS IS EXACT: a YTD cell with more than two decimal places is refused (data row) or unreadable (Total row)', async () => {
  reset()
  trialBalance = withTotal([row('a-630', '630 - Inventory', '100.004'), row('a-999', '999 - Equity', '0', '100.004')], '100.004', '100.004')
  const result = await pull()
  assert.deepEqual(proven(), [])
  assert.ok(result.errors.some((e) => e.includes('TB_NON_MONEY_CELL')), JSON.stringify(result.errors))
  reset()
  trialBalance = withTotal([row('a-630', '630 - Inventory', '100'), row('a-999', '999 - Equity', '0', '100')], '100.001', '100')
  await pull()
  assert.deepEqual(proven(), [])
})

test('COMPLETENESS IS EXACT: sums that equal the Total exactly prove the omission (a trailing-zero third place is the same amount)', async () => {
  reset()
  trialBalance = withTotal([row('a-630', '630 - Inventory', '100.50'), row('a-999', '999 - Equity', '0', '100.500')], '100.500', '100.50')
  await pull()
  assert.deepEqual(proven().map((s) => s.accountCode).sort(), ['260', '500', '631', '632'])
})

// [mutation: the duplicate-id check restricted to configured accounts]
test('COMPLETENESS: an account id repeated on two data rows (even an UNCONFIGURED one) proves nothing - the omitted configured account is withheld, not proven zero', async () => {
  reset()
  // 999 is repeated (200 in total) and stands in for the omitted configured 631; the sums still equal the Total exactly.
  trialBalance = withTotal([row('a-630', '630 - Inventory', '0'), row('a-999', '999 - Other', '100'), row('a-999', '999 - Other', '100'), row('a-998', '998 - Equity', '0', '200')], '200', '200')
  const result = await pull()
  assert.deepEqual(proven(), [])
  assert.ok(result.errors.some((e) => e.includes('TB_COMPLETENESS_UNPROVEN') && e.includes('a-999')), JSON.stringify(result.errors))
  assert.ok(!persisted.some((snapshot) => snapshot.accountCode === '631'), 'the omitted configured account is withheld')
})
