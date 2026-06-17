import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { requireAuth } from '@/lib/auth/server'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { getSupplierRfqs } from '@/app/actions/supplier-portal'
import { formatDateTime } from '@/lib/format-datetime'
import { getDisplayTimeZone } from '@/lib/display-timezone'

export const metadata: Metadata = { title: 'RFQs — Supplier Portal' }

export default async function SupplierRfqsPage() {
  const session = await requireAuth()
  if (session.user.role !== 'SUPPLIER') redirect('/dashboard')

  const rfqs = await getSupplierRfqs()
  const tz = await getDisplayTimeZone()

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-2xl font-semibold">Requests for Quotation</h1>
      <p className="text-sm text-muted-foreground">RFQs addressed to your company. Click to view details and submit a quote.</p>

      {rfqs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">No RFQs at this time.</div>
      ) : (
        <Table className="rounded-md border">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="px-4 text-xs">Reference</TableHead>
              <TableHead className="px-4 text-xs">Status</TableHead>
              <TableHead className="px-4 text-xs">Items</TableHead>
              <TableHead className="px-4 text-xs">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rfqs.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="px-4">
                  <Link href={`/supplier/rfqs/${r.id}`} className="font-mono text-primary hover:underline">{r.reference}</Link>
                </TableCell>
                <TableCell className="px-4">
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                    {r.status === 'RFQ_SENT' ? 'Awaiting Quote' : 'Draft'}
                  </span>
                </TableCell>
                <TableCell className="px-4 text-muted-foreground">{r.lineCount}</TableCell>
                <TableCell className="px-4 text-muted-foreground text-xs">
                  {formatDateTime(r.createdAt, { day: 'numeric', month: 'short', year: 'numeric' }, tz)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
