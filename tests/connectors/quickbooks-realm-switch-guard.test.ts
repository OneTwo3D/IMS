import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-9kek r4 finding 1, the wiring half. The guard's logic is covered in
// tests/accounting/tenant-switch-guard.test.ts; what matters here is that the CONNECT path actually
// consults it, and refuses BEFORE anything is exchanged or stored — a refusal that still leaves a
// token, a pin or a last-connected marker behind would be a half-completed switch, which is worse
// than either outcome.
//
// The pin (`quickbooks_expected_realm_id`) cannot do this job: disconnect deletes it, deliberately,
// because an explicit disconnect is how an operator declares they mean to move. So at the moment the
// question matters the pin is gone, and a separate marker that SURVIVES disconnect is what makes a
// switch recognisable as a switch.
// ---------------------------------------------------------------------------

const state: {
  settings: Map<string, string>
  bills: Array<{ accountingInvoiceId: string | null; accountingInvoiceProvenance: string }>
  tokens: Array<{ connector: string; tenantId: string }>
  fetches: string[]
  activities: string[]
} = { settings: new Map(), bills: [], tokens: [], fetches: [], activities: [] }

const zeroCount = { count: async () => 0 }

const db = {
  accountingToken: {
    async findUnique() { return state.tokens[0] ?? null },
    async upsert(args: { create: { tenantId: string } }) {
      state.tokens.push({ connector: 'quickbooks', tenantId: args.create.tenantId })
      return {}
    },
  },
  setting: {
    async findUnique(args: { where: { key: string } }) {
      const value = state.settings.get(args.where.key)
      return value === undefined ? null : { value }
    },
    async upsert(args: { where: { key: string }; update: { value: string } }) {
      state.settings.set(args.where.key, args.update.value)
      return {}
    },
  },
  purchaseInvoice: {
    async count(args: { where: Record<string, unknown> }) {
      const where = args.where as { accountingInvoiceProvenance?: unknown }
      return state.bills.filter((bill) => {
        if (bill.accountingInvoiceId === null) return false
        const condition = where.accountingInvoiceProvenance
        if (typeof condition === 'string') return bill.accountingInvoiceProvenance === condition
        const notIn = (condition as { notIn?: string[] } | undefined)?.notIn ?? []
        return !notIn.includes(bill.accountingInvoiceProvenance)
      }).length
    },
  },
  salesOrder: zeroCount,
  salesOrderRefund: zeroCount,
  supplierCreditNote: zeroCount,
  accountingSyncLog: zeroCount,
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/activity-log', {
  namedExports: { logActivity: async (entry: { action: string }) => { state.activities.push(entry.action) } },
})
mock.module('@/lib/auth/token-store', { namedExports: { setAuthToken: async () => {}, consumeAuthToken: async () => null } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })
mock.module('@/lib/secrets', {
  namedExports: {
    encryptSecret: (value: string) => value,
    decryptSecret: (value: string) => value,
    hasEncryptionKey: () => false,
    isEncryptedValue: () => true,
  },
})
mock.module('@/lib/settings-store', {
  namedExports: {
    getSettingValue: async (key: string) => state.settings.get(key) ?? null,
    serializeSettingValue: (_key: string, value: string) => value,
  },
})
mock.module('@/lib/base-currency', { namedExports: { getBaseCurrencyCode: async () => 'GBP' } })
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string) => {
      state.fetches.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => (url.includes('companyinfo')
          ? { CompanyInfo: { CompanyName: 'Acme', HomeCurrency: { value: 'GBP' } } }
          : { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'bearer' }),
        text: async () => '',
      }
    },
  },
})

function reset() {
  state.settings = new Map([
    ['quickbooks_client_id', 'cid'],
    ['quickbooks_client_secret', 'secret'],
  ])
  state.bills = []
  state.tokens = []
  state.fetches = []
  state.activities = []
}

test('[o3d-9kek r4 f1] connecting a DIFFERENT company is refused while its predecessor\'s ids are stored', async () => {
  reset()
  // Realm A connected before, then disconnected — which clears the pin, so nothing else in this file
  // would stop realm B.
  state.settings.set('quickbooks_last_connected_tenant_id', 'realm-A')
  state.bills.push({ accountingInvoiceId: '42', accountingInvoiceProvenance: 'quickbooks:realm-A' })
  const { exchangeCodeForTokens } = await import('@/lib/connectors/quickbooks/auth')

  const result = await exchangeCodeForTokens('code', 'realm-B', 'https://ims/callback')

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /realm-B/)
  // Refused BEFORE the exchange: no request, no token, and the last-connected marker still names the
  // company whose ids we hold — a half-applied switch would be the worst of both states.
  assert.deepEqual(state.fetches, [], 'nothing may be exchanged for a connection we are going to refuse')
  assert.deepEqual(state.tokens, [])
  assert.equal(state.settings.get('quickbooks_last_connected_tenant_id'), 'realm-A')
  assert.ok(state.activities.includes('quickbooks_realm_switch_refused'), 'a refusal nobody can see is a mystery outage')
})

test('[o3d-9kek r4 f1] the same company reconnects normally, and records itself for next time', async () => {
  reset()
  state.settings.set('quickbooks_last_connected_tenant_id', 'realm-A')
  state.bills.push({ accountingInvoiceId: '42', accountingInvoiceProvenance: 'quickbooks:realm-A' })
  const { exchangeCodeForTokens } = await import('@/lib/connectors/quickbooks/auth')

  const result = await exchangeCodeForTokens('code', 'realm-A', 'https://ims/callback')

  assert.equal(result.success, true)
  assert.equal(state.tokens[0]?.tenantId, 'realm-A')
  assert.equal(state.settings.get('quickbooks_last_connected_tenant_id'), 'realm-A')
})

test('[o3d-9kek r4 f1] a first-ever connection records the marker that makes the NEXT one checkable', async () => {
  reset()
  const { exchangeCodeForTokens } = await import('@/lib/connectors/quickbooks/auth')

  const result = await exchangeCodeForTokens('code', 'realm-A', 'https://ims/callback')

  assert.equal(result.success, true)
  // Without this write the guard can never fire: every subsequent connect would look like a first
  // connection, which is precisely the hole the deleted pin left.
  assert.equal(state.settings.get('quickbooks_last_connected_tenant_id'), 'realm-A')
})
