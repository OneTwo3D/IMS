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
 * Payment notes the SYSTEM writes (the storefront importer's receipts). They are fixed sentences with no identity, and the importer
 * RECOGNISES its own earlier receipts by the prefix (it must not raise a second receipt for the same payment), so the erasure keeps
 * them. Everything else on `Payment.notes` is free text typed by a person and is erased.
 */
export const SYSTEM_PAYMENT_NOTE_PREFIXES = ['Recorded from WooCommerce', 'Imported from WooCommerce'] as const

/**
 * Free text on a payment: BLANKED for an erased order. The payment itself still records (money must post and reconcile); only the
 * operator's or the storefront's free-text note is dropped, since it can name the person. `Payment.reference` is NOT touched: it
 * reconciles the receipt with the bank and the ledger.
 */
export async function paymentNotesForOrder(tx: Prisma.TransactionClient, orderId: string, notes: string | null | undefined): Promise<string | null> {
  if (!notes) return null
  if (SYSTEM_PAYMENT_NOTE_PREFIXES.some((prefix) => notes.startsWith(prefix))) return notes
  return (await orderIsErasedInTx(tx, orderId)) ? null : notes
}
