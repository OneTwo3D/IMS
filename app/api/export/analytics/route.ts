import { NextRequest, NextResponse } from 'next/server'
import { getProductSalesStats, getShipments, getDetails, getInvoiceStats, getRefundStats, getCustomerAging } from '@/app/actions/sales-stats'
import { getPurchaseProductStats, getReceivedGoods, getPurchaseBills, getSupplierAging, getPurchaseDetails } from '@/app/actions/purchase-stats'
import { getStockOnHand, getStockMovements, getStockAllocations, getReorderInventory } from '@/app/actions/inventory-stats'
import { generateForecasts } from '@/app/actions/forecasting'
import { toCsv, csvResponse } from '@/lib/csv'
import { requireApiAuth } from '@/lib/auth/server'
import { hasPermission } from '@/lib/permissions'
import { netLinearFigureBound } from '@/lib/domain/sales/refund-basis-analytics'
import {
  SUPPLIER_PAYMENT_AMOUNT_NOT_RECORDED,
  SUPPLIER_SETTLED_BILLED_BASIS,
  SUPPLIER_UNSETTLED_BILLED_BASIS,
} from '@/lib/domain/purchasing/supplier-payment-basis'

export async function GET(req: NextRequest) {
  const session = await requireApiAuth()
  if (session instanceof NextResponse) return session

  const type = req.nextUrl.searchParams.get('type') ?? 'products'
  if (!hasPermission(session.user.role, 'analytics')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const dateFrom = req.nextUrl.searchParams.get('from') ?? undefined
  const dateTo = req.nextUrl.searchParams.get('to') ?? undefined
  const date = new Date().toISOString().slice(0, 10)

  switch (type) {
    case 'products': {
      const { rows } = await getProductSalesStats(dateFrom, dateTo)
      // o3d-iigc round 4 (Codex finding 3): THE SAME RULE ROUND 3 APPLIED ONE FILE AWAY, APPLIED HERE.
      //
      // Round 3 renamed the supplier-aging column `netAmount` -> `netAmountExVat` for one stated
      // reason — A FILE READER HAS NO TOOLTIP — and then left the sales-side derived figures
      // exporting bare. Three of the four figures below are upper bounds whenever a refund could not
      // be placed on the net basis, and in the CSV that was invisible: one flag column named after
      // `netRevenue` alone spoke for all four, so `grossProfit`, `marginPct` and `avgOrderValue`
      // arrived in the spreadsheet indistinguishable from measurements.
      //
      // Each figure now carries its OWN bound column, immediately to its right, so a reader who
      // sorts, filters or charts one column sees that column's own verdict. `netRevenueIsUpperBound`
      // (yes/no) is REPLACED rather than kept: a two-valued column cannot express `indeterminate`,
      // and a `no` there would read as "exact" on precisely the figure whose relation we cannot
      // establish. `cogs`, `orderCount` and the quantity columns are basis-independent and get none.
      const linearBound = (r: { refundBasisComplete: boolean; refundsGrossBasis: number; refundsUnknownBasis: number }) =>
        netLinearFigureBound({ basisComplete: r.refundBasisComplete, unplacedCredit: r.refundsGrossBasis + r.refundsUnknownBasis })
      const data = rows.map((r) => ({
        sku: r.sku, name: r.name, type: r.type, stockUnit: r.stockUnit,
        barcode: r.barcode, mpn: r.mpn, lifecycleStatus: r.lifecycleStatus,
        qtySold: r.qtySold, qtyRefunded: r.qtyRefunded, netQty: r.netQty,
        grossRevenue: r.grossRevenue.toFixed(2), discounts: r.discounts.toFixed(2),
        // How loose every bound below is: at most these two columns added together.
        refunds: r.refunds.toFixed(2),
        refundsGrossBasis: r.refundsGrossBasis.toFixed(2),
        refundsUnknownBasis: r.refundsUnknownBasis.toFixed(2),
        netRevenue: r.netRevenue.toFixed(2), netRevenueBound: linearBound(r),
        cogs: r.cogs.toFixed(2),
        grossProfit: r.grossProfit.toFixed(2), grossProfitBound: linearBound(r),
        // NOT linearBound: margin is a ratio whose numerator and denominator both move with the
        // unsubtracted credit, so it can be `indeterminate` on a row whose other three are `upper`.
        marginPct: r.marginPct, marginPctBound: r.marginPctBound,
        orderCount: r.orderCount,
        avgOrderValue: r.avgOrderValue.toFixed(2), avgOrderValueBound: linearBound(r),
        salesPrice: r.salesPrice?.toFixed(2) ?? '', weight: r.weight ?? '',
      }))
      const headers = ['sku', 'name', 'type', 'stockUnit', 'barcode', 'mpn', 'lifecycleStatus', 'qtySold', 'qtyRefunded', 'netQty', 'grossRevenue', 'discounts', 'refunds', 'refundsGrossBasis', 'refundsUnknownBasis', 'netRevenue', 'netRevenueBound', 'cogs', 'grossProfit', 'grossProfitBound', 'marginPct', 'marginPctBound', 'orderCount', 'avgOrderValue', 'avgOrderValueBound', 'salesPrice', 'weight']
      return csvResponse(toCsv(data, headers), `sales-stats-products-${date}.csv`)
    }

    case 'shipments': {
      const rows = await getShipments(dateFrom, dateTo)
      const data = rows.map((r) => ({
        productName: r.productName, orderNumber: r.orderNumber, trackingNumber: r.trackingNumber,
        sku: r.sku, barcode: r.barcode, mpn: r.mpn, customerName: r.customerName, salesRep: r.salesRep,
        qty: r.qty, shippingService: r.shippingService, shippedAt: r.shippedAt.slice(0, 10),
        warehouse: r.warehouse, totalBase: r.totalBase.toFixed(2),
      }))
      return csvResponse(toCsv(data, ['productName', 'orderNumber', 'trackingNumber', 'sku', 'barcode', 'mpn', 'customerName', 'salesRep', 'qty', 'shippingService', 'shippedAt', 'warehouse', 'totalBase']), `shipments-${date}.csv`)
    }

    case 'details': {
      const rows = await getDetails(dateFrom, dateTo)
      const data = rows.map((r) => ({
        productName: r.productName, sku: r.sku, barcode: r.barcode, mpn: r.mpn,
        customerName: r.customerName, salesRep: r.salesRep, status: r.status,
        qty: r.qty, totalBase: r.totalBase.toFixed(2), createdAt: r.createdAt.slice(0, 10),
      }))
      return csvResponse(toCsv(data, ['productName', 'sku', 'barcode', 'mpn', 'customerName', 'salesRep', 'status', 'qty', 'totalBase', 'createdAt']), `sales-details-${date}.csv`)
    }

    case 'invoices': {
      const rows = await getInvoiceStats(dateFrom, dateTo)
      const data = rows.map((r) => ({
        productName: r.productName, orderNumber: r.orderNumber, invoiceNumber: r.invoiceNumber,
        invoicedAt: r.invoicedAt.slice(0, 10), sku: r.sku, customerName: r.customerName,
        salesRep: r.salesRep, status: r.paidAt ? 'Paid' : 'Unpaid', qty: r.qty,
        totalBase: r.totalBase.toFixed(2), balance: r.balance.toFixed(2),
      }))
      return csvResponse(toCsv(data, ['productName', 'orderNumber', 'invoiceNumber', 'invoicedAt', 'sku', 'customerName', 'salesRep', 'status', 'qty', 'totalBase', 'balance']), `invoices-${date}.csv`)
    }

    case 'refunds': {
      const rows = await getRefundStats(dateFrom, dateTo)
      const data = rows.map((r) => ({
        productName: r.productName, orderNumber: r.orderNumber, creditNoteNumber: r.creditNoteNumber,
        refundedAt: r.refundedAt.slice(0, 10), salesRep: r.salesRep, qty: r.qty,
        // o3d-iigc: an unestablishable proportion exports EMPTY, not 0 — a 0 in a spreadsheet
        // column averages and charts as a real zero.
        //
        // o3d-lvk: and the basis travels with it, because that blank has to be READABLE. In the UI
        // the cause is a tooltip; a spreadsheet has none, so without this column a reader sees a gap
        // and no reason for it. Same argument as round 3's `netAmount` -> `netAmountExVat` rename.
        totalBase: r.totalBase.toFixed(2), totalsBasis: r.totalsBasis,
        pctOfSale: r.pctOfSale ?? '', reason: r.reason,
      }))
      return csvResponse(toCsv(data, ['productName', 'orderNumber', 'creditNoteNumber', 'refundedAt', 'salesRep', 'qty', 'totalBase', 'totalsBasis', 'pctOfSale', 'reason']), `refunds-${date}.csv`)
    }

    case 'aging': {
      const rows = await getCustomerAging()
      const data = rows.map((r) => ({
        orderNumber: r.orderNumber, customerName: r.customerName, salesRep: r.salesRep,
        warehouse: r.warehouse, createdAt: r.createdAt.slice(0, 10),
        salesTotal: r.salesTotal.toFixed(2), refundsTotal: r.refundsTotal.toFixed(2),
        // o3d-iigc: withheld when the order's credits are not all on one proven basis. Empty, not
        // 0, and the basis of the figure is exported beside it so the column is readable at all.
        // (o3d-lvk called this column `refundsBasis`; it is the same fact, and `netTotalBasis` is
        // the better name because it says which figure the basis qualifies.)
        netTotal: r.netTotal?.toFixed(2) ?? '', netTotalBasis: r.netTotalBasis,
        dueAmount: r.dueAmount.toFixed(2), avgDso: r.avgDso,
        overdue0_30: r.overdue0_30.toFixed(2), overdue31_60: r.overdue31_60.toFixed(2),
        overdue61_90: r.overdue61_90.toFixed(2), overdue91plus: r.overdue91plus.toFixed(2),
      }))
      return csvResponse(toCsv(data, ['orderNumber', 'customerName', 'salesRep', 'warehouse', 'createdAt', 'salesTotal', 'refundsTotal', 'netTotal', 'netTotalBasis', 'dueAmount', 'avgDso', 'overdue0_30', 'overdue31_60', 'overdue61_90', 'overdue91plus']), `customer-aging-${date}.csv`)
    }

    case 'forecast': {
      const rows = await generateForecasts()
      const data = rows.map((r) => ({
        sku: r.sku, name: r.name, stockUnit: r.stockUnit, abcClass: r.abcClass,
        urgency: r.urgency, currentStock: r.currentStock, availableStock: r.availableStock,
        avgDailyDemand: r.avgDailyDemand, demandTrend: r.demandTrend,
        supplierId: r.supplierId, supplierName: r.supplierName, avgLeadTimeDays: r.avgLeadTimeDays,
        reorderPoint: r.reorderPoint, safetyStock: r.safetyStock,
        recommendedOrderQty: r.recommendedOrderQty, daysUntilStockout: r.daysUntilStockout,
      }))
      return csvResponse(toCsv(data, ['sku', 'name', 'stockUnit', 'abcClass', 'urgency', 'currentStock', 'availableStock', 'avgDailyDemand', 'demandTrend', 'supplierId', 'supplierName', 'avgLeadTimeDays', 'reorderPoint', 'safetyStock', 'recommendedOrderQty', 'daysUntilStockout']), `reorder-forecast-${date}.csv`)
    }

    case 'po_products': {
      const rows = await getPurchaseProductStats(dateFrom, dateTo)
      const data = rows.map((r) => ({ sku: r.sku, name: r.name, type: r.type, stockUnit: r.stockUnit, barcode: r.barcode, mpn: r.mpn, qtyOrdered: r.qtyOrdered, qtyReceived: r.qtyReceived, qtyReturned: r.qtyReturned, netQty: r.netQty, totalBase: r.totalBase.toFixed(2), landedCostBase: r.landedCostBase.toFixed(2), avgUnitCostBase: r.avgUnitCostBase.toFixed(4), supplierCount: r.supplierCount, poCount: r.poCount }))
      return csvResponse(toCsv(data, ['sku', 'name', 'type', 'stockUnit', 'barcode', 'mpn', 'qtyOrdered', 'qtyReceived', 'qtyReturned', 'netQty', 'totalBase', 'landedCostBase', 'avgUnitCostBase', 'supplierCount', 'poCount']), `purchase-stats-products-${date}.csv`)
    }
    case 'po_received': {
      const rows = await getReceivedGoods(dateFrom, dateTo)
      const data = rows.map((r) => ({ sku: r.sku, productName: r.productName, poReference: r.poReference, supplierName: r.supplierName, grnReference: r.grnReference, warehouseCode: r.warehouseCode, qtyReceived: r.qtyReceived, unitCostBase: r.unitCostBase.toFixed(2), totalBase: r.totalBase.toFixed(2), landedUnitCostBase: r.landedUnitCostBase.toFixed(2), status: r.status, receivedAt: r.receivedAt.slice(0, 10) }))
      return csvResponse(toCsv(data, ['sku', 'productName', 'poReference', 'supplierName', 'grnReference', 'warehouseCode', 'qtyReceived', 'unitCostBase', 'totalBase', 'landedUnitCostBase', 'status', 'receivedAt']), `received-goods-${date}.csv`)
    }
    case 'po_bills': {
      const rows = await getPurchaseBills(dateFrom, dateTo)
      const data = rows.map((r) => ({ poReference: r.poReference, supplierName: r.supplierName, invoiceNumber: r.invoiceNumber, sku: r.sku, productName: r.productName, qtyBilled: r.qtyBilled, invoiceDate: r.invoiceDate.slice(0, 10), totalForeign: r.totalForeign.toFixed(2), totalBase: r.totalBase.toFixed(2), status: r.status }))
      return csvResponse(toCsv(data, ['poReference', 'supplierName', 'invoiceNumber', 'sku', 'productName', 'qtyBilled', 'invoiceDate', 'totalForeign', 'totalBase', 'status']), `purchase-bills-${date}.csv`)
    }
    case 'po_aging': {
      const rows = await getSupplierAging()
      // o3d-8u4h: THE WITHHELD FIGURE REACHES THE FILE AS AN EMPTY CELL, NOT AS A ZERO.
      //
      // `dueAmount` used to export the whole billed ledger, forever, because nothing had ever
      // looked at a settlement. It is withheld now — due is billed less paid, and no amount paid to
      // a supplier is recorded anywhere — and `?? ''` is the same treatment the customer-aging
      // export already gives its withheld `netTotal`: empty, so a spreadsheet does not sum it, and
      // so nobody mistakes it for a measured nought.
      //
      // The two columns that replace it are amounts BILLED, split on whether a settlement was ever
      // recorded, and `settledBilledAmount + unsettledBilledAmount === billedAmount` in the file.
      // The four age bands are the unsettled billed value; a settled bill no longer ages forever,
      // and they are no longer called `overdue`, because a file reader has no tooltip either and
      // "overdue" claims a relation to a due date this report does not measure.
      const data = rows.map((r) => ({ supplierName: r.supplierName, grossAmount: r.grossAmount.toFixed(2),
        // o3d-iigc round 4: `refunds` is the credit ON THE NET AMOUNT'S OWN BASIS — ex-VAT line cost
        // reduced by the order's header discount — so grossAmount - tax - refunds still reproduces
        // netAmountExVat in the spreadsheet.
        refunds: r.refunds.toFixed(2),
        // o3d-iigc round 2: the basis travels with the figure — a CSV reader has no tooltip.
        netAmountExVat: r.netAmount.toFixed(2), landedCosts: r.landedCosts.toFixed(2), tax: r.tax.toFixed(2), totalAmount: r.totalAmount.toFixed(2),
        billedAmount: r.billedAmount.toFixed(2),
        settledBilledAmount: r.settledBilledAmount.toFixed(2), unsettledBilledAmount: r.unsettledBilledAmount.toFixed(2),
        dueAmount: r.dueAmount?.toFixed(2) ?? '',
        unsettledBilled0_30: r.unsettledBilled0_30.toFixed(2), unsettledBilled31_60: r.unsettledBilled31_60.toFixed(2),
        unsettledBilled61_90: r.unsettledBilled61_90.toFixed(2), unsettledBilled91plus: r.unsettledBilled91plus.toFixed(2),
        poCount: r.poCount, avgLeadTimeDays: r.avgLeadTimeDays }))
      return csvResponse(
        toCsv(data, ['supplierName', 'grossAmount', 'refunds', 'netAmountExVat', 'landedCosts', 'tax', 'totalAmount', 'billedAmount', 'settledBilledAmount', 'unsettledBilledAmount', 'dueAmount', 'unsettledBilled0_30', 'unsettledBilled31_60', 'unsettledBilled61_90', 'unsettledBilled91plus', 'poCount', 'avgLeadTimeDays']),
        `supplier-aging-${date}.csv`,
        // Report-level, because the reason is the same on every row: the export metadata rides both
        // the X-IMS-Export-Metadata header and `#` comment rows at the foot of the file, so an empty
        // cell in a downloaded spreadsheet still comes with the sentence explaining it.
        {
          dueAmount: SUPPLIER_PAYMENT_AMOUNT_NOT_RECORDED,
          settledBilledAmount: SUPPLIER_SETTLED_BILLED_BASIS,
          unsettledBilledAmount: SUPPLIER_UNSETTLED_BILLED_BASIS,
        },
      )
    }
    case 'po_details': {
      const rows = await getPurchaseDetails(dateFrom, dateTo)
      const data = rows.map((r) => ({ reference: r.reference, sku: r.sku, productName: r.productName, barcode: r.barcode, mpn: r.mpn, type: r.type, status: r.status, supplierName: r.supplierName, currency: r.currency, qty: r.qty, totalForeign: r.totalForeign.toFixed(2), totalBase: r.totalBase.toFixed(2), createdAt: r.createdAt.slice(0, 10) }))
      return csvResponse(toCsv(data, ['reference', 'sku', 'productName', 'barcode', 'mpn', 'type', 'status', 'supplierName', 'currency', 'qty', 'totalForeign', 'totalBase', 'createdAt']), `purchase-details-${date}.csv`)
    }

    case 'inv_onhand': {
      const rows = await getStockOnHand()
      const data = rows.map((r) => ({ sku: r.sku, name: r.name, type: r.type, stockUnit: r.stockUnit, barcode: r.barcode, mpn: r.mpn, warehouse: r.warehouseCode, quantity: r.quantity, reserved: r.reservedQty, available: r.available, value: r.inventoryValue.toFixed(2) }))
      return csvResponse(toCsv(data, ['sku', 'name', 'type', 'stockUnit', 'barcode', 'mpn', 'warehouse', 'quantity', 'reserved', 'available', 'value']), `stock-on-hand-${date}.csv`)
    }
    case 'inv_movements': {
      const rows = await getStockMovements(dateFrom, dateTo)
      const data = rows.map((r) => ({
        type: r.type,
        sku: r.sku,
        productName: r.productName,
        from: r.fromWarehouse,
        to: r.toWarehouse,
        qty: r.qty,
        note: r.note,
        date: r.createdAt.slice(0, 10),
        unitCostBase: r.unitCostBase == null ? '' : r.unitCostBase.toFixed(6),
        totalValueBase: r.totalValueBase == null ? '' : r.totalValueBase.toFixed(6),
      }))
      return csvResponse(toCsv(data, ['type', 'sku', 'productName', 'from', 'to', 'qty', 'note', 'date', 'unitCostBase', 'totalValueBase']), `stock-movements-${date}.csv`)
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
