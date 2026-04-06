import type { Metadata } from 'next'
import { ActivitySquare, RotateCcw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { getSetting } from '@/app/actions/settings'
import { ActivityLogRetentionSetting } from '@/components/settings/activity-log-retention'
import { DatabaseReset } from '@/components/settings/database-reset'

export const metadata: Metadata = { title: 'System Settings' }

export default async function SystemSettingsPage() {
  const [retInfo, retWarn, retError] = await Promise.all([
    getSetting('activity_log_retention_info'),
    getSetting('activity_log_retention_warning'),
    getSetting('activity_log_retention_error'),
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
