'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { setSetting } from '@/app/actions/settings'

type Props = {
  enabled: boolean
  retentionDays: string
  maxCount: string
  autoUpload: string
}

export function BackupScheduleSettings({ enabled, retentionDays, maxCount, autoUpload }: Props) {
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const [isEnabled, setIsEnabled] = useState(enabled)
  const [days, setDays] = useState(retentionDays)
  const [max, setMax] = useState(maxCount)
  const [upload, setUpload] = useState(autoUpload)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await Promise.all([
        setSetting('backup_schedule_enabled', isEnabled ? 'true' : 'false'),
        setSetting('backup_retention_days', days),
        setSetting('backup_max_count', max),
        setSetting('backup_auto_upload', upload),
      ])
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Runs daily via <code className="text-xs bg-muted px-1 rounded">/api/cron/backup</code>. Old backups are
        automatically purged based on the retention settings below.
      </p>

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
        Enable scheduled backups
      </label>

      <div className="grid grid-cols-3 gap-4 max-w-lg">
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
    </div>
  )
}
