import type { Metadata } from 'next'
import { SlidersHorizontal } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getAdjustmentReasons, getWarehousesForSettings, getAccountCodes } from '@/app/actions/settings'
import { AdjustmentReasonsTable } from '@/components/settings/adjustment-reasons-table'
import { WarehousesTable } from '@/components/settings/warehouses-table'
import { getIntegrationPluginState } from '@/lib/integration-plugins'

export const metadata: Metadata = { title: 'Inventory Settings' }

export default async function InventorySettingsPage() {
  const pluginState = await getIntegrationPluginState()
  const [reasons, warehouses, accountCodes] = await Promise.all([
    getAdjustmentReasons(),
    getWarehousesForSettings(),
    pluginState.xero ? getAccountCodes() : Promise.resolve([]),
  ])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Inventory Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Warehouses, stock adjustment reasons, and inventory configuration.</p>
      </div>

      <Card className="p-6">
        <WarehousesTable warehouses={warehouses} showStoreSync={pluginState.woocommerce} />
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Stock Adjustment Reasons</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Define selectable reasons for stock adjustments.
          {pluginState.xero ? (
            <> Each reason can be linked to an account code from your accounting integration so adjustments can post to a specific account.</>
          ) : null}
        </p>
        <AdjustmentReasonsTable reasons={reasons} accountCodes={accountCodes} showAccountCode={pluginState.xero} />
      </Card>
    </div>
  )
}
