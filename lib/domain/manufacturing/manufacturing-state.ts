import type { ProductionOrderStatus } from '@/app/generated/prisma/client'

export type ManufacturingTransitionDecision<TAction extends string> =
  | { allowed: true; action: TAction }
  | { allowed: false; error: string }

export type ProductionOrderCompletionAction = 'complete' | 'already-completed'
export type ProductionOrderStartAction = 'start'
export type ProductionOrderCancellationAction = 'release-reservations' | 'cancel-without-reservations'

export function evaluateProductionOrderCompletion(
  status: ProductionOrderStatus,
): ManufacturingTransitionDecision<ProductionOrderCompletionAction> {
  if (status === 'COMPLETED') return { allowed: true, action: 'already-completed' }
  if (status === 'IN_PROGRESS') return { allowed: true, action: 'complete' }
  // A DRAFT order has never been started, so it has neither a reserved stock
  // position nor a frozen component snapshot (audit-H6 captures both at
  // IN_PROGRESS). Completing it directly would consume whatever the live BOM
  // happens to be at completion time — non-deterministic if the BOM was edited
  // after the order was created, and not retry-safe (cogs-audit scjz.32). The
  // UI already requires Start Production before Mark Completed; enforce the same
  // on the server so the snapshot+reservation always exist before completion.
  if (status === 'DRAFT') {
    return {
      allowed: false,
      error: 'Cannot complete a production order that has not been started — start production first to reserve stock and freeze the bill of materials.',
    }
  }
  return { allowed: false, error: `Cannot complete a production order in ${status} status` }
}

export function evaluateProductionOrderStart(
  status: ProductionOrderStatus,
): ManufacturingTransitionDecision<ProductionOrderStartAction> {
  if (status === 'DRAFT') return { allowed: true, action: 'start' }
  return { allowed: false, error: `Cannot start a production order in ${status} status` }
}

export function evaluateProductionOrderCancellation(
  status: ProductionOrderStatus,
): ManufacturingTransitionDecision<ProductionOrderCancellationAction> {
  if (status === 'IN_PROGRESS') return { allowed: true, action: 'release-reservations' }
  if (status === 'DRAFT') return { allowed: true, action: 'cancel-without-reservations' }
  // COMPLETED orders have posted PRODUCTION_OUT (component FIFO consumption),
  // PRODUCTION_IN (output cost layer) and stock movements. "Cancelling" them
  // used to only flip status and delete manufacturingCostLine rows, which left
  // the consumed components gone, the output stock/layer in place, and the
  // overhead audit trail destroyed (inventory overstated, no reversal). Refuse
  // it: a completed order must be reversed through a dedicated flow, not cancelled.
  if (status === 'COMPLETED') {
    return {
      allowed: false,
      error: 'Cannot cancel a COMPLETED production order — it has posted stock movements and cost layers. Reverse it instead.',
    }
  }
  // Already CANCELLED — nothing to do.
  return { allowed: false, error: 'Production order is already cancelled' }
}
