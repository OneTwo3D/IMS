import Link from 'next/link'
import { Card } from '@/components/ui/card'
import type { WcOrderDivergencePage } from '@/app/actions/wc-order-divergences'

/**
 * WooCommerce orders that no longer match the IMS order. Read-only: IMS has changed nothing (not the order, WooCommerce or the warehouse). The row closes
 * itself when a later WooCommerce update matches the IMS order again. A person decides which side is right and, if the warehouse already has the order,
 * raises any change with it by hand.
 */
export function WcOrderDivergencesSection({ data }: { data: WcOrderDivergencePage }) {
  const { rows, total, shown } = data
  if (total === 0) return null
  return (
    <Card id="wc-order-divergences" className="p-4 space-y-3 scroll-mt-4">
      <div>
        <h2 className="text-sm font-semibold">{`WooCommerce orders that no longer match IMS (${total})`}</h2>
        <p className="text-xs text-muted-foreground">
          These orders were changed in WooCommerce after IMS imported them. IMS keeps invoicing and sending to the warehouse what it first imported, and has changed nothing.
          Check each order, decide which side is right, and tell the warehouse yourself if it already holds the order. A refund is not counted as a difference.
          Rows close themselves when a later WooCommerce update matches the IMS order again.
        </p>
      </div>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className="rounded-lg border p-3 space-y-1">
            <div className="text-sm font-medium">
              {'Order '}
              <Link className="underline underline-offset-2" href={`/sales/${row.orderId}`}>{row.orderNumber}</Link>
            </div>
            <ul className="list-disc pl-5 text-xs space-y-0.5">
              {row.differences.map((line) => <li key={line}>{line}</li>)}
            </ul>
            <p className="text-xs text-muted-foreground">
              {`First seen ${row.firstSeenAt.slice(0, 16).replace('T', ' ')} UTC, last seen ${row.lastSeenAt.slice(0, 16).replace('T', ' ')} UTC, seen ${row.seenCount} time${row.seenCount === 1 ? '' : 's'}.`}
            </p>
          </div>
        ))}
      </div>
      {total > shown && <p className="text-xs text-muted-foreground">{`Showing the first ${shown} of ${total}, oldest first.`}</p>}
    </Card>
  )
}
