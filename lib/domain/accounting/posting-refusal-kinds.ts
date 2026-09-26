/**
 * o3d-j625 r6/r7 — WHICH REFUSED POSTINGS CLEAR THEMSELVES, WHICH IMS RETRIES BUT MAY NEVER CLEAR, AND
 * WHICH ONLY A PERSON CAN CLOSE.
 *
 * Owner decisions: 2026-09-18 "Mark as handled"; 2026-09-19 "Handled + stop retry", which superseded part
 * of the first. Every refusal row names the SITE that refused, as one of the kinds below, and the kind —
 * never the row's text — decides whether the inbox offers "Mark as handled":
 *
 *   auto     a path in IMS raises the SAME posting again (same key, lib/accounting/posting-key.ts) AND
 *            nothing can make that path refuse for ever. Leaves the list when the posting is queued
 *            (every row is created through createAccountingSyncLogRow, which clears it). No button.
 *   retried  IMS retries the same posting, but the retry CAN get stuck — it replays the chart/connector the
 *            posting was built for (a switch makes it refuse for ever), gives up after N attempts, or only
 *            runs for today's date. The button IS offered: marking it handled records that it was posted
 *            by hand AND suppresses the posting key, so IMS's own retry of it is refused from then on
 *            (lib/domain/accounting/posting-suppression.ts) and it can never be posted twice. If IMS posts
 *            it first, the row clears itself as `queued`.
 *   manual   nothing in IMS raises that posting again — re-running the source action creates a DIFFERENT
 *            posting (a new receipt, a new return, a new bill) or cannot run twice. Post it by hand, then
 *            mark it handled (which suppresses the key too).
 *
 * Keyed per SITE where one posting type is refused from sites that differ: a held WooCommerce invoice is
 * retried by the release sweep, a manual order's invoice is not. IMPORT-FREE, so the client inbox can read
 * it. tests/accounting/posting-refusal-kinds.test.ts pins the classification, and help-docs/xero-sync.md's
 * tables are checked against it.
 */
export type RefusalClearing = 'auto' | 'retried' | 'manual'

export type KindSpec = {
  type: string
  referenceType: string
  clearing: RefusalClearing
  /** What raises the posting again, and (for `retried`) how that retry can get stuck; or why nothing does. */
  how: string
}

