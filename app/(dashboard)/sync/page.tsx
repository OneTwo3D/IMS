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
import { getStrandedAccountingSyncRows } from '@/app/actions/accounting-settlement'
import { getCurrentTaxRateDrift } from '@/lib/domain/accounting/tax-rate-drift-status'
import { SyncDashboard } from './sync-dashboard'
import { ConnectorOrphanBanner } from './connector-orphan-banner'
import { FailedSyncBanner } from './failed-sync-banner'
import { ExceptionsBanner } from './exceptions-banner'
import { getExceptionInboxSummary } from '@/app/actions/sync-exceptions'
import { TaxRateDriftBanner } from './tax-rate-drift-banner'

export const metadata: Metadata = { title: 'Integrations' }

export default async function SyncPage() {
  const pluginState = await getIntegrationPluginState()
  // Resolve the active WMS connector from this single plugin-state read and pass
  // it to getWmsSyncDashboardData so the facade doesn't read plugin state again.
  const activeWmsConnector = WMS_CONNECTOR_IDS.find((id) => pluginState[id]) ?? null
  if (!pluginState.woocommerce && !pluginState.shopify && !pluginState.xero && !pluginState.quickbooks && !activeWmsConnector) {
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
  // o3d-osl8: the rows BEHIND that count, with identifying detail. Deliberately NOT scoped to
  // the active connector — a row stranded on a retired one appears in no other view.
  const strandedRows = await getStrandedAccountingSyncRows(50).catch(() => [])
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
      {orphanSummary && <ConnectorOrphanBanner summary={orphanSummary} stranded={strandedRows} />}
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
