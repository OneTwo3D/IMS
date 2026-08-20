import type { FollowUpPayloadDebtTable } from '@/lib/domain/accounting/compacted-followup-loss'

/**
 * WHAT EACH XERO SYNC TYPE OWES ITS FOLLOW-UPS, AND WHETHER COMPACTION CAN DESTROY IT
 * (o3d-bqw7, o3d-kemx).
 *
 * THIS TABLE IS A RESTATEMENT OF `enqueueFollowUps` IN sync-processor.ts, AND THAT IS THE WHOLE
 * COST OF IT. There is no way to ask that function "what would you have enqueued from a payload you
 * no longer have?" — handed `{}` it takes no branch, enqueues nothing and returns NORMALLY, which
 * is exactly the silent success the compaction warning exists to catch. So the question is answered
 * from a reviewed table instead, and the table has to be kept honest by hand.
 *
 * WHAT KEEPS IT HONEST:
 *   • it is `Record<AccountingSyncType, …>`, so a new sync type fails type-check here rather than
 *     inheriting a default;
 *   • `tests/accounting/xero-followup-payload-debt.test.ts` drives the REAL processor down the
 *     already-posted short-circuit, once per interesting type, with the payload present and with the
 *     payload compacted away, and asserts the follow-up rows that appear match what this table
 *     claims. A wrong entry is a failing test, not a comment nobody re-read.
 *
 * THE THREE ENQUEUE FUNCTIONS IT TRACKS, and the exact line in each that makes the answer what it
 * is:
 *
 *   enqueueSalesInvoiceFollowUps  `if (payload._registerPayment)` gates INVOICE_PAYMENT — the money
 *                                 one, and the reason the safe direction matters. INVOICE_PDF below
 *                                 it reads `syncResult.externalId` and `referenceId` only, so it
 *                                 SURVIVES a tombstone and is enqueued by both short-circuit sites.
 *   enqueuePurchaseInvoiceFollowUps  `|| !payload.supplierInvoicePath` gates BILL_ATTACHMENT, and
 *                                 there is nothing else in the branch. A compacted bill loses
 *                                 everything it owed.
 *   enqueuePurchaseCreditNoteFollowUps  `payload.allocateToInvoiceId` / `payload.allocateAmount`
 *                                 gate PURCHASE_CREDIT_NOTE_ALLOCATION. Also everything it owed.
 *
 * And the fourth branch, which owns no function: `type === 'INVOICE_PDF' && referenceType ===
 * 'SalesOrder'` reads the SALES ORDER ROW (customer email, WooCommerce link) to enqueue
 * INVOICE_EMAIL / WC_INVOICE_NOTE. It never touches the payload, so compaction costs it nothing.
 *
 * EVERY OTHER TYPE FALLS OFF THE END OF `enqueueFollowUps` WITH NO BRANCH AT ALL. That is not an
 * assumption about them — it is the shape of the function: four `if`s and a return.
 *
 * WHAT THIS TABLE DELIBERATELY DOES NOT MODEL, in the safe direction (it can only over-report):
 *
 *   • `referenceType`. Each branch also requires its own reference type (SalesOrder,
 *     PurchaseInvoice/PurchaseOrder, SupplierCreditNote) — the same pairs BACK_REFERENCE_PAIRS
 *     already carries. A SALES_INVOICE row keyed to something else owes nothing and is still warned
 *     about. Folding the pairs in would double the facts that must track three functions to remove a
 *     row shape that does not occur.
 *   • WHETHER THIS PARTICULAR ROW asked for the payload-gated work. Only the destroyed payload knew
 *     whether a sale registered a payment or a bill carried a supplier PDF, and most bills carry no
 *     PDF. Those rows stay warned about, because the alternative is losing a payment in silence.
 *
 * WHICH TYPES CAN ACTUALLY BE COMPACTED TODAY is narrower still, and worth knowing when reading the
 * table: retention stamps `backReferenceEvidenceCompactedAt` only through
 * UNRESOLVED_BACK_REFERENCE_EVIDENCE_WHERE, which requires an external id, a SYNCED/FAILED status
 * and a type in BACK_REFERENCE_SWEEP_TYPES — SALES_INVOICE, CREDIT_NOTE, PURCHASE_INVOICE,
 * PURCHASE_CREDIT_NOTE. So the row this fix stops warning about IN PRODUCTION is the sales CREDIT_NOTE,
 * and the rest of the table is what stops the next widening of that predicate from re-introducing the
 * defect silently. The table is NOT scoped to those four for that reason.
 */
