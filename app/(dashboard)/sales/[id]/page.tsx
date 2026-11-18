import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getSalesOrder } from '@/app/actions/sales'
import { getReturnReasons } from '@/app/actions/return-reasons'
import { getWarehouses, getScopedStockLevelMap, getAvgCogsMap } from '@/app/actions/stock'
import { getCurrencies } from '@/app/actions/currencies'
import { getSetting, getTaxRates, getUsers } from '@/app/actions/settings'
import { listProducts } from '@/app/actions/products'
import { getCustomers } from '@/app/actions/customers'
import { getOrganisation } from '@/app/actions/company'
import { getOrderAllocations, getOrderFulfillmentRequirements, getOrderShipments } from '@/app/actions/allocation'
import { getRejectedAccountingDocumentUpdateWarnings } from '@/app/actions/accounting-sync'
import { getAccountingSettings } from '@/lib/accounting'
import { DEFAULT_CARRIERS } from '@/lib/tracking'
import { getSalesOrderAdminLinks } from '@/lib/shopping'
import { getWmsOrderStatusForSalesOrder } from '@/app/actions/wms-order-status'
import { getWmsOrderPushStateForSalesOrder } from '@/app/actions/wms-order-push'
import { getMergeCandidateForSalesOrder } from '@/app/actions/wms-merge-candidates'
import { getShopRefundDueForSalesOrder } from '@/app/actions/shop-refund-tasks'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { requireAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { documentDeleteUiStates } from '@/lib/domain/accounting/document-delete-service'
import { shouldWarnPaidWithoutInvoice } from '@/lib/domain/sales/paid-without-invoice'
import { getSalesOrderPegs } from '@/app/actions/pegging'
import { SoDetailClient } from './so-detail-client'

export const metadata: Metadata = { title: 'Sales Order' }

type Props = { params: Promise<{ id: string }> }

export default async function SalesOrderDetailPage({ params }: Props) {
  const { id } = await params
  const [session, so, warehouses, currencies, externalOrderLinks, allocations, shipments, fulfillmentRequirements, carriersJson, deliveryTrackingEnabled, invoiceUrlTemplate, accountingSettings, accountingAvailable, rejectedAccountingSyncs, invoiceTrigger, wmsOrderStatus, wmsPushState, mergeCandidate, returnReasons, shopRefundDue] = await Promise.all([
    requireAuth(),
    getSalesOrder(id),
    getWarehouses(),
    getCurrencies(true),
    getSalesOrderAdminLinks(id),
    getOrderAllocations(id),
    getOrderShipments(id),
    getOrderFulfillmentRequirements(id),
    getSetting('shipping_carriers'),
    getSetting('delivery_tracking_enabled'),
    getSetting('accounting_invoice_url_template'),
    getAccountingSettings(),
    isIntegrationPluginEnabled('xero'),
    getRejectedAccountingDocumentUpdateWarnings([{ referenceType: 'SalesOrder', referenceId: id }]),
    getSetting('invoice_trigger'),
    getWmsOrderStatusForSalesOrder(id),
    getWmsOrderPushStateForSalesOrder(id),
    getMergeCandidateForSalesOrder(id),
    getReturnReasons(true),
    getShopRefundDueForSalesOrder(id),
  ])
  let carriers: string[] = DEFAULT_CARRIERS
  try { if (carriersJson) carriers = JSON.parse(carriersJson) } catch { /* empty */ }

  if (!so) notFound()
  const pegs = await getSalesOrderPegs(id)
  // audit-H2: a fully-paid order whose trigger won't auto-generate an invoice.
  const paidWithoutInvoice = shouldWarnPaidWithoutInvoice({
    becamePaid: Boolean(so.paidAt),
    hasInvoiceNumber: Boolean(so.invoiceNumber),
    invoiceTrigger,
  })
  const stockWarehouseIds = Array.from(new Set([
    ...warehouses.map((warehouse) => warehouse.id),
    so.shipFromWarehouseId,
  ].filter((warehouseId): warehouseId is string => Boolean(warehouseId))))
  const stockLevels = await getScopedStockLevelMap({
    productIds: Array.from(new Set(so.lines.map((line) => line.productId).filter((productId): productId is string => Boolean(productId)))),
    warehouseIds: stockWarehouseIds,
  })

  // The Edit order dialog is the new-order form pre-filled, so it needs the same catalogue; only a DRAFT can be edited, so only a draft pays for loading it.
  const editForm = so.status === 'DRAFT' ? await loadEditFormData(session) : undefined
  // o3d-ngmt.21: the Delete control for a synced invoice — shown only for a user who may process sales, with the switch on, and for a document that reached Xero.
  const invoiceDeleteState = (await documentDeleteUiStates('SALES_INVOICE', [so.id], hasPermission(session.user.role, 'sales.process')))[so.id]

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link href="/sales" className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-2xl font-semibold font-mono">{so.displayOrderNumber}</h1>
      </div>
      <SoDetailClient
        order={so}
        warehouses={warehouses}
        currencies={currencies}
        externalOrderLinks={externalOrderLinks}
        wmsOrderStatus={wmsOrderStatus}
        wmsPushState={wmsPushState}
        mergeCandidate={mergeCandidate}
        returnReasons={returnReasons}
        shopRefundDue={shopRefundDue}
        stockLevels={stockLevels}
        initialAllocations={allocations}
        initialShipments={shipments}
        fulfillmentRequirements={fulfillmentRequirements}
        carriers={carriers}
        deliveryTrackingEnabled={deliveryTrackingEnabled === 'true'}
        accountingAvailable={accountingAvailable}
        accountingInvoiceUrlTemplate={invoiceUrlTemplate ?? accountingSettings.invoiceUrlTemplate}
        accountingSyncEnabled={accountingAvailable && accountingSettings.syncEnabled}
        currentUserRole={session.user.role}
        rejectedAccountingSyncs={rejectedAccountingSyncs}
        paidWithoutInvoice={paidWithoutInvoice}
        editForm={editForm}
        invoiceDeleteState={invoiceDeleteState}
        pegs={pegs}
      />
    </div>
  )
}

async function loadEditFormData(session: Awaited<ReturnType<typeof requireAuth>>) {
  const [{ products }, warehouses, taxRates, customers, avgCogs, users, organisation] = await Promise.all([
    listProducts({ pageSize: 1000, type: 'ALL', active: 'true' }),
    getWarehouses(),
    getTaxRates(),
    getCustomers(),
    getAvgCogsMap(),
    getUsers(),
    getOrganisation(),
  ])
  const stockable = products.filter(
    (p) => !['VARIABLE', 'NON_INVENTORY'].includes(p.type) && (p.lifecycleStatus === 'ACTIVE' || p.lifecycleStatus === 'EOL'),
  )
  const stockLevels = await getScopedStockLevelMap({
    productIds: stockable.map((product) => product.id),
    warehouseIds: warehouses.map((warehouse) => warehouse.id),
  })
  return {
    products: stockable,
    taxRates,
    customers,
    avgCogs,
    users,
    stockLevels,
    currentUserName: session.user.name ?? session.user.email ?? '',
    companyHomeCountry: organisation.country,
  }
}
