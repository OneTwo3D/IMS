'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setPurchaseOrderEmailEnabled } from '@/app/actions/purchase-orders'

const OPTIONS = [
  { value: 'false', label: 'Off (default)', description: 'Confirm & Send PO confirms the order only. Download the PO PDF and send it to the supplier directly.' },
  { value: 'true', label: 'On', description: 'Confirm & Send PO (and Email PO) email the supplier a branded message with the PO PDF attached, through the email queue and your SMTP settings. Leave off on a stage copy that holds real SMTP credentials.' },
]

type Props = { currentValue: string }

export function PurchaseOrderEmailSetting({ currentValue }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [value, setValue] = useState(currentValue)
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await setPurchaseOrderEmailEnabled(value === 'true')
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
            <input type="radio" name="purchaseOrderEmail" value={o.value} checked={value === o.value} onChange={() => setValue(o.value)} className="mt-0.5" />
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
