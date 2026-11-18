/**
 * What a first import of a WooCommerce order may do with stock (o3d-hqvrp.92).
 *
 * An order first seen already `completed` (or mapped to SHIPPED / DELIVERED / COMPLETED), or `refunded`, did not go through IMS's
 * fulfilment: its goods left by another route, or the sale was reversed. Reserving stock for it never gets released and never
 * decrements on-hand, which understates the availability pushed to the store.
 */
import { refundDispositionForStatus, type RefundDisposition } from '@/lib/domain/sales/refund-disposition'

/** Statuses an order cannot be CREATED into with a live stock reservation. */
export const WC_IMPORT_NO_ALLOCATION_STATUSES: readonly string[] = ['CANCELLED', 'SHIPPED', 'DELIVERED', 'COMPLETED']

/** WooCommerce's own `refunded` status states a FULL refund; the built-in mapping reads it as PROCESSING, so the disposition is derived from the slug. */
export function wcImportRefundDisposition(slug: string, imsStatus: string): RefundDisposition {
  const fromStatus = refundDispositionForStatus(imsStatus)
  return slug === 'refunded' && fromStatus === 'NONE' ? 'FULL' : fromStatus
}

export function wcImportShouldAutoAllocate(input: { imsStatus: string; lifecycleStatus: string; refundDisposition: RefundDisposition }): boolean {
  return !WC_IMPORT_NO_ALLOCATION_STATUSES.includes(input.imsStatus) && input.lifecycleStatus !== 'DRAFT' && input.refundDisposition !== 'FULL'
}
