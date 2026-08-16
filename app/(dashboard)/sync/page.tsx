import type { Metadata } from 'next'
import Link from 'next/link'
import { History } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button-variants'
import { redirect } from 'next/navigation'
import {
  getShoppingConnectorCredentials,
  getShoppingConnectorPaymentMethods,
  getShopifyConnectorCredentials,
  getShopifySyncLogs,
  getShopifySyncSettings,
  getShoppingStatusMappings,
  getShoppingSyncLogs,
  getShoppingSyncSettings,
  getShoppingTaxRateMappings,
} from '@/app/actions/shopping-sync'
import {
  fetchAccountingTaxRates,
  getAccountingAccounts,
  getAccountingConnectionStatus,
  getAccountingConnectionTestState,
  getAccountingSettingsMasked,
  getAccountingSyncLogs,
  getAccountingSyncReadiness,
} from '@/app/actions/accounting-sync'
import { getAccountingBatchHistory, getAccountingBatchPreview } from '@/app/actions/accounting-batch'
import { getWmsSyncDashboardData } from '@/app/actions/wms-sync'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getPaymentMethodCombos } from '@/app/actions/accounting'
import { getPaymentAccountMap } from '@/lib/accounting'
import { getTaxRates } from '@/app/actions/settings'
import { getCurrencies } from '@/app/actions/currencies'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getCrossConnectorOrphanSummary, getFailedAccountingSyncSummary } from '@/app/actions/accounting-sync'
import { getStrandedAccountingSyncRows } from '@/app/actions/accounting-stranded-rows'
import type { StrandedSyncRowsResult } from '@/lib/domain/accounting/stranded-sync-rows'
import { shouldRedirectFromSyncPage } from '@/lib/domain/accounting/stranded-sync-visibility'
import { getSession, requirePermission } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { isAuthorizationDenial } from '@/lib/auth/session-gates'
import { getCurrentTaxRateDrift } from '@/lib/domain/accounting/tax-rate-drift-status'
import { SyncDashboard } from './sync-dashboard'
import { SyncAccessDenied } from './access-denied'
import { ConnectorOrphanBanner } from './connector-orphan-banner'
import { FailedSyncBanner } from './failed-sync-banner'
import { ExceptionsBanner } from './exceptions-banner'
import { getExceptionInboxSummary } from '@/app/actions/sync-exceptions'
import { TaxRateDriftBanner } from './tax-rate-drift-banner'

export const metadata: Metadata = { title: 'Integrations' }

/**
 * Next signals redirect() / notFound() by THROWING, so a catch around a server read will happily
 * swallow them. requireAuth inside the stranded-row loader redirects for an unverified 2FA
 * session or an invalidated one — silently turning that into "the stranded list failed to load"
 * would leave the operator on this page instead of at the challenge.
 */
function isFrameworkControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest.startsWith('NEXT_HTTP_ERROR_FALLBACK'))
}

/**
 * Errors this page must NEVER absorb into a degraded panel.
 *
 * Two categories, for the same reason: neither is a dependency outage.
 *   * framework control flow — a redirect() is the answer, not an error to report;
 *   * an authorization denial — the reader was never entitled to this. Rendering that as
 *     "temporarily unavailable" hands a role without the permission a partially populated
 *     Integrations page (banners, accounting state, controls) and tells it to reload. The page
 *     gate below should already have stopped such a reader, so a denial reaching here means a
 *     read demands MORE than the page does; the honest response is to fail the whole page, which
 *     is exactly what the pre-panelisation Promise.all did.
 */
function isFatal(error: unknown): boolean {
  return isFrameworkControlFlow(error) || isAuthorizationDenial(error)
}

/**
 * One independent panel's read.
 *
 * This page aggregates a dozen unrelated panels, and an `await` that rejects anywhere in a server
 * component aborts the WHOLE component — the operator gets the error boundary instead of the
 * eleven panels that were fine. That is not merely untidy here: the most likely cause of the
 * stranded-row read failing (the database being unreachable, an AccountingSyncLog read erroring)
 * is exactly what makes the NEIGHBOURING reads fail too, so the failure banner that exists to
 * explain it could almost never be reached. Each non-essential read therefore degrades to a
 * declared-unavailable panel instead of taking the page down.
 *
 * `null` is "this panel is unavailable", which every consumer already distinguishes from empty.
 * Framework control flow and authorization denials are rethrown, never absorbed: an auth redirect
 * must still redirect, and "you may not see this" must not read as "this is temporarily down".
 */
async function panel<T>(label: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (isFatal(error)) throw error
    console.error(`[sync] the ${label} panel failed to load`, error)
    return null
  }
}

