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
import { getMintsoftDashboardData } from '@/app/actions/mintsoft-sync'
import { getPaymentMethodCombos } from '@/app/actions/accounting'
import { getPaymentAccountMap } from '@/lib/accounting'
import { getTaxRates } from '@/app/actions/settings'
import { getCurrencies } from '@/app/actions/currencies'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getCrossConnectorOrphanSummary } from '@/app/actions/accounting-sync'
import { SyncDashboard } from './sync-dashboard'
import { ConnectorOrphanBanner } from './connector-orphan-banner'

export const metadata: Metadata = { title: 'Integrations' }

export default async function SyncPage() {
  const pluginState = await getIntegrationPluginState()
  if (!pluginState.woocommerce && !pluginState.shopify && !pluginState.xero && !pluginState.quickbooks && !pluginState.mintsoft) {
    redirect('/settings/system?tab=plugins')
  }

  const [shoppingSettings, shoppingTaxMappings, shoppingStatusMappings, shoppingLogs, shoppingCredentials, shopifySettings, shopifyCredentials, shopifyLogs, taxRatesRaw, accountingSettings, accountingStatus, accountingConnectionTest, accountingAccounts, accountingLogs, paymentMethodCombos, paymentAccountMap, accountingReadiness, currenciesRaw, shoppingPaymentMethods, accountingBatchPreview, accountingBatchHistory, mintsoftData] = await Promise.all([
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
    pluginState.mintsoft ? getMintsoftDashboardData() : Promise.resolve(null),
  ])

  const taxRates = taxRatesRaw.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }))
  const currencies = currenciesRaw.map((c) => ({ code: c.code, name: c.name }))

  // Only hit the Xero Tax Rates API when the connector is live — otherwise
  // the sync page would pay for a round-trip on every render.
  const accountingTaxRates = pluginState.xero && accountingStatus.connected
    ? await fetchAccountingTaxRates().catch(() => [])
    : []

  // audit-H4: surface accounting sync rows stranded by a connector switch.
  const orphanSummary = await getCrossConnectorOrphanSummary().catch(() => null)

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect One Two Inventory with external platforms.
        </p>
      </div>
      {orphanSummary && <ConnectorOrphanBanner summary={orphanSummary} />}
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
        mintsoftData={mintsoftData}
      />
    </div>
  )
}
