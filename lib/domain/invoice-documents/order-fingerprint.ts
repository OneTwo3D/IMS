import { createHash } from 'node:crypto'

export type OrderEvidenceRow = {
  status: string
  invoiceNumber: string | null
  orderNumber: string | null
  externalOrderNumber: string | null
  customerName: string | null
  currency: string
  totalForeign: unknown
  storeCreditForeign: unknown
  storeCreditAssessment: unknown
}

/** The columns a document's ownership and expected gross are computed from. Selected the same way by the fetch, the promotion and the reader. */
export const ORDER_EVIDENCE_SELECT = {
  status: true,
  invoiceNumber: true,
  orderNumber: true,
  externalOrderNumber: true,
  customerName: true,
  currency: true,
  totalForeign: true,
  storeCreditForeign: true,
  storeCreditAssessment: true,
} as const

/**
 * Everything the ownership check and the expected gross were computed from, as one comparable string. The importer can correct an order's
 * invoice number (while no ledger invoice is linked), its credit or its customer while a fetch is in flight or after a document is stored.
 */
export function orderEvidenceKey(order: OrderEvidenceRow, creditNoteNumber: string | null): string {
  return JSON.stringify([
    order.status === 'CANCELLED',
    (order.invoiceNumber ?? '').trim().toLowerCase(),
    creditNoteNumber === null ? null : creditNoteNumber.trim().toLowerCase(),
    order.orderNumber,
    order.externalOrderNumber,
    order.customerName,
    order.currency,
    String(order.totalForeign),
    String(order.storeCreditForeign),
    order.storeCreditAssessment ?? null,
  ])
}

/** What is stored on the document row: a hash, so no customer name or amount is copied into the table. */
export function orderEvidenceFingerprint(order: OrderEvidenceRow, creditNoteNumber: string | null): string {
  return createHash('sha256').update(orderEvidenceKey(order, creditNoteNumber)).digest('hex')
}
