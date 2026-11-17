'use client'

import { useReorderSelection } from '@/lib/analytics/reorder-selection-context'
import type { ReorderSupplierOption } from '@/lib/domain/inventory/replenishment-reports'

/**
 * Supplier cell for a purchased row on Reorder Planning. The cell is rendered by a server component, so the
 * <select> is its own client island. Choosing a supplier other than the default routes this row's draft PO line
 * to that supplier; choosing the default (first option) removes the override. With only one catalog supplier it
 * is plain text.
 */
export function ReorderSupplierSelect({
  productId,
  sku,
  defaultSupplierId,
  defaultSupplierName,
  options,
}: {
  productId: string
  sku: string
  defaultSupplierId: string | null
  defaultSupplierName: string | null
  options: readonly ReorderSupplierOption[]
}) {
  const { supplierOverrides, setSupplierOverride } = useReorderSelection()
  const alternatives = options.filter((option) => option.supplierId !== defaultSupplierId)
  if (alternatives.length === 0) return <>{defaultSupplierName}</>
  const override = supplierOverrides[productId]
  return (
    <select
      className={`h-8 max-w-[14rem] rounded-md border bg-background px-1.5 text-sm ${override ? 'border-amber-400' : 'border-input'}`}
      value={override ?? defaultSupplierId ?? ''}
      onChange={(e) => setSupplierOverride(productId, e.target.value === defaultSupplierId ? null : e.target.value)}
      aria-label={`Supplier for ${sku}`}
      title={override ? 'Supplier overridden for the draft PO' : 'Default supplier. Pick another to override it in the draft PO.'}
    >
      {defaultSupplierId ? <option value={defaultSupplierId}>{defaultSupplierName ?? defaultSupplierId} (default)</option> : null}
      {alternatives.map((option) => (
        <option key={option.supplierId} value={option.supplierId}>{option.supplierName}</option>
      ))}
    </select>
  )
}