export const POSTING_REFUSAL_KINDS = {
  // ── auto ────────────────────────────────────────────────────────────────────────────────────────────
  tax_rate_sync: {
    type: 'TAX_RATE_SYNC', referenceType: 'TaxRate', clearing: 'auto',
    how: 'Saving the tax rate again pushes it to whichever connector is active then; it leaves this list when the push is queued.',
  },
  // ── retried (IMS retries, but the retry can get stuck) ──────────────────────────────────────────────
  sales_invoice_held_release: {
    type: 'SALES_INVOICE', referenceType: 'SalesOrder', clearing: 'retried',
    how: 'The WooCommerce reconcile sweep retries the held invoice, but always for the connector it was built for — after a permanent connector switch it is refused on every run.',
  },
  sales_invoice_update: {
    type: 'SALES_INVOICE_UPDATE', referenceType: 'SalesOrder', clearing: 'retried',
    how: 'Re-saving the order queues the update again, but it is refused for as long as the invoice belongs to a connector that is no longer active.',
  },
  purchase_invoice_update: {
    type: 'PURCHASE_INVOICE_UPDATE', referenceType: 'PurchaseOrder', clearing: 'retried',
    how: 'Re-saving the bill queues the update again, but it is refused for as long as the bill belongs to a connector that is no longer active.',
  },
  invoice_payment_receipt: {
    type: 'INVOICE_PAYMENT', referenceType: 'SalesOrder', clearing: 'retried',
    how: 'The receipt is registered again only when the invoice\'s deferred-receipt recovery runs, which does not happen for every invoice.',
  },
  credit_note_allocation: {
    type: 'PURCHASE_CREDIT_NOTE_ALLOCATION', referenceType: 'SupplierCreditNote', clearing: 'retried',
    how: 'The credit-note allocation sweep retries it, but refuses on every run until both documents are recorded as belonging to the active connector.',
  },
  unrealised_fx_journal: {
    type: 'UNREALISED_FX_JOURNAL', referenceType: 'FxRevaluation', clearing: 'retried',
    how: 'The FX revaluation raises this journal only for the date it runs for; the daily run values today, so a refused journal for an earlier date is not raised again unless that date is re-run.',
  },
  landed_cost_cogs_journal: {
    type: 'COGS_JOURNAL', referenceType: 'PurchaseOrder', clearing: 'retried',
    how: 'The landed-cost journal outbox retries it, but gives up after a fixed number of attempts.',
  },
  landed_cost_transit_journal: {
    type: 'STOCK_IN_TRANSIT', referenceType: 'PurchaseOrder', clearing: 'retried',
    how: 'The landed-cost journal outbox retries it, but gives up after a fixed number of attempts.',
  },
  refund_credit_note: {
    type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', clearing: 'retried',
    how: 'Retry refund accounting queues it again, but always for the connector the refund was staged for — after a connector switch it is refused every time.',
  },
  refund_cogs_reversal: {
    type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', clearing: 'retried',
    how: 'Retry refund accounting queues it again, but always for the connector the refund was staged for — after a connector switch it is refused every time.',
  },
  refund_unearned_reversal: {
    type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', clearing: 'retried',
    how: 'Retry refund accounting queues it again, but always for the connector the refund was staged for — after a connector switch it is refused every time.',
  },
  // ── manual ──────────────────────────────────────────────────────────────────────────────────────────
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
 * posting refused from ONE kind of site gets that kind. A posting refused from several (SALES_INVOICE/SalesOrder)
 * gets the first kind that offers the button — never an AUTO kind, which would hide a row that can stick —
 * and the site's own report or record then names the real one.
 */
export function defaultPostingRefusalKind(
  type: string,
  referenceType: string,
  /**
   * o3d-j625 r7 (mutation survivor): the map to read. Injectable ONLY so a test can drive the ambiguous
   * case — no (type, referenceType) in POSTING_REFUSAL_KINDS carries both an AUTO kind and another one, so
   * against the real map the "never an AUTO kind" filter below cannot be reached. That is an invariant the
   * kinds test asserts, and the filter is the fail-safe for the day a new kind breaks it; injecting the map
   * is how the fail-safe is shown to work rather than merely to exist.
   */
  kinds: Readonly<Record<string, KindSpec>> = POSTING_REFUSAL_KINDS,
): PostingRefusalKind | null {
  const matches = (Object.entries(kinds) as Array<[PostingRefusalKind, KindSpec]>)
    .filter(([, spec]) => spec.type === type && spec.referenceType === referenceType)
  if (matches.length === 1) return matches[0]![0]
  // A posting refused from several kinds of site: one that offers the button (retried or manual), never an
  // AUTO kind, which would hide a row that can stick. The site's own report (a merge) then names the real
  // kind; every such site reports or records one (tests/accounting/posting-refusal-kinds.test.ts).
  const markable = matches.filter(([, spec]) => spec.clearing !== 'auto')
  return markable.length > 0 ? markable[0]![0] : null
}

/** How a row clears. `null` (an unclassified or legacy row) is never markable — fail closed. */
export function postingRefusalClearing(kind: string | null | undefined): RefusalClearing | null {
  if (!kind || !(kind in POSTING_REFUSAL_KINDS)) return null
  return POSTING_REFUSAL_KINDS[kind as PostingRefusalKind].clearing
}

/** Whether the inbox offers — and the server accepts — "Mark as handled" for a row of this kind. */
export function postingRefusalMarkable(kind: string | null | undefined): boolean {
  const clearing = postingRefusalClearing(kind)
  return clearing === 'retried' || clearing === 'manual'
}

/** The longest note an operator may attach when marking a row handled (e.g. a ledger journal number). */
export const POSTING_REFUSAL_NOTE_MAX_LENGTH = 500
