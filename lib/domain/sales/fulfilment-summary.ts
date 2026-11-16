/**
 * Fulfilment summary for a sales order, DERIVED from the shipments it already has.
 *
 * The lifecycle status stays ALLOCATED while parcels are picked, packed and even partly dispatched
 * (the shipment, not the order, carries those states), so the status badge alone hid what is waiting
 * on whom. This reads the shipment statuses only; it adds no stored state.
 */

export type FulfilmentTone = 'ready' | 'picking' | 'packed' | 'partial' | 'dispatched'

export type FulfilmentSummary = { label: string; tone: FulfilmentTone }

/** Order statuses in which the order status itself under-reports what the shipments are doing. */
const SUMMARISED_ORDER_STATUSES: ReadonlySet<string> = new Set(['ALLOCATED', 'PICKING', 'PACKING'])

export function summariseFulfilment(
  orderStatus: string,
  shipmentStatuses: readonly string[],
): FulfilmentSummary | null {
  if (!SUMMARISED_ORDER_STATUSES.has(orderStatus)) return null
  const total = shipmentStatuses.length
  if (total === 0) return null
  const count = (status: string) => shipmentStatuses.filter((s) => s === status).length
  const shipped = count('SHIPPED')
  const packed = count('PACKED')
  const picking = count('PICKING')

  if (shipped === total) return { label: `Dispatched ${shipped}/${total} parcels`, tone: 'dispatched' }
  if (shipped > 0) return { label: `Partially shipped ${shipped}/${total}`, tone: 'partial' }
  if (packed === total) return { label: 'Packed — ready to ship', tone: 'packed' }
  if (picking > 0) return { label: `Picking (${picking} of ${total} parcels)`, tone: 'picking' }
  if (packed > 0) return { label: `Packed ${packed} of ${total} parcels`, tone: 'packed' }
  return { label: total === 1 ? 'Ready to pick' : `Ready to pick (${total} parcels)`, tone: 'ready' }
}

export const FULFILMENT_TONE_CLASS: Record<FulfilmentTone, string> = {
  ready: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900 dark:text-yellow-200',
  picking: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900 dark:text-blue-200',
  packed: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900 dark:text-indigo-200',
  partial: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900 dark:text-purple-200',
  dispatched: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900 dark:text-green-200',
}
