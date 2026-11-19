'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setSetting } from '@/app/actions/settings'

const OPTIONS = [
  { value: 'false', label: 'Off (default)', description: 'No dispatch email is sent by the IMS' },
  { value: 'true', label: 'On', description: 'Email direct customers a branded dispatch notification with tracking when their order ships. Storefront orders are excluded here — see the storefront switch below.' },
]

const STOREFRONT_OPTIONS = [
  { value: 'false', label: 'Off (default)', description: 'IMS sends no e-mail for storefront orders. WooCommerce (and its partial-shipment, AST and TrackShip plugins) keep sending theirs.' },
  { value: 'true', label: 'On', description: 'IMS sends the order confirmation, dispatch, partial-shipment and delivered e-mails for storefront orders. Switch WooCommerce\'s native customer e-mails OFF first: both on sends every customer two e-mails. The writers:check run reads both.' },
]

type Props = { currentValue: string; storefrontValue?: string }

export function DispatchEmailSetting({ currentValue, storefrontValue = 'false' }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [value, setValue] = useState(currentValue)
  const [saved, setSaved] = useState(false)
  const [storefront, setStorefront] = useState(storefrontValue)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      if (value !== currentValue) await setSetting('dispatch_email_enabled', value)
      if (storefront !== storefrontValue) await setSetting('storefront_customer_email_enabled', storefront)
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
            <input type="radio" name="dispatchEmail" value={o.value} checked={value === o.value} onChange={() => setValue(o.value)} className="mt-0.5" />
            <div>
              <span className="text-sm font-medium">{o.label}</span>
              <p className="text-xs text-muted-foreground">{o.description}</p>
            </div>
          </label>
        ))}
      </div>
      <div className="space-y-2 border-t pt-3">
        <p className="text-sm font-medium">Customer e-mail for storefront orders</p>
        {STOREFRONT_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-3 cursor-pointer">
            <input type="radio" name="storefrontCustomerEmail" value={o.value} checked={storefront === o.value} onChange={() => setStorefront(o.value)} className="mt-0.5" />
            <div>
              <span className="text-sm font-medium">{o.label}</span>
              <p className="text-xs text-muted-foreground">{o.description}</p>
            </div>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending || (value === currentValue && storefront === storefrontValue)}>
          {isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save
        </Button>
        {saved && <span className="text-xs text-green-600">Saved</span>}
      </div>
    </div>
  )
}
