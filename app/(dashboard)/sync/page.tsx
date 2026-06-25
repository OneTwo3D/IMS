import type { Metadata } from 'next'
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
import { getCurrentTaxRateDrift } from '@/lib/domain/accounting/tax-rate-drift-status'
import { SyncDashboard } from './sync-dashboard'
import { ConnectorOrphanBanner } from './connector-orphan-banner'
import { FailedSyncBanner } from './failed-sync-banner'
import { TaxRateDriftBanner } from './tax-rate-drift-banner'

export const metadata: Metadata = { title: 'Integrations' }

export default async function SyncPage() {
  const pluginState = await getIntegrationPluginState()
  const wmsEnabled = WMS_CONNECTOR_IDS.some((id) => pluginState[id])
  if (!pluginState.woocommerce && !pluginState.shopify && !pluginState.xero && !pluginState.quickbooks && !wmsEnabled) {
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
    getWmsSyncDashboardData(),
  ])

  const taxRates = taxRatesRaw.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }))
  const currencies = currenciesRaw.map((c) => ({ code: c.code, name: c.name }))

  // Only hit the accounting Tax Rates API when an accounting connector is live —
  // otherwise the sync page would pay for a round-trip on every render.
  const accountingTaxRates = (pluginState.xero || pluginState.quickbooks) && accountingStatus.connected
    ? await fetchAccountingTaxRates().catch(() => [])
    : []

  // audit-H4: surface accounting sync rows stranded by a connector switch.
  const orphanSummary = await getCrossConnectorOrphanSummary().catch(() => null)
  // audit-6vq0: surface accounting sync rows that exhausted retries (FAILED).
  const failedSyncSummary = await getFailedAccountingSyncSummary().catch(() => null)
  // 0jls5: surface IMS tax rates that have drifted from the live Xero definition.
  const taxRateDrift = pluginState.xero ? await getCurrentTaxRateDrift().catch(() => null) : null

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect One Two Inventory with external platforms.
        </p>
      </div>
      {orphanSummary && <ConnectorOrphanBanner summary={orphanSummary} />}
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
