import type { Metadata } from 'next'
import { getWcSyncSettings, getWcTaxMappings, getWcStatusMappings, getWcSyncLogs, getWcCredentials } from '@/app/actions/wc-sync'
import { getTaxRates } from '@/app/actions/settings'
import { SyncDashboard } from './sync-dashboard'

export const metadata: Metadata = { title: 'Integrations' }

export default async function SyncPage() {
  const [settings, taxMappings, statusMappings, logs, wcCreds, taxRatesRaw] = await Promise.all([
    getWcSyncSettings(),
    getWcTaxMappings(),
    getWcStatusMappings(),
    getWcSyncLogs(100),
    getWcCredentials(),
    getTaxRates(),
  ])

  const taxRates = taxRatesRaw.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }))

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
        wcCredentials={wcCreds}
      />
    </div>
  )
}