export const XERO_FOLLOW_UP_PAYLOAD_DEBT: FollowUpPayloadDebtTable = {
  // The money one. The PDF survives; the payment does not, and the phrase says so rather than
  // sending the operator to look for a PDF that was enqueued a millisecond earlier.
  SALES_INVOICE: {
    debt: 'PAYLOAD_BUILT',
    lost: 'the customer payment registration it may still have owed (its invoice PDF is rebuilt from columns compaction keeps, and has been enqueued)',
  },
  PURCHASE_INVOICE: {
    debt: 'PAYLOAD_BUILT',
    lost: 'the supplier-invoice attachment it may still have owed',
  },
  PURCHASE_CREDIT_NOTE: {
    debt: 'PAYLOAD_BUILT',
    lost: 'the allocation against the bill it offsets, which it may still have owed',
  },
  // Owes real work — INVOICE_EMAIL and WC_INVOICE_NOTE — but rebuilds both from the SalesOrder row,
  // so a tombstone loses nothing and the enqueue must still be called for it.
  INVOICE_PDF: { debt: 'COLUMN_BUILT' },

  // ---------------------------------------------------------------------------
  // NO BRANCH IN `enqueueFollowUps`. Nothing to lose, so nothing to warn about.
  //
  // CREDIT_NOTE is the one that matters in production: it IS a back-reference type, so retention
  // compacts it, and every compacted sales credit note was warned about and — since r4 gated the
  // release on that warning — could be held at PENDING for ever by a failing activity log while the
  // credit note sat posted in Xero. That is o3d-kemx, and this line is its fix.
  // ---------------------------------------------------------------------------
  CREDIT_NOTE: { debt: 'NONE' },
  PURCHASE_INVOICE_UPDATE: { debt: 'NONE' },
  SALES_INVOICE_UPDATE: { debt: 'NONE' },
  // The follow-ups THEMSELVES. A follow-up row does not enqueue a further follow-up.
  INVOICE_PAYMENT: { debt: 'NONE' },
  BILL_ATTACHMENT: { debt: 'NONE' },
  INVOICE_EMAIL: { debt: 'NONE' },
  WC_INVOICE_NOTE: { debt: 'NONE' },
  PURCHASE_CREDIT_NOTE_ALLOCATION: { debt: 'NONE' },
  BILL_PAYMENT: { debt: 'NONE' },
  // Journals and stock movements: posted as manual journals, they own no downstream work.
  COGS_JOURNAL: { debt: 'NONE' },
  INVENTORY_ADJUSTMENT: { debt: 'NONE' },
  STOCK_IN_TRANSIT: { debt: 'NONE' },
  STOCK_RECEIPT: { debt: 'NONE' },
  COGS_REVERSAL: { debt: 'NONE' },
  STOCK_ALLOCATION: { debt: 'NONE' },
  DAILY_BATCH_REVENUE_DEFERRAL: { debt: 'NONE' },
  DAILY_BATCH_INVENTORY_ALLOC: { debt: 'NONE' },
  DAILY_BATCH_GROUP_B: { debt: 'NONE' },
  DAILY_BATCH_INVENTORY_RECONCILIATION: { debt: 'NONE' },
  DAILY_BATCH_COGS_RECONCILIATION: { debt: 'NONE' },
  DAILY_BATCH_TRANSIT_RECONCILIATION: { debt: 'NONE' },
  UNEARNED_REV_REVERSAL: { debt: 'NONE' },
  REALISED_FX_JOURNAL: { debt: 'NONE' },
  UNREALISED_FX_JOURNAL: { debt: 'NONE' },
  MANUFACTURING_JOURNAL: { debt: 'NONE' },
  MANUFACTURING_RECLASS: { debt: 'NONE' },
  TAX_RATE_SYNC: { debt: 'NONE' },
}
