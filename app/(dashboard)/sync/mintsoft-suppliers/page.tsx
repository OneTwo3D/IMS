import type { Metadata } from 'next'
import Link from 'next/link'
import { getMintsoftSupplierMappingScreen } from '@/app/actions/mintsoft-suppliers'
import { MintsoftSuppliersClient } from './mintsoft-suppliers-client'

export const metadata: Metadata = { title: 'Mintsoft suppliers' }
export const dynamic = 'force-dynamic'

export default async function MintsoftSuppliersPage() {
  const screen = await getMintsoftSupplierMappingScreen()
  return (
    <div className="space-y-4">
      <div>
        <Link href="/sync" className="text-xs text-muted-foreground hover:underline">Integrations</Link>
        <h1 className="text-xl font-semibold">Mintsoft suppliers</h1>
        <p className="text-sm text-muted-foreground">
          Mintsoft needs a supplier on every ASN. Map each IMS supplier to the supplier Mintsoft already holds, or choose to create it there.
          Reading Mintsoft&apos;s list changes nothing in Mintsoft, and IMS never overwrites the details of a supplier Mintsoft already has.
        </p>
      </div>
      <MintsoftSuppliersClient screen={screen} />
    </div>
  )
}
