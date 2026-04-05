import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getSuppliers } from '@/app/actions/suppliers'
import { getTaxRates } from '@/app/actions/settings'
import { getCurrencies } from '@/app/actions/currencies'
import { SuppliersClient } from './suppliers-client'

export const metadata: Metadata = { title: 'Suppliers' }

export default async function SuppliersPage() {
  const [suppliers, taxRates, currencies] = await Promise.all([
    getSuppliers(true),
    getTaxRates(),
    getCurrencies(true),
  ])
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/purchase-orders" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-2xl font-semibold">Suppliers</h1>
      </div>
      <SuppliersClient initialSuppliers={suppliers} taxRates={taxRates} currencies={currencies} />
    </div>
  )
}
