import path from 'node:path'
import { mock } from 'node:test'

import { PermissionDeniedError } from '@/lib/auth/session-gates'
import { hasPermission, type Permission } from '@/lib/permissions'
import type { StrandedSyncRowsResult } from '@/lib/domain/accounting/stranded-sync-rows'

// ---------------------------------------------------------------------------
// The Integrations page, rendered in-process, with its reads under test control.
//
// SHARED, not duplicated: two files render this page and they differ in exactly one dimension —
// whether `getPaymentMethodCombos` is a mock or the REAL server action with its REAL permission
// gate (see installSyncPageMocks). Everything else (which modules are faked, how a call is
// recorded, how the resulting element tree is inspected) has to be identical between them or the
// comparison proves nothing, so it lives here once.
// ---------------------------------------------------------------------------

export const SYNC_DIR = path.join(process.cwd(), 'app', '(dashboard)', 'sync')

export const OK_STRANDED: StrandedSyncRowsResult = { rows: [], hasMore: false, total: 0 }

export function strandedRow(over: Partial<StrandedSyncRowsResult['rows'][number]> = {}) {
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
export class RedirectError extends Error {
  digest: string
  constructor(url: string) {
    super('NEXT_REDIRECT')
    this.digest = `NEXT_REDIRECT;replace;${url};307;`
  }
}

/**
 * Every read the page makes, keyed by name. Each entry is replaced wholesale per test — that is
 * how a failure, a denial or a distinct sentinel value is injected — and every invocation is
 * recorded in `calls` with its arguments.
 */
export type Reads = Record<string, () => unknown>

export function defaultReads(): Reads {
  return {
    getIntegrationPluginState: () => state.plugins,
    getStrandedAccountingSyncRows: () => OK_STRANDED,

    // --- the 22 dashboard reads, in the order the page starts them ---
    getShoppingSyncSettings: () => ({}),
    getShoppingTaxRateMappings: () => [],
    getShoppingStatusMappings: () => [],
    getShoppingSyncLogs: () => [],
    getShoppingConnectorCredentials: () => ({ url: '', key: '', secret: '', secretMasked: false, envOverrides: {}, connectionTest: null }),
    getShopifySyncSettings: () => ({ shopify_sync_enabled: 'false' }),
    getShopifyConnectorCredentials: () => ({}),
    getShopifySyncLogs: () => [],
    getTaxRates: () => [],
    getAccountingSettingsMasked: () => ({}),
    getAccountingConnectionStatus: () => ({ connected: false, tenantName: null }),
    getAccountingConnectionTestState: () => null,
    getAccountingAccounts: () => [],
    getAccountingSyncLogs: () => [],
    getPaymentMethodCombos: () => [],
    getPaymentAccountMap: () => '{}',
    getAccountingSyncReadiness: () => ({}),
    getCurrencies: () => [],
    getShoppingConnectorPaymentMethods: () => [],
    getAccountingBatchPreview: () => ({}),
    getAccountingBatchHistory: () => [],
    getWmsSyncDashboardData: () => ({}),

    // --- the conditional / banner reads ---
    fetchAccountingTaxRates: () => [],
    getCrossConnectorOrphanSummary: () => null,
    getFailedAccountingSyncSummary: () => null,
    getCurrentTaxRateDrift: () => null,
    getExceptionInboxSummary: () => null,
  }
}

export const state = {
  role: 'ADMIN' as string | null,
  plugins: {} as Record<string, boolean>,
  reads: defaultReads(),
  /** Every read the page made, in order, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown[] }>,
  redirects: [] as string[],
  /** Rows the REAL getPaymentMethodCombos sees, when it is not mocked out. */
  salesOrderRows: [] as Array<{ paymentMethod: string | null; currency: string }>,
  /** What the banner's cancel action returns, and every call it received. */
  cancel: {
    calls: [] as unknown[][],
    result: { success: true } as { success: boolean; cancelled?: number; error?: string; inFlightNotCancelled?: number },
    /**
     * Make the action REJECT instead of returning. The production action's permission gate and its
     * concurrency fence both throw rather than returning `{ success: false }` (round 5, finding 3),
     * and a fake that can only resolve cannot show what the banner does with that.
     */
    rejectWith: null as Error | null,
  },
  /**
   * What the FailedSyncBanner's retry action returns, and every call it received (o3d-aouf).
   *
   * It used to be `async () => ({ success: true })` — uninstrumented, never invoked, present only
   * so the banner module would link. A double that records nothing cannot fail, so the retry
   * control had no coverage at all: deleting its onClick, dropping the router.refresh, or
   * swallowing the error left the suite green. Shaped like `cancel` above for the same reasons.
   */
  retry: {
    calls: [] as unknown[][],
    result: { success: true, reset: 1 } as { success: boolean; reset?: number; error?: string },
    /** Make the action REJECT rather than return, as its permission gate does. */
    rejectWith: null as Error | null,
  },
  /** router.refresh() calls made by client components under test. */
  refreshes: 0,
  /**
   * WHAT THE REFRESH ACTUALLY DOES (o3d-osl8 round 7, finding 3).
   *
   * The double used to be `refresh: () => { state.refreshes += 1 }` and nothing else — it modelled
   * the CALL and not the EFFECT. That is why a component claiming "the rows below have been
   * reloaded from the server" passed its test while displaying exactly the pre-cancellation rows:
   * no test could tell the difference, because no double ever produced a fresh payload.
   *
   * Set this to deliver one (`banner.setProps(...)` with a new server-render marker), or leave it
   * null to model the refresh that never completes — a cached payload, a failed re-fetch, a
   * navigation that never lands. Both are real, and a component must be honest in both.
   */
  onRefresh: null as (() => void) | null,
}

export function resetSyncPageState() {
  state.role = 'ADMIN'
  state.plugins = {}
  state.reads = defaultReads()
  state.calls = []
  state.redirects = []
  state.salesOrderRows = []
  state.cancel = { calls: [], result: { success: true }, rejectWith: null }
  state.retry = { calls: [], result: { success: true, reset: 1 }, rejectWith: null }
  state.refreshes = 0
  state.onRefresh = null
}

/** Wraps a read so it is recorded and its value comes from the (per-test) registry. */
export function read(name: string) {
  return async (...args: unknown[]) => {
    state.calls.push({ name, args })
    return state.reads[name]()
  }
}

/** The argument lists a named read was called with. `[]` proves it was never called. */
export function callArgs(name: string): unknown[][] {
  return state.calls.filter((c) => c.name === name).map((c) => c.args)
}

/**
 * Install the module fakes the page render needs.
 *
 * `realPaymentMethodCombos` is the whole reason this is a function and not a top-level block. With
 * it set, `@/app/actions/accounting` is left ALONE, so the page calls the real server action and
 * the real `requirePermission` inside it decides — the only way a test can show that the page's
 * gate and that read's gate actually agree. Everything a mocked read gives (a recorded call, a
 * controllable result, an injectable failure) is then provided one layer down, at `@/lib/db`.
 */
export function installSyncPageMocks(options: { realPaymentMethodCombos?: boolean } = {}) {
  mock.module('next/navigation', {
    namedExports: {
      redirect: (url: string) => { state.redirects.push(url); throw new RedirectError(url) },
      useRouter: () => ({
        refresh: () => {
          state.refreshes += 1
          // The EFFECT, when the test asked for one. Null models the refresh that never lands.
          state.onRefresh?.()
        },
      }),
    },
  })

  // The real @/lib/permissions matrix and the real PermissionDeniedError, on purpose: the role →
  // permission decision and the TYPE the page keys its fatal/degradable split on are both under
  // test here, so neither may be faked.
  mock.module('@/lib/auth/server', {
    namedExports: {
      requirePermission: async (permission: Permission) => {
        state.calls.push({ name: 'requirePermission', args: [permission] })
        if (!state.role) throw new RedirectError('/login')
        if (!hasPermission(state.role, permission)) {
          throw new PermissionDeniedError(`Forbidden: missing permission ${permission}`, permission)
        }
        return { user: { id: 'u1', role: state.role } }
      },
      // Read only on the denial path, to decide WHERE the access-denied screen may send this role
      // (round 5, finding 4). Non-redirecting by contract, so it returns null rather than throwing
      // for a session that is not there.
      getSession: async () => {
        state.calls.push({ name: 'getSession', args: [] })
        return state.role ? { user: { id: 'u1', role: state.role } } : null
      },
    },
  })

  // Only getIntegrationPluginState: the page reads plugin state once and passes it down, and
  // isIntegrationPluginEnabled is reached only from @/app/actions/accounting-stranded-rows, which
  // is faked wholesale below. A double nothing can call is a double nothing can check.
  mock.module('@/lib/integration-plugins', {
    namedExports: { getIntegrationPluginState: read('getIntegrationPluginState') },
  })

  mock.module('@/app/actions/accounting-stranded-rows', {
    namedExports: { getStrandedAccountingSyncRows: read('getStrandedAccountingSyncRows') },
  })

  mock.module('@/app/actions/shopping-sync', {
    namedExports: {
      getShoppingConnectorCredentials: read('getShoppingConnectorCredentials'),
      getShoppingConnectorPaymentMethods: read('getShoppingConnectorPaymentMethods'),
      getShopifyConnectorCredentials: read('getShopifyConnectorCredentials'),
      getShopifySyncLogs: read('getShopifySyncLogs'),
      getShopifySyncSettings: read('getShopifySyncSettings'),
      getShoppingStatusMappings: read('getShoppingStatusMappings'),
      getShoppingSyncLogs: read('getShoppingSyncLogs'),
      getShoppingSyncSettings: read('getShoppingSyncSettings'),
      getShoppingTaxRateMappings: read('getShoppingTaxRateMappings'),
    },
  })

  mock.module('@/app/actions/accounting-sync', {
    namedExports: {
      fetchAccountingTaxRates: read('fetchAccountingTaxRates'),
      getAccountingAccounts: read('getAccountingAccounts'),
      getAccountingConnectionStatus: read('getAccountingConnectionStatus'),
      getAccountingConnectionTestState: read('getAccountingConnectionTestState'),
      getAccountingSettingsMasked: read('getAccountingSettingsMasked'),
      getAccountingSyncLogs: read('getAccountingSyncLogs'),
      getAccountingSyncReadiness: read('getAccountingSyncReadiness'),
      getCrossConnectorOrphanSummary: read('getCrossConnectorOrphanSummary'),
      getFailedAccountingSyncSummary: read('getFailedAccountingSyncSummary'),
      // Imported by the banner component itself. Records what it was called with — the difference
      // between "cancel this connector's rows" and the UNSCOPED cancel is a single argument.
      cancelOrphanedAccountingSyncRows: async (...args: unknown[]) => {
        state.cancel.calls.push(args)
        if (state.cancel.rejectWith) throw state.cancel.rejectWith
        return state.cancel.result
      },
      // Imported by FailedSyncBanner. Records its arguments: "Retry all failed" must send NO
      // entry id, and an entry id would scope it to one row (o3d-aouf).
      retryFailedAccountingSync: async (...args: unknown[]) => {
        state.retry.calls.push(args)
        if (state.retry.rejectWith) throw state.retry.rejectWith
        return state.retry.result
      },
    },
  })

  mock.module('@/app/actions/accounting-batch', {
    namedExports: {
      getAccountingBatchPreview: read('getAccountingBatchPreview'),
      getAccountingBatchHistory: read('getAccountingBatchHistory'),
    },
  })

  mock.module('@/app/actions/wms-sync', { namedExports: { getWmsSyncDashboardData: read('getWmsSyncDashboardData') } })
  mock.module('@/lib/accounting', { namedExports: { getPaymentAccountMap: read('getPaymentAccountMap') } })
  mock.module('@/app/actions/settings', { namedExports: { getTaxRates: read('getTaxRates') } })
  mock.module('@/app/actions/currencies', { namedExports: { getCurrencies: read('getCurrencies') } })
  mock.module('@/app/actions/sync-exceptions', { namedExports: { getExceptionInboxSummary: read('getExceptionInboxSummary') } })
  mock.module('@/lib/domain/accounting/tax-rate-drift-status', { namedExports: { getCurrentTaxRateDrift: read('getCurrentTaxRateDrift') } })

  if (options.realPaymentMethodCombos) {
    // The real action runs: its own requirePermission('sync') decides, and only the database and
    // the activity log beneath it are faked.
    mock.module('@/lib/db', {
      namedExports: {
        db: {
          salesOrder: {
            findMany: async (query: unknown) => {
              state.calls.push({ name: 'db.salesOrder.findMany', args: [query] })
              return state.salesOrderRows
            },
          },
        },
      },
    })
    mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
  } else {
    mock.module('@/app/actions/accounting', { namedExports: { getPaymentMethodCombos: read('getPaymentMethodCombos') } })
  }

  // The dashboard is a large client component with its own reads; it is not what these files are
  // about. Stubbed to render nothing, so its PRESENCE is observable only in the element tree — and
  // its PROPS, which are the whole point of the 22 reads, are asserted from that tree.
  mock.module(path.join(SYNC_DIR, 'sync-dashboard.tsx'), {
    namedExports: { SyncDashboard: function SyncDashboard() { return null } },
  })
}

// --- observing the result ---------------------------------------------------

type Element = { type?: unknown; props?: Record<string, unknown>; key?: string | null }

/** Names of every component element in the tree, walked through props.children. */
export function componentNames(node: unknown, found: string[] = []): string[] {
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

/** The first element of the named component, for asserting what the page constructed and handed it. */
export function elementOf(node: unknown, name: string): Element | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = elementOf(child, name)
      if (hit) return hit
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  const element = node as Element
  if (typeof element.type === 'function') {
    const fn = element.type as { displayName?: string; name: string }
    if ((fn.displayName ?? fn.name) === name) return element
  }
  if (element.props && 'children' in element.props) return elementOf(element.props.children, name)
  return null
}

/** The props of the first element of the named component. */
export function propsOf(node: unknown, name: string): Record<string, unknown> | null {
  return elementOf(node, name)?.props ?? null
}

export async function renderSyncPage() {
  const { default: SyncPage } = await import('@/app/(dashboard)/sync/page')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const tree = await SyncPage()
  return { tree, names: componentNames(tree), html: renderToStaticMarkup(tree) }
}
