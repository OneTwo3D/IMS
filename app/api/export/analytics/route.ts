import { NextRequest } from 'next/server'
import { getProductSalesStats, getShipments, getInvoiceStats, getRefundStats, getCustomerAging } from '@/app/actions/sales-stats'
import { generateForecasts } from '@/app/actions/forecasting'
import { toCsv, csvResponse } from '@/lib/csv'

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') ?? 'products'
  const dateFrom = req.nextUrl.searchParams.get('from') ?? undefined
  const dateTo = req.nextUrl.searchParams.get('to') ?? undefined
  const date = new Date().toISOString().slice(0, 10)

  switch (type) {
    case 'products': {
      const { rows } = await getProductSalesStats(dateFrom, dateTo)
      const data = rows.map((r) => ({
        sku: r.sku, name: r.name, type: r.type, stockUnit: r.stockUnit,
        barcode: r.barcode, active: r.active ? 'TRUE' : 'FALSE',
        qtySold: r.qtySold, qtyRefunded: r.qtyRefunded, netQty: r.netQty,
        grossRevenue: r.grossRevenue.toFixed(2), discounts: r.discounts.toFixed(2),
        refunds: r.refunds.toFixed(2), netRevenue: r.netRevenue.toFixed(2),
        cogs: r.cogs.toFixed(2), grossProfit: r.grossProfit.toFixed(2),
        marginPct: r.marginPct, orderCount: r.orderCount,
        avgOrderValue: r.avgOrderValue.toFixed(2),
        salesPrice: r.salesPrice?.toFixed(2) ?? '', weight: r.weight ?? '',
      }))
      const headers = ['sku', 'name', 'type', 'stockUnit', 'barcode', 'active', 'qtySold', 'qtyRefunded', 'netQty', 'grossRevenue', 'discounts', 'refunds', 'netRevenue', 'cogs', 'grossProfit', 'marginPct', 'orderCount', 'avgOrderValue', 'salesPrice', 'weight']
      return csvResponse(toCsv(data, headers), `sales-stats-products-${date}.csv`)
    }

    case 'shipments': {
      const rows = await getShipments(dateFrom, dateTo)
      const data = rows.map((r) => ({
        orderNumber: r.orderNumber, customerName: r.customerName,
        shippedAt: r.shippedAt.slice(0, 10), shippingService: r.shippingService,
        trackingNumber: r.trackingNumber, warehouse: r.warehouse,
        lineCount: r.lineCount, totalGbp: r.totalGbp.toFixed(2),
      }))
      return csvResponse(toCsv(data, ['orderNumber', 'customerName', 'shippedAt', 'shippingService', 'trackingNumber', 'warehouse', 'lineCount', 'totalGbp']), `shipments-${date}.csv`)
    }

    case 'invoices': {
      const rows = await getInvoiceStats(dateFrom, dateTo)
      const data = rows.map((r) => ({
        invoiceNumber: r.invoiceNumber, orderNumber: r.orderNumber,
        customerName: r.customerName, invoicedAt: r.invoicedAt.slice(0, 10),
        totalGbp: r.totalGbp.toFixed(2), paidAt: r.paidAt?.slice(0, 10) ?? '',
        balance: r.balance.toFixed(2),
      }))
      return csvResponse(toCsv(data, ['invoiceNumber', 'orderNumber', 'customerName', 'invoicedAt', 'totalGbp', 'paidAt', 'balance']), `invoices-${date}.csv`)
    }

    case 'refunds': {
      const rows = await getRefundStats(dateFrom, dateTo)
      const data = rows.map((r) => ({
        creditNoteNumber: r.creditNoteNumber, orderNumber: r.orderNumber,
        customerName: r.customerName, refundedAt: r.refundedAt.slice(0, 10),
        reason: r.reason, totalGbp: r.totalGbp.toFixed(2),
      }))
      return csvResponse(toCsv(data, ['creditNoteNumber', 'orderNumber', 'customerName', 'refundedAt', 'reason', 'totalGbp']), `refunds-${date}.csv`)
    }

    case 'aging': {
      const rows = await getCustomerAging()
      const data = rows.map((r) => ({
        customerName: r.customerName, totalInvoiced: r.totalInvoiced.toFixed(2),
        totalPaid: r.totalPaid.toFixed(2), outstanding: r.outstanding.toFixed(2),
        overdueAmount: r.overdueAmount.toFixed(2), oldestUnpaidDays: r.oldestUnpaidDays,
      }))
      return csvResponse(toCsv(data, ['customerName', 'totalInvoiced', 'totalPaid', 'outstanding', 'overdueAmount', 'oldestUnpaidDays']), `customer-aging-${date}.csv`)
    }

    case 'forecast': {
      const rows = await generateForecasts()
      const data = rows.map((r) => ({
        sku: r.sku, name: r.name, stockUnit: r.stockUnit, abcClass: r.abcClass,
        urgency: r.urgency, currentStock: r.currentStock, availableStock: r.availableStock,
        avgDailyDemand: r.avgDailyDemand, demandTrend: r.demandTrend,
        supplierName: r.supplierName, avgLeadTimeDays: r.avgLeadTimeDays,
        reorderPoint: r.reorderPoint, safetyStock: r.safetyStock,
        recommendedOrderQty: r.recommendedOrderQty, daysUntilStockout: r.daysUntilStockout,
      }))
      return csvResponse(toCsv(data, ['sku', 'name', 'stockUnit', 'abcClass', 'urgency', 'currentStock', 'availableStock', 'avgDailyDemand', 'demandTrend', 'supplierName', 'avgLeadTimeDays', 'reorderPoint', 'safetyStock', 'recommendedOrderQty', 'daysUntilStockout']), `reorder-forecast-${date}.csv`)
    }

    default:
      return new Response('Unknown type', { status: 400 })
  }
}
