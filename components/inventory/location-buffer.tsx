'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { saveLocationBuffers, type LocationBuffers } from '@/app/actions/location-buffer'

export function LocationBuffer({ data, canEdit }: { data: LocationBuffers; canEdit: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.warehouses.map((w) => [w.warehouseId, w.bufferQty === '0' ? '' : w.bufferQty])),
  )
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  function save() {
    setMessage(null)
    setFieldErrors({})
    startTransition(async () => {
      const result = await saveLocationBuffers(
        data.productId,
        data.warehouses.map((w) => ({ warehouseId: w.warehouseId, bufferQty: values[w.warehouseId] ?? '' })),
        reason,
      )
      if (result.success) {
        setMessage({ tone: 'ok', text: result.changed === 0 ? 'No changes to save.' : `Saved ${result.changed} change${result.changed === 1 ? '' : 's'}. The store quantity is being updated.` })
        if (result.changed > 0) setReason('')
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
        <ShieldOff className="h-4 w-4" />
        Channel buffer by warehouse
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Units held back at a warehouse so they are never offered on connected sales channels. The store sees available minus the buffer (never below 0).
        Your own stock figures and order allocation are not affected.
      </p>
      {data.warehouses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active warehouses.</p>
      ) : (
        <div className="space-y-0">
          <div className="grid grid-cols-[minmax(0,1fr)_repeat(2,minmax(0,4.5rem))_minmax(0,6rem)] gap-2 text-xs text-muted-foreground pb-1.5 border-b border-border">
            <span>Warehouse</span>
            <span className="text-right">On hand</span>
            <span className="text-right">Available</span>
            <span className="text-right">Buffer ({data.stockUnit})</span>
          </div>
          {data.warehouses.map((w) => (
            <div key={w.warehouseId} className="grid grid-cols-[minmax(0,1fr)_repeat(2,minmax(0,4.5rem))_minmax(0,6rem)] gap-2 py-1.5 items-center border-b border-border/50 last:border-0">
              <span className="truncate text-sm">
                <span className="font-mono font-medium">{w.warehouseCode}</span>
                {!w.syncsToStore && <span className="ml-2 text-[10px] text-muted-foreground" title="This warehouse does not sync stock to the store, so a buffer here changes nothing on the store.">not synced</span>}
              </span>
              <span className="font-mono text-right text-xs">{Number(w.onHand).toLocaleString()}</span>
              <span className="font-mono text-right text-xs">{Number(w.available).toLocaleString()}</span>
              <div>
                <Input
                  inputMode="decimal"
                  className="h-7 px-2 text-right font-mono text-xs"
                  aria-label={`${w.warehouseCode} buffer`}
                  aria-invalid={fieldErrors[w.warehouseId] ? true : undefined}
                  placeholder="0"
                  value={values[w.warehouseId] ?? ''}
                  disabled={!canEdit || pending}
                  onChange={(e) => setValues((prev) => ({ ...prev, [w.warehouseId]: e.target.value }))}
                />
                {fieldErrors[w.warehouseId] && <p className="text-[10px] text-destructive mt-0.5">{fieldErrors[w.warehouseId]}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
      {canEdit ? (
        <div className="mt-3 space-y-2">
          <Input
            className="h-8 text-xs"
            aria-label="Reason for the buffer change"
            aria-invalid={fieldErrors.reason ? true : undefined}
            placeholder="Reason for the change (required)"
            maxLength={500}
            value={reason}
            disabled={pending}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={save} disabled={pending}>{pending ? 'Saving…' : 'Save buffer'}</Button>
            {message && <span className={`text-xs ${message.tone === 'ok' ? 'text-muted-foreground' : 'text-destructive'}`} role="status">{message.text}</span>}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">You need inventory edit permission to change the buffer.</p>
      )}
    </Card>
  )
}
