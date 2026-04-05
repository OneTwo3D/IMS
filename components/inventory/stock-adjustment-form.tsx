'use client'

import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { adjustStock, type AdjustmentFormState, type AdjustmentReasonOption } from '@/app/actions/stock'

type Warehouse = { id: string; code: string; name: string; type: string }

type Props = {
  productId: string
  warehouses: Warehouse[]
  reasons: AdjustmentReasonOption[]
}

export function StockAdjustmentForm({ productId, warehouses, reasons }: Props) {
  const router = useRouter()
  // formKey resets the form by remounting it after a successful save
  const [formKey, setFormKey] = useState(0)
  const [state, formAction, isPending] = useActionState(
    adjustStock,
    {}
  )
  const [successMsg, setSuccessMsg] = useState('')

  useEffect(() => {
    if (state.success) {
      router.refresh()
      setSuccessMsg('Adjustment saved.')
      // Reset form after a brief flash, allowing another adjustment
      const t = setTimeout(() => {
        setFormKey((k) => k + 1)
        setSuccessMsg('')
      }, 1500)
      return () => clearTimeout(t)
    }
  }, [state.success, router])

  const hasReasons = reasons.length > 0

  return (
    <div className="space-y-3">
      {successMsg && (
        <p className="text-sm text-green-600 font-medium">{successMsg}</p>
      )}
      <form key={formKey} action={formAction} className="space-y-3">
        <input type="hidden" name="productId" value={productId} />

        {state.message && (
          <p className="text-sm text-destructive">{state.message}</p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="adj-warehouse" className="text-xs">Warehouse</Label>
            <Select id="adj-warehouse" name="warehouseId" className="h-8 text-xs">
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="adj-qty" className="text-xs">
              Quantity <span className="text-muted-foreground">(+ add / − remove)</span>
            </Label>
            <Input
              id="adj-qty"
              name="qty"
              type="number"
              step="1"
              placeholder="e.g. 10 or -5"
              className="h-8 text-xs"
              aria-invalid={!!state.errors?.qty}
            />
            {state.errors?.qty && (
              <p className="text-xs text-destructive">{state.errors.qty[0]}</p>
            )}
          </div>
        </div>

        {hasReasons ? (
          <div className="space-y-1">
            <Label htmlFor="adj-reason" className="text-xs">Reason *</Label>
            <Select id="adj-reason" name="reasonId" className="h-8 text-xs" required>
              <option value="">— Select a reason —</option>
              {reasons.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </Select>
            {state.errors?.reasonId && (
              <p className="text-xs text-destructive">{state.errors.reasonId[0]}</p>
            )}
            <Input
              id="adj-note"
              name="note"
              placeholder="Optional additional note"
              className="h-8 text-xs mt-1"
            />
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="adj-note" className="text-xs">
              Reason / Note{' '}
              <span className="text-muted-foreground text-xs font-normal">
                — configure reasons in{' '}
                <a href="/settings" className="underline hover:no-underline">Settings</a>
              </span>
            </Label>
            <Input
              id="adj-note"
              name="note"
              placeholder="e.g. Cycle count correction"
              className="h-8 text-xs"
            />
          </div>
        )}

        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? 'Saving…' : 'Apply Adjustment'}
        </Button>
      </form>
    </div>
  )
}
