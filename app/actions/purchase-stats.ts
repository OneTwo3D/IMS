'use server'

import { db } from '@/lib/db'
import { requirePermission } from '@/lib/auth/server'
import { COMMITTED_PURCHASE_ORDER_WHERE, INCOMING_PO_STATUSES } from '@/lib/domain/inventory/po-status-sets'
import { headerDiscountedReturnCreditBase } from '@/lib/domain/purchasing/return-credit-basis'
import { billedPaymentMarkerSplit } from '@/lib/domain/purchasing/supplier-payment-basis'

// ---------------------------------------------------------------------------
// Product purchase stats (Products tab)
// ---------------------------------------------------------------------------

export type PurchaseProductRow = {
  productId: string
  sku: string
  name: string
  type: string
  stockUnit: string
  barcode: string | null
  mpn: string | null
  supplierName: string | null
  qtyOrdered: number
  qtyReceived: number
  qtyReturned: number
  netQty: number
  totalBase: number
  landedCostBase: number
  avgUnitCostBase: number
  incomingQty: number
  supplierCount: number
  poCount: number
  createdAt: string | null
}

export async function getPurchaseProductStats(dateFrom?: string, dateTo?: string): Promise<PurchaseProductRow[]> {
  await requirePermission('analytics')
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')
  const hasDate = Object.keys(dateFilter).length > 0

  // o3d-27l: only COMMITTED purchase history — a PO that was actually ordered (poSentAt stamped or a
  // status that proves an order), not the DRAFT/RFQ_SENT/QUOTE_RECEIVED quote pipeline (nor a quote
  // abandoned straight to CLOSED) and not CANCELLED. So Qty Ordered, spend (totalBase), average cost
  // and Incoming all share one committed population; Incoming is a clean subset, not a rescoped column.
  const pos = await db.purchaseOrder.findMany({
    where: {
      type: 'GOODS',
      ...COMMITTED_PURCHASE_ORDER_WHERE,
      ...(hasDate ? { createdAt: dateFilter } : {}),
    },
    select: {
      id: true, supplierId: true, createdAt: true, status: true,
      supplier: { select: { name: true } },
      lines: {
        select: {
          productId: true, qty: true, qtyReceived: true, qtyReturned: true,
          totalBase: true, landedUnitCostBase: true,
          product: { select: { sku: true, name: true, type: true, stockUnit: true, barcode: true, mpn: true } },
        },
      },
    },
  })
  const incomingStatuses = new Set<string>(INCOMING_PO_STATUSES)

  const map = new Map<string, PurchaseProductRow>()
  const suppliersByProduct = new Map<string, Set<string>>()
  const posByProduct = new Map<string, Set<string>>()

  for (const po of pos) {
    for (const l of po.lines) {
      const pid = l.productId
      if (!map.has(pid)) {
        map.set(pid, {
          productId: pid, sku: l.product.sku, name: l.product.name,
          type: l.product.type, stockUnit: l.product.stockUnit, barcode: l.product.barcode, mpn: l.product.mpn,
          supplierName: po.supplier.name,
          qtyOrdered: 0, qtyReceived: 0, qtyReturned: 0, netQty: 0,
          totalBase: 0, landedCostBase: 0, avgUnitCostBase: 0,
          incomingQty: 0, supplierCount: 0, poCount: 0, createdAt: null,
        })
        suppliersByProduct.set(pid, new Set())
        posByProduct.set(pid, new Set())
      }
      const row = map.get(pid)!
      row.qtyOrdered += Number(l.qty)
      row.qtyReceived += Number(l.qtyReceived)
      row.qtyReturned += Number(l.qtyReturned)
      // o3d-27l: Incoming is only the not-yet-received balance of a PO that is still INCOMING
      // (PO_SENT/SHIPPED/PARTIALLY_RECEIVED). A terminal PO — RECEIVED/CLOSED/RETURNED, e.g. one
      // closed after a short delivery — is committed history but NOT incoming, so it must not carry a
      // phantom balance here even though its ordered/received qty still counts above.
      if (incomingStatuses.has(po.status)) {
        row.incomingQty += Math.max(0, Number(l.qty) - Number(l.qtyReceived))
      }
      row.totalBase += Number(l.totalBase)
      const landed = Number(l.landedUnitCostBase)
      if (landed > 0) row.landedCostBase += landed * Number(l.qty)
      row.supplierName = po.supplier.name
      if (!row.createdAt || po.createdAt.toISOString() > row.createdAt) row.createdAt = po.createdAt.toISOString()
      suppliersByProduct.get(pid)!.add(po.supplierId)
      posByProduct.get(pid)!.add(po.id)
    }
  }

  const rows: PurchaseProductRow[] = []
  for (const row of map.values()) {
    row.netQty = row.qtyReceived - row.qtyReturned
    row.avgUnitCostBase = row.qtyOrdered > 0 ? Math.round((row.totalBase / row.qtyOrdered) * 10000) / 10000 : 0
    row.supplierCount = suppliersByProduct.get(row.productId)?.size ?? 0
    row.poCount = posByProduct.get(row.productId)?.size ?? 0
    row.totalBase = Math.round(row.totalBase * 100) / 100
    row.landedCostBase = Math.round(row.landedCostBase * 100) / 100
    rows.push(row)
  }
  rows.sort((a, b) => b.totalBase - a.totalBase)
  return rows
}

