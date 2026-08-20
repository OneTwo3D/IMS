import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { PermissionDeniedError, isAuthorizationDenial } from '@/lib/auth/session-gates'
import { getPermissions, hasPermission, type Permission } from '@/lib/permissions'

// ---------------------------------------------------------------------------
// o3d-osl8 round 5, finding 1 — the /sync page's gate against its reads' REAL gates, with the
// accounting facade, the connector registry and the connector actions all real.
//
// The round-4 file (sync-page-real-gates.test.ts) un-faked exactly one read. Everything else,
// including the whole of @/app/actions/accounting-sync, stayed a stub — so "MANAGER renders the
// page" was a statement about the doubles. It also enabled no accounting plugin, which meant the
// connector adapter was never entered at all: with Xero active, getAccountingConnectionTestState
// delegates through lib/connectors/accounting-registry into app/actions/xero-sync, and NOTHING in
// the suite ran that delegation under a non-ADMIN role. That is precisely the layer a round-5
// review reported as broken (it is not — see below), and the reason it could not be settled from
// the tests is that no test went there.
//
// WHAT THIS FILE FAKES, and why that is not the gate under test:
//   • @/lib/auth/server — requirePermission is REPLACED, but it enforces the REAL ROLE_PERMISSIONS
//     matrix and throws the REAL PermissionDeniedError. It is replaced only to choose the role and
//     to RECORD which permission each read demanded. The permission → allow/deny decision is the
//     product's.
//   • @/lib/integration-plugins — which connector is enabled. That is the input being varied.
//   • @/lib/db — a proxy that rejects every query with a recognisable non-authorization error, so
//     a read reaching the database is observable and a denial can never be confused with it.
// Everything between the page and those three is the real code: the facade, the registry, the
// dynamic imports it makes, and each connector action's own gate.
// ---------------------------------------------------------------------------

class DatabaseUnavailable extends Error {
  constructor() { super('DB_UNAVAILABLE_IN_GATE_TEST') }
}

const state = {
  role: 'MANAGER' as string,
  plugins: {} as Record<string, boolean>,
  /** Every permission demanded, in order, by whatever read is running. */
  demanded: [] as Permission[],
  /** True once any query was attempted — proof the gate was passed, not merely absent. */
  reachedDatabase: false,
}

/** A db whose every model.method rejects. Reads that pass their gate end up here. */
const rejectingDb: unknown = new Proxy({}, {
  get(_target, model: string) {
    if (model === 'then') return undefined
    if (model === '$transaction') {
      return async (arg: unknown) => {
        state.reachedDatabase = true
        if (typeof arg === 'function') throw new DatabaseUnavailable()
        throw new DatabaseUnavailable()
      }
    }
    if (typeof model === 'string' && model.startsWith('$')) {
      return async () => { state.reachedDatabase = true; throw new DatabaseUnavailable() }
    }
    return new Proxy({}, {
      get: () => async () => { state.reachedDatabase = true; throw new DatabaseUnavailable() },
    })
  },
})

mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: state.role } }),
    getSession: async () => ({ user: { id: 'u1', role: state.role } }),
    requirePermission: async (permission: Permission) => {
      state.demanded.push(permission)
      if (!hasPermission(state.role, permission)) {
        throw new PermissionDeniedError(`Forbidden: missing permission ${permission}`, permission)
      }
      return { user: { id: 'u1', role: state.role } }
    },
    requireFreshPermission: async (permission: Permission) => {
      state.demanded.push(permission)
      if (!hasPermission(state.role, permission)) {
        throw new PermissionDeniedError(`Forbidden: missing permission ${permission}`, permission)
      }
      return { user: { id: 'u1', role: state.role } }
    },
    requireRole: async (...roles: string[]) => {
      // Recorded as a ROLE demand so a read gated on requireRole('ADMIN') — the failure mode this
      // file exists to detect — is caught rather than passing unnoticed.
      state.demanded.push(`role:${roles.join('|')}` as Permission)
      if (!roles.includes(state.role)) throw new PermissionDeniedError(`Forbidden: role ${state.role}`, 'sync')
      return { user: { id: 'u1', role: state.role } }
    },
    requireAdmin: async () => {
      state.demanded.push('role:ADMIN' as Permission)
      if (state.role !== 'ADMIN') throw new PermissionDeniedError('Forbidden: role', 'sync')
      return { user: { id: 'u1', role: state.role } }
    },
    freshAuthFailureResult: () => null,
    PermissionDeniedError,
    isAuthorizationDenial,
  },
})

