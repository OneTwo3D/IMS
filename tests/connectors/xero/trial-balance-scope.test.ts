import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { XERO_REQUESTED_SCOPES, XERO_SCOPE_STRING, missingScopes } from '../../../lib/connectors/xero/scopes.ts'

/**
 * Reports/TrialBalance needs `accounting.reports.trialbalance.read`. A token that lacks it must be refused by
 * name BEFORE any request; an unknown grant fails open; a grant that has it proceeds.
 */

const SCOPE = 'accounting.reports.trialbalance.read'
let granted: string[] | null = null
let getCalls: string[] = []
let cachedCalls: string[] = []

mock.module('@/lib/db', { namedExports: { db: { accountingAccount: { findMany: async () => [] } } } })
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/connectors/xero/auth', { namedExports: { getGrantedScopes: async () => granted } })
mock.module('@/lib/connectors/xero/settings', {
  namedExports: {
    getXeroSettings: async () => ({
      xero_inventory_account: '630', xero_allocated_inventory_account: '631', xero_cogs_account: '500', xero_transit_account: '632', xero_unearned_revenue_account: '260',
    }),
  },
})
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (path: string) => { getCalls.push(path); return { ok: true, data: path.startsWith('Accounts') ? { Accounts: [] } : { Reports: [] } } },
    xeroGetCached: async (path: string) => { cachedCalls.push(path); return { ok: true, data: { Organisations: [{ BaseCurrency: 'GBP' }] } } },
  },
})
mock.module('@/lib/connectors/xero/connection-fence', {
  namedExports: {
    captureXeroConnection: async () => ({ tenantId: 't', connectionGeneration: 'g' }),
    withXeroConnectionFence: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => ({ ok: true, value: await fn({ accountingAccount: { upsert: async () => undefined, updateMany: async () => undefined } }) }),
  },
})
mock.module('@/lib/domain/accounting/account-balance-snapshots', {
  namedExports: {
    balanceDateString: (d: Date | string) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10)),
    persistAccountingAccountBalanceSnapshots: async () => ({ attempted: 0, persisted: 0, snapshots: [] }),
  },
})

async function pull() {
  getCalls = []; cachedCalls = []
  const { syncXeroAccountBalanceSnapshots } = await import('../../../lib/connectors/xero/account-balances.ts')
  return syncXeroAccountBalanceSnapshots({ balanceDate: '2026-10-19' })
}

test('the requested scope string includes the trial-balance scope', () => {
  assert.ok(XERO_REQUESTED_SCOPES.includes(SCOPE))
  assert.ok(XERO_SCOPE_STRING.split(' ').includes(SCOPE))
  assert.ok(!XERO_SCOPE_STRING.split(' ').includes('accounting.reports.read'), 'the broad scope is invalid_scope for this app')
})

test('readiness lists the scope as missing for a grant without it, and not for one with it', () => {
  const without = XERO_REQUESTED_SCOPES.filter((s) => s !== SCOPE)
  assert.deepEqual(missingScopes(without), [SCOPE])
  assert.deepEqual(missingScopes([...XERO_REQUESTED_SCOPES]), [])
  assert.deepEqual(missingScopes(null), [])
})

test('a known grant lacking the scope is refused by name and makes no HTTP call', async () => {
  granted = XERO_REQUESTED_SCOPES.filter((s) => s !== SCOPE)
  const res = await pull()
  assert.equal(res.errors.length, 1)
  assert.match(res.errors[0]!, /REQUIRES RECONNECT/)
  assert.ok(res.errors[0]!.includes(SCOPE))
  assert.doesNotMatch(res.errors[0]!, /Failed to fetch/)
  assert.deepEqual(getCalls, [])
  assert.deepEqual(cachedCalls, [])
})

test('an unrecorded grant fails open and attempts the call', async () => {
  granted = null
  await pull()
  assert.equal(getCalls.length, 2) // the Trial Balance, then the current chart of accounts
  assert.match(getCalls[0]!, /^Reports\/TrialBalance\?date=2026-10-19/)
})

test('a grant that includes the scope proceeds to the call', async () => {
  granted = [...XERO_REQUESTED_SCOPES]
  await pull()
  assert.equal(getCalls.length, 2)
})
