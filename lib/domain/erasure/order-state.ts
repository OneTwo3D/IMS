import type { Prisma } from '@/app/generated/prisma/client'

/**
 * Whether the order (or its customer) is erased, read INSIDE the caller's transaction and AFTER the caller has taken the order lock
 * (`lockSalesOrder`). Every place that copies a contact name or email into an accounting row or a parked hold reads it this way,
 * so the copy and the answer cannot be separated by an erasure.
 */
export async function orderIsErasedInTx(tx: Prisma.TransactionClient, orderId: string): Promise<boolean> {
  const row = await tx.salesOrder.findUnique({ where: { id: orderId }, select: { erasedAt: true, customer: { select: { gdprAnonymisedAt: true } } } })
  return Boolean(row?.erasedAt || row?.customer?.gdprAnonymisedAt)
}


/**
 * THE EXACT SENTENCES THE STOREFRONT IMPORTER WRITES to `Payment.notes` (its receipts). They are fixed text with no identity, and the
 * importer recognises its own earlier receipts by them, so the erasure keeps a note ONLY if it equals one of these in full. A note that
 * merely STARTS with one (a person typed the prefix and then a name) is free text and is erased. These constants are the importer's
 * single source: lib/connectors/woocommerce/sync/order-import.ts writes exactly these.
 */
export const WC_RECEIPT_NOTE_PAID_LATER_PARTIAL = 'Recorded from WooCommerce (paid later than the import): the part of the order total not already covered by earlier receipts'
export const WC_RECEIPT_NOTE_PAID_LATER = 'Recorded from WooCommerce (the order was imported unpaid and paid later)'
export const WC_RECEIPT_NOTE_IMPORTED_PAID = 'Imported from WooCommerce (paid when the order was imported)'
export const SYSTEM_PAYMENT_NOTES: readonly string[] = [WC_RECEIPT_NOTE_PAID_LATER_PARTIAL, WC_RECEIPT_NOTE_PAID_LATER, WC_RECEIPT_NOTE_IMPORTED_PAID]

export function isSystemPaymentNote(notes: string | null | undefined): boolean {
  return typeof notes === 'string' && SYSTEM_PAYMENT_NOTES.includes(notes)
}

/**
 * Free text on a payment: BLANKED for an erased order. The payment itself still records (money must post and reconcile); only the
 * operator's or the storefront's free-text note is dropped, since it can name the person. `Payment.reference` is NOT touched: it
 * reconciles the receipt with the bank and the ledger.
 */
export async function paymentNotesForOrder(tx: Prisma.TransactionClient, orderId: string, notes: string | null | undefined): Promise<string | null> {
  if (!notes) return null
  if (isSystemPaymentNote(notes)) return notes
  return (await orderIsErasedInTx(tx, orderId)) ? null : notes
}