mock.module('@/lib/integration-plugins', {
  namedExports: {
    isIntegrationPluginEnabled: async (id: string) => state.plugins[id] === true,
    getIntegrationPluginState: async () => ({
      woocommerce: false, shopify: false, xero: false, quickbooks: false, mintsoft: false, shiphero: false,
      ...state.plugins,
    }),
    INTEGRATION_PLUGIN_SETTING_KEYS: {
      woocommerce: 'plugin_woocommerce_enabled', shopify: 'plugin_shopify_enabled',
      xero: 'plugin_xero_enabled', quickbooks: 'plugin_quickbooks_enabled',
      mintsoft: 'plugin_mintsoft_enabled', shiphero: 'plugin_shiphero_enabled',
    },
    isIntegrationModuleVisible: () => true,
  },
})

mock.module('@/lib/db', { namedExports: { db: rejectingDb } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn } })

/**
 * The reads the /sync page performs, named as the page names them. Each entry is called for real.
 *
 * Kept in step with app/(dashboard)/sync/page.tsx by a test below that compares this list against
 * the page's own import list — a read added to the page and not to this file would otherwise be
 * silently unguarded here, which is the shape of the bug in the first place.
 */
async function dashboardReads(): Promise<Array<[string, () => Promise<unknown>]>> {
  const shopping = await import('@/app/actions/shopping-sync')
  const accounting = await import('@/app/actions/accounting-sync')
  const batch = await import('@/app/actions/accounting-batch')
  const wms = await import('@/app/actions/wms-sync')
  const combos = await import('@/app/actions/accounting')
  const accountingLib = await import('@/lib/accounting')
  const settings = await import('@/app/actions/settings')
  const currencies = await import('@/app/actions/currencies')
  const stranded = await import('@/app/actions/accounting-stranded-rows')
  const exceptions = await import('@/app/actions/sync-exceptions')
  const drift = await import('@/lib/domain/accounting/tax-rate-drift-status')

  return [
    ['getStrandedAccountingSyncRows', () => stranded.getStrandedAccountingSyncRows(50)],
    ['getShoppingSyncSettings', () => shopping.getShoppingSyncSettings()],
    ['getShoppingTaxRateMappings', () => shopping.getShoppingTaxRateMappings()],
    ['getShoppingStatusMappings', () => shopping.getShoppingStatusMappings()],
    ['getShoppingSyncLogs', () => shopping.getShoppingSyncLogs(100)],
    ['getShoppingConnectorCredentials', () => shopping.getShoppingConnectorCredentials()],
    ['getShopifySyncSettings', () => shopping.getShopifySyncSettings()],
    ['getShopifyConnectorCredentials', () => shopping.getShopifyConnectorCredentials()],
    ['getShopifySyncLogs', () => shopping.getShopifySyncLogs(100)],
    ['getTaxRates', () => settings.getTaxRates()],
    ['getAccountingSettingsMasked', () => accounting.getAccountingSettingsMasked()],
    ['getAccountingConnectionStatus', () => accounting.getAccountingConnectionStatus()],
    ['getAccountingConnectionTestState', () => accounting.getAccountingConnectionTestState()],
    ['getAccountingAccounts', () => accounting.getAccountingAccounts()],
    ['getAccountingSyncLogs', () => accounting.getAccountingSyncLogs(50)],
    ['getPaymentMethodCombos', () => combos.getPaymentMethodCombos()],
    ['getPaymentAccountMap', () => accountingLib.getPaymentAccountMap()],
    ['getAccountingSyncReadiness', () => accounting.getAccountingSyncReadiness()],
    ['getCurrencies', () => currencies.getCurrencies(true)],
    ['getShoppingConnectorPaymentMethods', () => shopping.getShoppingConnectorPaymentMethods()],
    ['getAccountingBatchPreview', () => batch.getAccountingBatchPreview()],
    ['getAccountingBatchHistory', () => batch.getAccountingBatchHistory(30)],
    ['getWmsSyncDashboardData', () => wms.getWmsSyncDashboardData(null)],
    ['fetchAccountingTaxRates', () => accounting.fetchAccountingTaxRates({ allowCache: true })],
    ['getCrossConnectorOrphanSummary', () => accounting.getCrossConnectorOrphanSummary()],
    ['getFailedAccountingSyncSummary', () => accounting.getFailedAccountingSyncSummary()],
    ['getCurrentTaxRateDrift', () => drift.getCurrentTaxRateDrift()],
    ['getExceptionInboxSummary', () => exceptions.getExceptionInboxSummary()],
  ]
}

