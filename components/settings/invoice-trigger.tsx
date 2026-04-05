'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setSetting } from '@/app/actions/settings'

const OPTIONS = [
  { value: 'manual', label: 'Manual only', description: 'Invoices are generated manually from the order detail page' },
  { value: 'on_shipped', label: 'On shipment', description: 'Invoice is auto-generated when the order is shipped' },
  { value: 'on_paid', label: 'On payment', description: 'Invoice is auto-generated when the order is marked as paid' },
]

type Props = { currentValue: string }

export function InvoiceTriggerSetting({ currentValue }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [value, setValue] = useState(currentValue)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await setSetting('invoice_trigger', value)
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
            <input type="radio" name="invoiceTrigger" value={o.value} checked={value === o.value} onChange={() => setValue(o.value)} className="mt-0.5" />
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
