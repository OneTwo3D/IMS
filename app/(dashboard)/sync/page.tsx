import type { Metadata } from 'next'
import { getWcSyncSettings, getWcTaxRateMappings, getWcStatusMappings, getWcSyncLogs, getWcCredentials, getWcActivePaymentGateways } from '@/app/actions/wc-sync'
import { getXeroSettingsMasked, getXeroConnectionStatus, getXeroAccounts, getXeroSyncLogs, getXeroSyncReadiness, fetchXeroTaxRates } from '@/app/actions/xero-sync'
import { getXeroDailyBatchPreview, getXeroDailyBatchHistory } from '@/app/actions/xero-daily-batch'
import { getPaymentMethodCombos } from '@/app/actions/accounting'
import { getPaymentAccountMap } from '@/lib/accounting'
import { getTaxRates } from '@/app/actions/settings'
import { getCurrencies } from '@/app/actions/currencies'
import { SyncDashboard } from './sync-dashboard'

export const metadata: Metadata = { title: 'Integrations' }

export default async function SyncPage() {
  const [settings, taxMappings, statusMappings, logs, wcCreds, taxRatesRaw, xeroSettings, xeroStatus, xeroAccounts, xeroLogs, paymentMethodCombos, paymentAccountMap, xeroReadiness, currenciesRaw, wcPaymentGateways, dailyBatchPreview, dailyBatchHistory] = await Promise.all([
    getWcSyncSettings(),
    getWcTaxRateMappings(),
    getWcStatusMappings(),
    getWcSyncLogs(100),
    getWcCredentials(),
    getTaxRates(),
    getXeroSettingsMasked(),
    getXeroConnectionStatus(),
    getXeroAccounts(),
    getXeroSyncLogs(50),
    getPaymentMethodCombos(),
    getPaymentAccountMap(),
    getXeroSyncReadiness(),
    getCurrencies(true),
    getWcActivePaymentGateways(),
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
        wcSettings={settings}
        wcTaxMappings={taxMappings}
        wcStatusMappings={statusMappings}
        wcLogs={logs}
        taxRates={taxRates}
        imsTaxRates={taxRatesRaw}
        xeroTaxRates={xeroTaxRates}
        wcCredentials={wcCreds}
        xeroSettings={xeroSettings}
        xeroConnected={xeroStatus.connected}
        xeroTenantName={xeroStatus.tenantName}
        xeroAccounts={xeroAccounts}
        xeroLogs={xeroLogs}
        paymentMethodCombos={paymentMethodCombos}
        paymentAccountMap={paymentAccountMap}
        currencies={currencies}
        wcPaymentGateways={wcPaymentGateways}
        xeroReadiness={xeroReadiness}
        dailyBatchPreview={dailyBatchPreview}
        dailyBatchHistory={dailyBatchHistory}
      />
    </div>
  )
}
