import { resolvePurchaseOrderFxRateToBase } from '@/lib/domain/purchasing/purchase-order-fx'
import {
  rebasePurchaseOrderStoredBaseAmountsWithParentUpdate,
  type PurchaseOrderFxRebaseParentUpdate,
  type PurchaseOrderFxRebaseStoredOrder,
  type PurchaseOrderFxRebaseTransactionalDb,
} from '@/lib/domain/purchasing/purchase-order-fx-rebase'

export type PurchaseOrderFxRateOnlyExisting = PurchaseOrderFxRebaseStoredOrder & {
  currency: string
}

export type PurchaseOrderFxRateOnlyInput = {
  currency?: string
  fxRateToBase?: number | null
}

export type PurchaseOrderFxRateOnlyUpdateDb<TResult = unknown> =
  PurchaseOrderFxRebaseTransactionalDb<TResult> & Parameters<typeof resolvePurchaseOrderFxRateToBase>[0]

export async function updatePurchaseOrderFxRateOnly<TResult>(
  db: PurchaseOrderFxRateOnlyUpdateDb<TResult>,
  poId: string,
  existing: PurchaseOrderFxRateOnlyExisting,
  input: PurchaseOrderFxRateOnlyInput,
  options: {
    baseCurrency: string
    asOf: Date
    parentUpdate: PurchaseOrderFxRebaseParentUpdate
  },
): Promise<TResult> {
  const fxRateToBase = await resolvePurchaseOrderFxRateToBase(db, {
    currency: input.currency ?? existing.currency,
    baseCurrency: options.baseCurrency,
    asOf: options.asOf,
    inputRateToBase: input.fxRateToBase,
  })

  return rebasePurchaseOrderStoredBaseAmountsWithParentUpdate(db, poId, existing, fxRateToBase, {
    ...options.parentUpdate,
    data: {
      ...options.parentUpdate.data,
      ...(input.currency !== undefined && { currency: input.currency }),
      fxRateToBase,
    },
  })
}
