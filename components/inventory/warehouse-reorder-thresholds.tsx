'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { saveWarehouseReorderThresholds, type WarehouseReorderThresholds } from '@/app/actions/reorder-thresholds'

type FieldKey = 'reorderPoint' | 'safetyStockQty' | 'reorderQty'

const COLUMNS: Array<{ key: FieldKey; label: string }> = [
  { key: 'reorderPoint', label: 'Reorder point' },
  { key: 'safetyStockQty', label: 'Safety stock' },
  { key: 'reorderQty', label: 'Reorder qty' },
]

export function WarehouseReorderThresholds({ data, canEdit }: { data: WarehouseReorderThresholds; canEdit: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [values, setValues] = useState<Record<string, Record<FieldKey, string>>>(() =>
    Object.fromEntries(data.warehouses.map((w) => [w.warehouseId, {
      reorderPoint: w.reorderPoint ?? '',
      safetyStockQty: w.safetyStockQty ?? '',
      reorderQty: w.reorderQty ?? '',
    }])),
  )
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function save() {
    setMessage(null)
    setFieldErrors({})
    startTransition(async () => {
      const result = await saveWarehouseReorderThresholds(
        data.productId,
        data.warehouses.map((w) => ({
          warehouseId: w.warehouseId,
          ...values[w.warehouseId],
          expected: { reorderPoint: w.reorderPoint, safetyStockQty: w.safetyStockQty, reorderQty: w.reorderQty },
        })),
      )
      if (result.success) {
        const saved = result.changed === 0 ? 'No changes to save.' : `Saved ${result.changed} change${result.changed === 1 ? '' : 's'}.`
        setMessage(result.conflictMessage
          ? { tone: 'error', text: `${saved} ${result.conflictMessage}` }
          : { tone: 'ok', text: saved })
        router.refresh()
      } else {
        setFieldErrors(result.fieldErrors ?? {})
        setMessage({ tone: 'error', text: result.error })
      }
    })
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold flex items-center gap-2 mb-1">
        <SlidersHorizontal className="h-4 w-4" />
        Reorder thresholds by warehouse
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Leave a cell blank to inherit the product value (shown in grey). Used by Reorder Planning when filtered to a warehouse.
        Planning only: never sent to a warehouse system or store.
      </p>
      {data.warehouses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active warehouses.</p>
      ) : (
        <div className="space-y-0">
          <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,5.5rem))] gap-2 text-xs text-muted-foreground pb-1.5 border-b border-border">
            <span>Warehouse</span>
            {COLUMNS.map((c) => <span key={c.key} className="text-right">{c.label}</span>)}
          </div>
          {data.warehouses.map((w) => (
            <div key={w.warehouseId} className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(0,5.5rem))] gap-2 py-1.5 items-center border-b border-border/50 last:border-0">
              <span className="truncate text-sm">
                <span className="font-mono font-medium">{w.warehouseCode}</span>
                {w.wmsBound && <span className="ml-2 text-[10px] text-muted-foreground" title="Bound to a warehouse system. Overrides are allowed: they are planning-only and are not sent to it.">WMS</span>}
              </span>
              {COLUMNS.map((c) => {
                const errorKey = `${w.warehouseId}.${c.key}`
                return (
                  <div key={c.key}>
                    <Input
                      inputMode="decimal"
                      className="h-7 px-2 text-right font-mono text-xs"
                      aria-label={`${w.warehouseCode} ${c.label}`}
                      aria-invalid={fieldErrors[errorKey] ? true : undefined}
                      title={fieldErrors[errorKey]}
                      placeholder={data.inherited[c.key] ?? '—'}
                      value={values[w.warehouseId][c.key]}
                      disabled={!canEdit || pending}
                      onChange={(e) => setValues((prev) => ({ ...prev, [w.warehouseId]: { ...prev[w.warehouseId], [c.key]: e.target.value } }))}
                    />
                    {fieldErrors[errorKey] && <p className="text-[10px] text-destructive mt-0.5">{fieldErrors[errorKey]}</p>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
      {canEdit ? (
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" size="sm" onClick={save} disabled={pending}>{pending ? 'Saving…' : 'Save thresholds'}</Button>
          {message && <span className={`text-xs ${message.tone === 'ok' ? 'text-muted-foreground' : 'text-destructive'}`} role="status">{message.text}</span>}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">You need inventory edit permission to change these.</p>
      )}
    </Card>
  )
}
