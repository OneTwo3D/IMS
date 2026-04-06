import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireAuth } from '@/lib/auth/server'
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
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b"><tr>
              <th className="px-4 py-2 w-10" />
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">SKU</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Name</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Your SKU</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Status</th>
            </tr></thead>
            <tbody className="divide-y">
              {products.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt="" className="w-8 h-8 rounded object-cover" />
                    ) : (
                      <div className="w-8 h-8 rounded bg-muted" />
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{p.sku}</td>
                  <td className="px-4 py-2">{p.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{p.supplierSku ?? '—'}</td>
                  <td className="px-4 py-2">
                    {p.active
                      ? <span className="text-xs text-green-600">Active</span>
                      : <span className="text-xs text-muted-foreground">Inactive</span>
                    }
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
