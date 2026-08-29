'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { setSettings } from '@/app/actions/settings'

/**
 * o3d-j7y4 (Codex r18 MEDIUM; count corrected r19): the shopping-inbox retention window is OVERRIDDEN
 * for one set of rows while the currency-evidence hold stands, and until this notice existed the only
 * statement this screen made about them was that processed webhook payloads are cleared on the
 * schedule below — which, for those rows, was not true. `null` when no override is in force.
 */
export type EvidenceHoldNotice = {
  /** The issue that owns the hold, owns its data-minimisation cost, and is the only thing that lifts it. */
  issue: string
  /** The configured window this exemption overrides, in months. 0 means the compaction is off anyway. */
  retentionMonths: number
  /**
   * Payloads that survive SOLELY because of the override — held AND otherwise past the window AND
   * still compactable. Round 18 showed the whole held set here and called it what the exemption was
   * retaining, which counted young rows and never-compacted statuses as compliance impact.
   */
  retainedByOverride: number
  /** The whole held population that still carries a payload, labelled as the evidence it is. */
  evidenceRowsWithPayload: number
}

type Props = {
  salesOrdersValue: string
  purchaseOrdersValue: string
  customersValue: string
  stockMovementsValue: string
  syncLogsValue: string
  webhookEventsValue: string
  wmsEventsValue: string
  wmsSyncJobsValue: string
  evidenceHold: EvidenceHoldNotice | null
}

const FIELDS = [
  { key: 'retention_sales_orders_months', label: 'Sales Orders', stateKey: 'salesOrders' as const, hint: 'Archive completed, delivered, cancelled, or refunded orders' },
  { key: 'retention_purchase_orders_months', label: 'Purchase Orders', stateKey: 'purchaseOrders' as const, hint: 'Archive received, closed, invoiced, returned, or cancelled POs' },
  { key: 'retention_customers_months', label: 'Customers', stateKey: 'customers' as const, hint: 'Archive inactive customers' },
  { key: 'retention_stock_movements_months', label: 'Stock Movements', stateKey: 'stockMovements' as const, hint: 'Permanently delete movements' },
  { key: 'retention_sync_logs_months', label: 'Sync Logs', stateKey: 'syncLogs' as const, hint: 'Permanently delete settled sync logs (unfinished accounting work, unresolved refund parks and any row an operator recovery acted on are kept)' },
  { key: 'retention_webhook_events_months', label: 'Webhook Events', stateKey: 'webhookEvents' as const, hint: 'Clear processed inbox payloads (keeps dedup + dead letters)' },
  { key: 'retention_wms_events_months', label: 'WMS Inbound Events', stateKey: 'wmsEvents' as const, hint: 'Clear processed WMS callback payloads (keeps dedup + dead letters)' },
  { key: 'retention_wms_sync_jobs_months', label: 'WMS Sync Runs', stateKey: 'wmsSyncJobs' as const, hint: 'Delete finished sync runs and their per-SKU log lines' },
] as const

