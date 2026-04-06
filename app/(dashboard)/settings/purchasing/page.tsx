import type { Metadata } from 'next'
import { PackageOpen, Ship } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getSetting, getPurchaseUnits } from '@/app/actions/settings'
import { PurchaseUnitsTable } from '@/components/settings/purchase-units-table'
import { LandedCostMethodSetting } from '@/components/settings/landed-cost-method'

export const metadata: Metadata = { title: 'Purchasing Settings' }

export default async function PurchasingSettingsPage() {
  const [purchaseUnits, landedCostMethod] = await Promise.all([
    getPurchaseUnits(false),
    getSetting('default_landed_cost_method'),
  ])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Purchasing Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Purchase units and landed cost configuration.</p>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <PackageOpen className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Purchase Units</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Define purchase packaging units and their conversion to stock units. For example,
          if you buy wire in 1 km rolls but stock it in metres, create a unit with conversion
          factor 1000.
        </p>
        <PurchaseUnitsTable units={purchaseUnits} />
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Ship className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Landed Cost Distribution</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Default method for distributing additional costs (shipping, customs, fees) across
          purchase order line items. This can be overridden per PO.
        </p>
        <LandedCostMethodSetting currentMethod={landedCostMethod ?? 'BY_VALUE'} />
      </Card>
    </div>
  )
}
