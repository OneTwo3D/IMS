'use client'

import { useState, useTransition } from 'react'
import { Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { setSetting } from '@/app/actions/settings'

type Props = {
  salesOrdersValue: string
  purchaseOrdersValue: string
  customersValue: string
  stockMovementsValue: string
  syncLogsValue: string
}

const FIELDS = [
  { key: 'retention_sales_orders_months', label: 'Sales Orders', stateKey: 'salesOrders' as const, hint: 'Archive completed/cancelled orders' },
  { key: 'retention_purchase_orders_months', label: 'Purchase Orders', stateKey: 'purchaseOrders' as const, hint: 'Archive received/invoiced/cancelled POs' },
  { key: 'retention_customers_months', label: 'Customers', stateKey: 'customers' as const, hint: 'Archive inactive customers' },
  { key: 'retention_stock_movements_months', label: 'Stock Movements', stateKey: 'stockMovements' as const, hint: 'Permanently delete movements' },
  { key: 'retention_sync_logs_months', label: 'Sync Logs', stateKey: 'syncLogs' as const, hint: 'Permanently delete sync logs' },
] as const

export function DataRetentionSetting({
  salesOrdersValue,
  purchaseOrdersValue,
  customersValue,
  stockMovementsValue,
  syncLogsValue,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [values, setValues] = useState({
    salesOrders: salesOrdersValue,
    purchaseOrders: purchaseOrdersValue,
    customers: customersValue,
    stockMovements: stockMovementsValue,
    syncLogs: syncLogsValue,
  })
  const [saved, setSaved] = useState(false)

  function handleSave() {
    setSaved(false)
    startTransition(async () => {
      await Promise.all(
        FIELDS.map((f) => setSetting(f.key, values[f.stateKey]))
      )
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Set to 0 to keep records forever. Financial records (orders, customers) are soft-archived — hidden from lists but accessible via direct link. Operational data (movements, sync logs) is permanently deleted. Cleanup runs daily via <code className="text-xs bg-muted px-1 rounded">/api/cron/activity-cleanup</code>.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4 max-w-3xl">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label className="text-xs">{f.label} (months)</Label>
            <Input
              type="number"
              min={0}
              value={values[f.stateKey]}
              onChange={(e) => setValues((v) => ({ ...v, [f.stateKey]: e.target.value }))}
              className="h-9"
            />
            <p className="text-[10px] text-muted-foreground leading-tight">{f.hint}</p>
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
