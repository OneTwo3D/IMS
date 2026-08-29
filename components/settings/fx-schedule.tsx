'use client'

import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchAllFxRates } from '@/app/actions/currencies'
import { useFormatDateTime } from '@/components/providers/timezone-provider'

/**
 * THE SCHEDULE CONTROLS THIS PANEL USED TO OFFER DID NOTHING (Codex r20 HIGH).
 *
 * It saved `fx_schedule_enabled` and `fx_schedule_interval_hours` through the generic settings
 * writer, and NOTHING READ EITHER ROW. The FX refresh is a registered cron job (`fx_rates`), so its
 * enablement and its schedule are `cron_fx_rates_enabled` / `cron_fx_rates_schedule`, written by the
 * Scheduled Jobs editor and rendered into the crontab; `/api/cron/fx-rates` then runs
 * unconditionally whenever it is invoked. So an operator could switch automatic updates off here,
 * see "Saved", and have rates keep refreshing on the old schedule indefinitely.
 *
 * The controls are gone rather than rewired. Rewiring would mean inventing a mapping from "every N
 * hours" (this panel offered 1-168) to a cron expression, and no such mapping is faithful past 23.
 * The real control already exists and is one screen away; this panel now says where, and keeps the
 * two things it genuinely does — showing when rates were last fetched, and fetching them now.
 */
type Props = {
  lastFetched: string | null
}

export function FxScheduleSettings({ lastFetched }: Props) {
  const formatDateTime = useFormatDateTime()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  async function handleRefreshNow() {
    setRefreshing(true)
    setRefreshMsg(null)
    try {
      const result = await fetchAllFxRates()
      setRefreshing(false)
      if (result.success) {
        setRefreshMsg(`Updated ${result.updated} rate(s).`)
        setTimeout(() => setRefreshMsg(null), 3000)
      } else {
        setRefreshMsg(result.error ?? 'Failed to fetch rates.')
      }
    } catch { setRefreshMsg('An unexpected error occurred.'); setRefreshing(false) }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        FX rates are fetched from the ECB via <code className="text-xs bg-muted px-1 rounded">/api/cron/fx-rates</code>.
        {lastFetched && (
          <span> Last updated: {formatDateTime(lastFetched, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.</span>
        )}
      </p>

      <p className="text-xs text-muted-foreground">
        Automatic updates are switched on or off, and scheduled, on the <strong>FX Rate Update</strong> job in
        Settings &rarr; System &rarr; Scheduled Jobs — that is the setting the crontab is built from.
      </p>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleRefreshNow} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
          Update Now
        </Button>
        {refreshMsg && <span className="text-sm text-green-600">{refreshMsg}</span>}
      </div>
    </div>
  )
}
