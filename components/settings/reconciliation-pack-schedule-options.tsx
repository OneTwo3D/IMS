'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { saveReconciliationPackScheduleOptions } from '@/app/actions/cron'
import { resolveSettingSaveView } from '@/lib/domain/settings/setting-save-outcome'
import { PACK_SCHEDULE_PHASES } from '@/lib/reconciliation-pack/schedule-constants'

type Props = {
  /** The stored phase, or the empty string when none is set. */
  phase: string
  vendorReads: boolean
}

export function ReconciliationPackScheduleOptions({ phase: initialPhase, vendorReads: initialVendorReads }: Props) {
  const [isPending, startTransition] = useTransition()
  const [phase, setPhase] = useState(initialPhase)
  const [vendorReads, setVendorReads] = useState(initialVendorReads)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')

  function handleSave() {
    setSaved(false)
    setError('')
    setWarning('')
    startTransition(async () => {
      try {
        const view = resolveSettingSaveView({
          result: await saveReconciliationPackScheduleOptions({ phase, vendorReads }),
          what: 'The scheduled reconciliation pack options',
        })
        if (!view.committed) {
          setError(view.error)
          return
        }
        setWarning(view.warning)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'An error occurred')
      }
    })
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">Reconciliation Pack: scheduled run options</h3>
      <p className="text-xs text-muted-foreground">
        These apply only if the Reconciliation Pack job above is switched on, which it is not by default. With no phase set the
        job refuses to run and records the refusal in the activity log. With the WooCommerce option off (the default) a scheduled run contacts no
        vendor at all.
      </p>
      <div className="flex items-center gap-4">
        <label htmlFor="pack-schedule-phase" className="text-sm font-medium w-40 shrink-0">Phase</label>
        <Select id="pack-schedule-phase" value={phase} onChange={(e) => setPhase(e.target.value)} className="w-48 shrink-0">
          <option value="">Not set (the job will refuse)</option>
          {PACK_SCHEDULE_PHASES.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </Select>
      </div>
      <div className="flex items-center gap-4">
        <Switch checked={vendorReads} onCheckedChange={(checked) => setVendorReads(!!checked)} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-tight">Read WooCommerce in scheduled runs</p>
          <p className="text-xs text-muted-foreground">
            Adds --vendor-reads-only: GET requests to WooCommerce only, within the pack&apos;s own request budget, and at most one such run every 20 hours.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Save options
        </Button>
        {saved && <span className="text-sm text-green-600 flex items-center gap-1"><Check className="h-3 w-3" />Saved</span>}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
      {warning && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{warning}</p>}
    </div>
  )
}
