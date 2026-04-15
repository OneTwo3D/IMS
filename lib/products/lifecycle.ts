import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'

export const SELLABLE_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['ACTIVE']
export const OPERATIONAL_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['ACTIVE', 'NOT_FOR_SALE']
export const COMPONENT_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['ACTIVE', 'NOT_FOR_SALE']
export const WOO_STOCK_SYNC_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['ACTIVE', 'NOT_FOR_SALE', 'ARCHIVED']

export function isSellableProductStatus(status: ProductLifecycleStatus): boolean {
  return status === 'ACTIVE'
}

export function isOperationalProductStatus(status: ProductLifecycleStatus): boolean {
  return status !== 'ARCHIVED'
}

export function isComponentEligibleProductStatus(status: ProductLifecycleStatus): boolean {
  return status !== 'ARCHIVED'
}

export function shouldSyncStockToWoo(status: ProductLifecycleStatus): boolean {
  return status === 'ACTIVE' || status === 'NOT_FOR_SALE' || status === 'ARCHIVED'
}

export function shouldForceWooDraft(status: ProductLifecycleStatus): boolean {
  return status !== 'ACTIVE'
}

export function shouldForceWooZeroStock(status: ProductLifecycleStatus): boolean {
  return status === 'ARCHIVED'
}

export function deriveLifecycleStatusFromLegacyActive(active: boolean): ProductLifecycleStatus {
  return active ? 'ACTIVE' : 'NOT_FOR_SALE'
}

export function deriveLegacyActiveFromLifecycleStatus(status: ProductLifecycleStatus): boolean {
  return status !== 'ARCHIVED'
}

export function deriveLifecycleStatusFromWooStatus(
  externalStatus: string,
  currentStatus?: ProductLifecycleStatus | null,
): ProductLifecycleStatus {
  if (externalStatus === 'publish') return 'ACTIVE'
  if (currentStatus === 'ARCHIVED') return 'ARCHIVED'
  return 'NOT_FOR_SALE'
}

export function deriveWooStatusFromLifecycleStatus(status: ProductLifecycleStatus): 'publish' | 'draft' {
  return status === 'ACTIVE' ? 'publish' : 'draft'
}
