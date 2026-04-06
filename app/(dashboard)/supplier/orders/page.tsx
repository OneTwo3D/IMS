import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { requireAuth } from '@/lib/auth/server'
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
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b"><tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Reference</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Your Ref</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Items</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Expected</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
            </tr></thead>
            <tbody className="divide-y">
              {orders.map((o) => (
                <tr key={o.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2 font-mono text-xs">{o.reference}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{o.supplierRef ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[o.status] ?? 'bg-muted text-muted-foreground'}`}>
                      {o.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{o.lineCount}</td>
                  <td className="px-4 py-2 text-muted-foreground text-xs">
                    {o.expectedDelivery ? new Date(o.expectedDelivery).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground text-xs">
                    {new Date(o.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
