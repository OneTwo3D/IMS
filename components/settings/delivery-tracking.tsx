'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { setSetting } from '@/app/actions/settings'

const DEFAULT_CARRIERS = [
  'Royal Mail',
  'DPD',
  'DHL',
  'DHL Express',
  'FedEx',
  'UPS',
  'Hermes / Evri',
  'Yodel',
  'Amazon Logistics',
  'ParcelForce',
  'TNT',
  'GLS',
  'Collect+',
]

type Props = {
  enabled: boolean
  source: string // 'woocommerce' | 'trackship'
  apiKey: string
  carriers: string[]
}

export function DeliveryTrackingSettings({ enabled: initEnabled, source: initSource, apiKey: initApiKey, carriers: initCarriers }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [enabled, setEnabled] = useState(initEnabled)
  const [source, setSource] = useState(initSource || 'woocommerce')
  const [apiKey, setApiKey] = useState(initApiKey)
  const [carriers, setCarriers] = useState<string[]>(initCarriers.length > 0 ? initCarriers : DEFAULT_CARRIERS)
  const [newCarrier, setNewCarrier] = useState('')
  const [saved, setSaved] = useState(false)

  function addCarrier() {
    const name = newCarrier.trim()
    if (!name || carriers.includes(name)) return
    setCarriers([...carriers, name])
    setNewCarrier('')
  }

  function removeCarrier(name: string) {
    setCarriers(carriers.filter((c) => c !== name))
  }

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await setSetting('delivery_tracking_enabled', enabled ? 'true' : 'false')
      await setSetting('delivery_tracking_source', source)
      await setSetting('trackship_api_key', apiKey)
      await setSetting('shipping_carriers', JSON.stringify(carriers))
      router.refresh()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-6">
      {/* Enable toggle */}
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="rounded border-input"
        />
        <div>
          <span className="text-sm font-medium">Enable delivery tracking</span>
          <p className="text-xs text-muted-foreground">
            Track shipment delivery status via TrackShip API. Adds &ldquo;Delivered&rdquo; status to sales orders.
          </p>
        </div>
      </label>

      {enabled && (
        <>
          {/* Delivery status source */}
          <div className="space-y-2">
            <Label>Delivery Status Source</Label>
            <div className="space-y-2">
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="radio" name="trackingSource" value="woocommerce" checked={source === 'woocommerce'} onChange={() => setSource('woocommerce')} className="mt-0.5" />
                <div>
                  <span className="text-sm font-medium">Import from WooCommerce</span>
                  <p className="text-xs text-muted-foreground">
                    Read delivery status from WooCommerce order meta (requires Advanced Shipment Tracking + TrackShip plugin on WC).
                    Avoids duplicate API lookups if WooCommerce already queries TrackShip.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="radio" name="trackingSource" value="trackship" checked={source === 'trackship'} onChange={() => setSource('trackship')} className="mt-0.5" />
                <div>
                  <span className="text-sm font-medium">TrackShip API (direct)</span>
                  <p className="text-xs text-muted-foreground">
                    Query TrackShip API directly from this system. Use this if WooCommerce is not connected or does not have TrackShip.
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* TrackShip API Key — only for direct mode */}
          {source === 'trackship' && (
            <div className="space-y-1.5">
              <Label>TrackShip API Key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your TrackShip API key"
                className="h-9 text-sm max-w-md font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Get your API key from{' '}
                <a href="https://trackship.com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  trackship.com
                </a>
              </p>
            </div>
          )}
        </>
      )}

      {/* Shipping Carriers */}
      <div className="space-y-3">
        <div>
          <Label>Shipping Carriers</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure available carriers for the tracking number dropdown when shipping orders.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {carriers.map((c) => (
            <span key={c} className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm bg-muted/50">
              {c}
              <button type="button" onClick={() => removeCarrier(c)} className="text-muted-foreground hover:text-destructive ml-0.5">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2 max-w-sm">
          <Input
            value={newCarrier}
            onChange={(e) => setNewCarrier(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCarrier() } }}
            placeholder="Add carrier..."
            className="h-8 text-sm"
          />
          <Button variant="outline" size="sm" className="h-8" onClick={addCarrier} disabled={!newCarrier.trim()}>
            <Plus className="h-3 w-3 mr-1" />Add
          </Button>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-2 pt-2 border-t">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save
        </Button>
        {saved && <span className="text-xs text-green-600">Saved</span>}
      </div>
    </div>
  )
}
