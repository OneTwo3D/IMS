import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * A configured account CODE is not an identity: Xero can reassign it. Every single-balance read by a configured code (inventory
 * GL reconciliation, COGS and transit reconciliations, the inventory valuation report) resolves the code to the one active chart
 * account, reads by that account's id under the connected organisation, and WITHHOLDS when that is unproven.
 */
type Row = { id: string; connector: string; externalAccountId: string; accountCode: string; accountName: string; balanceDate: Date; currency: string; amountForeign: string; amountBase: string; sourcePayloadRef: string | null; tenantId: string | null; financialYearEnd: null; parserVersion: number | null; syncRunId: null; fetchedAt: Date }
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const row = (id: string, accountId: string, code: string, iso: string, amount: string, tenantId: string | null = 't1'): Row => ({ id, connector: 'xero', externalAccountId: accountId, accountCode: code, accountName: code, balanceDate: day(iso), currency: 'GBP', amountForeign: amount, amountBase: amount, sourcePayloadRef: `xero:trial-balance:${iso}`, tenantId, financialYearEnd: null, parserVersion: 2, syncRunId: null, fetchedAt: day(iso) })

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
        findFirst: async ({ where }: { where: { externalAccountId?: string; accountCode?: string; tenantId?: string; parserVersion?: number; balanceDate: { lte: Date }; currency?: string } }) => {
          queries.push(where)
          return rows.filter((r) => (where.externalAccountId === undefined || r.externalAccountId === where.externalAccountId) && (where.accountCode === undefined || r.accountCode === where.accountCode) && (where.tenantId === undefined || r.tenantId === where.tenantId) && (where.parserVersion === undefined || r.parserVersion === where.parserVersion) && r.balanceDate <= where.balanceDate.lte && (where.currency === undefined || r.currency === where.currency))
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

test('PARSER VERSION: a balance written by an earlier parser is absent to every single-balance reader', async () => {
  good(); rows = rows.map((r) => ({ ...r, parserVersion: null }))
  assert.deepEqual(await inv(), { available: false, reason: 'no_gl_snapshot' })
  assert.deepEqual(await cogs(), { available: false, reason: 'no_gl_snapshot' })
  assert.deepEqual(await transit(), { available: false, reason: 'no_gl_snapshot' })
  good(); rows = rows.map((r) => ({ ...r, parserVersion: 1 }))
  assert.deepEqual(await inv(), { available: false, reason: 'no_gl_snapshot' })
})

const REF = (iso: string, suffix = '') => `xero:trial-balance:${iso}${suffix}`
const refOf = (id: string, ref: string | null, amount?: string) => { rows = rows.map((r) => (r.id === id ? { ...r, sourcePayloadRef: ref, ...(amount === undefined ? {} : { amountBase: amount, amountForeign: amount }) } : r)) }

test('PROVENANCE: a legacy unproven absent-from-tb zero, an unknown ref, no ref or another date\'s ref is no balance: inconclusive by name, never compared', async () => {
  const bad: Array<[string, string | null]> = [
    ['legacy unproven absent zero', REF('2026-10-19', ':absent-from-tb')],
    ['unknown suffix', REF('2026-10-19', ':absent-from-something')],
    ['no ref at all', null],
    ['the reference of another date', REF('2026-10-18')],
    ['a proven ref of another date', REF('2026-10-18', ':absent-from-complete-tb')],
  ]
  for (const [name, ref] of bad) {
    for (const id of ['1', '2']) { good(); refOf(id, ref, '0'); assert.deepEqual(await inv(), { available: false, reason: 'gl_balance_unproven' }, `inventory leg ${id}: ${name}`) }
    good(); refOf('3', ref, '0'); assert.deepEqual(await cogs(), { available: false, reason: 'gl_balance_unproven' }, `cogs: ${name}`)
    good(); refOf('4', ref, '0'); assert.deepEqual(await transit(), { available: false, reason: 'gl_balance_unproven' }, `transit: ${name}`)
  }
})

test('PROVENANCE: a proven-absent zero is a real zero, compared and LABELLED; a proven label over a non-zero amount is no balance', async () => {
  good(); refOf('2', REF('2026-10-19', ':absent-from-complete-tb'), '0')
  const ok = await inv()
  assert.ok(ok.available)
  if (ok.available) assert.deepEqual(ok.glProvenance, { inventory: 'reported', allocated: 'proven-absent' })
  good()
  const reported = await inv()
  assert.ok(reported.available)
  if (reported.available) assert.deepEqual(reported.glProvenance, { inventory: 'reported', allocated: 'reported' })
  good(); refOf('2', REF('2026-10-19', ':absent-from-complete-tb'), '3')
  assert.deepEqual(await inv(), { available: false, reason: 'gl_balance_unproven' })
})

test('PROVENANCE: a legacy zero is also refused as the OPENING leg of a movement; a proven-absent opening is accepted', async () => {
  good()
  rows = [...rows, row('5', 'a-500', '500', '2026-10-18', '0'), row('6', 'a-632', '632', '2026-10-18', '0')]
  refOf('5', REF('2026-10-18', ':absent-from-tb')); refOf('6', REF('2026-10-18', ':absent-from-tb'))
  assert.deepEqual(await cogs(), { available: false, reason: 'gl_balance_unproven' })
  assert.deepEqual(await transit(), { available: false, reason: 'gl_balance_unproven' })
  refOf('5', REF('2026-10-18', ':absent-from-complete-tb')); refOf('6', REF('2026-10-18', ':absent-from-complete-tb'))
  const c = await cogs().catch((e) => e)
  assert.ok(!(c && typeof c === 'object' && 'reason' in c && c.reason === 'gl_balance_unproven'), 'a proven-absent opening is not refused for provenance')
})
