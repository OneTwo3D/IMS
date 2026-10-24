import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * A configured account CODE is not an identity: Xero can reassign it. Every single-balance read by a configured code (inventory
 * GL reconciliation, COGS and transit reconciliations, the inventory valuation report) resolves the code to the one active chart
 * account, reads by that account's id under the connected organisation, and WITHHOLDS when that is unproven.
 */
type Row = { id: string; connector: string; externalAccountId: string; accountCode: string; accountName: string; balanceDate: Date; currency: string; amountForeign: string; amountBase: string; sourcePayloadRef: null; tenantId: string | null; financialYearEnd: null; syncRunId: null; fetchedAt: Date }
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const row = (id: string, accountId: string, code: string, iso: string, amount: string, tenantId: string | null = 't1'): Row => ({ id, connector: 'xero', externalAccountId: accountId, accountCode: code, accountName: code, balanceDate: day(iso), currency: 'GBP', amountForeign: amount, amountBase: amount, sourcePayloadRef: null, tenantId, financialYearEnd: null, syncRunId: null, fetchedAt: day(iso) })

let rows: Row[] = []
let chart: Array<{ code: string; externalAccountId: string; type: string }> = []
let tenant: string | null = 't1'
let queries: Array<Record<string, unknown>> = []

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingAccount: { findMany: async ({ where }: { where: { code: string } }) => chart.filter((c) => c.code === where.code) },
      accountingToken: { findUnique: async () => (tenant === null ? null : { tenantId: tenant }) },
      accountingAccountBalanceSnapshot: {
        findFirst: async ({ where }: { where: { externalAccountId?: string; accountCode?: string; tenantId?: string; balanceDate: { lte: Date }; currency?: string } }) => {
          queries.push(where)
          return rows.filter((r) => (where.externalAccountId === undefined || r.externalAccountId === where.externalAccountId) && (where.accountCode === undefined || r.accountCode === where.accountCode) && (where.tenantId === undefined || r.tenantId === where.tenantId) && r.balanceDate <= where.balanceDate.lte && (where.currency === undefined || r.currency === where.currency))
            .sort((a, b) => b.balanceDate.getTime() - a.balanceDate.getTime())[0] ?? null
        },
      },
      inventorySnapshot: { findMany: async () => [{ valueBase: '10', valueReplayReliable: true }] },
      inventorySnapshotRun: { findUnique: async () => ({ id: 'r' }) },
      setting: { findUnique: async () => ({ value: '2020-01-01' }) },
    },
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
const settings = { inventoryAccount: '630', allocatedInventoryAccount: '631', cogsAccount: '500', transitAccount: '632' }
mock.module('@/lib/accounting', { namedExports: { getActiveAccountingConnectorInfo: async () => ({ id: 'xero' }), getAccountingSettingsFor: async () => settings, getAccountingSettings: async () => settings } })

const NOW = day('2026-10-20')
const good = () => {
  chart = [{ code: '630', externalAccountId: 'a-630', type: 'INVENTORY' }, { code: '631', externalAccountId: 'a-631', type: 'INVENTORY' }, { code: '500', externalAccountId: 'a-500', type: 'DIRECTCOSTS' }, { code: '632', externalAccountId: 'a-632', type: 'CURRENT' }]
  rows = [row('1', 'a-630', '630', '2026-10-19', '10'), row('2', 'a-631', '631', '2026-10-19', '0'), row('3', 'a-500', '500', '2026-10-19', '5'), row('4', 'a-632', '632', '2026-10-19', '1')]
  tenant = 't1'
  queries = []
}
const inv = async () => (await import('../../../lib/domain/accounting/inventory-gl-reconciliation.ts')).loadInventoryGlReconciliation({ now: NOW })
const cogs = async () => (await import('../../../lib/domain/accounting/cogs-gl-reconciliation.ts')).loadCogsGlReconciliation({ now: NOW })
const transit = async () => (await import('../../../lib/domain/accounting/transit-gl-reconciliation.ts')).loadTransitGlReconciliation({ now: NOW })

test('inventory GL reconciliation reads each configured code BY ACCOUNT ID under the connected organisation', async () => {
  good()
  await inv()
  assert.deepEqual(queries.map((q) => [q.externalAccountId, q.tenantId, q.accountCode]), [['a-630', 't1', undefined], ['a-631', 't1', undefined]])
})

test('a code reassigned to a new account: the OLD account\'s balance is never compared (no snapshot for the new account)', async () => {
  good()
  chart = chart.map((c) => (c.code === '630' ? { ...c, externalAccountId: 'a-NEW' } : c))
  assert.deepEqual(await inv(), { available: false, reason: 'no_gl_snapshot' })
})

test('inventory GL reconciliation is withheld when the chart does not name exactly one active account for either code', async () => {
  good(); chart = chart.filter((c) => c.code !== '631')
  assert.deepEqual(await inv(), { available: false, reason: 'account_identity_unproven' })
  good(); chart = [...chart, { code: '630', externalAccountId: 'a-630b', type: 'INVENTORY' }]
  assert.deepEqual(await inv(), { available: false, reason: 'account_identity_unproven' })
})

test('with no recorded connected organisation nothing is read as the configured balance', async () => {
  good(); tenant = null
  assert.deepEqual(await inv(), { available: false, reason: 'account_identity_unproven' })
  assert.deepEqual(await cogs(), { available: false, reason: 'account_identity_unproven' })
  assert.deepEqual(await transit(), { available: false, reason: 'account_identity_unproven' })
})

test('a balance fetched under another organisation is not the configured account\'s', async () => {
  good(); rows = rows.map((r) => ({ ...r, tenantId: 't-other' }))
  assert.deepEqual(await inv(), { available: false, reason: 'no_gl_snapshot' })
  assert.deepEqual(await cogs(), { available: false, reason: 'no_gl_snapshot' })
  assert.deepEqual(await transit(), { available: false, reason: 'no_gl_snapshot' })
})

test('COGS and transit reconciliations are withheld on an ambiguous or unknown chart code', async () => {
  good(); chart = chart.filter((c) => c.code !== '500' && c.code !== '632')
  assert.deepEqual(await cogs(), { available: false, reason: 'account_identity_unproven' })
  assert.deepEqual(await transit(), { available: false, reason: 'account_identity_unproven' })
})
