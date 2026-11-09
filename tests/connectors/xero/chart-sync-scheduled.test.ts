import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * The scheduled chart-of-accounts refresh is NON-DESTRUCTIVE and refuses a response that cannot be a real chart:
 *  - an empty or malformed Accounts body writes nothing and does not advance the read-sync stamp;
 *  - it never deactivates an account that is absent from the response (the list cannot be proved complete);
 *  - the operator's on-demand refresh keeps deactivating, and never stamps.
 * Xero is never contacted: the transport and the connection fence are mocked.
 */

let accountsBody: unknown = { Accounts: [] }
let upserts: string[] = []
let updateData: Array<Record<string, unknown>> = []
let deactivations = 0
let stamps: string[] = []

mock.module('@/lib/db', { namedExports: { db: {} } })
mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async () => ({ ok: true, data: accountsBody }),
    xeroGetCached: async () => ({ ok: true, data: {} }),
  },
})
mock.module('@/lib/connectors/xero/connection-fence', {
  namedExports: {
    captureXeroConnection: async () => ({ tenantId: 't', connectionGeneration: 'g' }),
    withXeroConnectionFence: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) => ({
      ok: true,
      value: await fn({
        accountingAccount: {
          upsert: async ({ create, update }: { create: { externalAccountId: string }; update: Record<string, unknown> }) => { upserts.push(create.externalAccountId); updateData.push(update) },
          updateMany: async () => { deactivations += 1 },
        },
        setting: { upsert: async ({ where }: { where: { key: string } }) => { stamps.push(where.key) } },
      }),
    }),
  },
})

const chart = (ids: string[]) => ({ Accounts: ids.map((id) => ({ AccountID: id, Code: id, Name: `n-${id}`, Type: 'BANK', TaxType: 'NONE', Status: 'ACTIVE', Class: 'ASSET' })) })

test.beforeEach(() => { upserts = []; updateData = []; deactivations = 0; stamps = [] })

test('scheduled: an empty response is a failed run - nothing written, no stamp', async () => {
  const { syncChartOfAccounts } = await import('../../../lib/connectors/xero/accounts.ts')
  accountsBody = { Accounts: [] }
  const result = await syncChartOfAccounts({ recordScheduledSuccess: true })
  assert.equal(result.synced, 0)
  assert.equal(result.errors.length, 1)
  assert.deepEqual({ upserts, deactivations, stamps }, { upserts: [], deactivations: 0, stamps: [] })
})

test('scheduled: a row without an id is a failed run - nothing written, no stamp', async () => {
  const { syncChartOfAccounts } = await import('../../../lib/connectors/xero/accounts.ts')
  accountsBody = { Accounts: [{ Code: '200', Name: 'x' }] }
  const result = await syncChartOfAccounts({ recordScheduledSuccess: true })
  assert.equal(result.errors.length, 1)
  assert.deepEqual({ upserts, deactivations, stamps }, { upserts: [], deactivations: 0, stamps: [] })
})

test('scheduled: ONE malformed row (every field the upsert reads is checked) rejects the whole response', async () => {
  const { syncChartOfAccounts } = await import('../../../lib/connectors/xero/accounts.ts')
  const good = chart(['a1', 'a2']).Accounts
  const bad: Array<[string, Record<string, unknown>]> = [
    ['unknown Status', { ...good[1], Status: 'PAUSED' }],
    ['missing Status', { ...good[1], Status: undefined }],
    ['missing Type', { ...good[1], Type: undefined }],
    ['blank Name', { ...good[1], Name: '  ' }],
    ['numeric Code', { ...good[1], Code: 200 }],
    ['non-text TaxType', { ...good[1], TaxType: 5 }],
    ['repeated AccountID', { ...good[0] }],
  ]
  for (const [label, row] of bad) {
    accountsBody = { Accounts: [good[0], row] }
    const result = await syncChartOfAccounts({ recordScheduledSuccess: true })
    assert.equal(result.errors.length, 1, label)
    assert.deepEqual({ upserts, deactivations, stamps }, { upserts: [], deactivations: 0, stamps: [] }, `${label}: nothing written`)
  }
})

test('scheduled: a valid but partial chart is stored and stamped as "read and validated" - the stamp does not claim completeness', async () => {
  const { syncChartOfAccounts } = await import('../../../lib/connectors/xero/accounts.ts')
  const { getReadSyncStream } = await import('../../../lib/ops/read-sync-liveness-constants.ts')
  accountsBody = chart(['a1'])
  const result = await syncChartOfAccounts({ recordScheduledSuccess: true })
  assert.deepEqual(result, { synced: 1, errors: [] })
  assert.equal(deactivations, 0)
  assert.match(getReadSyncStream('xero-chart-of-accounts').successMeans, /does not prove the list was complete/)
})

test('scheduled: inserts and updates, stamps, and never deactivates', async () => {
  const { syncChartOfAccounts } = await import('../../../lib/connectors/xero/accounts.ts')
  accountsBody = chart(['a1', 'a2'])
  const result = await syncChartOfAccounts({ recordScheduledSuccess: true })
  assert.deepEqual(result, { synced: 2, errors: [] })
  assert.deepEqual(upserts, ['a1', 'a2'])
  assert.equal(deactivations, 0, 'absent accounts are left to the operator refresh')
  assert.deepEqual(stamps, ['xero_chart_of_accounts_last_success_at'])
})

test('on-demand: still deactivates absent accounts and never stamps', async () => {
  const { syncChartOfAccounts } = await import('../../../lib/connectors/xero/accounts.ts')
  accountsBody = chart(['a1'])
  const result = await syncChartOfAccounts()
  assert.deepEqual(result, { synced: 1, errors: [] })
  assert.equal(deactivations, 1)
  assert.deepEqual(stamps, [])
})

test('the rebind clears the chart stamp together with the cached chart', async () => {
  const { DERIVED_ORG_KEYED_KEYS } = await import('../../../lib/connectors/xero/account-mapping-rebind.ts')
  const { XERO_CHART_OF_ACCOUNTS_LAST_SUCCESS_SETTING } = await import('../../../lib/ops/read-sync-liveness-constants.ts')
  assert.ok((DERIVED_ORG_KEYED_KEYS as readonly string[]).includes(XERO_CHART_OF_ACCOUNTS_LAST_SUCCESS_SETTING))
})

test('scheduled: an OMITTED Code or TaxType never overwrites the stored value; explicit values (even null) apply; on-demand writes through', async () => {
  const { syncChartOfAccounts } = await import('../../../lib/connectors/xero/accounts.ts')
  const full = chart(['a1']).Accounts[0]!
  accountsBody = { Accounts: [{ ...full, Code: undefined, TaxType: undefined }] }
  await syncChartOfAccounts({ recordScheduledSuccess: true })
  assert.equal('code' in updateData[0]!, false, 'omitted Code: stored code preserved')
  assert.equal('taxType' in updateData[0]!, false, 'omitted TaxType: stored value preserved')
  assert.equal(updateData[0]!.name, 'n-a1')

  updateData = []
  accountsBody = { Accounts: [{ ...full, Code: '210', TaxType: null }] }
  await syncChartOfAccounts({ recordScheduledSuccess: true })
  assert.equal(updateData[0]!.code, '210', 'an explicit value applies')
  assert.equal(updateData[0]!.taxType, null, 'an explicit null applies')

  updateData = []
  accountsBody = { Accounts: [{ ...full, Code: undefined, TaxType: undefined }] }
  await syncChartOfAccounts()
  assert.equal(updateData[0]!.code, null, 'the operator refresh keeps its old write-through')
})
