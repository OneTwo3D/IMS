'use client'

import { useState, useTransition } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { saveIntegrationPluginState } from '@/app/actions/settings'
import { resolvePluginSelectionSaveView } from '@/lib/domain/integrations/plugin-save-outcome'
import type { IntegrationPluginState } from '@/lib/integration-plugins'

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

  /**
   * What the switches showed before this page's session of edits — the server-rendered selection.
   *
   * A rollback target has to be a selection the DATABASE is known to have held, and the only one
   * this screen can name is the one it was rendered with. Using the pre-click switch values instead
   * would restore an intermediate the database never saw.
   */
  const previous = {
    woocommerce: initialWooCommerceEnabled,
    shopify: initialShopifyEnabled,
    xero: initialXeroEnabled,
    quickbooks: initialQuickBooksEnabled,
    mintsoft: initialMintsoftEnabled,
  } as IntegrationPluginState

  /** The switches, as one value, so the shared resolver can decide what they must show next. */
  function currentSelection(): IntegrationPluginState {
    return {
      woocommerce: woocommerceEnabled,
      shopify: shopifyEnabled,
      xero: xeroEnabled,
      quickbooks: quickbooksEnabled,
      mintsoft: mintsoftEnabled,
    } as IntegrationPluginState
  }

  function applySelection(plugins: IntegrationPluginState) {
    setWooCommerceEnabled(plugins.woocommerce)
    setShopifyEnabled(plugins.shopify)
    setXeroEnabled(plugins.xero)
    setQuickBooksEnabled(plugins.quickbooks)
    setMintsoftEnabled(plugins.mintsoft)
  }

  function handleSave() {
    setSaved(false)
    setError('')
    setSchedulerWarning('')

    // What is on screen right now — the operator's request. On the ONE outcome that committed
    // nothing (`refused`) the resolver replaces this with `previous`; on every other outcome the
    // switches stay where they are, or move to what the server read back under the lock.
    const requested = currentSelection()

    startTransition(async () => {
      // ONE decision, made by the SAME resolver the onboarding wizard uses (o3d-osl8 round 8,
      // finding 2). Round 7 fixed the classification in the wizard and cross-ported only the
      // warning here, so this screen kept its own copy of the rule — and that copy still reported
      // a COMMITTED write as a failed save whenever the scheduler step threw rather than returning:
      // the save landed in the catch below and printed a bare red error, which reads as "nothing
      // happened" and invites a retry of a write that is already stored. The rule now has one
      // implementation and no per-screen presentation parameter, because the two screens do not
      // need different presentation — only different switches to apply it to.
      //
      // The scheduler reconciliation is no longer called from here at all: it is a post-commit step
      // of the write, so it happens inside the action, under the guard that classifies it.
      const view = await (async () => {
        try {
          // ONE atomic, connector-selection-locked write (o3d-osl8 round 5, finding 2). This used
          // to be five parallel setSetting calls, so switching accounting connectors was observable
          // mid-flight as both-off or both-on — and a concurrent orphan cancel could discard the
          // incoming connector's queue from inside that window.
          const result = await saveIntegrationPluginState({
            woocommerce: requested.woocommerce,
            shopify: requested.shopify,
            xero: requested.xero,
            quickbooks: requested.quickbooks,
            mintsoft: requested.mintsoft,
          })
          return resolvePluginSelectionSaveView({ attempt: { kind: 'result', result }, requested, previous })
        } catch (e) {
          // A REJECTION, which is not a refusal: a permission gate throwing, a transaction
          // aborting, or a transport failure that lost the reply after the write committed. The
          // resolver keeps the switches where they are and says the outcome is unknown.
          return resolvePluginSelectionSaveView({ attempt: { kind: 'rejected', error: e }, requested, previous })
        }
      })()

      applySelection(view.plugins)
      setError(view.error)
      setSchedulerWarning(view.schedulerWarning)
      if (view.committed) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
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
      {/* Amber, not destructive, and worded as "saved, but": the selection above is durable and the
          switches show it. Only the scheduler is behind. */}
      {schedulerWarning && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{schedulerWarning}</p>
      )}
    </div>
  )
}
