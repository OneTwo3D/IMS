/**
 * Server-side money rules for a manual sales order write (create and edit). The form already filters these, but the server is the authority: the invoice payload sends discount, shipping and fee
 * amounts only when positive, so a negative figure would be stored in IMS and silently dropped from the invoice.
 */
export interface SalesOrderMoneyInput {
  shippingForeign?: number
  orderDiscountForeign?: number
  taxRateValue?: number
  fees?: { description?: string; amount: number }[]
  lines: { sku?: string; discountAmount?: number }[]
}

function bad(v: number | undefined): boolean {
  return v !== undefined && v !== null && (!Number.isFinite(v) || v < 0)
}

export function salesOrderMoneyRefusal(input: SalesOrderMoneyInput): string | null {
  if (bad(input.shippingForeign)) return 'Shipping cannot be negative'
  if (bad(input.orderDiscountForeign)) return 'The order discount cannot be negative'
  if (bad(input.taxRateValue)) return 'The tax rate cannot be negative'
  for (const fee of input.fees ?? []) {
    if (!Number.isFinite(fee.amount) || fee.amount < 0) return `Fee "${fee.description ?? ''}" cannot be negative`
  }
  for (const line of input.lines) {
    if (bad(line.discountAmount)) return `Negative discount for ${line.sku ?? 'a line'}`
  }
  return null
}

/** The header tax rate: the named rate's own value when the name resolves, else the caller's value, else 0. The caller's value is never preferred over a resolved rate. */
export function resolveHeaderTaxRate(namedRateValue: number | null | undefined, callerValue: number | undefined): number {
  return namedRateValue ?? callerValue ?? 0
}