/** Runs one read and reports ONLY whether authorization refused it. Everything else is noise here. */
async function denialFor(read: () => Promise<unknown>): Promise<PermissionDeniedError | null> {
  try {
    await read()
    return null
  } catch (error) {
    if (isAuthorizationDenial(error)) return error as PermissionDeniedError
    return null
  }
}

test.beforeEach(() => {
  state.role = 'MANAGER'
  state.plugins = {}
  state.demanded = []
  state.reachedDatabase = false
})

test('the premise: MANAGER holds `sync`, and the page admits it on exactly that', () => {
  assert.ok(getPermissions('MANAGER').has('sync'))
  assert.ok(!getPermissions('MANAGER').has('settings'), 'and NOT `settings` — the cancel gate')
  assert.ok(!getPermissions('MANAGER').has('settings.company'))
})

const PLUGIN_SCENARIOS: Array<{ label: string; value: Record<string, boolean> }> = [
  { label: 'Xero enabled', value: { xero: true, woocommerce: true } },
  { label: 'QuickBooks enabled', value: { quickbooks: true, woocommerce: true } },
  { label: 'no accounting connector', value: { woocommerce: true } },
]

for (const plugins of PLUGIN_SCENARIOS) {
  test(`MANAGER is refused by NO /sync dashboard read — ${plugins.label} — through the real facade and adapter`, async () => {
    state.plugins = plugins.value
    const reads = await dashboardReads()
    const refused: string[] = []

    for (const [name, read] of reads) {
      state.demanded = []
      const denial = await denialFor(read)
      if (denial) refused.push(`${name} → ${denial.message}`)
    }

    assert.deepEqual(
      refused, [],
      'the /sync page treats a denial from any read as FATAL, so each of these would give MANAGER '
        + 'the generic error boundary instead of the page',
    )
  })

  test(`no /sync dashboard read demands more than MANAGER holds — ${plugins.label}`, async () => {
    // Stronger than "it did not throw": it records what each read ASKED FOR. A read that is
    // re-gated on `settings`, `settings.company`, or requireRole('ADMIN') fails here even if some
    // future refactor swallows its own denial.
    state.plugins = plugins.value
    state.role = 'ADMIN' // ADMIN so every read runs to completion and every demand is recorded
    const reads = await dashboardReads()
    const managerPermissions = getPermissions('MANAGER')
    const overGated: string[] = []

    for (const [name, read] of reads) {
      state.demanded = []
      await denialFor(read)
      for (const demanded of state.demanded) {
        const ok = String(demanded).startsWith('role:')
          ? String(demanded) === 'role:MANAGER' || String(demanded).split(':')[1].split('|').includes('MANAGER')
          : managerPermissions.has(demanded)
        if (!ok) overGated.push(`${name} demands ${demanded}`)
      }
    }

    assert.deepEqual(overGated, [], 'a /sync read may not demand a permission the page does not require')
  })
}

