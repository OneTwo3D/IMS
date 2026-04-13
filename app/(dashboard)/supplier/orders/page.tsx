import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/auth/server'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { getSupplierOrders } from '@/app/actions/supplier-portal'

export const metadata: Metadata = { title: 'Purchase Orders — Supplier Portal' }

const STATUS_BADGE: Record<string, string> = {
  RFQ_SENT: 'bg-yellow-100 text-yellow-800',
  PO_SENT: 'bg-blue-100 text-blue-800',
  PARTIALLY_RECEIVED: 'bg-indigo-100 text-indigo-800',
  RECEIVED: 'bg-green-100 text-green-800',
  INVOICED: 'bg-purple-100 text-purple-800',
  CANCELLED: 'bg-red-100 text-red-800',
}

export default async function SupplierOrdersPage() {
  const session = await requireAuth()
  if (session.user.role !== 'SUPPLIER') redirect('/dashboard')

  const orders = await getSupplierOrders()

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-2xl font-semibold">Purchase Orders</h1>
      <p className="text-sm text-muted-foreground">Orders placed with your company.</p>

      {orders.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">No purchase orders yet.</div>
      ) : (
        <Table className="rounded-md border min-w-[600px]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="px-4 text-xs">Reference</TableHead>
              <TableHead className="px-4 text-xs">Your Ref</TableHead>
              <TableHead className="px-4 text-xs">Status</TableHead>
              <TableHead className="px-4 text-xs">Items</TableHead>
              <TableHead className="px-4 text-xs">Expected</TableHead>
              <TableHead className="px-4 text-xs">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="px-4 font-mono text-xs">{o.reference}</TableCell>
                <TableCell className="px-4 font-mono text-xs text-muted-foreground">{o.supplierRef ?? '—'}</TableCell>
                <TableCell className="px-4">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[o.status] ?? 'bg-muted text-muted-foreground'}`}>
                    {o.status.replace(/_/g, ' ')}
                  </span>
                </TableCell>
                <TableCell className="px-4 text-muted-foreground">{o.lineCount}</TableCell>
                <TableCell className="px-4 text-muted-foreground text-xs">
                  {o.expectedDelivery ? new Date(o.expectedDelivery).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
                </TableCell>
                <TableCell className="px-4 text-muted-foreground text-xs">
                  {new Date(o.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
