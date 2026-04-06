'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { setSetting } from '@/app/actions/settings'
import { fetchAllFxRates } from '@/app/actions/currencies'

type Props = {
  enabled: boolean
  intervalHours: string
  lastFetched: string | null
}

export function FxScheduleSettings({ enabled, intervalHours, lastFetched }: Props) {
  const [isPending, startTransition] = useTransition()
  const [saved, setSaved] = useState(false)
  const [isEnabled, setIsEnabled] = useState(enabled)
  const [hours, setHours] = useState(intervalHours)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await Promise.all([
        setSetting('fx_schedule_enabled', isEnabled ? 'true' : 'false'),
        setSetting('fx_schedule_interval_hours', hours),
      ])
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  async function handleRefreshNow() {
    setRefreshing(true)
    setRefreshMsg(null)
    const result = await fetchAllFxRates()
    setRefreshing(false)
    if (result.success) {
      setRefreshMsg(`Updated ${result.updated} rate(s).`)
      setTimeout(() => setRefreshMsg(null), 3000)
    } else {
      setRefreshMsg(result.error ?? 'Failed to fetch rates.')
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        FX rates are fetched from the ECB via <code className="text-xs bg-muted px-1 rounded">/api/cron/fx-rates</code>.
        {lastFetched && (
          <span> Last updated: {new Date(lastFetched).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.</span>
        )}
      </p>

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
        Enable automatic FX rate updates
      </label>

      <div className="flex items-center gap-3 max-w-xs">
        <div className="space-y-1.5 flex-1">
          <Label className="text-xs">Update interval (hours)</Label>
          <Input type="number" min={1} max={168} value={hours} onChange={(e) => setHours(e.target.value)} className="h-9" />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Save
        </Button>
        <Button variant="outline" size="sm" onClick={handleRefreshNow} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          Update Now
        </Button>
        {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check className="h-3 w-3" />Saved</span>}
        {refreshMsg && <span className="text-sm text-green-600">{refreshMsg}</span>}
      </div>
    </div>
  )
}
