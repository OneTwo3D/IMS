'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { setSetting } from '@/app/actions/settings'

type Props = {
  infoValue: string
  warningValue: string
  errorValue: string
}

export function ActivityLogRetentionSetting({ infoValue, warningValue, errorValue }: Props) {
  const [isPending, startTransition] = useTransition()
  const [info, setInfo] = useState(infoValue)
  const [warning, setWarning] = useState(warningValue)
  const [error, setError] = useState(errorValue)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await Promise.all([
        setSetting('activity_log_retention_info', info),
        setSetting('activity_log_retention_warning', warning),
        setSetting('activity_log_retention_error', error),
      ])
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Set to 0 to keep entries forever. Cleanup runs daily via <code className="text-xs bg-muted px-1 rounded">/api/cron/activity-cleanup</code>.
      </p>
      <div className="grid grid-cols-3 gap-4 max-w-lg">
        <div className="space-y-1.5">
          <Label className="text-xs">Info (days)</Label>
          <Input type="number" min={0} value={info} onChange={(e) => setInfo(e.target.value)} className="h-9" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Warning (days)</Label>
          <Input type="number" min={0} value={warning} onChange={(e) => setWarning(e.target.value)} className="h-9" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Error (days)</Label>
          <Input type="number" min={0} value={error} onChange={(e) => setError(e.target.value)} className="h-9" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Save
        </Button>
        {saved && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />Saved
          </span>
        )}
      </div>
    </div>
  )
}
