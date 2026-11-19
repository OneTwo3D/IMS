import type { MergeHoldBadgeView } from '@/app/actions/wms-merge-candidates'

/**
 * The merge hold of this order in the warehouse. HELD: waiting for a person to merge and confirm it there (IMS never releases it); red once it has stood
 * longer than the reminder age. NOT HELD: IMS tried and could not hold it, so check it in the warehouse before it is picked.
 */
export function MergeHoldBadge({ view }: { view: MergeHoldBadgeView }) {
  if (view.state === 'NOT_HELD') {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100" title="IMS could not hold this order for merging. Check it in the warehouse system before it is picked." data-merge-hold="not-held">
        Not held
      </span>
    )
  }
  if (view.state === 'PENDING') {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100" title="IMS asked the warehouse to hold this order and has not confirmed the answer. It may be held: check it in the warehouse system. IMS reads its status and will say." data-merge-hold="pending">
        Merge hold unconfirmed
      </span>
    )
  }
  return view.overdue ? (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900 dark:bg-red-900 dark:text-red-100" title="On merge hold for longer than the reminder age. Merge and confirm it in the warehouse system; IMS will not release it." data-merge-hold="overdue">
      Merge hold overdue
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100" title="Held in the warehouse so it can be merged. Merge and confirm it there; IMS will not release it. Changes and cancels are not sent while it is held: act in the warehouse system." data-merge-hold="held">
      On merge hold
    </span>
  )
}
