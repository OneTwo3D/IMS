import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/auth/server'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { getSupplierProducts } from '@/app/actions/supplier-portal'

export const metadata: Metadata = { title: 'My Products — Supplier Portal' }

export default async function SupplierProductsPage() {
  const session = await requireAuth()
  if (session.user.role !== 'SUPPLIER') redirect('/dashboard')

  const products = await getSupplierProducts()

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-2xl font-semibold">My Products</h1>
      <p className="text-sm text-muted-foreground">Products linked to your company. No pricing or cost information is shown.</p>

      {products.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">No products linked to your account.</div>
      ) : (
        <Table className="rounded-md border min-w-[500px]">
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="px-4 w-10" />
              <TableHead className="px-4 text-xs">SKU</TableHead>
              <TableHead className="px-4 text-xs">Name</TableHead>
              <TableHead className="px-4 text-xs">Your SKU</TableHead>
              <TableHead className="px-4 text-xs">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="px-4">
                  {p.imageUrl ? (
                    <img src={p.imageUrl} alt="" className="w-8 h-8 rounded object-cover" />
                  ) : (
                    <div className="w-8 h-8 rounded bg-muted" />
                  )}
                </TableCell>
                <TableCell className="px-4 font-mono text-xs">{p.sku}</TableCell>
                <TableCell className="px-4">{p.name}</TableCell>
                <TableCell className="px-4 font-mono text-xs text-muted-foreground">{p.supplierSku ?? '—'}</TableCell>
                <TableCell className="px-4">
                  {p.active
                    ? <span className="text-xs text-green-600">Active</span>
                    : <span className="text-xs text-muted-foreground">Inactive</span>
                  }
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
