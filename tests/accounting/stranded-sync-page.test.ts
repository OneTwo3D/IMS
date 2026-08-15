import assert from 'node:assert/strict'
import path from 'node:path'
import test, { mock } from 'node:test'

import type { StrandedSyncRowsResult } from '@/lib/domain/accounting/stranded-sync-rows'

// ---------------------------------------------------------------------------
// o3d-osl8 item 1 — the Integrations page, as BEHAVIOUR.
//
// A React Server Component is an async function that returns an element tree, so it can simply be
// awaited here with its dependencies module-mocked. That gives real evidence, which the structural
// AST guard this file replaces could not provide: that guard matched names and source order, so it
// stayed green against code that called hasPermission as a dead expression, hardcoded the gate, or
// passed constants to the decision functions.
//
// Two complementary observations are made of the result:
//   * the ELEMENT TREE (walked through props.children) — which components the page actually
//     constructed. This is how "the dashboard is absent" is observed at all: the dashboard is
//     stubbed out here, so it contributes no markup either way.
//   * the RENDERED MARKUP (react-dom/server, already a dependency of any Next app; no DOM, no new
//     package) — what the operator would actually read. This is what proves the resolved banner
//     state reaches the page rather than merely being computed.
// ---------------------------------------------------------------------------

const SYNC_DIR = path.join(process.cwd(), 'app', '(dashboard)', 'sync')

const OK_STRANDED: StrandedSyncRowsResult = { rows: [], hasMore: false, total: 0 }

function strandedRow(over: Partial<StrandedSyncRowsResult['rows'][number]> = {}) {
  return {
    id: 'log-1',
    connector: 'quickbooks',
    type: 'SALES_INVOICE',
    status: 'FAILED',
    referenceType: 'SalesOrder',
    referenceId: 'order-7',
    externalTransactionId: null,
    errorMessage: 'HTTP 500 from QuickBooks',
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ageDays: 12,
    ...over,
  }
}

/** Next signals redirect() by throwing an error carrying this digest. */
class RedirectError extends Error {
  digest: string
  constructor(url: string) {
    super('NEXT_REDIRECT')
    this.digest = `NEXT_REDIRECT;replace;${url};307;`
  }
}

const state = {
  role: 'ADMIN' as string | null,
  plugins: {} as Record<string, boolean>,
  /** What the stranded-row loader does. Resolve for rows, reject for a failed read. */
  stranded: async (): Promise<StrandedSyncRowsResult> => OK_STRANDED,
  /** Every limit the loader was called with. Length 0 proves the read never happened. */
  strandedCalls: [] as number[],
  /** An ordinary dashboard read that shares the AccountingSyncLog table with the loader. */
  accountingLogs: async (): Promise<unknown[]> => [],
  /** The aggregate orphan count, or null when it is unavailable. */
  orphanSummary: async (): Promise<unknown> => null,
  /** A second, unrelated dashboard read — used to race two rejections against each other. */
  currencies: async (): Promise<unknown[]> => [],
  redirects: [] as string[],
}

mock.module('next/navigation', {
  namedExports: {
    redirect: (url: string) => { state.redirects.push(url); throw new RedirectError(url) },
    useRouter: () => ({ refresh: () => {} }),
  },
})

// Real @/lib/permissions on purpose: the role→permission matrix is the thing under test here.
mock.module('@/lib/auth/server', {
  namedExports: {
    getSession: async () => (state.role ? { user: { id: 'u1', role: state.role } } : null),
  },
})

mock.module('@/lib/integration-plugins', {
  namedExports: {
    getIntegrationPluginState: async () => state.plugins,
    isIntegrationPluginEnabled: async (id: string) => !!state.plugins[id],
  },
})

mock.module('@/app/actions/accounting-stranded-rows', {
  namedExports: {
    getStrandedAccountingSyncRows: async (limit: number) => {
      state.strandedCalls.push(limit)
      return state.stranded()
    },
  },
})

