import type { ShopRefundBadgeView } from '@/app/actions/shop-refund-tasks'

/**
 * "Refund to make in WooCommerce": IMS recorded a refund on this order and has written nothing to WooCommerce. A person pays the customer back
 * there; IMS then links that refund to its own credit note and clears this badge. The task is on Sync > Exceptions.
 */
export function ShopRefundBadge({ view }: { view: ShopRefundBadgeView }) {
  const amounts = view.amounts.length > 0 ? ` (${view.amounts.join(', ')})` : ''
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100"
      title="IMS recorded a refund on this order and wrote nothing to WooCommerce. Refund the customer in WooCommerce; when IMS imports it, it is parked for you to confirm it settles the credit note. See Sync > Exceptions."
      data-shop-refund-due
    >
      {`Refund to make in WooCommerce${view.count > 1 ? ` x${view.count}` : ''}${amounts}`}
    </span>
  )
}
