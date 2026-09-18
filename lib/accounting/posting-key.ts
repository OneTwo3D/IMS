import type { AccountingSyncType } from '@/app/generated/prisma/client'

/**
 * o3d-j625 r5 (review HIGH 1/2/3) — THE KEY OF A REFUSED POSTING IS DERIVED FROM THE ENQUEUE'S OWN
 * PARAMS, NEVER RE-TYPED BESIDE THEM.
 *
 * r4 had each reporting site hand-write the `(type, referenceType, referenceId)` its inbox row was keyed
 * on, while {@link clearAccountingPostingRefusal} was fed the ENQUEUE's params. Eleven of fourteen
 * matched. The three that did not are the whole finding, and none of them was a typo:
 *
 *   HIGH 1  the bill create recorded `PURCHASE_INVOICE/PurchaseOrder/poId` for a posting enqueued as
 *           `PURCHASE_INVOICE/PurchaseInvoice/<bill id>`. The clear could never match it, and the inbox
 *           has no acknowledge action — an unclearable row, under section copy promising it clears.
 *   HIGH 2  the supplier return recorded `INVENTORY_ADJUSTMENT/PurchaseOrder/<po id>` — which is the key
 *           the PO CANCELLATION's own posting uses. A successful cancellation therefore stamped
 *           `resolvedAt` over a supplier-return reversal that was never written: a false "paid" on an
 *           owed posting, which is exactly the silence the in-transaction clear exists to prevent.
 *   HIGH 3  the key was per DOCUMENT where the posting is per RECEIPT. An INVOICE_PAYMENT is one receipt
 *           against one document (see lib/domain/accounting/invoice-payment-capacity.ts) — so a refused
 *           deposit's row was resolved by a later balance succeeding, leaving the ledger short and the
 *           inbox empty.
 *
 * So the key is a FUNCTION OF THE ENQUEUE PARAMS, called by the writer and by the clear, and the params
 * are the ones actually handed to the enqueue. Two postings cannot share a key unless they are the same
 * posting, and a posting cannot be recorded under a key its own clear will not match.
 *
 * `scope` IS WHAT MAKES A POSTING FINER THAN ITS DOCUMENT ITS OWN ROW. For the types whose obligation is
 * per RECEIPT, per RUN or per ADJUSTMENT, the enqueue already carries that discriminator — its
 * `idempotencyKey` is built from exactly the thing that makes this posting distinct (the receipt
 * reference, the recalc nonce, the adjustment). For the types whose obligation is the DOCUMENT — a sales
 * invoice for an order, an update to a bill — the idempotency key is a CONTENT HASH that changes with
 * every edit, so keying on it would strand the previous attempt's row for ever (HIGH 1 again, in a new
 * form). Those are `''`: one open row per document, cleared by the next successful posting of it.
 *
 * INVOICE_PAYMENT is neither: its obligation is the RECEIPT, and the receipt is named in the payload
 * rather than the reference. It is scoped by `paymentId` explicitly.
 */
export type AccountingPostingKey = {
  type: string
  referenceType: string
  referenceId: string
  /** The obligation discriminator within the document, or `''` when the document IS the obligation. */
  scope: string
}

/**
 * The types whose obligation is the DOCUMENT, not the attempt: their idempotency key is a content hash
 * of the payload, so a later, different attempt would never clear an earlier attempt's row.
 */
const DOCUMENT_SCOPED_POSTING_TYPES: ReadonlySet<string> = new Set([
  'SALES_INVOICE',
  'SALES_INVOICE_UPDATE',
  'PURCHASE_INVOICE',
  'PURCHASE_INVOICE_UPDATE',
  'CREDIT_NOTE',
  'PURCHASE_CREDIT_NOTE',
  'PURCHASE_CREDIT_NOTE_ALLOCATION',
  'BILL_PAYMENT',
  'TAX_RATE_SYNC',
  'BILL_ATTACHMENT',
  'INVOICE_PDF',
  'INVOICE_EMAIL',
  'WC_INVOICE_NOTE',
])

export function accountingPostingKey(params: {
  type: AccountingSyncType | string
  referenceType: string
  referenceId: string
  idempotencyKey?: string
  payload?: Record<string, unknown>
}): AccountingPostingKey {
  const base = { type: String(params.type), referenceType: params.referenceType, referenceId: params.referenceId }
  if (params.type === 'INVOICE_PAYMENT') {
    // The RECEIPT, named in the payload rather than the reference. `''` for a payload that names none —
    // an older row, or a producer that does not — which is one shared row rather than a wrong one.
    const paymentId = params.payload?.paymentId
    return { ...base, scope: typeof paymentId === 'string' && paymentId !== '' ? `payment:${paymentId}` : '' }
  }
  if (DOCUMENT_SCOPED_POSTING_TYPES.has(base.type)) return { ...base, scope: '' }
  return { ...base, scope: params.idempotencyKey ?? '' }
}