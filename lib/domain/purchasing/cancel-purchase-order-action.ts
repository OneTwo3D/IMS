import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/server'
import {
  cancelPurchaseOrderService,
  type CancelPurchaseOrderResult,
} from '@/lib/domain/purchasing/cancellation-service'

export type CancelPurchaseOrderActionDeps = {
  requirePermission: typeof requirePermission
  cancelPurchaseOrderService: typeof cancelPurchaseOrderService
  revalidatePath: typeof revalidatePath
}

const defaultCancelPurchaseOrderActionDeps: CancelPurchaseOrderActionDeps = {
  requirePermission,
  cancelPurchaseOrderService,
  revalidatePath,
}

export async function cancelPurchaseOrderAction(
  id: string,
  deps: CancelPurchaseOrderActionDeps = defaultCancelPurchaseOrderActionDeps,
): Promise<CancelPurchaseOrderResult> {
  await deps.requirePermission('purchasing.create')
  const result = await deps.cancelPurchaseOrderService(id)
  if (result.success) {
    deps.revalidatePath('/purchase-orders')
    deps.revalidatePath(`/purchase-orders/${id}`)
  }
  return result
}
