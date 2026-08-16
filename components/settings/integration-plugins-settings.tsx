'use client'

import { useState, useTransition } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { saveIntegrationPluginState } from '@/app/actions/settings'
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
  /** Saved, but the scheduler is behind. Not an error — see handleSave. */
  const [schedulerWarning, setSchedulerWarning] = useState('')

  function handleSave() {
    setSaved(false)
    setError('')
    setSchedulerWarning('')

    startTransition(async () => {
      try {
        // ONE atomic, connector-selection-locked write (o3d-osl8 round 5, finding 2). This used to
        // be five parallel setSetting calls, so switching accounting connectors was observable
        // mid-flight as both-off or both-on — and a concurrent orphan cancel could discard the
        // incoming connector's queue from inside that window.
        const saved = await saveIntegrationPluginState({
          woocommerce: woocommerceEnabled,
          shopify: shopifyEnabled,
          xero: xeroEnabled,
          quickbooks: quickbooksEnabled,
          mintsoft: mintsoftEnabled,
        })
        if (!saved.success) {
          setError(saved.error ?? 'Failed to save plugin settings')
          return
        }

        // o3d-osl8 round 7, finding 1, cross-checked onto the sibling call site. The write above
        // has COMMITTED by the time this runs, so a scheduler failure here is not a failed save
        // either. This page never rolled its switches back (they are local state that already
        // matches what was stored), but it did report the outcome as a bare red error with no
        // indication that the selection had been saved — which reads as "nothing happened" and
        // invites a retry of a save that already landed.
        const result = await syncCrontab()
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
        if (!result.success) {
          setSchedulerWarning(
            `Your plugin selection was SAVED, but the scheduler could not be updated to match it: `
            + `${result.error ?? 'Failed to apply scheduler changes'} Scheduled jobs may still be running for the `
            + `previous selection until this is applied. Use Sync crontab on the Scheduler tab, which also reports `
            + `whether the managed crontab block is currently in drift.`,
          )
        }
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
      {schedulerWarning && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{schedulerWarning}</p>
      )}
    </div>
  )
}
