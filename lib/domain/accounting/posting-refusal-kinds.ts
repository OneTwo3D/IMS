/**
 * o3d-j625 r6 (review H4, owner decision 2026-09-18: "Mark as handled") — WHICH REFUSED POSTINGS CLEAR
 * THEMSELVES, AND WHICH ONLY A PERSON CAN CLOSE.
 *
 * Every refusal row names the SITE that refused, as one of the kinds below. The kind — not the text of the
 * row, and not the posting type alone — decides whether the inbox offers "Mark as handled":
 *
 *   AUTO    a path in IMS raises the SAME posting again (same key, see lib/accounting/posting-key.ts), and
 *           since r6 every accounting sync row is created through createAccountingSyncLogRow, which clears
 *           the refusal the row discharges. These rows leave the list when the posting is queued. They
 *           must NOT be markable: someone could dismiss a row IMS would have cleared while the debt is
 *           still real (the owner rejected the action on every row for exactly that reason).
 *   MANUAL  nothing in IMS raises that posting again — re-running the source action creates a DIFFERENT
 *           posting (a new receipt, a new return, a new bill) or cannot run twice. The only remedy is to
 *           post it by hand in the ledger, and the row leaves the list when someone marks it handled.
 *
 * Keyed per SITE where one posting type is refused from sites that differ: a held WooCommerce invoice is
 * retried by the release sweep, a manual order's invoice is not. IMPORT-FREE, so the client inbox can read
 * it. tests/accounting/posting-refusal-kinds.test.ts pins both halves.
 */
export type RefusalClearing = 'auto' | 'manual'

type KindSpec = {
  type: string
  referenceType: string
  clearing: RefusalClearing
  /** AUTO: what raises the posting again. MANUAL: why nothing does. Shown to the operator. */
  how: string
}

export const POSTING_REFUSAL_KINDS = {
  // ── AUTO ────────────────────────────────────────────────────────────────────────────────────────────
  sales_invoice_held_release: {
    type: 'SALES_INVOICE', referenceType: 'SalesOrder', clearing: 'auto',
    how: 'The WooCommerce reconcile sweep retries the held invoice release; it leaves this list when the invoice is queued.',
  },
  sales_invoice_update: {
    type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', clearing: 'auto',
    how: 'Re-saving the order queues the update again; it leaves this list when the update is queued.',
  },
  purchase_invoice_update: {
    type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', clearing: 'auto',
    how: 'Re-saving the bill queues the update again; it leaves this list when the update is queued.',
  },
  tax_rate_sync: {
    type: 'TAX_RATE_SYNC', referenceType: 'TaxRate', clearing: 'auto',
    how: 'Saving the tax rate again pushes it again; it leaves this list when the push is queued.',
  },
  invoice_payment_receipt: {
    type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', clearing: 'auto',
    how: 'The receipt stays owed and is registered again by the deferred-receipt recovery once the cause is corrected; it leaves this list when that receipt is queued.',
  },
  credit_note_allocation: {
    type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', referenceType: 'SupplierCreditNote', clearing: 'auto',
    how: 'The credit-note allocation sweep retries it; it leaves this list when the allocation is queued.',
  },
  unrealised_fx_journal: {
    type: 'UNREALISED_FX_JOURNAL', referenceType: 'FxRevaluation', clearing: 'auto',
    how: 'Running the FX revaluation for that date again raises the same journal; it leaves this list when it is queued.',
  },
  landed_cost_cogs_journal: {
    type: 'COGS_JOURNAL', referenceType: 'PurchaseOrder', clearing: 'auto',
    how: 'The landed-cost journal outbox retries the owed journal; it leaves this list when it is queued.',
  },
  landed_cost_transit_journal: {
    type: 'STOCK_IN_TRANSIT', referenceType: 'PurchaseOrder', clearing: 'auto',
    how: 'The landed-cost journal outbox retries the owed journal; it leaves this list when it is queued.',
  },
  // ── MANUAL, but the same posting as an AUTO kind above: the caller decides (see queueLandedCostAdjustmentJournals).
  landed_cost_cogs_journal_direct: {
    type: 'COGS_JOURNAL', referenceType: 'PurchaseOrder', clearing: 'manual',
    how: 'Raised by a purchase-order edit, freight PO or cancellation, which runs once; nothing re-runs it.',
  },
  landed_cost_transit_journal_direct: {
    type: 'STOCK_IN_TRANSIT', referenceType: 'PurchaseOrder', clearing: 'manual',
    how: 'Raised by a purchase-order edit, freight PO or cancellation, which runs once; nothing re-runs it.',
  },
  refund_credit_note: {
    type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', clearing: 'auto',
    how: 'Retry refund accounting on the refund queues it again; it leaves this list when it is queued.',
  },
  refund_cogs_reversal: {
    type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', clearing: 'auto',
    how: 'Retry refund accounting on the refund queues it again; it leaves this list when it is queued.',
  },
  refund_unearned_reversal: {
    type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', clearing: 'auto',
    how: 'Retry refund accounting on the refund queues it again; it leaves this list when it is queued.',
  },
  // ── MANUAL ──────────────────────────────────────────────────────────────────────────────────────────
  sales_invoice_order: {
    type: 'SALES_INVOICE', referenceType: 'SalesOrder', clearing: 'manual',
    how: 'The invoice is queued once, when the order is created or finalised, and nothing queues it again.',
  },
  sales_invoice_import: {
    type: 'SALES_INVOICE', referenceType: 'SalesOrder', clearing: 'manual',
    how: 'The invoice is queued once, when the WooCommerce order is imported, and nothing queues it again.',
  },
  stock_adjustment_journal: {
    type: 'INVENTORY_ADJUSTMENT', referenceType: 'StockMovement', clearing: 'manual',
    how: 'The journal is queued once, with the stock movement; nothing queues it again for that movement.',
  },
  purchase_order_cancellation_reversal: {
    type: 'INVENTORY_ADJUSTMENT', referenceType: 'PurchaseOrder', clearing: 'manual',
    how: 'The reversal is queued once, when the purchase order is cancelled, which cannot happen twice.',
  },
  supplier_return_reversal: {
    type: 'INVENTORY_ADJUSTMENT', referenceType: 'PurchaseReturn', clearing: 'manual',
    how: 'The reversal is queued once, with the return; raising the return again would be a second return.',
  },
  stock_receipt_journal: {
    type: 'STOCK_RECEIPT', referenceType: 'PurchaseOrder', clearing: 'manual',
    how: 'The journal is queued once, with the receipt; receiving again is a different receipt.',
  },
  purchase_invoice: {
    type: 'PURCHASE_INVOICE', referenceType: 'PurchaseInvoice', clearing: 'manual',
    how: 'The bill is queued once, when it is created; creating it again would be a second bill.',
  },
  realised_fx_bill_payment: {
    type: 'REALISED_FX_JOURNAL', referenceType: 'PurchaseInvoice', clearing: 'manual',
    how: 'The realised gain/loss is queued once, when the bill is paid; the FX revaluation raises unrealised journals, not this one.',
  },
  realised_fx_receipt: {
    type: 'REALISED_FX_JOURNAL', referenceType: 'Payment', clearing: 'manual',
    how: 'The realised gain/loss is queued once, when the receipt settles; the FX revaluation raises unrealised journals, not this one.',
  },
  manufacturing_journal: {
    type: 'MANUFACTURING_JOURNAL', referenceType: 'ProductionOrder', clearing: 'manual',
    how: 'The journal is queued once, when the production order completes, which cannot happen twice.',
  },
  manufacturing_reclass: {
    type: 'MANUFACTURING_RECLASS', referenceType: 'ProductionOrder', clearing: 'manual',
    how: 'The reclass is queued once for this cost change; a later cost change is a different reclass.',
  },
  allocation_reversal: {
    type: 'ALLOCATION_REVERSAL', referenceType: 'SalesOrder', clearing: 'manual',
    how: 'Each reversal belongs to one trim of the order\'s allocations and is never raised again.',
  },
} as const satisfies Record<string, KindSpec>

