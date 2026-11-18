import Link from 'next/link'
import type { PurchaseOrderPegRow } from '@/app/actions/pegging'
import { PeggedBadge } from '@/components/sales/so-pegs-card'

/** The sales orders pegged to a purchase order's lines: stock received on a line is allocated to these orders first. */
export function PoPegsCard({ pegs, lineLabels }: { pegs: PurchaseOrderPegRow[]; lineLabels: Record<string, string> }) {
  if (pegs.length === 0) return null
  return (
    <div className="rounded-lg border bg-card" data-peg-card>
      <div className="border-b px-4 py-2">
        <h3 className="text-sm font-semibold">Pegged sales orders</h3>
        <p className="text-xs text-muted-foreground">Stock received on these lines is allocated to the pegged orders first; any remainder follows the normal oldest-order-first rule.</p>
      </div>
      <div className="divide-y">
        {pegs.map((peg) => (
          <div key={peg.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
            <span className="font-mono text-xs">{lineLabels[peg.purchaseOrderLineId] ?? peg.purchaseOrderLineId}</span>
            <PeggedBadge />
            <Link href={`/sales/${peg.salesOrderId}`} className="underline underline-offset-2">{peg.salesOrderNumber}</Link>
            {peg.customerName && <span className="text-muted-foreground">{peg.customerName}</span>}
            <span className="ml-auto text-xs">{peg.qty} pegged ({peg.receivedQty} received, {peg.allocatedQty} allocated)</span>
          </div>
        ))}
      </div>
    </div>
  )
}
