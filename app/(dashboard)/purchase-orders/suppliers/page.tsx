import type { Metadata } from 'next'
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
    <SuppliersClient initialSuppliers={suppliers} taxRates={taxRates} currencies={currencies} />
  )
}
