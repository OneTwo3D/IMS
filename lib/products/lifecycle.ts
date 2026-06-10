import type { ProductLifecycleStatus } from '@/app/generated/prisma/client'

export const SELLABLE_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['ACTIVE', 'EOL']
export const PURCHASABLE_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['ACTIVE', 'DRAFT']
export const REORDER_ELIGIBLE_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['ACTIVE', 'DRAFT']
export const OPERATIONAL_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['DRAFT', 'ACTIVE', 'EOL']
export const COMPONENT_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['DRAFT', 'ACTIVE', 'EOL']
export const WOO_STOCK_SYNC_PRODUCT_STATUSES: ProductLifecycleStatus[] = ['DRAFT', 'ACTIVE', 'EOL', 'ARCHIVED']

export function isSellableProductStatus(status: ProductLifecycleStatus): boolean {
  return status === 'ACTIVE' || status === 'EOL'
}

export function isPurchasableProductStatus(status: ProductLifecycleStatus): boolean {
  return status === 'ACTIVE' || status === 'DRAFT'
}

export function isReorderEligibleProductStatus(status: ProductLifecycleStatus): boolean {
  return status === 'ACTIVE' || status === 'DRAFT'
}

export function isOperationalProductStatus(status: ProductLifecycleStatus): boolean {
  return status !== 'ARCHIVED'
}

export function isComponentEligibleProductStatus(status: ProductLifecycleStatus): boolean {
  return status !== 'ARCHIVED'
}

export function shouldSyncStockToWoo(status: ProductLifecycleStatus): boolean {
  return status === 'ACTIVE' || status === 'EOL' || status === 'ARCHIVED'
}

export function shouldForceWooDraft(status: ProductLifecycleStatus): boolean {
  return status === 'DRAFT' || status === 'ARCHIVED'
}

export function shouldForceWooZeroStock(status: ProductLifecycleStatus): boolean {
  return status === 'ARCHIVED'
}

export function deriveLifecycleStatusFromLegacyActive(active: boolean): ProductLifecycleStatus {
  return active ? 'ACTIVE' : 'EOL'
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
  if (currentStatus === 'EOL') return 'EOL'
  return 'DRAFT'
}

export function deriveWooStatusFromLifecycleStatus(status: ProductLifecycleStatus): 'publish' | 'draft' {
  return status === 'ACTIVE' || status === 'EOL' ? 'publish' : 'draft'
}