mock.module('@/app/actions/shopping-sync', {
  namedExports: {
    getShoppingConnectorCredentials: async () => ({ url: '', key: '', secret: '', secretMasked: false, envOverrides: {}, connectionTest: null }),
    getShoppingConnectorPaymentMethods: async () => [],
    getShopifyConnectorCredentials: async () => ({}),
    getShopifySyncLogs: async () => [],
    getShopifySyncSettings: async () => ({ shopify_sync_enabled: 'false' }),
    getShoppingStatusMappings: async () => [],
    getShoppingSyncLogs: async () => [],
    getShoppingSyncSettings: async () => ({}),
    getShoppingTaxRateMappings: async () => [],
  },
})

mock.module('@/app/actions/accounting-sync', {
  namedExports: {
    fetchAccountingTaxRates: async () => [],
    getAccountingAccounts: async () => [],
    getAccountingConnectionStatus: async () => ({ connected: false, tenantName: null }),
    getAccountingConnectionTestState: async () => null,
    getAccountingSettingsMasked: async () => ({}),
    getAccountingSyncLogs: async () => state.accountingLogs(),
    getAccountingSyncReadiness: async () => ({}),
    getCrossConnectorOrphanSummary: async () => state.orphanSummary(),
    getFailedAccountingSyncSummary: async () => null,
    // Imported by the banner component itself.
    cancelOrphanedAccountingSyncRows: async () => ({ success: true }),
    retryFailedAccountingSync: async () => ({ success: true }),
  },
})

mock.module('@/app/actions/accounting-batch', {
  namedExports: {
    getAccountingBatchPreview: async () => ({}),
    getAccountingBatchHistory: async () => [],
  },
})

mock.module('@/app/actions/wms-sync', { namedExports: { getWmsSyncDashboardData: async () => ({}) } })
mock.module('@/app/actions/accounting', { namedExports: { getPaymentMethodCombos: async () => [] } })
mock.module('@/lib/accounting', { namedExports: { getPaymentAccountMap: async () => '{}' } })
mock.module('@/app/actions/settings', { namedExports: { getTaxRates: async () => [] } })
mock.module('@/app/actions/currencies', { namedExports: { getCurrencies: async () => state.currencies() } })
mock.module('@/app/actions/sync-exceptions', { namedExports: { getExceptionInboxSummary: async () => null } })
mock.module('@/lib/domain/accounting/tax-rate-drift-status', { namedExports: { getCurrentTaxRateDrift: async () => null } })

// The dashboard is a large client component with its own reads; it is not what this file is about.
// Stubbed to render nothing, so its PRESENCE is observable only in the element tree.
mock.module(path.join(SYNC_DIR, 'sync-dashboard.tsx'), {
  namedExports: { SyncDashboard: function SyncDashboard() { return null } },
})

// --- observing the result ---------------------------------------------------

type Element = { type?: unknown; props?: Record<string, unknown> }

/** Names of every component element in the tree, walked through props.children. */
function componentNames(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) componentNames(child, found)
    return found
  }
  if (!node || typeof node !== 'object') return found
  const element = node as Element
  if (typeof element.type === 'function') {
    const fn = element.type as { displayName?: string; name: string }
    found.push(fn.displayName ?? fn.name)
  }
  if (element.props && 'children' in element.props) componentNames(element.props.children, found)
  return found
}

/** The props of the first element of the named component, for asserting what the page handed it. */
function propsOf(node: unknown, name: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = propsOf(child, name)
      if (hit) return hit
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  const element = node as Element
  if (typeof element.type === 'function') {
    const fn = element.type as { displayName?: string; name: string }
    if ((fn.displayName ?? fn.name) === name) return element.props ?? {}
  }
  if (element.props && 'children' in element.props) return propsOf(element.props.children, name)
  return null
}

async function renderSyncPage() {
  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const tree = await SyncPage()
  return { tree, names: componentNames(tree), html: renderToStaticMarkup(tree) }
}

