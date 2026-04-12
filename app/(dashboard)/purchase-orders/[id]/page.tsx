import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getPurchaseOrder } from '@/app/actions/purchase-orders'
import { getSuppliers } from '@/app/actions/suppliers'
import { listProducts } from '@/app/actions/products'
import { getWarehouses } from '@/app/actions/stock'
import { getCurrencies } from '@/app/actions/currencies'
import { getTaxRates, getPurchaseUnits, getSetting } from '@/app/actions/settings'
import { getOrganisation } from '@/app/actions/company'
import { DEFAULT_CARRIERS } from '@/lib/tracking'
import { PoDetailClient } from './po-detail-client'

export const metadata: Metadata = { title: 'Purchase Order' }

type Props = { params: Promise<{ id: string }> }

export default async function PurchaseOrderDetailPage({ params }: Props) {
  const { id } = await params
  const [po, suppliers, productsResult, warehouses, currencies, taxRates, purchaseUnits, billUrlTemplate, organisation, carriersJson] = await Promise.all([
    getPurchaseOrder(id),
    getSuppliers(),
    listProducts({ pageSize: 1000, type: 'ALL' }),
    getWarehouses(),
    getCurrencies(true),
    getTaxRates(),
    getPurchaseUnits(),
    getSetting('accounting_bill_url_template'),
    getOrganisation(),
    getSetting('shipping_carriers'),
  ])

  if (!po) notFound()

  let carriers: string[] = DEFAULT_CARRIERS
  try { if (carriersJson) carriers = JSON.parse(carriersJson) } catch { /* empty */ }

  const products = productsResult.products.filter(
    (p) => !['VARIABLE', 'NON_INVENTORY', 'KIT'].includes(p.type),
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/purchase-orders" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-2xl font-semibold font-mono">{po.reference}</h1>
      </div>
      <PoDetailClient po={po} suppliers={suppliers} products={products} warehouses={warehouses} currencies={currencies} taxRates={taxRates} purchaseUnits={purchaseUnits} carriers={carriers} companyHomeCountry={organisation?.country ?? null} accountingBillUrlTemplate={billUrlTemplate ?? 'https://go.xero.com/AccountsPayable/View.aspx?InvoiceID={id}'} />
    </div>
  )
}
