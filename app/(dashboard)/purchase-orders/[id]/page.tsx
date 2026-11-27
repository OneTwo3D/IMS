import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getPurchaseOrder, getSupplierLastPrices } from '@/app/actions/purchase-orders'
import { getRejectedAccountingDocumentUpdateWarnings } from '@/app/actions/accounting-sync'
import { getWmsPurchaseOrderAsnState } from '@/app/actions/wms-asn'
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
import { computePrepaidReconciliation } from '@/lib/domain/purchasing/prepaid-reconciliation'
import { getSession } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { documentDeleteUiStates } from '@/lib/domain/accounting/document-delete-service'
import { isPurchaseOrderEmailEnabled } from '@/lib/purchase-order-email'
import { listOrderAttachments, canEditOrderAttachments, canViewOrderAttachments } from '@/lib/domain/order-attachments'
import { OrderAttachmentsCard } from '@/components/orders/order-attachments-card'
import { getPurchaseOrderPegs } from '@/app/actions/pegging'
import { PoPegsCard } from '@/components/sales/po-pegs-card'
import { PoDetailClient } from './po-detail-client'
import { PoPrepaymentFxCard } from './po-prepayment-fx-card'
import { db } from '@/lib/db'
import { getBaseCurrencyCode } from '@/lib/base-currency'
import { isPurchaseEventFxEnabled } from '@/lib/domain/purchasing/purchase-event-fx-settings'
import { getPurchaseOrderFxView } from '@/lib/domain/purchasing/purchase-receipt-fx'
import { stockUnitsForeign } from '@/lib/domain/purchasing/purchase-bill-fx'

export const metadata: Metadata = { title: 'Purchase Order' }

type Props = { params: Promise<{ id: string }> }

