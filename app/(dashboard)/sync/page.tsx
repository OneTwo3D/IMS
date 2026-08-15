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
import { getSession } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { getCurrentTaxRateDrift } from '@/lib/domain/accounting/tax-rate-drift-status'
import { SyncDashboard } from './sync-dashboard'
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

export default async function SyncPage() {
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
  // Gated on `sync` HERE as well as inside the action. The loader returns per-row detail (ids,
  // referenced entities, external transaction ids, raw connector error text), so a role without
  // `sync` must not merely fail to render it — it must never cause the read, and must redirect
  // exactly as it did before. Checking the role first also keeps the page off the action's throw
  // path, so an unauthorised role is a section that is absent, not one that silently failed.
  const session = await getSession()
  const canSeeStrandedRows = !!session && hasPermission(session.user.role, 'sync')
  let stranded: StrandedSyncRowsResult | null = null
  // A FAILED read is its own state, not an empty one. Collapsing it to [] silently demoted the
  // banner to count-only — or, when only inactive FAILED rows exist, removed it altogether,
  // recreating the precise blind spot this feature closes.
  let strandedLoadFailed = false
  if (canSeeStrandedRows) {
    try {
      stranded = await getStrandedAccountingSyncRows(50)
    } catch (error) {
      if (isFrameworkControlFlow(error)) throw error
      strandedLoadFailed = true
      console.error('[sync] failed to load stranded accounting sync rows', error)
    }
  }

  if (shouldRedirectFromSyncPage({
    anyIntegrationPluginEnabled,
    hasSyncPermission: canSeeStrandedRows,
    strandedRowsExist: (stranded?.rows.length ?? 0) > 0,
    strandedRowsUnknown: strandedLoadFailed,
  })) {
    redirect('/settings/system?tab=plugins')
  }

  const [shoppingSettings, shoppingTaxMappings, shoppingStatusMappings, shoppingLogs, shoppingCredentials, shopifySettings, shopifyCredentials, shopifyLogs, taxRatesRaw, accountingSettings, accountingStatus, accountingConnectionTest, accountingAccounts, accountingLogs, paymentMethodCombos, paymentAccountMap, accountingReadiness, currenciesRaw, shoppingPaymentMethods, accountingBatchPreview, accountingBatchHistory, wmsData] = await Promise.all([
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
  ])

  const taxRates = taxRatesRaw.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }))
  const currencies = currenciesRaw.map((c) => ({ code: c.code, name: c.name }))

  // Only hit the accounting Tax Rates API when an accounting connector is live —
  // otherwise the sync page would pay for a round-trip on every render.
  const accountingTaxRates = (pluginState.xero || pluginState.quickbooks) && accountingStatus.connected
    // o3d-r30: passive display read — the settings page rate list may be up to 4h stale; the explicit
    // "Refresh Xero tax rates" button and the authoritative auto-link both read live.
    ? await fetchAccountingTaxRates({ allowCache: true }).catch(() => [])
    : []

  // audit-H4: surface accounting sync rows stranded by a connector switch.
  const orphanSummary = await getCrossConnectorOrphanSummary().catch(() => null)
  // audit-6vq0: surface accounting sync rows that exhausted retries (FAILED).
  const failedSyncSummary = await getFailedAccountingSyncSummary().catch(() => null)
  // 0jls5: surface IMS tax rates that have drifted from the live Xero definition.
  const taxRateDrift = pluginState.xero ? await getCurrentTaxRateDrift().catch(() => null) : null
  // q66in.4.2: aggregate count of dead-lettered/parked sync work across connectors.
  const exceptionSummary = await getExceptionInboxSummary().catch(() => null)

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
      />
      {failedSyncSummary && <FailedSyncBanner summary={failedSyncSummary} />}
      {taxRateDrift && <TaxRateDriftBanner drift={taxRateDrift} />}
      <SyncDashboard
        pluginState={pluginState}
        shoppingSettings={shoppingSettings}
        shoppingTaxMappings={shoppingTaxMappings}
        shoppingStatusMappings={shoppingStatusMappings}
        shoppingLogs={shoppingLogs}
        taxRates={taxRates}
        imsTaxRates={taxRatesRaw}
        accountingTaxRates={accountingTaxRates}
        shoppingCredentials={shoppingCredentials}
        shopifySettings={shopifySettings}
        shopifyCredentials={shopifyCredentials}
        shopifyLogs={shopifyLogs}
        accountingSettings={accountingSettings}
        accountingConnected={accountingStatus.connected}
        accountingTenantName={accountingStatus.tenantName}
        accountingConnectionTest={accountingConnectionTest}
        accountingAccounts={accountingAccounts}
        accountingLogs={accountingLogs}
        paymentMethodCombos={paymentMethodCombos}
        paymentAccountMap={paymentAccountMap}
        currencies={currencies}
        shoppingPaymentMethods={shoppingPaymentMethods}
        accountingReadiness={accountingReadiness}
        accountingBatchPreview={accountingBatchPreview}
        accountingBatchHistory={accountingBatchHistory}
        wmsData={wmsData}
      />
    </div>
  )
}
