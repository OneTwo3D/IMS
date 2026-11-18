/**
 * Guards on CREATING a supplier bill against a purchase order (`createInvoice`).
 *
 * 1. STATUS. A bill is raised for goods the supplier has delivered (or, for a prepaid supplier, ordered) on an order that is
 *    live with the supplier. A DRAFT, RFQ_SENT or QUOTE_RECEIVED order has not been placed, and a CANCELLED one has been
 *    retired (its received stock reversed), so none of them can be billed. CLOSED IS BILLABLE ON PURPOSE: closing is the
 *    "close short" of an order, which keeps the goods that landed and their cost and only drops the unreceived balance; the
 *    supplier's invoice for those goods routinely arrives after the order is closed. The quantity caps still apply, so a
 *    closed order can be billed only for what was received and not yet billed (plus unbilled cost lines).
 * 2. DUPLICATE SUPPLIER INVOICE NUMBER. The usual AP control: the same supplier and the same supplier invoice number is
 *    refused unless the operator explicitly overrides it. Application-level only (no unique index), so existing data that
 *    already repeats a number cannot make a migration fail and a deliberate second bill under one number stays possible.
 */

/** Statuses a bill may be created against. */
export const BILLABLE_PO_STATUSES: readonly string[] = [
  'PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'INVOICED', 'PARTIALLY_RETURNED', 'RETURNED', 'CLOSED',
]

/** The refusal for a status that cannot be billed, or null when it can. */
export function purchaseOrderBillStatusRefusal(status: string, reference: string): string | null {
  if (BILLABLE_PO_STATUSES.includes(status)) return null
  return `Purchase order ${reference} is ${status}, so it cannot be billed. Only an order that has been placed with the supplier (and not cancelled) can have a supplier bill.`
}

export class PurchaseBillStatusRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PurchaseBillStatusRefusal'
  }
}

/** The supplier invoice number as compared: trimmed, or null when blank. Comparison is case-insensitive. */
export function normalizeSupplierInvoiceNumber(raw: string | null | undefined): string | null {
  const text = raw?.trim()
  return text ? text : null
}

export type DuplicateSupplierBill = { invoiceId: string; poReference: string }

export class DuplicateSupplierInvoiceNumberError extends Error {
  readonly duplicate: DuplicateSupplierBill
  constructor(invoiceNumber: string, duplicate: DuplicateSupplierBill) {
    super(`A bill with supplier invoice number "${invoiceNumber}" already exists for this supplier (on purchase order ${duplicate.poReference}). Check it is not a duplicate; to bill it again anyway, confirm the override.`)
    this.name = 'DuplicateSupplierInvoiceNumberError'
    this.duplicate = duplicate
  }
}

type DuplicateLookupTx = {
  $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>
  purchaseInvoice: {
    findFirst(args: {
      where: { invoiceNumber: { equals: string; mode: 'insensitive' }; po: { supplierId: string } }
      select: { id: true; po: { select: { reference: true } } }
    }): Promise<{ id: string; po: { reference: string } } | null>
  }
}

/**
 * Throws DuplicateSupplierInvoiceNumberError when the supplier already has a bill under this number. Serialised per
 * supplier+number with a transaction advisory lock, so two tabs or two users entering the same paper invoice cannot both
 * pass the check (they would otherwise hold different order locks when the orders differ).
 */
export async function assertNoDuplicateSupplierBill(
  tx: DuplicateLookupTx,
  params: { supplierId: string; invoiceNumber: string | null; override?: boolean },
): Promise<void> {
  if (!params.invoiceNumber || params.override) return
  const key = `purchase-bill:${params.supplierId}:${params.invoiceNumber.toLowerCase()}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  const found = await tx.purchaseInvoice.findFirst({
    where: { invoiceNumber: { equals: params.invoiceNumber, mode: 'insensitive' }, po: { supplierId: params.supplierId } },
    select: { id: true, po: { select: { reference: true } } },
  })
  if (found) throw new DuplicateSupplierInvoiceNumberError(params.invoiceNumber, { invoiceId: found.id, poReference: found.po.reference })
}
