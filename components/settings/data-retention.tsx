'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { setSettings } from '@/app/actions/settings'

type Props = {
  salesOrdersValue: string
  purchaseOrdersValue: string
  customersValue: string
  stockMovementsValue: string
  syncLogsValue: string
  webhookEventsValue: string
  wmsEventsValue: string
  wmsSyncJobsValue: string
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
            <p className="text-[10px] text-muted-foreground leading-tight pt-1.5 pb-3">{f.hint}</p>
          </div>
        ))}
      </div>
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