export type PostingRefusalKind = keyof typeof POSTING_REFUSAL_KINDS

/**
 * The kind a row recorded by the ENQUEUE ITSELF gets (the facade's chart/document refusal, and the
 * in-transaction refusals a caller asked to have recorded), before the site's own report names it. A
 * posting refused from ONE kind of site gets that kind. A posting refused from several gets its single
 * MANUAL kind if it has exactly one (the landed-cost journals), and otherwise none (SALES_INVOICE/SalesOrder:
 * the held release records its kind itself, and the order and import paths report theirs) — never an AUTO
 * kind, which would hide a row that cannot clear.
 */
export function defaultPostingRefusalKind(type: string, referenceType: string): PostingRefusalKind | null {
  const matches = (Object.entries(POSTING_REFUSAL_KINDS) as Array<[PostingRefusalKind, KindSpec]>)
    .filter(([, spec]) => spec.type === type && spec.referenceType === referenceType)
  if (matches.length === 1) return matches[0]![0]
  // A posting refused from several kinds of site: the MANUAL one, until the site's own report (a merge)
  // names the real kind. Every such site does report or record (tests/accounting/posting-refusal-kinds.test.ts).
  const manual = matches.filter(([, spec]) => spec.clearing === 'manual')
  if (manual.length === 1) return manual[0]![0]
  return null
}

/** How a row clears. `null` (an unclassified or legacy row) is never markable — fail closed. */
export function postingRefusalClearing(kind: string | null | undefined): RefusalClearing | null {
  if (!kind || !(kind in POSTING_REFUSAL_KINDS)) return null
  return POSTING_REFUSAL_KINDS[kind as PostingRefusalKind].clearing
}

/** The longest note an operator may attach when marking a row handled (e.g. a ledger journal number). */
export const POSTING_REFUSAL_NOTE_MAX_LENGTH = 500
