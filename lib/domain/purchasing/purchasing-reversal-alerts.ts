import { Prisma } from '@/app/generated/prisma/client'
import {
  addMoney,
  multiplyMoney,
  roundQuantity,
  subtractMoney,
  toDecimal,
  type DecimalInput,
} from '@/lib/domain/math/decimal'

// ---------------------------------------------------------------------------
// Purchase-order returns vs. supplier bills (audit-C4)
//
// returnPurchaseOrder reverses stock and FIFO cost layers but never touches the
// supplier invoices already recorded against the PO. Returning goods that have
// been billed therefore leaves the AP liability standing at the full amount with
// no system prompt. This computes, for a PO, how much each line has been billed
// against the quantity actually kept (received − returned) so the UI and the
// activity log can flag the over-billed bills and amount. Phase 1 is alert-only;
// it does not create a credit memo.
// ---------------------------------------------------------------------------

export type PurchaseOrderOverBillingLine = {
  poLineId: string
  productId: string
  sku: string | null
  billedQty: string
  netReceivedQty: string
  overBilledQty: string
  /** overBilledQty × the line's average billed unit cost, in base currency. */
  overBilledValueBase: string
}

export type PurchaseOrderOverBillingBill = {
  invoiceId: string
  invoiceNumber: string | null
  totalBase: string
}

export type PurchaseOrderOverBillingSummary = {
  /** True when the PO has at least one recorded supplier invoice. */
  hasInvoices: boolean
  /** True when at least one line is billed beyond the quantity now kept. */
  hasOverBilling: boolean
  totalOverBilledQty: string
  totalOverBilledValueBase: string
  lines: PurchaseOrderOverBillingLine[]
  bills: PurchaseOrderOverBillingBill[]
}

type PoLineInput = {
  id: string
  productId: string
  sku?: string | null
  qtyReceived: DecimalInput
  qtyReturned: DecimalInput
}

type InvoiceInput = {
  id: string
  invoiceNumber: string | null
  totalBase: DecimalInput
  lines: Array<{
    poLineId: string | null
    qtyBilled: DecimalInput
    totalBase: DecimalInput
  }>
}

export function computePurchaseOrderOverBilling(input: {
  lines: PoLineInput[]
  invoices: InvoiceInput[]
}): PurchaseOrderOverBillingSummary {
  const hasInvoices = input.invoices.length > 0

  // Sum billed quantity and value per PO line across every invoice line, and
  // remember which invoices billed each line (so we can name only the bills that
  // actually contributed to an over-billed line, not every bill on the PO).
  const billedByLine = new Map<string, { qty: Prisma.Decimal; valueBase: Prisma.Decimal; invoiceIds: Set<string> }>()
  for (const invoice of input.invoices) {
    for (const line of invoice.lines) {
      if (!line.poLineId) continue
      const existing = billedByLine.get(line.poLineId) ?? { qty: toDecimal(0), valueBase: toDecimal(0), invoiceIds: new Set<string>() }
      existing.qty = addMoney(existing.qty, line.qtyBilled)
      existing.valueBase = addMoney(existing.valueBase, line.totalBase)
      existing.invoiceIds.add(invoice.id)
      billedByLine.set(line.poLineId, existing)
    }
  }

  let totalOverBilledQty = toDecimal(0)
  let totalOverBilledValueBase = toDecimal(0)
  const lines: PurchaseOrderOverBillingLine[] = []
  const contributingInvoiceIds = new Set<string>()

  for (const poLine of input.lines) {
    const billed = billedByLine.get(poLine.id)
    if (!billed || billed.qty.lte(0)) continue
    // Clamp to 0: a corrupt qtyReturned > qtyReceived must not inflate over-billing.
    const netReceived = Prisma.Decimal.max(subtractMoney(poLine.qtyReceived, poLine.qtyReturned), toDecimal(0))
    const overBilledQty = subtractMoney(billed.qty, netReceived)
    if (overBilledQty.lte(0)) continue

    // Average billed unit cost for the line; guards against a zero qty divide.
    const avgUnitCostBase = billed.qty.gt(0) ? billed.valueBase.div(billed.qty) : toDecimal(0)
    const overBilledValueBase = roundQuantity(multiplyMoney(overBilledQty, avgUnitCostBase), 2)

    totalOverBilledQty = addMoney(totalOverBilledQty, overBilledQty)
    totalOverBilledValueBase = addMoney(totalOverBilledValueBase, overBilledValueBase)
    for (const invoiceId of billed.invoiceIds) contributingInvoiceIds.add(invoiceId)
    lines.push({
      poLineId: poLine.id,
      productId: poLine.productId,
      sku: poLine.sku ?? null,
      billedQty: roundQuantity(billed.qty, 4).toString(),
      netReceivedQty: roundQuantity(netReceived, 4).toString(),
      overBilledQty: roundQuantity(overBilledQty, 4).toString(),
      overBilledValueBase: overBilledValueBase.toString(),
    })
  }

  return {
    hasInvoices,
    hasOverBilling: lines.length > 0,
    totalOverBilledQty: roundQuantity(totalOverBilledQty, 4).toString(),
    totalOverBilledValueBase: roundQuantity(totalOverBilledValueBase, 2).toString(),
    lines,
    // Only the bills that billed an over-billed line — totalBase is the gross
    // bill total (incl. tax/freight), shown for reference, not the over-billed value.
    bills: input.invoices
      .filter((invoice) => contributingInvoiceIds.has(invoice.id))
      .map((invoice) => ({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        totalBase: roundQuantity(toDecimal(invoice.totalBase), 2).toString(),
      })),
  }
}
