'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { setSetting } from '@/app/actions/settings'
import { syncCrontab } from '@/app/actions/cron'
import { ALL_PRESETS } from '@/lib/cron-registry'

export type CronJobState = {
  slug: string
  settingKey: string
  module: string
  moduleLabel: string
  label: string
  description: string
  enabled: boolean
  schedule: string
}

type Props = {
  jobs: CronJobState[]
}

export function CronJobsSettings({ jobs: initial }: Props) {
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [jobs, setJobs] = useState(initial)

  // Group by module preserving registration order
  const modules: { module: string; moduleLabel: string; jobs: CronJobState[] }[] = []
  for (const job of jobs) {
    const existing = modules.find((m) => m.module === job.module)
    if (existing) {
      existing.jobs.push(job)
    } else {
      modules.push({ module: job.module, moduleLabel: job.moduleLabel, jobs: [job] })
    }
  }

  function updateJob(settingKey: string, patch: Partial<CronJobState>) {
    setJobs((prev) => prev.map((j) => (j.settingKey === settingKey ? { ...j, ...patch } : j)))
  }

  function handleSave() {
    setSaved(false)
    setError('')
    startTransition(async () => {
      try {
        // Persist all settings
        await Promise.all(
          jobs.flatMap((j) => [
            setSetting(`cron_${j.settingKey}_enabled`, String(j.enabled)),
            setSetting(`cron_${j.settingKey}_schedule`, j.schedule),
          ])
        )

        // Sync to system crontab
        const result = await syncCrontab()
        if (!result.success) {
          setError(result.error ?? 'Failed to sync crontab')
          return
        }

        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'An error occurred')
      }
    })
  }

  return (
    <div className="space-y-5">
      {modules.map((group, groupIdx) => (
        <div key={group.module}>
          {groupIdx > 0 && <div className="border-t mb-4" />}
          <h3 className="text-sm font-medium text-muted-foreground mb-3">{group.moduleLabel}</h3>
          <div className="space-y-3">
            {group.jobs.map((job) => (
              <div
                key={job.settingKey}
                className="flex items-center gap-4 py-1.5"
              >
                <Switch
                  checked={job.enabled}
                  onCheckedChange={(checked) =>
                    updateJob(job.settingKey, { enabled: !!checked })
                  }
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-tight">{job.label}</p>
                  <p className="text-xs text-muted-foreground">{job.description}</p>
                </div>
                <Select
                  value={job.schedule}
                  onChange={(e) =>
                    updateJob(job.settingKey, { schedule: e.target.value })
                  }
                  className="w-48 shrink-0"
                  disabled={!job.enabled}
                >
                  {ALL_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                  {!ALL_PRESETS.some((p) => p.value === job.schedule) && (
                    <option value={job.schedule}>{job.schedule}</option>
                  )}
                </Select>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2 pt-2">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Save &amp; Apply
        </Button>
        {saved && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />Saved
          </span>
        )}
        {error && (
          <span className="text-sm text-destructive">{error}</span>
        )}
      </div>
    </div>
  )
}
