import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { getSalesOrder } from '@/app/actions/sales'
import { getWarehouses, getStockLevelMap } from '@/app/actions/stock'
import { getCurrencies } from '@/app/actions/currencies'
import { getSetting } from '@/app/actions/settings'
import { getOrderAllocations, getOrderShipments } from '@/app/actions/allocation'
import { getAccountingSettings } from '@/lib/accounting'
import { DEFAULT_CARRIERS } from '@/lib/tracking'
import { getSalesOrderAdminLinks } from '@/lib/shopping'
import { isIntegrationPluginEnabled } from '@/lib/integration-plugins'
import { SoDetailClient } from './so-detail-client'

export const metadata: Metadata = { title: 'Sales Order' }

type Props = { params: Promise<{ id: string }> }

export default async function SalesOrderDetailPage({ params }: Props) {
  const { id } = await params
  const [so, warehouses, currencies, externalOrderLinks, stockLevels, allocations, shipments, carriersJson, deliveryTrackingEnabled, invoiceUrlTemplate, accountingSettings, accountingAvailable] = await Promise.all([
    getSalesOrder(id),
    getWarehouses(),
    getCurrencies(true),
    getSalesOrderAdminLinks(id),
    getStockLevelMap(),
    getOrderAllocations(id),
    getOrderShipments(id),
    getSetting('shipping_carriers'),
    getSetting('delivery_tracking_enabled'),
    getSetting('accounting_invoice_url_template'),
    getAccountingSettings(),
    isIntegrationPluginEnabled('xero'),
  ])
  let carriers: string[] = DEFAULT_CARRIERS
  try { if (carriersJson) carriers = JSON.parse(carriersJson) } catch { /* empty */ }

  if (!so) notFound()

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
        stockLevels={stockLevels}
        initialAllocations={allocations}
        initialShipments={shipments}
        carriers={carriers}
        deliveryTrackingEnabled={deliveryTrackingEnabled === 'true'}
        accountingAvailable={accountingAvailable}
        accountingInvoiceUrlTemplate={invoiceUrlTemplate ?? accountingSettings.invoiceUrlTemplate}
        accountingSyncEnabled={accountingAvailable && accountingSettings.syncEnabled}
      />
    </div>
  )
}
