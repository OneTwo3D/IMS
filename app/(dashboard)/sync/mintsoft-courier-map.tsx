'use client'

import { useEffect, useState, useTransition } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { getMintsoftCourierServiceMap, saveMintsoftCourierServiceMap } from '@/app/actions/mintsoft-sync'

/**
 * Phase 8 carrier mapping: edit the IMS shipping-service → Mintsoft
 * CourierServiceId map consumed by the outbound order-push payload. Self-contained
 * — loads the current map on mount and saves via its own action.
 */
export function MintsoftCourierMapSection() {
  const [value, setValue] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [saving, startSaving] = useTransition()

  useEffect(() => {
    getMintsoftCourierServiceMap()
      .then((map) => setValue(map))
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [])

  function handleSave() {
    setError('')
    setSaved(false)
    startSaving(async () => {
      const result = await saveMintsoftCourierServiceMap(value)
      if (result.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setError(result.error ?? 'Failed to save courier mapping.')
      }
    })
  }

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium">Courier service mapping</h3>
        <p className="text-xs text-muted-foreground">
          Map IMS shipping-service names to Mintsoft courier service ids for outbound order dispatch. A JSON object,
          e.g. <code className="rounded bg-muted px-1">{'{ "Royal Mail Tracked 24": 12, "DPD Next Day": 34 }'}</code>.
          Unmapped services pass the name through for Mintsoft to resolve.
        </p>
      </div>
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={!loaded || saving}
        rows={6}
        placeholder='{ "Royal Mail Tracked 24": 12 }'
        className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
      />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} disabled={!loaded || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : saved ? <Check className="h-4 w-4 mr-1" /> : null}
          {saved ? 'Saved' : 'Save mapping'}
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </Card>
  )
}
