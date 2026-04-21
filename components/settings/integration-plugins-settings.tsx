'use client'

import { useState, useTransition } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { setSetting } from '@/app/actions/settings'
import { syncCrontab } from '@/app/actions/cron'

type Props = {
  woocommerceEnabled: boolean
  shopifyEnabled: boolean
  xeroEnabled: boolean
  quickbooksEnabled: boolean
  mintsoftEnabled: boolean
}

export function IntegrationPluginsSettings({
  woocommerceEnabled: initialWooCommerceEnabled,
  shopifyEnabled: initialShopifyEnabled,
  xeroEnabled: initialXeroEnabled,
  quickbooksEnabled: initialQuickBooksEnabled,
  mintsoftEnabled: initialMintsoftEnabled,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [woocommerceEnabled, setWooCommerceEnabled] = useState(initialWooCommerceEnabled)
  const [shopifyEnabled, setShopifyEnabled] = useState(initialShopifyEnabled)
  const [xeroEnabled, setXeroEnabled] = useState(initialXeroEnabled)
  const [quickbooksEnabled, setQuickBooksEnabled] = useState(initialQuickBooksEnabled)
  const [mintsoftEnabled, setMintsoftEnabled] = useState(initialMintsoftEnabled)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  function handleSave() {
    setSaved(false)
    setError('')

    startTransition(async () => {
      try {
        await Promise.all([
          setSetting('plugin_woocommerce_enabled', String(woocommerceEnabled)),
          setSetting('plugin_shopify_enabled', String(shopifyEnabled)),
          setSetting('plugin_xero_enabled', String(xeroEnabled)),
          setSetting('plugin_quickbooks_enabled', String(quickbooksEnabled)),
          setSetting('plugin_mintsoft_enabled', String(mintsoftEnabled)),
        ])

        const result = await syncCrontab()
        if (!result.success) {
          setError(result.error ?? 'Failed to apply scheduler changes')
          return
        }

        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save plugin settings')
      }
    })
  }

  return (
    <div className="space-y-5">
      <label className="flex items-start gap-3 cursor-pointer">
        <Switch checked={woocommerceEnabled} onCheckedChange={setWooCommerceEnabled} />
        <div>
          <div className="text-sm font-medium">WooCommerce plugin</div>
          <p className="text-xs text-muted-foreground">
            Enables the shopping connector, webhooks, sync UI, and WooCommerce-specific scheduler jobs.
          </p>
        </div>
      </label>

      <label className="flex items-start gap-3 cursor-pointer">
        <Switch checked={shopifyEnabled} onCheckedChange={setShopifyEnabled} />
        <div>
          <div className="text-sm font-medium">Shopify plugin</div>
          <p className="text-xs text-muted-foreground">
            Reserves the shopping connector slot, settings, and sync/dashboard wiring for Shopify.
          </p>
        </div>
      </label>

      <label className="flex items-start gap-3 cursor-pointer">
        <Switch checked={xeroEnabled} onCheckedChange={setXeroEnabled} />
        <div>
          <div className="text-sm font-medium">Xero plugin</div>
          <p className="text-xs text-muted-foreground">
            Enables the accounting connector, callback flow, sync UI, and accounting scheduler jobs backed by Xero.
          </p>
        </div>
      </label>

      <label className="flex items-start gap-3 cursor-pointer">
        <Switch checked={quickbooksEnabled} onCheckedChange={setQuickBooksEnabled} />
        <div>
          <div className="text-sm font-medium">QuickBooks plugin</div>
          <p className="text-xs text-muted-foreground">
            Reserves the accounting connector slot, settings, and sync/dashboard wiring for QuickBooks.
          </p>
        </div>
      </label>

      <label className="flex items-start gap-3 cursor-pointer">
        <Switch checked={mintsoftEnabled} onCheckedChange={setMintsoftEnabled} />
        <div>
          <div className="text-sm font-medium">Mintsoft plugin</div>
          <p className="text-xs text-muted-foreground">
            Enables Mintsoft WMS settings, webhook intake, sync UI, and Mintsoft-specific scheduler jobs.
          </p>
        </div>
      </label>

      <div className="flex items-center gap-2 pt-2 border-t">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Save &amp; Apply
        </Button>
        {saved && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />
            Saved
          </span>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </div>
  )
}
