import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getPurchaseOrder } from '@/app/actions/purchase-orders'
import { getRejectedAccountingDocumentUpdateWarnings } from '@/app/actions/accounting-sync'
import { getMintsoftPurchaseOrderAsnState } from '@/app/actions/mintsoft-sync'
import { getSuppliers } from '@/app/actions/suppliers'
import { listProducts } from '@/app/actions/products'
import { getWarehouses } from '@/app/actions/stock'
import { getCurrencies } from '@/app/actions/currencies'
import { getTaxRates, getPurchaseUnits, getSetting } from '@/app/actions/settings'
import { getOrganisation } from '@/app/actions/company'
import { getAccountingSettings } from '@/lib/accounting'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { DEFAULT_CARRIERS } from '@/lib/tracking'
import { computePurchaseOrderOverBilling } from '@/lib/domain/purchasing/purchasing-reversal-alerts'
import { PoDetailClient } from './po-detail-client'

export const metadata: Metadata = { title: 'Purchase Order' }

type Props = { params: Promise<{ id: string }> }

export default async function PurchaseOrderDetailPage({ params }: Props) {
  const { id } = await params
  const [po, suppliers, productsResult, warehouses, currencies, taxRates, purchaseUnits, billUrlTemplate, organisation, carriersJson, accountingSettings, accountingAvailable, mintsoftAsnState] = await Promise.all([
    getPurchaseOrder(id),
    getSuppliers(),
    listProducts({ pageSize: 1000, type: 'ALL', active: 'true' }),
    getWarehouses(),
    getCurrencies(true),
    getTaxRates(),
    getPurchaseUnits(),
    getSetting('accounting_bill_url_template'),
    getOrganisation(),
    getSetting('shipping_carriers'),
    getAccountingSettings(),
    isIntegrationPluginEnabled('xero'),
    getMintsoftPurchaseOrderAsnState(id),
  ])

  if (!po) notFound()
  const rejectedAccountingSyncs = await getRejectedAccountingDocumentUpdateWarnings([
    { referenceType: 'PurchaseOrder', referenceId: id },
    ...po.invoices.map((invoice) => ({ referenceType: 'PurchaseInvoice', referenceId: invoice.id })),
  ])

  let carriers: string[] = DEFAULT_CARRIERS
  try { if (carriersJson) carriers = JSON.parse(carriersJson) } catch { /* empty */ }

  // audit-C4: surface bills that are over-billed relative to the quantity kept
  // after returns, so finance can raise a supplier credit.
  const overBilling = computePurchaseOrderOverBilling({
    lines: po.lines.map((l) => ({ id: l.id, productId: l.productId, sku: l.sku, qtyReceived: l.qtyReceived, qtyReturned: l.qtyReturned })),
    invoices: po.invoices.map((inv) => ({ id: inv.id, invoiceNumber: inv.invoiceNumber, totalBase: inv.totalBase, lines: inv.lines.map((il) => ({ poLineId: il.poLineId, qtyBilled: il.qtyBilled, totalBase: il.totalBase })) })),
  })

  const products = productsResult.products.filter(
    (p) => !['VARIABLE', 'NON_INVENTORY', 'KIT'].includes(p.type) && (p.lifecycleStatus === 'ACTIVE' || p.lifecycleStatus === 'DRAFT'),
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/purchase-orders" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-2xl font-semibold font-mono">{po.reference}</h1>
      </div>
      <PoDetailClient po={po} suppliers={suppliers} products={products} warehouses={warehouses} currencies={currencies} taxRates={taxRates} purchaseUnits={purchaseUnits} carriers={carriers} companyHomeCountry={organisation?.country ?? null} accountingAvailable={accountingAvailable} accountingBillUrlTemplate={billUrlTemplate ?? accountingSettings.billUrlTemplate} mintsoftAsnState={mintsoftAsnState} rejectedAccountingSyncs={rejectedAccountingSyncs} overBilling={overBilling} />
    </div>
  )
}
