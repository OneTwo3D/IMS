import type { Metadata } from 'next'
import { getPurchaseOrders } from '@/app/actions/purchase-orders'
import { getSuppliers } from '@/app/actions/suppliers'
import { listProducts } from '@/app/actions/products'
import { getWarehouses } from '@/app/actions/stock'
import { getCurrencies } from '@/app/actions/currencies'
import { getTaxRates, getPurchaseUnits } from '@/app/actions/settings'
import { getGoodsPosForLinking } from '@/app/actions/purchase-orders'
import { getOrganisation } from '@/app/actions/company'
import { PurchaseOrdersClient } from './po-page-client'

export const metadata: Metadata = { title: 'Purchase Orders' }

type SearchParams = { q?: string; status?: string; page?: string; invoiced?: string; returned?: string; archived?: string }

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const [list, suppliers, productsResult, warehouses, currencies, taxRates, purchaseUnits, goodsPos, organisation] = await Promise.all([
    getPurchaseOrders({ q: sp.q, status: sp.status, page: sp.page, invoiced: sp.invoiced === '1', returned: sp.returned === '1', includeArchived: sp.archived === '1' }),
    getSuppliers(),
    listProducts({ pageSize: 1000, type: 'ALL', active: 'true' }),
    getWarehouses(),
    getCurrencies(true),
    getTaxRates(),
    getPurchaseUnits(),
    getGoodsPosForLinking(),
    getOrganisation(),
  ])

  const products = productsResult.products.filter(
    (p) => !['VARIABLE', 'NON_INVENTORY', 'KIT'].includes(p.type) && (p.lifecycleStatus === 'ACTIVE' || p.lifecycleStatus === 'DRAFT'),
  )

  return (
    <PurchaseOrdersClient
      list={list}
      suppliers={suppliers}
      products={products}
      warehouses={warehouses}
      currencies={currencies}
      taxRates={taxRates}
      purchaseUnits={purchaseUnits}
      goodsPos={goodsPos}
      companyHomeCountry={organisation?.country ?? null}
    />
  )
}
