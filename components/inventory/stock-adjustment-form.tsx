'use client'

import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { adjustStock, type AdjustmentReasonOption } from '@/app/actions/stock'

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
  const [prevSuccess, setPrevSuccess] = useState<boolean | undefined>(undefined)
  // 0tr0: a per-submission idempotency token so a double-click / retry submits the
  // same token and the server dedups the adjustment. Held in state with a lazy
  // initializer so it's present on the very first render — including SSR, so a
  // no-JS / pre-hydration submit still carries a token (lpg9). The server value and
  // the client value legitimately differ (random per environment), so the hidden
  // input is suppressHydrationWarning. Rotated on each successful save (see below).
  const [idempotencyToken, setIdempotencyToken] = useState(() => crypto.randomUUID())

  // Show success message immediately (render-time state adjustment)
  if (state.success && !prevSuccess) {
    setPrevSuccess(true)
    setSuccessMsg('Adjustment saved.')
  }
  if (!state.success && prevSuccess) {
    setPrevSuccess(undefined)
  }

  // Handle side effects (router refresh + delayed form reset)
  useEffect(() => {
    if (!state.success) return
    router.refresh()
    const t = setTimeout(() => {
      // Rotate the token so the next adjustment is a distinct submission (the old
      // token stays attached until now, but the submit button is disabled while the
      // success message shows, so it can't be reused).
      setIdempotencyToken(crypto.randomUUID())
      setFormKey((k) => k + 1)
      setSuccessMsg('')
    }, 1500)
    return () => clearTimeout(t)
  }, [state.success, router])

  const hasReasons = reasons.length > 0

  return (
    <div className="space-y-3">
      {successMsg && (
        <p className="text-sm text-green-600 font-medium">{successMsg}</p>
      )}
      <form key={formKey} action={formAction} className="space-y-3">
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="idempotencyToken" value={idempotencyToken} suppressHydrationWarning />

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

        <div className="space-y-1">
          <Label htmlFor="adj-unit-cost" className="text-xs">
            Unit cost{' '}
            <span className="text-muted-foreground">(base currency — required for additions of a product with no existing cost; 0 for samples)</span>
          </Label>
          <Input
            id="adj-unit-cost"
            name="unitCostBase"
            type="number"
            step="any"
            min="0"
            placeholder="leave blank to use average cost"
            className="h-8 text-xs"
            aria-invalid={!!state.errors?.unitCostBase}
          />
          {state.errors?.unitCostBase && (
            <p className="text-xs text-destructive">{state.errors.unitCostBase[0]}</p>
          )}
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

        {/* 0tr0: stay disabled through the post-success window (until the form
            remounts and mints a new token). Otherwise an edit-and-resubmit in that
            window reuses the same token and the new adjustment is silently deduped. */}
        <Button type="submit" size="sm" disabled={isPending || !!successMsg}>
          {isPending ? 'Saving…' : 'Apply Adjustment'}
        </Button>
      </form>
    </div>
  )
}
