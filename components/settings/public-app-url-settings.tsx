'use client'

import { useState, useTransition } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { setSetting } from '@/app/actions/settings'
import { syncCrontab } from '@/app/actions/cron'
import { resolveSchedulerFollowUp } from '@/lib/domain/integrations/scheduler-followup'

type Props = {
  currentValue: string
  source: 'settings' | 'none'
  suggestedValue?: string
}

export function PublicAppUrlSettings({ currentValue, source, suggestedValue }: Props) {
  const [isPending, startTransition] = useTransition()
  const [value, setValue] = useState(currentValue || suggestedValue || '')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  /** Saved, but the scheduler is behind. Not an error — see handleSave. */
  const [schedulerWarning, setSchedulerWarning] = useState('')

  function handleSave() {
    setSaved(false)
    setError('')
    setSchedulerWarning('')

    startTransition(async () => {
      try {
        const normalized = value.trim().replace(/\/+$/, '')
        if (!normalized) {
          setError('Enter the public base URL.')
          return
        }

        try {
          const parsed = new URL(normalized)
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            setError('URL must start with http:// or https://')
            return
          }
        } catch {
          setError('Enter a valid URL.')
          return
        }

        // COMMITTED. setSetting returns void and throws on failure, so reaching the next line means
        // the URL is stored (o3d-osl8 round 8, finding 1 — the same shape as the plugin screen).
        await setSetting('public_app_url', normalized)

        // The crontab reconciliation is a POST-COMMIT step. Reporting its failure — returned or
        // thrown — as a red error with no "Saved" told the operator their URL had not been stored,
        // which is false, and invited them to enter it again. It is a warning about the scheduler.
        const followUp = await resolveSchedulerFollowUp({ what: 'The Public App URL', sync: syncCrontab })
        setSchedulerWarning(followUp.warning)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save app URL')
      }
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Configure the public base URL used for external callbacks and generated cron targets.
        {' '}Current source: <span className="font-medium">{source}</span>.
      </p>
      {!currentValue && suggestedValue && (
        <p className="text-xs text-muted-foreground">
          Suggested from this request: <span className="font-medium">{suggestedValue}</span>
        </p>
      )}
      <div className="max-w-xl space-y-1.5">
        <Label className="text-xs">Public App URL</Label>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://ims.example.com"
          className="h-9 font-mono"
          autoComplete="off"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Save &amp; Apply
        </Button>
        {saved && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />
            Saved
          </span>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
      {schedulerWarning && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{schedulerWarning}</p>
      )}
    </div>
  )
}
