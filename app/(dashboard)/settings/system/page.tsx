import type { Metadata } from 'next'
import { ActivitySquare, Archive, RotateCcw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getSetting } from '@/app/actions/settings'
import { ActivityLogRetentionSetting } from '@/components/settings/activity-log-retention'
import { DataRetentionSetting } from '@/components/settings/data-retention'
import { DatabaseReset } from '@/components/settings/database-reset'

export const metadata: Metadata = { title: 'System Settings' }

export default async function SystemSettingsPage() {
  const [retInfo, retWarn, retError, drSales, drPurchase, drCustomers, drMovements, drSyncLogs] = await Promise.all([
    getSetting('activity_log_retention_info'),
    getSetting('activity_log_retention_warning'),
    getSetting('activity_log_retention_error'),
    getSetting('retention_sales_orders_months'),
    getSetting('retention_purchase_orders_months'),
    getSetting('retention_customers_months'),
    getSetting('retention_stock_movements_months'),
    getSetting('retention_sync_logs_months'),
  ])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">System Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Activity log retention and database management.</p>
      </div>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <ActivitySquare className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Activity Log Retention</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          How long activity log entries are kept before automatic cleanup. Set to 0 to keep
          entries forever.
        </p>
        <ActivityLogRetentionSetting
          infoValue={retInfo ?? '30'}
          warningValue={retWarn ?? '60'}
          errorValue={retError ?? '90'}
        />
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Archive className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Data Retention</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          How long business records are kept before automatic archival or deletion. Financial records
          are soft-archived (hidden from lists, accessible by direct link). Operational data is permanently deleted.
        </p>
        <DataRetentionSetting
          salesOrdersValue={drSales ?? '0'}
          purchaseOrdersValue={drPurchase ?? '0'}
          customersValue={drCustomers ?? '0'}
          stockMovementsValue={drMovements ?? '0'}
          syncLogsValue={drSyncLogs ?? '6'}
        />
      </Card>

      <Card className="p-6 border-destructive/30">
        <div className="flex items-center gap-2 mb-4">
          <RotateCcw className="h-4 w-4 text-destructive" />
          <h2 className="text-base font-semibold text-destructive">Database Reset</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Reset parts of the database. This is useful for clearing test data before going live,
          or for starting fresh. User accounts are always preserved.
        </p>
        <DatabaseReset />
      </Card>
    </div>
  )
}
