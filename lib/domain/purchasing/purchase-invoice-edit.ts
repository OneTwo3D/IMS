import { accountingPayloadKey } from '@/lib/accounting/payload-key'

export type PurchaseInvoiceEditHeader = {
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  notes: string | null
  supplierInvoiceUrl: string | null
}

export type PurchaseInvoiceEditLine = {
  id: string
  description: string | null
  qtyBilled: number
  unitCostForeign: number
  totalForeign: number
}

export function assertPurchaseInvoiceEditable(invoice: { paidAt: Date | string | null }): void {
  if (invoice.paidAt) throw new Error('Paid bills cannot be edited')
}

function sortedLines(lines: PurchaseInvoiceEditLine[]): PurchaseInvoiceEditLine[] {
  return [...lines].sort((a, b) => a.id.localeCompare(b.id))
}

export function hasPurchaseInvoiceEditChanges(params: {
  existingHeader: PurchaseInvoiceEditHeader
  nextHeader: PurchaseInvoiceEditHeader
  existingLines: PurchaseInvoiceEditLine[]
  nextLines: PurchaseInvoiceEditLine[]
}): boolean {
  return JSON.stringify(params.existingHeader) !== JSON.stringify(params.nextHeader)
    || JSON.stringify(sortedLines(params.existingLines)) !== JSON.stringify(sortedLines(params.nextLines))
}

export function buildPurchaseInvoiceUpdateIdempotencyKey(params: {
  invoiceId: string
  accountingInvoiceId: string
  payload: Record<string, unknown>
}): string {
  return accountingPayloadKey(
    `purchase-invoice-update:${params.invoiceId}:${params.accountingInvoiceId}`,
    params.payload,
  )
}