// ---------------------------------------------------------------------------
// Received goods (line-level)
// ---------------------------------------------------------------------------

export type ReceivedGoodsRow = {
  receiptLineId: string
  poReference: string
  poId: string
  supplierName: string
  grnReference: string | null
  sku: string
  productName: string
  productId: string
  receivedAt: string
  warehouseCode: string | null
  qtyReceived: number
  unitCostBase: number
  totalBase: number
  landedUnitCostBase: number
  status: string
}

export async function getReceivedGoods(dateFrom?: string, dateTo?: string): Promise<ReceivedGoodsRow[]> {
  await requirePermission('analytics')
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const receipts = await db.purchaseReceipt.findMany({
    where: Object.keys(dateFilter).length ? { receivedAt: dateFilter } : undefined,
    select: {
      id: true, reference: true, receivedAt: true,
      po: { select: { id: true, reference: true, status: true, supplier: { select: { name: true } } } },
      lines: {
        select: {
          id: true, qtyReceived: true, warehouseId: true,
          poLine: { select: { unitCostBase: true, landedUnitCostBase: true, product: { select: { id: true, sku: true, name: true } } } },
        },
      },
    },
    orderBy: { receivedAt: 'desc' },
  })

  const warehouses = await db.warehouse.findMany({ select: { id: true, code: true } })
  const whMap = new Map(warehouses.map((w) => [w.id, w.code]))

  const rows: ReceivedGoodsRow[] = []
  for (const r of receipts) {
    for (const l of r.lines) {
      const qty = Number(l.qtyReceived)
      const unitCost = Number(l.poLine.unitCostBase)
      rows.push({
        receiptLineId: l.id, poReference: r.po.reference, poId: r.po.id,
        supplierName: r.po.supplier.name, grnReference: r.reference,
        sku: l.poLine.product.sku, productName: l.poLine.product.name, productId: l.poLine.product.id,
        receivedAt: r.receivedAt.toISOString(),
        warehouseCode: l.warehouseId ? whMap.get(l.warehouseId) ?? null : null,
        qtyReceived: qty, unitCostBase: unitCost,
        totalBase: Math.round(qty * unitCost * 100) / 100,
        landedUnitCostBase: Number(l.poLine.landedUnitCostBase),
        status: r.po.status,
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Bills (line-level purchase invoices)
// ---------------------------------------------------------------------------

export type BillRow = {
  invoiceLineId: string
  poId: string
  poReference: string
  invoiceNumber: string | null
  supplierName: string
  sku: string
  productName: string
  productId: string
  invoiceDate: string
  qtyBilled: number
  totalForeign: number
  totalBase: number
  supplierInvoiceUrl: string | null
  status: string
}

export async function getPurchaseBills(dateFrom?: string, dateTo?: string): Promise<BillRow[]> {
  await requirePermission('analytics')
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const invoices = await db.purchaseInvoice.findMany({
    where: Object.keys(dateFilter).length ? { invoiceDate: dateFilter } : undefined,
    select: {
      id: true, invoiceNumber: true, invoiceDate: true, supplierInvoiceUrl: true,
      po: { select: { id: true, reference: true, status: true, supplier: { select: { name: true } } } },
      lines: {
        select: {
          id: true,
          qtyBilled: true,
          totalForeign: true,
          totalBase: true,
          description: true,
          poLine: { select: { product: { select: { id: true, sku: true, name: true } } } },
          costLine: { select: { description: true } },
        },
      },
    },
    orderBy: { invoiceDate: 'desc' },
  })

  const rows: BillRow[] = []
  for (const inv of invoices) {
    for (const l of inv.lines) {
      const isProduct = l.poLine != null
      rows.push({
        invoiceLineId: l.id, poId: inv.po.id, poReference: inv.po.reference,
        invoiceNumber: inv.invoiceNumber, supplierName: inv.po.supplier.name,
        sku: isProduct ? l.poLine!.product.sku : '—',
        productName: isProduct
          ? l.poLine!.product.name
          : l.description ?? l.costLine?.description ?? '—',
        productId: isProduct ? l.poLine!.product.id : '',
        invoiceDate: inv.invoiceDate.toISOString(),
        qtyBilled: Number(l.qtyBilled),
        totalForeign: Number(l.totalForeign), totalBase: Number(l.totalBase),
        supplierInvoiceUrl: inv.supplierInvoiceUrl, status: inv.po.status,
      })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Supplier aging (with aging buckets)
// ---------------------------------------------------------------------------

export type SupplierAgingRow = {
  supplierId: string
  supplierName: string
  /** VAT-INCLUSIVE committed spend: PurchaseOrder.totalBase, which is net goods + VAT + freight. */
  grossAmount: number
  /**
   * ALWAYS WITHHELD (o3d-8u4h). Was a hardcoded `0`. A discount TOTAL cannot be assembled: the
   * per-line part is already folded into the stored line totals and survives only in foreign
   * currency under the order's own tax convention, and the header part alone is a part, not a
   * total. See SUPPLIER_DISCOUNT_TOTAL_NOT_RECORDED.
   */
  discounts: number | null
  /** Returned value at the EX-VAT line cost — PurchaseOrderLine.unitCostBase is always net. */
  refunds: number
  /**
   * EX-VAT: `grossAmount` less its own stored VAT, less `refunds`. Both sides of that subtraction
   * are therefore on the net basis. See getSupplierAging for why this convention and not the other.
   */
  netAmount: number
  landedCosts: number
  tax: number
  totalAmount: number
  /** Sum of PurchaseInvoice.totalBase — VAT-INCLUSIVE, and every bill, marked or not. */
  billedAmount: number
  /**
   * o3d-8u4h. The two halves of `billedAmount`, grouped on THE RAW EVIDENCE: whether the bill
   * carries a payment marker (`PurchaseInvoice.paidAt`) or does not. Amounts BILLED, on the same
   * VAT-inclusive basis as `billedAmount`.
   *
   * Round 2 renamed these from `settledBilledAmount`/`unsettledBilledAmount`. "Settled" published a
   * settlement relation the marker does not prove: `markBillPaid` accepts a partial amount and
   * stamps `paidAt` anyway, so a part-paid bill was being reported as fully settled AND dropped out
   * of every age band. The marker is the only fact; these names claim only the marker.
   *
   * `billedAmount === billedWithPaymentMarker + billedWithoutPaymentMarker`, which the reader can
   * check across the row.
   */
  billedWithPaymentMarker: number
  billedWithoutPaymentMarker: number
  /**
   * ALWAYS WITHHELD (o3d-8u4h). Was a hardcoded `0`, which asserted that nothing had ever been
   * paid to this supplier. No amount paid to a supplier is recorded anywhere in the schema.
   * See SUPPLIER_PAYMENT_AMOUNT_NOT_RECORDED.
   */
  paidAmount: number | null
  /**
   * ALWAYS WITHHELD (o3d-8u4h). Was `billedAmount` — i.e. the whole bill, forever. Due is billed
   * less paid, and paid is not a recorded quantity; supplier credit notes reduce what is owed too.
   * `billedWithoutPaymentMarker` is the nearest thing that IS known, and says what it is.
   */
  dueAmount: number | null
  /**
   * o3d-8u4h: was `overdue0_30`/`31_60`/`61_90`/`91plus`. Same four age bands, cut from the INVOICE
   * date, but now over the bills carrying NO payment marker — a marked bill no longer ages forever
   * — and no longer called "overdue", because that is a relation to a DUE DATE which this report
   * does not measure. See SUPPLIER_BILLED_WITHOUT_PAYMENT_MARKER_BASIS.
   */
  billedWithoutPaymentMarker0_30: number
  billedWithoutPaymentMarker31_60: number
  billedWithoutPaymentMarker61_90: number
  billedWithoutPaymentMarker91plus: number
  poCount: number
  avgLeadTimeDays: number | null
}

export async function getSupplierAging(): Promise<SupplierAgingRow[]> {
  await requirePermission('analytics')
  const suppliers = await db.supplier.findMany({
    where: { active: true },
    select: {
      id: true, name: true,
      purchaseOrders: {
        // o3d-27l/o3d-1di: same committed population as the Products tab, so aging doesn't inflate
        // Gross/Tax/Total/PO Count with the quote pipeline (and doesn't surface quote-only suppliers).
        where: { type: 'GOODS', ...COMMITTED_PURCHASE_ORDER_WHERE },
        select: {
          totalBase: true, taxBase: true, directFreightBase: true, poSentAt: true, receivedAt: true,
          // o3d-iigc round 4: subtotalBase and the line totals were not fetched before, so the header
          // discount was not merely mishandled — it was NOT VISIBLE to this query at all.
          subtotalBase: true,
          lines: { select: { totalBase: true } },
          // o3d-8u4h: `paidAt` is the ONLY settlement fact the schema holds for a supplier bill.
          // Without it in the select, every bill aged forever and Due was the whole ledger.
          invoices: { select: { totalBase: true, invoiceDate: true, paidAt: true } },
          returns: { select: { lines: { select: { qtyReturned: true, poLine: { select: { unitCostBase: true } } } } } },
        },
      },
    },
  })

  const now = Date.now()
  return suppliers.map((s) => {
    let grossAmount = 0, tax = 0, landedCosts = 0, billedAmount = 0, refunds = 0
    let billedMarked = 0, billedUnmarked = 0
    let unmarked0_30 = 0, unmarked31_60 = 0, unmarked61_90 = 0, unmarked91plus = 0
    const leadTimes: number[] = []

    for (const po of s.purchaseOrders) {
      grossAmount += Number(po.totalBase)
      tax += Number(po.taxBase)
      landedCosts += Number(po.directFreightBase)
      refunds += headerDiscountedReturnCreditBase(po)
      const split = billedPaymentMarkerSplit(po.invoices)
      billedMarked += split.withMarker
      billedUnmarked += split.withoutMarker
      for (const inv of po.invoices) {
        const t = Number(inv.totalBase); billedAmount += t
        // o3d-8u4h: A BILL CARRYING A PAYMENT MARKER STOPS AGEING. It used to age forever, because
        // nothing in this loop had ever looked at `paidAt`, so a bill paid two years ago sat in the
        // 91+ column for good. The buckets are the billed value of the UNMARKED bills now, and are
        // named for that — not for a settlement the marker cannot prove.
        if (inv.paidAt != null) continue
        const d = Math.round((now - inv.invoiceDate.getTime()) / 86400000)
        if (d > 90) unmarked91plus += t; else if (d > 60) unmarked61_90 += t; else if (d > 30) unmarked31_60 += t; else unmarked0_30 += t
      }
      if (po.poSentAt && po.receivedAt) { const d = Math.round((po.receivedAt.getTime() - po.poSentAt.getTime()) / 86400000); if (d > 0 && d < 365) leadTimes.push(d) }
    }

    // o3d-iigc round 2 (Codex finding 2): NET AMOUNT IS EX-VAT, AND THE COLUMN NOW SAYS SO.
    //
    // `po.totalBase` is VAT-INCLUSIVE — createPurchaseOrder stores subtotalBase + taxBase +
    // directFreightBase — while a return is valued at `poLine.unitCostBase`, which is EX-VAT at
    // every writer of that column (createPurchaseOrder and updatePurchaseOrder both extract the
    // VAT into `netUnitForeign` before calcLineTotals; calcRequotedLineAmounts does the same for a
    // supplier requote; the FX rebase only re-divides the stored foreign value). Verified in the
    // tree rather than assumed, and PurchaseReturnLine stores no amount of its own, so this is the
    // only place the credit's value is formed.
    //
    // The old figure subtracted that ex-VAT credit straight from the VAT-inclusive total, which is
    // NEITHER convention: on a £1,000 net PO plus £200 VAT with a £100 net return it reported
    // £1,100, where consistent-gross is £1,080 and consistent-net is £900. It matched neither, so
    // it answered no question a reader could have asked.
    //
    // Unlike the sales side there is no basis ambiguity to refuse here — the credit is provably
    // NET — so a figure IS computable, and withholding it would be the opposite error. WHICH
    // convention follows this branch's existing rule for the customer-aging net total: put the
    // ORDER total on THE CREDIT'S basis and then subtract (orderTotalOnBasis + netOfRefunds in
    // lib/domain/sales/refund-basis-analytics). The credit is NET, so the PO total goes on the NET
    // basis: gross less its own stored VAT. That also requires NO CONVERSION — `taxBase` is stored
    // on the header and exact — whereas grossing the return up would mean re-deriving a rate per
    // return line, and each line of a PO may carry its own.
    //
    // It still includes direct freight, because `grossAmount` does and `landedCosts` reports that
    // same freight beside it; only the VAT basis was in question.
    //
    // o3d-iigc round 4 (Codex finding 4): AND THE HEADER-DISCOUNT LOOSENESS ROUND 3 FLAGGED IS NOW
    // FIXED, in headerDiscountedReturnCreditBase below — it was the same class of defect as the one
    // round 3 had just repaired (an order total on one basis, a credit on another), only the
    // mismatched axis was the DISCOUNT rather than the VAT, so leaving it produced a `netAmount`
    // that was again neither convention.
    //
    // o3d-8u4h: AND THREE OF THE FIGURES BELOW WERE NOT CALCULATIONS AT ALL.
    //
    // `paidAmount: 0`, `discounts: 0` and `dueAmount: billedAmount` were not calculations that came
    // out wrong. They were quantities THIS SYSTEM DOES NOT HOLD, published as measurements — and a
    // zero in a Paid column is the strongest claim available: "nothing has ever been paid to this
    // supplier". They are `null` now, which is o3d-iigc's rule applied unchanged: a figure that
    // cannot be stated publishes nothing, while the related total that IS known stays on the row.
    //
    // What is known is what was BILLED, so `billedAmount` is untouched and is now split on THE RAW
    // EVIDENCE — the bills carrying a payment marker and the bills carrying none. Round 2's
    // correction: calling those halves "settled" and "unsettled" published a settlement relation
    // `paidAt` does not prove, because `markBillPaid` stamps it on a part-payment too, so a
    // part-paid bill was reported as fully settled AND vanished from every age band. Both halves
    // are amounts billed, grouped by a marker, and are named for exactly that.
    // lib/domain/purchasing/supplier-payment-basis.ts carries the whole reasoning and the sentences
    // the page and the CSV show the reader.
    return {
      supplierId: s.id, supplierName: s.name,
      grossAmount: Math.round(grossAmount * 100) / 100, discounts: null,
      refunds: Math.round(refunds * 100) / 100, netAmount: Math.round((grossAmount - tax - refunds) * 100) / 100,
      landedCosts: Math.round(landedCosts * 100) / 100, tax: Math.round(tax * 100) / 100,
      totalAmount: Math.round(grossAmount * 100) / 100,
      billedAmount: Math.round(billedAmount * 100) / 100,
      billedWithPaymentMarker: Math.round(billedMarked * 100) / 100,
      billedWithoutPaymentMarker: Math.round(billedUnmarked * 100) / 100,
      paidAmount: null,
      dueAmount: null,
      billedWithoutPaymentMarker0_30: Math.round(unmarked0_30 * 100) / 100, billedWithoutPaymentMarker31_60: Math.round(unmarked31_60 * 100) / 100,
      billedWithoutPaymentMarker61_90: Math.round(unmarked61_90 * 100) / 100, billedWithoutPaymentMarker91plus: Math.round(unmarked91plus * 100) / 100,
      poCount: s.purchaseOrders.length,
      avgLeadTimeDays: leadTimes.length ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) : null,
    }
  }).filter((r) => r.poCount > 0).sort((a, b) => b.totalAmount - a.totalAmount)
}

// ---------------------------------------------------------------------------
// PO details (line-level)
// ---------------------------------------------------------------------------

export type PurchaseDetailRow = {
  poId: string
  reference: string
  lineProductId: string
  sku: string
  productName: string
  barcode: string | null
  mpn: string | null
  type: string
  status: string
  supplierName: string
  currency: string
  qty: number
  unitCostForeign: number
  totalForeign: number
  totalBase: number
  createdAt: string
}

export async function getPurchaseDetails(dateFrom?: string, dateTo?: string): Promise<PurchaseDetailRow[]> {
  await requirePermission('analytics')
  const dateFilter: Record<string, unknown> = {}
  if (dateFrom) dateFilter.gte = new Date(dateFrom)
  if (dateTo) dateFilter.lte = new Date(dateTo + 'T23:59:59')

  const pos = await db.purchaseOrder.findMany({
    where: { type: 'GOODS', ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}) },
    select: {
      id: true, reference: true, status: true, currency: true, createdAt: true,
      supplier: { select: { name: true } },
      lines: { select: { productId: true, qty: true, unitCostForeign: true, totalForeign: true, totalBase: true, product: { select: { sku: true, name: true, barcode: true, mpn: true, type: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const rows: PurchaseDetailRow[] = []
  for (const po of pos) {
    for (const l of po.lines) {
      rows.push({
        poId: po.id, reference: po.reference, lineProductId: l.productId,
        sku: l.product.sku, productName: l.product.name, barcode: l.product.barcode, mpn: l.product.mpn,
        type: l.product.type, status: po.status, supplierName: po.supplier.name,
        currency: po.currency, qty: Number(l.qty),
        unitCostForeign: Number(l.unitCostForeign), totalForeign: Number(l.totalForeign),
        totalBase: Number(l.totalBase), createdAt: po.createdAt.toISOString(),
      })
    }
  }
  return rows
}