export function DataRetentionSetting({
  salesOrdersValue,
  purchaseOrdersValue,
  customersValue,
  stockMovementsValue,
  syncLogsValue,
  webhookEventsValue,
  wmsEventsValue,
  wmsSyncJobsValue,
  evidenceHold,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [values, setValues] = useState({
    salesOrders: salesOrdersValue,
    purchaseOrders: purchaseOrdersValue,
    customers: customersValue,
    stockMovements: stockMovementsValue,
    syncLogs: syncLogsValue,
    webhookEvents: webhookEventsValue,
    wmsEvents: wmsEventsValue,
    wmsSyncJobs: wmsSyncJobsValue,
  })
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      // ONE transaction (o3d-osl8 round 9, finding 1) — see setSettings.
      await setSettings(Object.fromEntries(FIELDS.map((f) => [f.key, values[f.stateKey]])))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Set to 0 to keep records forever. Financial records (orders, customers) are soft-archived — hidden from lists but accessible via direct link. Operational data (movements, sync logs) is permanently deleted, with two exceptions kept for correctness rather than for history: an accounting sync row whose back-reference is still unresolved has its <em>content</em> cleared on schedule but keeps its identifying record, and a row for a payment or credit-note allocation already sent to the ledger is kept in full, because its existence is what stops the same money being sent twice. Cleanup runs daily via <code className="text-xs bg-muted px-1 rounded">/api/cron/activity-cleanup</code>.
      </p>
      <p className="text-xs text-muted-foreground">
        One exception: accounting sync entries that are still <strong>pending, in progress or failed</strong> are never deleted by age. They are unfinished work, not history — the payload is what a retry posts, and deleting one while a worker still holds it would put a document in the ledger that nothing here records. They expire normally once they settle (synced or cancelled), so clearing them is a matter of resolving them on the Accounting Sync page.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 max-w-4xl">
        {FIELDS.map((f) => (
          <div key={f.key} className="grid grid-rows-subgrid row-span-3 gap-0">
            <Label className="text-xs self-end pb-1">{f.label} (months)</Label>
            <Input
              type="number"
              min={0}
              value={values[f.stateKey]}
              onChange={(e) => setValues((v) => ({ ...v, [f.stateKey]: e.target.value }))}
              className="h-9"
            />
            <p className="text-[10px] text-muted-foreground leading-tight pt-1.5 pb-3">
              {f.hint}
              {evidenceHold && f.key === 'retention_webhook_events_months' && (
                <span className="text-amber-700 dark:text-amber-500"> — one exception is in force, see below</span>
              )}
            </p>
          </div>
        ))}
      </div>
      {evidenceHold && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-1.5">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-400">
            Webhook Events: an exemption is currently overriding this window
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            WooCommerce <strong>order</strong> deliveries — <strong>all of them, at any age</strong> — are{' '}
            <strong>not</strong> cleared by the schedule above. Their payloads are the only evidence of
            whether the store stated a currency on orders imported before IMS began requiring one, and
            clearing one destroys that evidence permanently. Everything else in the inbox — product
            deliveries, the bulk of it — is cleared exactly as configured, and lowering the window does not
            reach the held-back orders.
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {evidenceHold.retentionMonths > 0 ? (
              <>
                <strong>{evidenceHold.retainedByOverride.toLocaleString()}</strong>{' '}
                {evidenceHold.retainedByOverride === 1 ? 'payload is' : 'payloads are'} being kept alive by
                this exemption today — that is, {evidenceHold.retainedByOverride === 1 ? 'it is' : 'they are'}{' '}
                past your {evidenceHold.retentionMonths}-month window and would already be cleared without
                it.
              </>
            ) : (
              <>
                Your Webhook Events window is set to <strong>0</strong>, so this compaction is switched off
                entirely and the exemption is currently keeping <strong>nothing</strong> alive that your own
                settings would clear.
              </>
            )}{' '}
            <strong>{evidenceHold.evidenceRowsWithPayload.toLocaleString()}</strong> order{' '}
            {evidenceHold.evidenceRowsWithPayload === 1 ? 'delivery' : 'deliveries'} still carry a payload in
            total, most of them inside your window and held back by nothing.
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            <strong>There is no automatic expiry, and that is deliberate.</strong> A version of this
            exemption that stopped at a recorded instant was tried and withdrawn: it saved nothing for a
            whole retention window, and it could be made to say the wrong thing — by a rollback, on a fresh
            installation — in the one direction that destroys evidence irreversibly. The exemption
            therefore grows while it is on, and the payloads it retains carry billing and delivery names and
            addresses. It ends when <strong>{evidenceHold.issue}</strong> is closed, which owns that cost as
            an accepted constraint; re-enabling the deletion is a reviewed code change, not a toggle.
          </p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={isPending}>
          {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          Save
        </Button>
        {saved && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <Check className="h-3 w-3" />Saved
          </span>
        )}
      </div>
    </div>
  )
}
