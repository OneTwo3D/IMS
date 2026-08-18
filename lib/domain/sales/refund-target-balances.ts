/**
 * o3d-w00 (Codex r2 #2 / r3 #2): what each PART of an order still has left to refund.
 *
 * `createSalesOrderRefund` caps the ORDER total. That does not stop one line absorbing money that came
 * off another: the total reconciles while the credit posts to the wrong account under the wrong VAT
 * identity. So each target — every order line, plus the shipping charge — carries its own remaining
 * balance, net of what earlier refunds already credited to it.
 *
 * Codex r3 #2: this calculation is only sound when it is performed under the same lock the refund
 * commits under. Computed ahead of the transaction it is advisory only — two concurrent recordings for
 * one order each read the same £10 line as fully refundable, each allocate £10, and both then serialise
 * successfully inside `createSalesOrderRefund` because its locked check enforces only the order-wide
 * ceiling. The authoritative call therefore happens INSIDE the refund transaction, after
 * `lockSalesOrder`; the exception-inbox action calls the same helper beforehand purely so the operator
 * gets a named, immediate refusal instead of a generic one. One implementation, so the two can't drift.
 */

import { toDecimal, type Decimal, type DecimalInput } from '@/lib/domain/math/decimal'

/** Half a currency minor unit — these are penny comparisons on 2dp figures. */
export const REFUND_TARGET_BALANCE_EPSILON = 0.005

export type RefundTargetOrder = {
  shippingForeign?: DecimalInput
  lines: readonly { id: string; description?: string | null; totalForeign?: DecimalInput }[]
}

/** A refund line that already exists on the order (any prior refund). */
export type PriorRefundTargetLine = {
  salesOrderLineId?: string | null
  lineKind?: string | null
  totalForeign?: DecimalInput
}

/** A NET foreign-currency amount this recording wants to put on one target. */
export type RefundTargetAllocation = {
  lineId?: string | null
  lineKind?: 'sale' | 'shipping' | 'discount' | null
  netForeign: DecimalInput
}

export type OverAllocatedRefundTarget = {
  /** 'shipping', or the order line's description (falling back to its id). */
  label: string
  allocatedNetForeign: Decimal
  remainingNetForeign: Decimal
  chargedNetForeign: Decimal
  /** True when earlier refunds are the reason it no longer fits — worth saying out loud. */
  reducedByPriorRefunds: boolean
}

function targetKey(lineId: string | null | undefined, lineKind: string | null | undefined): string | null {
  if (lineKind === 'discount') return null // a mirrored discount is negative money, not a refund target
  if (lineId) return `line:${lineId}`
  if (lineKind === 'shipping') return 'shipping'
  // An unlinked SALE line is un-attributable by construction; the uniform-tax gate governs it, not this.
  return null
}

/**
 * The first target this allocation would over-refund, or null when every one of them fits.
 *
 * Allocations are AGGREGATED per target first: two rows against one line each pass their own balance
 * check and together exceed it.
 */
export function findOverAllocatedRefundTarget(input: {
  order: RefundTargetOrder
  priorRefundLines: readonly PriorRefundTargetLine[]
  allocations: readonly RefundTargetAllocation[]
  epsilon?: number
}): OverAllocatedRefundTarget | null {
  const epsilon = toDecimal(input.epsilon ?? REFUND_TARGET_BALANCE_EPSILON)
  const orderLineById = new Map(input.order.lines.map((line) => [line.id, line]))

  const priorByKey = new Map<string, Decimal>()
  for (const priorLine of input.priorRefundLines) {
    const key = targetKey(priorLine.salesOrderLineId, priorLine.lineKind)
    if (!key) continue
    priorByKey.set(key, (priorByKey.get(key) ?? toDecimal(0)).add(toDecimal(priorLine.totalForeign ?? 0)))
  }

  const allocatedByKey = new Map<string, Decimal>()
  const orderedKeys: string[] = []
  for (const allocation of input.allocations) {
    const key = targetKey(allocation.lineId, allocation.lineKind ?? (allocation.lineId ? 'sale' : null))
    if (!key) continue
    if (!allocatedByKey.has(key)) orderedKeys.push(key)
    allocatedByKey.set(key, (allocatedByKey.get(key) ?? toDecimal(0)).add(toDecimal(allocation.netForeign)))
  }

  for (const key of orderedKeys) {
    const allocated = allocatedByKey.get(key) ?? toDecimal(0)
    const isShipping = key === 'shipping'
    const line = isShipping ? undefined : orderLineById.get(key.slice('line:'.length))
    if (!isShipping && !line) continue // "not on this order" is a different, earlier refusal
    const charged = isShipping ? toDecimal(input.order.shippingForeign ?? 0) : toDecimal(line?.totalForeign ?? 0)
    const prior = priorByKey.get(key) ?? toDecimal(0)
    const remaining = charged.sub(prior)
    if (allocated.sub(remaining).gt(epsilon)) {
      return {
        label: isShipping ? 'shipping' : (line?.description || `line ${line?.id}`),
        allocatedNetForeign: allocated,
        remainingNetForeign: remaining,
        chargedNetForeign: charged,
        reducedByPriorRefunds: prior.gt(0),
      }
    }
  }
  return null
}

/** The operator-facing refusal for an over-allocated target — one wording, wherever it is raised. */
export function overAllocatedRefundTargetMessage(over: OverAllocatedRefundTarget): string {
  return (
    `The amount allocated to ${over.label} (${over.allocatedNetForeign.toFixed(2)} net) is more than it ` +
    `has left to refund (${over.remainingNetForeign.toFixed(2)} net` +
    `${over.reducedByPriorRefunds ? ', after earlier refunds' : ''}). ` +
    'Split the refund across the parts it actually covered.'
  )
}
