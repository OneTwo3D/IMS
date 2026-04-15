import type { Metadata } from 'next'
import {
  getShoppingConnectorCredentials,
  getShoppingConnectorPaymentMethods,
  getShoppingStatusMappings,
  getShoppingSyncLogs,
  getShoppingSyncSettings,
  getShoppingTaxRateMappings,
} from '@/app/actions/shopping-sync'
import { getXeroSettingsMasked, getXeroConnectionStatus, getXeroAccounts, getXeroSyncLogs, getXeroSyncReadiness, fetchXeroTaxRates } from '@/app/actions/xero-sync'
import { getXeroDailyBatchPreview, getXeroDailyBatchHistory } from '@/app/actions/xero-daily-batch'
import { getPaymentMethodCombos } from '@/app/actions/accounting'
import { getPaymentAccountMap } from '@/lib/accounting'
import { getTaxRates } from '@/app/actions/settings'
import { getCurrencies } from '@/app/actions/currencies'
import { SyncDashboard } from './sync-dashboard'

export const metadata: Metadata = { title: 'Integrations' }

export default async function SyncPage() {
  const [shoppingSettings, shoppingTaxMappings, shoppingStatusMappings, shoppingLogs, shoppingCredentials, taxRatesRaw, xeroSettings, xeroStatus, xeroAccounts, xeroLogs, paymentMethodCombos, paymentAccountMap, xeroReadiness, currenciesRaw, shoppingPaymentMethods, dailyBatchPreview, dailyBatchHistory] = await Promise.all([
    getShoppingSyncSettings(),
    getShoppingTaxRateMappings(),
    getShoppingStatusMappings(),
    getShoppingSyncLogs(100),
    getShoppingConnectorCredentials(),
    getTaxRates(),
    getXeroSettingsMasked(),
    getXeroConnectionStatus(),
    getXeroAccounts(),
    getXeroSyncLogs(50),
    getPaymentMethodCombos(),
    getPaymentAccountMap(),
    getXeroSyncReadiness(),
    getCurrencies(true),
    getShoppingConnectorPaymentMethods(),
    getXeroDailyBatchPreview(),
    getXeroDailyBatchHistory(30),
  ])

  const taxRates = taxRatesRaw.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }))
  const currencies = currenciesRaw.map((c) => ({ code: c.code, name: c.name }))

  // Only hit the Xero Tax Rates API when the connector is live — otherwise
  // the sync page would pay for a round-trip on every render.
  const xeroTaxRates = xeroStatus.connected ? await fetchXeroTaxRates().catch(() => []) : []

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect One Two Inventory with external platforms.
        </p>
      </div>
      <SyncDashboard
        shoppingSettings={shoppingSettings}
        shoppingTaxMappings={shoppingTaxMappings}
        shoppingStatusMappings={shoppingStatusMappings}
        shoppingLogs={shoppingLogs}
        taxRates={taxRates}
        imsTaxRates={taxRatesRaw}
        xeroTaxRates={xeroTaxRates}
        shoppingCredentials={shoppingCredentials}
        xeroSettings={xeroSettings}
        xeroConnected={xeroStatus.connected}
        xeroTenantName={xeroStatus.tenantName}
        xeroAccounts={xeroAccounts}
        xeroLogs={xeroLogs}
        paymentMethodCombos={paymentMethodCombos}
        paymentAccountMap={paymentAccountMap}
        currencies={currencies}
        shoppingPaymentMethods={shoppingPaymentMethods}
        xeroReadiness={xeroReadiness}
        dailyBatchPreview={dailyBatchPreview}
        dailyBatchHistory={dailyBatchHistory}
      />
    </div>
  )
}
