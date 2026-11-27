'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setSetting } from '@/app/actions/settings'

const OPTIONS = [
  { value: 'false', label: 'Off (default)', description: 'Returned items go back into the warehouse chosen for the return, as today. No condition is asked for.' },
  { value: 'true', label: 'On', description: 'Every restock of a return asks whether the items are sellable. Unsellable items go into a quarantine warehouse at their cost, where they are never allocated, never counted as available and never pushed to the store. Review them there: write them off with an adjustment, or transfer them back to stock.' },
]

type Props = { currentValue: string }

export function ReturnConditionCheckSetting({ currentValue }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [value, setValue] = useState(currentValue)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await setSetting('return_condition_check_enabled', value)
      router.refresh()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-3 cursor-pointer">
            <input type="radio" name="returnConditionCheck" value={o.value} checked={value === o.value} onChange={() => setValue(o.value)} className="mt-0.5" />
            <div>
              <span className="text-sm font-medium">{o.label}</span>
              <p className="text-xs text-muted-foreground">{o.description}</p>
            </div>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending || value === currentValue}>
          {isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save
        </Button>
        {saved && <span className="text-xs text-green-600">Saved</span>}
      </div>
    </div>
  )
}