test.beforeEach(() => {
  state.role = 'ADMIN'
  state.plugins = {}
  state.stranded = async () => OK_STRANDED
  state.strandedCalls = []
  state.accountingLogs = async () => []
  state.orphanSummary = async () => null
  state.currencies = async () => []
  state.redirects = []
})

test('a role without `sync` causes NO stranded read at all, and still redirects', async () => {
  // The loader returns per-row detail — sync-log ids, referenced entity ids, external transaction
  // ids, raw connector error text. A role without `sync` must not merely fail to render it; the
  // read must never happen, and the page must redirect exactly as it did before the feature.
  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  state.role = 'WAREHOUSE'

  await assert.rejects(() => SyncPage(), /NEXT_REDIRECT/)
  assert.deepEqual(state.strandedCalls, [], 'the unauthorised role must cause no read whatsoever')
  assert.deepEqual(state.redirects, ['/settings/system?tab=plugins'])
})

test('with every plugin disabled and nothing stranded, the page still redirects', async () => {
  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')

  await assert.rejects(() => SyncPage(), /NEXT_REDIRECT/)
  assert.deepEqual(state.strandedCalls, [50], 'the rows are read BEFORE the redirect is decided')
  assert.deepEqual(state.redirects, ['/settings/system?tab=plugins'])
})

test('with every plugin disabled, stranded rows keep the page reachable and list themselves', async () => {
  // The state this feature exists for: the retired accounting connector was the last enabled
  // plugin, so every unresolved accounting row is stranded — and the only page that can show them
  // used to redirect away before looking.
  state.stranded = async () => ({ rows: [strandedRow()], hasMore: false, total: 1 })

  const { names, html } = await renderSyncPage()

  assert.deepEqual(state.redirects, [], 'stranded rows must hold the page open')
  assert.ok(names.includes('ConnectorOrphanBanner'), 'the banner must be in the tree')
  assert.match(html, /Showing all 1 stranded row\(s\), oldest first\./)
  assert.match(html, /SalesOrder:order-7/, 'the row is identified, not counted')
  assert.match(html, /HTTP 500 from QuickBooks/)
})

test('the stranded failure banner renders even when the neighbouring accounting-log read fails too', async () => {
  // FINDING 1. The common causes of the loader failing — the database being unreachable, an
  // AccountingSyncLog read erroring — take the ORDINARY accounting-log read down with it. That
  // read used to be an uncaught await in a Promise.all a few lines later, so the whole server
  // component aborted and the operator got the error boundary instead of this branch's explicit
  // failure state, on the one page that could have recovered them.
  state.stranded = async () => { throw new Error('database is unreachable') }
  state.accountingLogs = async () => { throw new Error('database is unreachable') }

  const { names, html } = await renderSyncPage()

  assert.deepEqual(state.redirects, [], 'an unknown stranded state must not redirect away')
  assert.ok(names.includes('ConnectorOrphanBanner'))
  assert.match(html, /The list of stranded sync rows could not be loaded/)
  assert.match(html, /This does NOT mean there\s+are none/, '"we could not look" is not "there are none"')
  // The dashboard read failed with it, and says so rather than rendering as empty.
  assert.ok(!names.includes('SyncDashboard'), 'the dashboard panel is absent, not half-populated')
  assert.match(html, /could not be loaded, so they are not shown/)
})

test('a redirect thrown by the stranded loader is still a redirect, not a failed panel', async () => {
  // requireAuth inside the loader redirects an unverified-2FA or invalidated session. Catching
  // that as "the list failed to load" would strand the operator here instead of at the challenge.
  state.plugins = { woocommerce: true }
  state.stranded = async () => { throw new RedirectError('/auth/2fa') }

  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  await assert.rejects(() => SyncPage(), (error: RedirectError) => error.digest.startsWith('NEXT_REDIRECT'))
})

