import { NextRequest } from 'next/server'
import { getProductSalesStats, getShipments, getInvoiceStats, getRefundStats, getCustomerAging } from '@/app/actions/sales-stats'
import { getPurchaseProductStats, getReceivedGoods, getPurchaseBills, getSupplierAging, getPurchaseDetails } from '@/app/actions/purchase-stats'
import { getStockOnHand, getStockMovements, getStockAllocations, getReorderInventory } from '@/app/actions/inventory-stats'
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

    case 'po_products': {
      const rows = await getPurchaseProductStats(dateFrom, dateTo)
      const data = rows.map((r) => ({ sku: r.sku, name: r.name, type: r.type, stockUnit: r.stockUnit, qtyOrdered: r.qtyOrdered, qtyReceived: r.qtyReceived, qtyReturned: r.qtyReturned, netQty: r.netQty, totalGbp: r.totalGbp.toFixed(2), landedCostGbp: r.landedCostGbp.toFixed(2), avgUnitCostGbp: r.avgUnitCostGbp.toFixed(4), supplierCount: r.supplierCount, poCount: r.poCount }))
      return csvResponse(toCsv(data, ['sku', 'name', 'type', 'stockUnit', 'qtyOrdered', 'qtyReceived', 'qtyReturned', 'netQty', 'totalGbp', 'landedCostGbp', 'avgUnitCostGbp', 'supplierCount', 'poCount']), `purchase-stats-products-${date}.csv`)
    }
    case 'po_received': {
      const rows = await getReceivedGoods(dateFrom, dateTo)
      const data = rows.map((r) => ({ sku: r.sku, productName: r.productName, poReference: r.poReference, supplierName: r.supplierName, grnReference: r.grnReference, warehouseCode: r.warehouseCode, qtyReceived: r.qtyReceived, unitCostGbp: r.unitCostGbp.toFixed(2), totalGbp: r.totalGbp.toFixed(2), landedUnitCostGbp: r.landedUnitCostGbp.toFixed(2), status: r.status, receivedAt: r.receivedAt.slice(0, 10) }))
      return csvResponse(toCsv(data, ['sku', 'productName', 'poReference', 'supplierName', 'grnReference', 'warehouseCode', 'qtyReceived', 'unitCostGbp', 'totalGbp', 'landedUnitCostGbp', 'status', 'receivedAt']), `received-goods-${date}.csv`)
    }
    case 'po_bills': {
      const rows = await getPurchaseBills(dateFrom, dateTo)
      const data = rows.map((r) => ({ poReference: r.poReference, supplierName: r.supplierName, invoiceNumber: r.invoiceNumber, sku: r.sku, productName: r.productName, qtyBilled: r.qtyBilled, invoiceDate: r.invoiceDate.slice(0, 10), totalForeign: r.totalForeign.toFixed(2), totalGbp: r.totalGbp.toFixed(2), status: r.status }))
      return csvResponse(toCsv(data, ['poReference', 'supplierName', 'invoiceNumber', 'sku', 'productName', 'qtyBilled', 'invoiceDate', 'totalForeign', 'totalGbp', 'status']), `purchase-bills-${date}.csv`)
    }
    case 'po_aging': {
      const rows = await getSupplierAging()
      const data = rows.map((r) => ({ supplierName: r.supplierName, grossAmount: r.grossAmount.toFixed(2), refunds: r.refunds.toFixed(2), netAmount: r.netAmount.toFixed(2), landedCosts: r.landedCosts.toFixed(2), tax: r.tax.toFixed(2), totalAmount: r.totalAmount.toFixed(2), billedAmount: r.billedAmount.toFixed(2), dueAmount: r.dueAmount.toFixed(2), overdue0_30: r.overdue0_30.toFixed(2), overdue31_60: r.overdue31_60.toFixed(2), overdue61_90: r.overdue61_90.toFixed(2), overdue91plus: r.overdue91plus.toFixed(2), poCount: r.poCount, avgLeadTimeDays: r.avgLeadTimeDays }))
      return csvResponse(toCsv(data, ['supplierName', 'grossAmount', 'refunds', 'netAmount', 'landedCosts', 'tax', 'totalAmount', 'billedAmount', 'dueAmount', 'overdue0_30', 'overdue31_60', 'overdue61_90', 'overdue91plus', 'poCount', 'avgLeadTimeDays']), `supplier-aging-${date}.csv`)
    }
    case 'po_details': {
      const rows = await getPurchaseDetails(dateFrom, dateTo)
      const data = rows.map((r) => ({ reference: r.reference, sku: r.sku, productName: r.productName, barcode: r.barcode, type: r.type, status: r.status, supplierName: r.supplierName, currency: r.currency, qty: r.qty, totalForeign: r.totalForeign.toFixed(2), totalGbp: r.totalGbp.toFixed(2), createdAt: r.createdAt.slice(0, 10) }))
      return csvResponse(toCsv(data, ['reference', 'sku', 'productName', 'barcode', 'type', 'status', 'supplierName', 'currency', 'qty', 'totalForeign', 'totalGbp', 'createdAt']), `purchase-details-${date}.csv`)
    }

    case 'inv_onhand': {
      const rows = await getStockOnHand()
      const data = rows.map((r) => ({ sku: r.sku, name: r.name, type: r.type, stockUnit: r.stockUnit, barcode: r.barcode, warehouse: r.warehouseCode, quantity: r.quantity, reserved: r.reservedQty, available: r.available, value: r.inventoryValue.toFixed(2) }))
      return csvResponse(toCsv(data, ['sku', 'name', 'type', 'stockUnit', 'barcode', 'warehouse', 'quantity', 'reserved', 'available', 'value']), `stock-on-hand-${date}.csv`)
    }
    case 'inv_movements': {
      const rows = await getStockMovements(dateFrom, dateTo)
      const data = rows.map((r) => ({ type: r.type, sku: r.sku, productName: r.productName, from: r.fromWarehouse, to: r.toWarehouse, qty: r.qty, note: r.note, date: r.createdAt.slice(0, 10) }))
      return csvResponse(toCsv(data, ['type', 'sku', 'productName', 'from', 'to', 'qty', 'note', 'date']), `stock-movements-${date}.csv`)
    }
    case 'inv_allocations': {
      const rows = await getStockAllocations()
      const data = rows.map((r) => ({ sku: r.sku, productName: r.productName, warehouse: r.warehouseCode, totalStock: r.totalStock, reserved: r.reservedQty, available: r.available, pendingOrders: r.pendingOrders }))
      return csvResponse(toCsv(data, ['sku', 'productName', 'warehouse', 'totalStock', 'reserved', 'available', 'pendingOrders']), `stock-allocations-${date}.csv`)
    }
    case 'inv_reorder': {
      const rows = await getReorderInventory()
      const data = rows.map((r) => ({ sku: r.sku, name: r.name, stockUnit: r.stockUnit, currentStock: r.currentStock, available: r.availableStock, reorderPoint: r.reorderPoint, shortfall: r.shortfall, supplier: r.supplierName, dailyDemand: r.avgDailyDemand, daysToStockout: r.daysUntilStockout }))
      return csvResponse(toCsv(data, ['sku', 'name', 'stockUnit', 'currentStock', 'available', 'reorderPoint', 'shortfall', 'supplier', 'dailyDemand', 'daysToStockout']), `reorder-inventory-${date}.csv`)
    }

    default:
      return new Response('Unknown type', { status: 400 })
  }
}
