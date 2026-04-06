import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { requireAuth } from '@/lib/auth/server'
import { getSupplierRfqs } from '@/app/actions/supplier-portal'

export const metadata: Metadata = { title: 'RFQs — Supplier Portal' }

export default async function SupplierRfqsPage() {
  const session = await requireAuth()
  if (session.user.role !== 'SUPPLIER') redirect('/dashboard')

  const rfqs = await getSupplierRfqs()

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-2xl font-semibold">Requests for Quotation</h1>
      <p className="text-sm text-muted-foreground">RFQs addressed to your company. Click to view details and submit a quote.</p>

      {rfqs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">No RFQs at this time.</div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b"><tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Reference</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Items</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Date</th>
            </tr></thead>
            <tbody className="divide-y">
              {rfqs.map((r) => (
                <tr key={r.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2">
                    <Link href={`/supplier/rfqs/${r.id}`} className="font-mono text-primary hover:underline">{r.reference}</Link>
                  </td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                      {r.status === 'RFQ_SENT' ? 'Awaiting Quote' : 'Draft'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{r.lineCount}</td>
                  <td className="px-4 py-2 text-muted-foreground text-xs">
                    {new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
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