test('a null orphan summary hides the cancel controls but not the stranded rows', async () => {
  // The aggregate count and the row list are separate panels. When the count is unavailable there
  // is no trustworthy total to act on, so the cancel controls go — but the rows, which are the
  // only view of work stranded on a retired connector, must stay.
  state.plugins = { woocommerce: true }
  state.orphanSummary = async () => { throw new Error('count query failed') }
  state.stranded = async () => ({ rows: [strandedRow(), strandedRow({ id: 'log-2', referenceId: 'order-9' })], hasMore: false, total: 2 })

  const { names, html } = await renderSyncPage()

  assert.ok(names.includes('ConnectorOrphanBanner'))
  assert.match(html, /Showing all 2 stranded row\(s\), oldest first\./)
  assert.match(html, /SalesOrder:order-9/)
  assert.ok(!html.includes('<button'), 'no cancel control without a trustworthy total')
  assert.ok(!html.includes('accounting sync row(s) are queued'), 'no aggregate paragraph either')
})

test('a truncated list says how many of how many — never a bare count', async () => {
  // The list is read-only: nothing here can clear a FAILED row (o3d-e2mz), so the oldest rows
  // never move and every newer stranded row is hidden behind them indefinitely. "3" would read as
  // "there are 3".
  state.plugins = { woocommerce: true }
  state.stranded = async () => ({
    rows: [strandedRow({ id: 'a' }), strandedRow({ id: 'b' }), strandedRow({ id: 'c' })],
    hasMore: true,
    total: 137,
  })

  const { html } = await renderSyncPage()

  assert.match(html, /Showing the oldest 3 of 137 stranded row\(s\) — 134 more are not listed here\./)
  assert.match(html, /The hidden rows stay hidden until the ones listed here are resolved\./)
})

test('a failed dashboard read degrades to a notice instead of taking the banners down', async () => {
  // Per-panel degradation, stated rather than implied: the dashboard is one panel because a
  // half-loaded one would show "no credentials" / "no sync activity" for reads that never
  // returned — the same lie (failure rendered as emptiness) the banner above refuses to tell.
  state.plugins = { woocommerce: true }
  state.accountingLogs = async () => { throw new Error('database is unreachable') }
  state.stranded = async () => ({ rows: [strandedRow()], hasMore: false, total: 1 })

  const { names, html } = await renderSyncPage()

  assert.ok(!names.includes('SyncDashboard'), 'the failed panel is absent')
  assert.match(html, /could not be loaded, so they are not shown/)
  assert.match(html, /This does NOT\s+mean nothing is configured/)
  assert.ok(names.includes('ConnectorOrphanBanner'), 'the other panels survive it')
  assert.match(html, /Showing all 1 stranded row\(s\), oldest first\./)
})

test('a redirect thrown by any dashboard read still redirects, even alongside an ordinary failure', async () => {
  // Promise.all rejects with whichever rejection lands first, so an ordinary error could otherwise
  // mask a redirect thrown by a different read and demote an auth challenge to a degraded page.
  state.plugins = { woocommerce: true }
  // The ordinary failure is the FASTER of the two, so a first-rejection-wins page would degrade.
  state.accountingLogs = async () => { throw new Error('database is unreachable') }
  state.currencies = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    throw new RedirectError('/auth/2fa')
  }

  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  await assert.rejects(() => SyncPage(), (error: RedirectError) => error.digest === 'NEXT_REDIRECT;replace;/auth/2fa;307;')
})

test('the page hands the banner the resolver inputs it claims to — including the failure flag', async () => {
  // The element tree, not the source text: this is the data flow the AST guard asserted only by
  // name matching, and it is what makes the rendered wording above attributable to the page.
  state.plugins = { woocommerce: true }
  state.stranded = async () => { throw new Error('database is unreachable') }

  const { tree } = await renderSyncPage()
  const props = propsOf(tree, 'ConnectorOrphanBanner')

  assert.ok(props, 'the banner is constructed')
  assert.equal(props.strandedLoadFailed, true, 'a failed read is passed as a failure')
  assert.equal(props.stranded, null, 'and NOT as an empty list')
  assert.equal(props.summary, null)
})
