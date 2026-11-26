'use client'

import { type ChangeEvent, useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { adjustStock, getAdjustmentDefaultUnitCosts, type AdjustmentDefaultUnitCost, type AdjustmentReasonOption } from '@/app/actions/stock'
import { describeDefaultUnitCost } from '@/components/inventory/adjustment-default-cost'

type Warehouse = { id: string; code: string; name: string; type: string }

type Props = {
  productId: string
  warehouses: Warehouse[]
  reasons: AdjustmentReasonOption[]
  /** o3d-0ypv9: switch `stock_adjustment_reason_cost_required`. Off (the default) renders the form exactly as before. */
  reasonCostRequired?: boolean
}

export function StockAdjustmentForm({ productId, warehouses, reasons, reasonCostRequired = false }: Props) {
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
  // o3d-0ypv9: the selected warehouse, tracked only so the switch-on cost default follows it.
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '')

  // Show success message immediately (render-time state adjustment)
  if (state.success && !prevSuccess) {
    setPrevSuccess(true)
    setSuccessMsg('Adjustment saved.')
  }
  if (!state.success && prevSuccess) {
    setPrevSuccess(undefined)
  }

  // A primitive, not the `warehouses` array: every router.refresh() hands down a new array, which would re-run the effect below forever.
  const defaultWarehouseId = warehouses[0]?.id ?? ''
  // Handle side effects (router refresh + delayed form reset)
  useEffect(() => {
    if (!state.success) return
    router.refresh()
    const t = setTimeout(() => {
      // Rotate the token so the next adjustment is a distinct submission (the old
      // token stays attached until now, but the submit button is disabled while the
      // success message shows, so it can't be reused).
      setIdempotencyToken(crypto.randomUUID())
      setWarehouseId(defaultWarehouseId)
      setFormKey((k) => k + 1)
      setSuccessMsg('')
    }, 1500)
    return () => clearTimeout(t)
  }, [state.success, router, defaultWarehouseId])

  const hasReasons = reasons.length > 0
  // o3d-0ypv9 (switch on): show the unit cost a blank addition defaults to (the latest cost layer, never an average).
  const [costDefault, setCostDefault] = useState<{ key: string; value: AdjustmentDefaultUnitCost | null } | null>(null)
  const costKey = `${productId}:${warehouseId}`
  useEffect(() => {
    if (!reasonCostRequired || !warehouseId) return
    let cancelled = false
    getAdjustmentDefaultUnitCosts([{ productId, warehouseId }])
      .then((rows) => { if (!cancelled) setCostDefault({ key: costKey, value: rows[0] ?? null }) })
      .catch(() => { if (!cancelled) setCostDefault({ key: costKey, value: null }) })
    return () => { cancelled = true }
  }, [reasonCostRequired, productId, warehouseId, costKey, formKey])
  const currentDefault = costDefault?.key === costKey ? costDefault.value : undefined

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
            <Select
              id="adj-warehouse"
              name="warehouseId"
              className="h-8 text-xs"
              {...(reasonCostRequired ? { onChange: (e: ChangeEvent<HTMLSelectElement>) => setWarehouseId(e.target.value) } : {})}
            >
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
            {reasonCostRequired ? (
              <span className="text-muted-foreground">(base currency — for additions; leave blank to use the latest cost layer&apos;s unit cost; 0 only for genuinely free stock)</span>
            ) : (
              <span className="text-muted-foreground">(base currency — required for additions of a product with no existing cost; 0 for samples)</span>
            )}
          </Label>
          <Input
            id="adj-unit-cost"
            name="unitCostBase"
            type="number"
            step="any"
            min="0"
            placeholder={reasonCostRequired ? describeDefaultUnitCost(currentDefault).placeholder : 'leave blank to use average cost'}
            className="h-8 text-xs"
            aria-invalid={!!state.errors?.unitCostBase}
          />
          {reasonCostRequired && currentDefault !== undefined && (
            <p className="text-xs text-muted-foreground" data-testid="adj-unit-cost-default">{describeDefaultUnitCost(currentDefault).hint}</p>
          )}
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
        ) : reasonCostRequired ? (
          <p className="text-xs text-destructive">
            Every stock adjustment needs a reason. Add an adjustment reason (with its account) in{' '}
            <a href="/settings" className="underline hover:no-underline">Settings</a> first.
          </p>
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
        <Button type="submit" size="sm" disabled={isPending || !!successMsg || (reasonCostRequired && !hasReasons)}>
          {isPending ? 'Saving…' : 'Apply Adjustment'}
        </Button>
      </form>
    </div>
  )
}
