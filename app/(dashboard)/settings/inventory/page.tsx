import type { Metadata } from 'next'
import { SlidersHorizontal } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getAdjustmentReasons } from '@/app/actions/settings'
import { AdjustmentReasonsTable } from '@/components/settings/adjustment-reasons-table'

export const metadata: Metadata = { title: 'Inventory Settings' }

export default async function InventorySettingsPage() {
  const reasons = await getAdjustmentReasons()

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Inventory Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Stock adjustment reasons and inventory configuration.</p>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Stock Adjustment Reasons</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Define selectable reasons for stock adjustments. Each reason can be linked to a specific
          Xero account code — when set, adjustments using that reason will post to that account
          instead of the default inventory adjustment account.
        </p>
        <AdjustmentReasonsTable reasons={reasons} />
      </Card>
    </div>
  )
}