export default async function PurchaseOrderDetailPage({ params }: Props) {
  const { id } = await params
  const session = await getSession()
  const showMargin = !!session && hasPermission(session.user.role, 'inventory.prices')
  const [po, suppliers, productsResult, warehouses, currencies, taxRates, purchaseUnits, billUrlTemplate, organisation, carriersJson, accountingSettings, accountingAvailable, wmsAsnState, poEmailEnabled] = await Promise.all([
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
    getWmsPurchaseOrderAsnState(id),
    isPurchaseOrderEmailEnabled(),
  ])

  if (!po) notFound()
  const pegs = await getPurchaseOrderPegs(id)
  const pegLineLabels = Object.fromEntries(po.lines.map((l) => [l.id, l.sku]))
  // Supplier SKU per product from the existing supplier-product mapping (the loader the PO form uses); a failed read leaves the column empty rather than breaking the page.
  const supplierSkus: Record<string, string | null> = {}
  try {
    for (const [productId, row] of Object.entries(await getSupplierLastPrices(po.supplierId))) supplierSkus[productId] = row.supplierSku
  } catch { /* column stays empty */ }
  const rejectedAccountingSyncs = await getRejectedAccountingDocumentUpdateWarnings([
    { referenceType: 'PurchaseOrder', referenceId: id },
    ...po.invoices.map((invoice) => ({ referenceType: 'PurchaseInvoice', referenceId: invoice.id })),
  ])

  // o3d-ngmt.21: the Delete control for each synced bill — only for a user who may edit bills, with the switch on, and for a bill that reached Xero.
  const billDeleteStates = await documentDeleteUiStates('PURCHASE_BILL', po.invoices.map((invoice) => invoice.id), !!session && hasPermission(session.user.role, 'purchasing.invoice'))
  let carriers: string[] = DEFAULT_CARRIERS
  try { if (carriersJson) carriers = JSON.parse(carriersJson) } catch { /* empty */ }

  // audit-C4: surface bills that are over-billed relative to the quantity kept
  // after returns, so finance can raise a supplier credit.
  const overBilling = computePurchaseOrderOverBilling({
    lines: po.lines.map((l) => ({ id: l.id, productId: l.productId, sku: l.sku, qtyReceived: l.qtyReceived, qtyReturned: l.qtyReturned })),
    invoices: po.invoices.map((inv) => ({ id: inv.id, invoiceNumber: inv.invoiceNumber, totalBase: inv.totalBase, lines: inv.lines.map((il) => ({ poLineId: il.poLineId, qtyBilled: il.qtyBilled, totalBase: il.totalBase })) })),
  })

  // audit-C1b: prepaid suppliers can be billed beyond what arrives (the deposit
  // was deliberate, so three-way-match is off) — surface a read-time soft
  // reconciliation banner when billed > received.
  // Only reconcile once receipt is effectively done — otherwise a still-arriving
  // PO would alarm mid-delivery. (Receipt-complete / post-receipt statuses.)
  const PREPAID_RECONCILE_STATUSES = ['RECEIVED', 'INVOICED', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED']
  const prepaidReconciliation = computePrepaidReconciliation({
    isPrepaidSupplier: po.supplierPrepaid && PREPAID_RECONCILE_STATUSES.includes(po.status),
    lines: po.lines.map((l) => ({ id: l.id, productId: l.productId, sku: l.sku, qtyReceived: l.qtyReceived, qtyReturned: l.qtyReturned })),
    invoices: po.invoices.map((inv) => ({ lines: inv.lines.map((il) => ({ poLineId: il.poLineId, qtyBilled: il.qtyBilled, totalBase: il.totalBase })) })),
  })

  // Supporting documents: shown to anyone who can see purchase orders, editable by those who can edit them (the routes re-check both).
  const attachments = session && canViewOrderAttachments(session.user.role, 'purchase') ? await listOrderAttachments('purchase', id) : []
  const canEditAttachments = !!session && canEditOrderAttachments(session.user.role, 'purchase')

  // Per-event FX rates for purchasing (o3d-hqvrp.51): the Xero prepayment rate card, only while the switch is on and for a foreign order.
  const baseCurrency = await getBaseCurrencyCode()
  const showPrepaymentFx = po.currency.toUpperCase() !== baseCurrency.toUpperCase() && await isPurchaseEventFxEnabled(db)
  const prepaymentFx = showPrepaymentFx ? await getPurchaseOrderFxView(id) : null
  // Per-event FX (step 3b): a new bill's lines are prefilled at the PO goods unit cost after the header discount (the price its stock part is billed
  // at), so a bill keyed as prefilled carries no price variance equal to the discount.
  const billUnitPrefillForeign = showPrepaymentFx
    ? Object.fromEntries([...stockUnitsForeign({ subtotalForeign: po.subtotalForeign, lines: po.lines.map((l) => ({ id: l.id, unitCostForeign: l.unitCostForeign, totalForeign: l.totalForeign })) })]
      .map(([lineId, unit]) => [lineId, unit.toNumber()]))
    : undefined

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
      <PoDetailClient po={po} suppliers={suppliers} products={products} warehouses={warehouses} currencies={currencies} taxRates={taxRates} purchaseUnits={purchaseUnits} carriers={carriers} companyHomeCountry={organisation?.country ?? null} showMargin={showMargin} accountingAvailable={accountingAvailable} accountingBillUrlTemplate={billUrlTemplate ?? accountingSettings.billUrlTemplate} wmsAsnState={wmsAsnState} rejectedAccountingSyncs={rejectedAccountingSyncs} overBilling={overBilling} prepaidReconciliation={prepaidReconciliation} poEmailEnabled={poEmailEnabled} supplierSkus={supplierSkus} canEditLineNotes={!!session && hasPermission(session.user.role, 'purchasing.create')} canApprove={!!session && hasPermission(session.user.role, 'purchasing.approve')} currentUserId={session?.user.id} billDeleteStates={billDeleteStates} billUnitPrefillForeign={billUnitPrefillForeign} />
      {showPrepaymentFx && (
        <PoPrepaymentFxCard poId={po.id} poReference={po.reference} currency={po.currency} baseCurrency={baseCurrency} fx={prepaymentFx} canRead={!!session && hasPermission(session.user.role, 'purchasing.invoice')} />
      )}
      <PoPegsCard pegs={pegs} lineLabels={pegLineLabels} />
      <OrderAttachmentsCard kind="purchase" orderId={po.id} attachments={attachments} canEdit={canEditAttachments} />
    </div>
  )
}
