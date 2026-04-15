import type { Metadata } from 'next'
import Link from 'next/link'
import { ActivitySquare, Archive, RotateCcw, Timer } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/card'
import { getSetting } from '@/app/actions/settings'
import { ActivityLogRetentionSetting } from '@/components/settings/activity-log-retention'
import { DataRetentionSetting } from '@/components/settings/data-retention'
import { DatabaseReset } from '@/components/settings/database-reset'
import { CronJobsSettings } from '@/components/settings/cron-jobs-settings'
import type { CronJobState } from '@/components/settings/cron-jobs-settings'
import { getAllCronJobs } from '@/lib/cron-jobs'

export const metadata: Metadata = { title: 'System Settings' }

const TABS = [
  { key: 'scheduler', label: 'Scheduler', icon: Timer },
  { key: 'retention', label: 'Data Retention', icon: Archive },
  { key: 'reset', label: 'Database Reset', icon: RotateCcw },
] as const

type Tab = (typeof TABS)[number]['key']

export default async function SystemSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = typeof params.tab === 'string' ? params.tab : undefined
  const activeTab: Tab = TABS.some((t) => t.key === raw) ? (raw as Tab) : 'scheduler'

  // Only fetch data needed for the active tab
  const [cronJobs, retentionData] = await Promise.all([
    activeTab === 'scheduler' ? loadCronJobs() : null,
    activeTab === 'retention' ? loadRetentionData() : null,
  ])

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">System Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Scheduled jobs, data retention, and database management.</p>
      </div>

      <div className="flex gap-1 border-b">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = tab.key === activeTab
          return (
            <Link
              key={tab.key}
              href={`/settings/system?tab=${tab.key}`}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border',
              )}
            >
              <Icon className={cn('h-3.5 w-3.5', tab.key === 'reset' && active && 'text-destructive')} />
              {tab.label}
            </Link>
          )
        })}
      </div>

      {activeTab === 'scheduler' && cronJobs && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground mb-4">
            Enable or disable cron jobs and set their frequency. Changes are applied to the
            system crontab when you save.
          </p>
          <p className="text-sm text-muted-foreground mb-4">
            WooCommerce is now webhook-first for order and product intake. The WooCommerce scheduler entry is a backup reconciliation job and should normally run daily rather than every few minutes.
          </p>
          <CronJobsSettings jobs={cronJobs} />
        </Card>
      )}

      {activeTab === 'retention' && retentionData && (
        <div className="space-y-6">
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
              infoValue={retentionData.retInfo ?? '30'}
              warningValue={retentionData.retWarn ?? '60'}
              errorValue={retentionData.retError ?? '90'}
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
              salesOrdersValue={retentionData.drSales ?? '0'}
              purchaseOrdersValue={retentionData.drPurchase ?? '0'}
              customersValue={retentionData.drCustomers ?? '0'}
              stockMovementsValue={retentionData.drMovements ?? '0'}
              syncLogsValue={retentionData.drSyncLogs ?? '6'}
            />
          </Card>
        </div>
      )}

      {activeTab === 'reset' && (
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
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data loaders — only called for the active tab
// ---------------------------------------------------------------------------

async function loadCronJobs(): Promise<CronJobState[]> {
  const allJobs = getAllCronJobs()
  const cronSettingKeys = allJobs.flatMap((j) => [
    `cron_${j.settingKey}_enabled`,
    `cron_${j.settingKey}_schedule`,
  ])
  // Also fetch any legacy enabled keys as fallbacks
  const legacyKeys = allJobs
    .filter((j) => j.legacyEnabledKey)
    .map((j) => j.legacyEnabledKey!)

  const [cronValues, legacyValues] = await Promise.all([
    Promise.all(cronSettingKeys.map((k) => getSetting(k))),
    Promise.all(legacyKeys.map((k) => getSetting(k))),
  ])

  const settings = new Map<string, string | null>()
  cronSettingKeys.forEach((key, i) => settings.set(key, cronValues[i]))
  legacyKeys.forEach((key, i) => settings.set(key, legacyValues[i]))

  return allJobs.map((j) => {
    const cronEnabled = settings.get(`cron_${j.settingKey}_enabled`)
    // If the new cron_*_enabled key has never been saved, fall back to legacy key
    let enabled: boolean
    if (cronEnabled !== null) {
      enabled = cronEnabled === 'true'
    } else if (j.legacyEnabledKey) {
      enabled = settings.get(j.legacyEnabledKey) === 'true'
    } else {
      enabled = j.defaultEnabled
    }

    return {
      slug: j.slug,
      settingKey: j.settingKey,
      module: j.module,
      moduleLabel: j.moduleLabel,
      label: j.label,
      description: j.description,
      enabled,
      schedule: settings.get(`cron_${j.settingKey}_schedule`) ?? j.defaultSchedule,
    }
  })
}

async function loadRetentionData() {
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
  return { retInfo, retWarn, retError, drSales, drPurchase, drCustomers, drMovements, drSyncLogs }
}