test('the Xero connection-test state really is reached through the adapter, and really is gated', async () => {
  // The specific delegation round 5 reported as ADMIN-only: page → getAccountingConnectionTestState
  // → accounting-registry → app/actions/xero-sync#getXeroConnectionTestState. Its local
  // `requireAdmin` is an alias for requirePermission('sync'), NOT lib/auth/server's requireAdmin
  // (requireRole('ADMIN')) — the shadowing is what made the report plausible.
  state.plugins = { xero: true }
  const { getAccountingConnectionTestState } = await import('@/app/actions/accounting-sync')

  state.role = 'MANAGER'
  state.demanded = []
  const denial = await denialFor(() => getAccountingConnectionTestState())

  assert.equal(denial, null, 'MANAGER is not refused')
  // SUPERSEDED SHAPE (o3d-m3gy): this was `deepEqual(state.demanded, ['sync'])`, written when the
  // dispatcher carried NO guard of its own and the delegate was the only frame that asked. o3d-512h
  // round 2 gave every dispatcher its own gate, because a dispatcher that answers `if (!connector)
  // return …` never reaches the delegate whose guard the allowlist said it inherited — so on exactly
  // the path an unauthorized caller takes there was no guard at all. Two frames now ask, and both
  // legitimately ask for the same thing. The property this pins is unchanged and is about WHAT is
  // demanded, not how many times: nothing beyond the page's own permission.
  assert.deepEqual(
    [...new Set(state.demanded)], ['sync'],
    'the delegation asked for `sync` and nothing more — the page\'s own permission',
  )
  assert.equal(state.demanded.length, 2, 'and it asked at BOTH frames: the dispatcher and the delegate')
  assert.ok(state.reachedDatabase, 'it got past the gate to the query, so the gate really ran and really passed')

  // Still a gate, not an absence of one.
  state.role = 'FINANCE'
  state.demanded = []
  const financeDenial = await denialFor(() => getAccountingConnectionTestState())
  assert.ok(financeDenial, 'a role without `sync` is still refused by the connector adapter itself')
  assert.equal(financeDenial?.permission, 'sync')
})

test('with no accounting connector the test state is a DECLARED "never", not an absent value', async () => {
  // Round 5 asked how a blank connection-test state is prevented from reading as "not connected".
  // It is not blank: the facade returns an explicit status when no connector is enabled, so the
  // never-tested case and the not-configured case are the same declared state rather than a hole.
  state.plugins = {}
  state.role = 'MANAGER'
  const { getAccountingConnectionTestState } = await import('@/app/actions/accounting-sync')

  assert.deepEqual(await getAccountingConnectionTestState(), {
    status: 'never', testedAt: null, message: '', fingerprint: null,
  })
})

test('this file covers every read app/(dashboard)/sync/page.tsx actually performs', async () => {
  // The audit is only worth anything if the list is the page's list. Compared against the page
  // source so a read added there and not here fails, rather than being quietly unaudited.
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const source = readFileSync(path.join(process.cwd(), 'app', '(dashboard)', 'sync', 'page.tsx'), 'utf8')

  const covered = new Set((await dashboardReads()).map(([name]) => name))
  const missing = [...covered].filter((name) => !source.includes(name))
  assert.deepEqual(missing, [], 'this file audits a read the page no longer makes — remove it')

  // Every `getX()` / `fetchX()` call the page makes on an imported action.
  const called = new Set(
    [...source.matchAll(/\b((?:get|fetch)[A-Z]\w+)\(/g)].map((m) => m[1]),
  )
  const pageOnly = [...called].filter((name) => !covered.has(name) && ![
    'getIntegrationPluginState', // the page's own plugin read; varied as an input above
    'getSession', // the denial path, not a dashboard read
  ].includes(name))
  assert.deepEqual(pageOnly, [], 'the page performs a read whose gate this file does not audit')
})
