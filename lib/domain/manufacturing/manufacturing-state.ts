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
  if (status === 'IN_PROGRESS' || status === 'DRAFT') return { allowed: true, action: 'complete' }
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
  return { allowed: true, action: 'cancel-without-reservations' }
}
