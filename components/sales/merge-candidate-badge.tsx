import Link from 'next/link'
import type { MergeCandidateBadgeView } from '@/app/actions/wms-merge-candidates'

/**
 * "Mergeable": this order is for the same customer and address as other open orders that are all still NEW in the warehouse. A person checks
 * them in the warehouse system and merges them there if appropriate; IMS never merges and has changed nothing.
 */
export function MergeCandidateBadge({ view }: { view: MergeCandidateBadgeView }) {
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100"
      title={['Check these orders in the warehouse system and merge them there if appropriate. IMS does not merge.', ...view.warnings].join(' ')}
      data-merge-candidate
    >
      Mergeable with
      {view.partners.map((partner) => (
        <Link key={partner.orderId} href={`/sales/${partner.orderId}`} className="underline underline-offset-2">{partner.orderNumber}</Link>
      ))}
    </span>
  )
}