export default async function SyncPage() {
  /**
   * THE PAGE BOUNDARY. `sync` is what this page is, and it is enforced here — before any
   * dashboard read, any banner read and any plugin-state read — rather than being left to the
   * individual actions.
   *
   * Why it has to be here and not only in the reads: the page renders a dozen independently
   * degradable panels, so a role that merely fails every read still gets an Integrations page
   * back, and a read whose own gate is weaker than `sync` (several require only authentication)
   * would populate it. The sidebar already shows this page only to `sync` holders
   * (components/layout/sidebar.tsx) and every mutating control on it requires `sync`; the page
   * itself was the one entrance that checked only authentication.
   *
   * The denial is ANSWERED HERE rather than thrown at the RSC boundary. It is still fail-closed —
   * nothing below this line runs, no read happens, no page is rendered — but a role denial is a
   * stable, explainable state, and app/(dashboard)/error.tsx renders it as "Something went wrong"
   * with Go to Login and Try Again, neither of which can ever resolve it (in production the
   * boundary sees only a digest, so it cannot even recognise the case). See access-denied.tsx.
   *
   * Not a redirect: an unentitled reader is told why, rather than given a tour of somewhere else
   * it may not be able to act on either. requireAuth inside requirePermission still THROWS its
   * redirect for an unauthenticated / unverified-2FA / invalidated session, and that is rethrown
   * untouched below — an authentication challenge is not an authorization denial.
   */
  let session
  try {
    session = await requirePermission('sync')
  } catch (error) {
    if (isAuthorizationDenial(error)) {
      // The denial screen's destination depends on the ROLE (round 5, finding 4): SUPPLIER cannot
      // reach /dashboard. requirePermission threw before handing back a session, so it is read
      // again here. getSession does NOT redirect — an unauthenticated session cannot reach this
      // line (requirePermission redirects it), and if one somehow did, a null role falls back to
      // the destination every role holds rather than to a second denial.
      const denied = await getSession()
      return <SyncAccessDenied role={denied?.user?.role ?? null} />
    }
    throw error
  }

  /**
   * Round 5, finding 3. `sync` gets you this page; CANCELLING an orphaned connector's queue is a
   * destructive write and stays on `settings`, which MANAGER does not hold. The banner used to
   * render its cancel buttons for everyone, and cancelOrphanedAccountingSyncRows' gate throws
   * rather than returning `{ success: false }` — so a MANAGER click produced an unhandled
   * rejection inside a transition, not the banner's own error line. The capability is now decided
   * HERE, where the session is, and passed down; the action still re-checks.
   */
  const canCancelOrphans = hasPermission(session.user.role, 'settings')

  const pluginState = await getIntegrationPluginState()
  // Resolve the active WMS connector from this single plugin-state read and pass
  // it to getWmsSyncDashboardData so the facade doesn't read plugin state again.
  const activeWmsConnector = WMS_CONNECTOR_IDS.find((id) => pluginState[id]) ?? null
  const anyIntegrationPluginEnabled = !!(
    pluginState.woocommerce || pluginState.shopify || pluginState.xero || pluginState.quickbooks || activeWmsConnector
  )

  // o3d-osl8 item 1: the rows behind the orphan count, with identifying detail. Deliberately NOT
  // scoped to the active connector — a row stranded on a retired one appears in no other view.
  //
  // READ BEFORE THE REDIRECT BELOW, on purpose. When the retired accounting connector was the
  // last enabled plugin, every unresolved accounting row is stranded (buildStrandedSyncRowWhere
  // returns an unscoped predicate) — and redirecting first made this page, the only one that can
  // show them, unreachable in exactly that state.
  //
  // The loader returns per-row detail (ids, referenced entities, external transaction ids, raw
  // connector error text) and requires `sync`, which the page boundary above has already
  // established — a reader without it never reaches this line, so the read still cannot happen
  // for an unentitled role. The action re-checks anyway; this is not the only gate.
  let stranded: StrandedSyncRowsResult | null = null
  // A FAILED read is its own state, not an empty one. Collapsing it to [] silently demoted the
  // banner to count-only — or, when only inactive FAILED rows exist, removed it altogether,
  // recreating the precise blind spot this feature closes.
  let strandedLoadFailed = false
  try {
    stranded = await getStrandedAccountingSyncRows(50)
  } catch (error) {
    // A denial from the action means its gate is stricter than the page's; that is a bug to
    // surface, not a row list to quietly report as unavailable.
    if (isFatal(error)) throw error
    strandedLoadFailed = true
    console.error('[sync] failed to load stranded accounting sync rows', error)
  }

  if (shouldRedirectFromSyncPage({
    anyIntegrationPluginEnabled,
    // Invariant, not a shortcut: requirePermission('sync') above is the only way to get here.
    hasSyncPermission: true,
    strandedRowsExist: (stranded?.rows.length ?? 0) > 0,
    strandedRowsUnknown: strandedLoadFailed,
  })) {
    redirect('/settings/system?tab=plugins')
  }

  // The dashboard's own reads, started together as before. They are ONE panel: unlike the banners
  // they are not independently meaningful — a half-loaded dashboard would show "no credentials",
  // "no sync activity", "no accounts" for reads that never came back, which is the same lie
  // (failure rendered as emptiness) that the stranded-row failure state exists to stop telling.
  // So they fail together, and they fail into an explicit notice rather than into defaults.
  const dashboardReads = [
    getShoppingSyncSettings(),
    getShoppingTaxRateMappings(),
    getShoppingStatusMappings(),
    getShoppingSyncLogs(100),
    getShoppingConnectorCredentials(),
    pluginState.shopify ? getShopifySyncSettings() : Promise.resolve({ shopify_sync_enabled: 'false' }),
    pluginState.shopify
      ? getShopifyConnectorCredentials()
      : Promise.resolve({
          storeDomain: '',
          adminApiAccessToken: '',
          accessTokenMasked: false,
          webhookSecret: '',
          webhookSecretMasked: false,
          envOverrides: {},
        }),
    pluginState.shopify ? getShopifySyncLogs(100) : Promise.resolve([]),
    getTaxRates(),
    getAccountingSettingsMasked(),
    getAccountingConnectionStatus(),
    getAccountingConnectionTestState(),
    getAccountingAccounts(),
    getAccountingSyncLogs(50),
    getPaymentMethodCombos(),
    getPaymentAccountMap(),
    getAccountingSyncReadiness(),
    getCurrencies(true),
    pluginState.woocommerce ? getShoppingConnectorPaymentMethods() : Promise.resolve([]),
    getAccountingBatchPreview(),
    getAccountingBatchHistory(30),
    getWmsSyncDashboardData(activeWmsConnector),
  ] as const

  // allSettled, NOT all. Promise.all rejects on the FIRST rejection, so a redirect thrown by one
  // read (requireSyncPermission and friends redirect an unverified-2FA or invalidated session)
  // could be masked by an ordinary failure in another that happened to lose the race. Every read
  // settles before anything is decided, and control flow wins over any number of ordinary errors.
  const settledDashboardReads = await Promise.allSettled(dashboardReads)
  const dashboardRejections = settledDashboardReads.filter((r) => r.status === 'rejected')
  // Control flow first (a redirect is the most specific answer available), then denials. Both are
  // decided across ALL rejections, before any panel decision: a single denial among twenty-two
  // reads must take the page down rather than be outvoted into "this panel is unavailable".
  const dashboardControlFlow = dashboardRejections.find((r) => isFrameworkControlFlow(r.reason))
  if (dashboardControlFlow) throw dashboardControlFlow.reason
  const dashboardDenial = dashboardRejections.find((r) => isAuthorizationDenial(r.reason))
  if (dashboardDenial) throw dashboardDenial.reason
  for (const rejection of dashboardRejections) {
    // No per-read label: the rejection's own stack names the action, and a parallel label array
    // would silently misattribute the moment a read is inserted.
    console.error('[sync] a dashboard read failed; the dashboard panel is unavailable', rejection.reason)
  }

  // Hoisted, so the destructuring stays positional next to the reads above instead of being
  // rebuilt by index. Every promise is already settled by the time this runs.
  async function readDashboard() {
    const [shoppingSettings, shoppingTaxMappings, shoppingStatusMappings, shoppingLogs, shoppingCredentials, shopifySettings, shopifyCredentials, shopifyLogs, taxRatesRaw, accountingSettings, accountingStatus, accountingConnectionTest, accountingAccounts, accountingLogs, paymentMethodCombos, paymentAccountMap, accountingReadiness, currenciesRaw, shoppingPaymentMethods, accountingBatchPreview, accountingBatchHistory, wmsData] = await Promise.all(dashboardReads)
    return {
      shoppingSettings,
      shoppingTaxMappings,
      shoppingStatusMappings,
      shoppingLogs,
      shoppingCredentials,
      shopifySettings,
      shopifyCredentials,
      shopifyLogs,
      taxRatesRaw,
      accountingSettings,
      accountingStatus,
      accountingConnectionTest,
      accountingAccounts,
      accountingLogs,
      paymentMethodCombos,
      paymentAccountMap,
      accountingReadiness,
      currenciesRaw,
      shoppingPaymentMethods,
      accountingBatchPreview,
      accountingBatchHistory,
      wmsData,
      taxRates: taxRatesRaw.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name })),
      currencies: currenciesRaw.map((c) => ({ code: c.code, name: c.name })),
    }
  }

  const dashboard = dashboardRejections.length > 0 ? null : await readDashboard()

  // Only hit the accounting Tax Rates API when an accounting connector is live —
  // otherwise the sync page would pay for a round-trip on every render.
  const accountingTaxRates = dashboard && (pluginState.xero || pluginState.quickbooks) && dashboard.accountingStatus.connected
    // o3d-r30: passive display read — the settings page rate list may be up to 4h stale; the explicit
    // "Refresh Xero tax rates" button and the authoritative auto-link both read live.
    ? (await panel('accounting tax rates', () => fetchAccountingTaxRates({ allowCache: true }))) ?? []
    : []

  // Each banner is its own panel: independently read, independently degradable, and — crucially —
  // rendered even when the dashboard below could not be. `panel` rather than `.catch(() => null)`
  // so a redirect thrown inside one of these is still a redirect and not a blank banner.
  //
  // audit-H4: surface accounting sync rows stranded by a connector switch.
  const orphanSummary = await panel('connector orphan summary', () => getCrossConnectorOrphanSummary())
  // audit-6vq0: surface accounting sync rows that exhausted retries (FAILED).
  const failedSyncSummary = await panel('failed accounting sync summary', () => getFailedAccountingSyncSummary())
  // 0jls5: surface IMS tax rates that have drifted from the live Xero definition.
  const taxRateDrift = pluginState.xero ? await panel('tax rate drift', () => getCurrentTaxRateDrift()) : null
  // q66in.4.2: aggregate count of dead-lettered/parked sync work across connectors.
  const exceptionSummary = await panel('exception inbox', () => getExceptionInboxSummary())

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect One Two Inventory with external platforms.
          </p>
        </div>
        {/* q66in.4.6: audit-grade before/after timeline of WMS connector mutations. */}
        <Link href="/sync/events" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <History className="h-4 w-4 mr-1" />Event Timeline
        </Link>
      </div>
      {exceptionSummary && <ExceptionsBanner summary={exceptionSummary} />}
      {/* Unconditional: whether there is anything to show is resolveConnectorOrphanBannerState's
          decision (the banner returns null when there is not), so the "does it render" rule lives
          in ONE pure, tested place instead of being half-expressed here. It must render when the
          summary failed but rows exist, and when the ROW READ failed regardless of the summary. */}
      <ConnectorOrphanBanner
        summary={orphanSummary}
        stranded={stranded}
        strandedLoadFailed={strandedLoadFailed}
        canCancel={canCancelOrphans}
        // o3d-osl8 round 7, finding 3: the marker that lets the banner OBSERVE that a
        // router.refresh() actually produced a new server payload, instead of asserting it did.
        // Generated per render, so a cached RSC payload carries the marker of the render it was
        // cached from and is correctly reported as "not refreshed".
        serverRenderedAt={new Date().toISOString()}
      />
      {failedSyncSummary && <FailedSyncBanner summary={failedSyncSummary} />}
      {taxRateDrift && <TaxRateDriftBanner drift={taxRateDrift} />}
      {/* An unavailable dashboard is stated, not implied by an empty one — and it no longer takes
          the banners above down with it. */}
      {!dashboard && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          The integration settings and sync history below could not be loaded, so they are not shown. This does NOT
          mean nothing is configured or that nothing has synced. Any warnings above were read separately and still
          apply. Reload this page to try again.
        </p>
      )}
      {dashboard && (
        <SyncDashboard
          pluginState={pluginState}
          shoppingSettings={dashboard.shoppingSettings}
          shoppingTaxMappings={dashboard.shoppingTaxMappings}
          shoppingStatusMappings={dashboard.shoppingStatusMappings}
          shoppingLogs={dashboard.shoppingLogs}
          taxRates={dashboard.taxRates}
          imsTaxRates={dashboard.taxRatesRaw}
          accountingTaxRates={accountingTaxRates}
          shoppingCredentials={dashboard.shoppingCredentials}
          shopifySettings={dashboard.shopifySettings}
          shopifyCredentials={dashboard.shopifyCredentials}
          shopifyLogs={dashboard.shopifyLogs}
          accountingSettings={dashboard.accountingSettings}
          accountingConnected={dashboard.accountingStatus.connected}
          accountingTenantName={dashboard.accountingStatus.tenantName}
          accountingConnectionTest={dashboard.accountingConnectionTest}
          accountingAccounts={dashboard.accountingAccounts}
          accountingLogs={dashboard.accountingLogs}
          paymentMethodCombos={dashboard.paymentMethodCombos}
          paymentAccountMap={dashboard.paymentAccountMap}
          currencies={dashboard.currencies}
          shoppingPaymentMethods={dashboard.shoppingPaymentMethods}
          accountingReadiness={dashboard.accountingReadiness}
          accountingBatchPreview={dashboard.accountingBatchPreview}
          accountingBatchHistory={dashboard.accountingBatchHistory}
          wmsData={dashboard.wmsData}
        />
      )}
    </div>
  )
}
