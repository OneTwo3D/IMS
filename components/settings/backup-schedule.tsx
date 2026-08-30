'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { saveBackupScheduleSettings } from '@/app/actions/settings'
import { validateBackupScheduleInput } from '@/lib/domain/settings/backup-schedule-input'
import { resolveSettingSaveView } from '@/lib/domain/settings/setting-save-outcome'

type Props = {
  enabled: boolean
  retentionDays: string
  maxCount: string
  autoUpload: string
}

export function BackupScheduleSettings({ enabled, retentionDays, maxCount, autoUpload }: Props) {
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  /** Saved, but the crontab is behind. Not an error — see handleSave. */
  const [schedulerWarning, setSchedulerWarning] = useState('')
  const [isEnabled, setIsEnabled] = useState(enabled)
  const [days, setDays] = useState(retentionDays)
  const [max, setMax] = useState(maxCount)
  const [upload, setUpload] = useState(autoUpload)

  function handleSave() {
    setSaved(false)
    setError('')
    setSchedulerWarning('')

    const input = { enabled: isEnabled, retentionDays: days, maxCount: max, autoUpload: upload }
    // Immediate feedback only. The SAME function is the server action's gate, so a value that slips
    // past here is still refused there rather than stored.
    const validated = validateBackupScheduleInput(input)
    if (!validated.ok) {
      setError(validated.error)
      return
    }

    startTransition(async () => {
      try {
        // ONE round trip, and the crontab reconciliation is INSIDE it (Codex r20 HIGH). This screen
        // used to save through the generic key/value writer, which never reconciled the crontab and
        // never wrote `cron_backup_enabled` — so the switch below could store 'true' and install no
        // cron line at all. The action writes both enablement rows and reconciles; the screen only
        // renders the outcome.
        const view = resolveSettingSaveView({
          result: await saveBackupScheduleSettings(input),
          what: 'The backup schedule',
        })
        if (!view.committed) {
          setError(view.error)
          return
        }
        setSchedulerWarning(view.warning)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save the backup schedule')
      }
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Runs via <code className="text-xs bg-muted px-1 rounded">/api/cron/backup</code> on the schedule set for
        the <strong>Database Backup</strong> job in Settings &rarr; System &rarr; Scheduled Jobs. The switch below
        is the same enablement the scheduler reads — saving it rewrites the crontab. Old backups are automatically
        purged based on the retention settings.
      </p>

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
        Enable scheduled backups
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-lg">
        <div className="space-y-1.5">
          <Label className="text-xs">Retention (days)</Label>
          <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} className="h-9" />
          <p className="text-xs text-muted-foreground">Delete backups older than this</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Max backups</Label>
          <Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} className="h-9" />
          <p className="text-xs text-muted-foreground">Keep at most this many</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Auto-upload</Label>
          <select
            value={upload}
            onChange={(e) => setUpload(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          >
            <option value="">None</option>
            <option value="s3">S3</option>
            <option value="sftp">SFTP</option>
          </select>
          <p className="text-xs text-muted-foreground">Upload after creation</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Save
        </Button>
        {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check className="h-3 w-3" />Saved</span>}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {schedulerWarning && <p className="text-sm text-amber-700">{schedulerWarning}</p>}
    </div>
  )
}
