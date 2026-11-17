'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { getMergeCandidatePanel, saveMergeCandidateMode, type MergeCandidatePanel } from '@/app/actions/wms-merge-candidates'

/**
 * Merge candidates: orders of the same customer, to the same address, that are all still NEW in the warehouse. OFF by default.
 * IMS never merges (the warehouse has no merge API). With the mode on, IMS flags the group and raises ONE operator task per group
 * (Sync > Exceptions); a person checks the orders in the warehouse system and merges them there if appropriate. IMS writes nothing to the warehouse.
 */
export function MergeCandidatesSection() {
  const [panel, setPanel] = useState<MergeCandidatePanel | null>(null)
  const [mode, setMode] = useState<'off' | 'flag'>('off')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [saving, startSaving] = useTransition()

  function load() {
    getMergeCandidatePanel()
      .then((next) => { setPanel(next); setMode(next.mode) })
      .catch(() => setError('The merge candidates could not be loaded.'))
  }
  useEffect(load, [])

  function save() {
    setError('')
    setSaved(false)
    startSaving(async () => {
      const result = await saveMergeCandidateMode(mode)
      if (result.success) {
        setSaved(true)
        load()
        setTimeout(() => setSaved(false), 2000)
      } else setError(result.error ?? 'The mode was not saved.')
    })
  }

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium">Merge candidates</h3>
        <p className="text-xs text-muted-foreground">
          Orders for the same customer and delivery address that are all still NEW in the warehouse. Off by default. When on, IMS flags them
          (a Mergeable badge on each order, an activity entry, this list and one task per group on Sync &gt; Exceptions). IMS never merges
          and writes nothing to the warehouse: check the orders in the warehouse system and merge them there if appropriate.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium" htmlFor="merge-candidate-mode">Mode</label>
        <select
          id="merge-candidate-mode"
          value={mode}
          onChange={(event) => setMode(event.target.value === 'flag' ? 'flag' : 'off')}
          disabled={panel === null || saving}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
        >
          <option value="off">Off</option>
          <option value="flag">Flag</option>
        </select>
        <Button size="sm" onClick={save} disabled={panel === null || saving || mode === panel?.mode}>Save</Button>
        {saved && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {panel?.error && <p className="text-sm text-destructive">{panel.error}</p>}
      {panel && panel.mode === 'flag' && !panel.error && (
        panel.groups.length === 0
          ? <p className="text-sm text-muted-foreground">No merge candidates right now.</p>
          : (
            <div className="space-y-2">
              {panel.groups.map((group) => (
                <div key={group.members.map((member) => member.orderId).join(',')} className="rounded-lg border p-3 space-y-1 text-sm">
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {group.members.map((member) => (
                      <span key={member.orderId}>
                        <Link className="underline underline-offset-2" href={`/sales/${member.orderId}`}>{member.orderNumber}</Link>
                        <span className="text-xs text-muted-foreground">{` (warehouse order ${member.warehouseOrder})`}</span>
                      </span>
                    ))}
                  </div>
                  {group.warnings.map((warning) => <p key={warning} className="text-xs text-amber-700 dark:text-amber-300">{warning}</p>)}
                </div>
              ))}
            </div>
          )
      )}
    </Card>
  )
}
