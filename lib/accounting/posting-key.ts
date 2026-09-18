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
 * are the ones actually handed to the enqueue, so a posting cannot be recorded under a key its own clear
 * will not match. Whether two DIFFERENT postings can share a key is a per-type question, answered type by
 * type in SCOPE_RULES below (r6) rather than asserted for the set.
 */
export type AccountingPostingKey = {
  type: string
  referenceType: string
  referenceId: string
  /** The obligation discriminator within the document, or `''` when the document IS the obligation. */
  scope: string
}

/**
 * o3d-j625 r6 (review H2) — ONE RULE PER TYPE, AND THE TYPE CHECKER ASKS FOR IT.
 *
 * r5 split the types into "document-scoped" and "everything else keyed by its idempotency key", and argued
 * the whole set at once. The independent review executed two counter-examples: PURCHASE_INVOICE_UPDATE is
 * enqueued against the PURCHASE ORDER, which holds several bills, so bill B's update cleared bill A's
 * refusal; and ALLOCATION_REVERSAL passes no idempotency key, so every trim of an order shared scope `''`
 * and trim 2 cleared trim 1 while trim 1's amount still sat in Allocated Inventory.
 *
 * So each type now names what makes one of its postings distinct from another, in a `Record` over the
 * enum — a new AccountingSyncType does not compile until someone has written that sentence for it. For
 * each rule the two properties that matter are stated: TWO DIFFERENT POSTINGS CANNOT COLLIDE, and A RETRY
 * OF THE SAME POSTING CANNOT DIVERGE. Where the second does not hold, the rule says so rather than
 * claiming it; tests/accounting/posting-refusal-key.test.ts asserts both, per type.
 *
 * WHERE A DISCRIMINATOR COMES FROM. Always from the params handed to the enqueue — and the same fields are
 * on the stored row (`payload`, and `payload._idempotencyKey`, which both queues stamp verbatim from
 * `params.idempotencyKey`), so {@link accountingPostingKeyForRow} derives the identical key from a row. That
 * is what lets the row-creating primitive clear refusals for EVERY path that writes a row (review H3).
 *
 * WHAT AN IDEMPOTENCY KEY IS HERE (review L3). Not a "receipt reference" in general: most are a prefix
 * naming the source document plus a CONTENT HASH of the payload (accountingPayloadKey), and some hash in
 * values that change between attempts. Where one is used as the discriminator below, the rule says which
 * prefix makes postings distinct and whether a retry reproduces the same hash.
 */
type ScopeRule = (params: PostingKeyParams) => string
type PostingKeyParams = {
  type: string
  referenceType: string
  referenceId: string
  idempotencyKey?: string
  payload?: Record<string, unknown>
}

/** The document IS the obligation: one open row per referenced document. */
const DOCUMENT: ScopeRule = () => ''
/** The enqueue's idempotency key is the discriminator (see each type's note for what it contains). */
const IDEMPOTENCY_KEY: ScopeRule = (params) => params.idempotencyKey ?? ''

function payloadString(params: PostingKeyParams, field: string): string | null {
  const value = params.payload?.[field]
  return typeof value === 'string' && value !== '' ? value : null
}

const SCOPE_RULES: Record<AccountingSyncType, ScopeRule> = {
  // One invoice per sales order. A retry is the same order → same key.
  SALES_INVOICE: DOCUMENT,
  // Successive edits of ONE invoice. A later successful update carries the latest content and so discharges
  // an earlier refused one — the same obligation ("the ledger holds the current invoice"), deliberately.
  SALES_INVOICE_UPDATE: DOCUMENT,
  // Referenced by the bill itself (PurchaseInvoice/<bill id>): one posting per bill.
  PURCHASE_INVOICE: DOCUMENT,
  // Referenced by the PURCHASE ORDER, which holds several bills (review H2). The bill is named in the
  // payload as `accountingInvoiceId` — always present, because an update is only enqueued for a bill the
  // ledger already holds. Two bills → two keys; successive edits of one bill → one key (as above).
  PURCHASE_INVOICE_UPDATE: (params) => {
    const bill = payloadString(params, 'accountingInvoiceId')
    return bill ? `bill:${bill}` : ''
  },
  // One refund per SalesOrderRefund / one supplier credit note per SupplierCreditNote.
  CREDIT_NOTE: DOCUMENT,
  PURCHASE_CREDIT_NOTE: DOCUMENT,
  // One allocation per supplier credit note (the sweep enqueues at most one per note, against its bill).
  PURCHASE_CREDIT_NOTE_ALLOCATION: DOCUMENT,
  // PurchaseInvoice/<bill id>. A bill is paid once; a reversed-then-repaid bill is the same obligation
  // ("this bill's payment is in the ledger"), which the later payment discharges.
  BILL_PAYMENT: DOCUMENT,
  // One RECEIPT against one invoice (invoice-payment-capacity.ts). The receipt is named in the payload.
  // `''` when a payload names none — an older row — which is one shared row rather than a wrong one.
  INVOICE_PAYMENT: (params) => {
    const paymentId = payloadString(params, 'paymentId')
    return paymentId ? `payment:${paymentId}` : ''
  },
  // Follow-ups of one document; a later one supersedes an earlier.
  BILL_ATTACHMENT: DOCUMENT,
  INVOICE_PDF: DOCUMENT,
  INVOICE_EMAIL: DOCUMENT,
  WC_INVOICE_NOTE: DOCUMENT,
  // Successive pushes of one tax rate; the latest discharges the earlier.
  TAX_RATE_SYNC: DOCUMENT,
  // Every producer references a document that IS one posting: StockMovement/<movement id> (one adjustment),
  // PurchaseReturn/<return id>, PurchaseOrder/<po id> for the cancellation reversal (a PO is cancelled
  // once). DOCUMENT rather than the idempotency key because the cancellation's key is a content hash of
  // cost layers read at cancel time — a retry could hash differently and strand the refused row.
  INVENTORY_ADJUSTMENT: DOCUMENT,
  // Every call is its own trim of an order's allocations and carries `_reversalToken` (a fresh UUID minted
  // for exactly that call, allocation-service.ts) in its payload. Two trims → two tokens → two keys. There
  // is no retry of a trim: a refused reversal is re-raised by a human, so "retries diverge" does not arise.
  ALLOCATION_REVERSAL: (params) => {
    const token = payloadString(params, '_reversalToken')
    return token ? `reversal:${token}` : ''
  },
  // PurchaseOrder/<po id>, and a PO has several receipts: the key is `purchase-receipt:<po>:<receiptRef>`
  // plus a payload hash. Different receipts differ in the prefix. The same receipt re-enqueued with the
  // same lines hashes the same; there is no automatic retry path (review H4 is about exactly that).
  STOCK_RECEIPT: IDEMPOTENCY_KEY,
  // One per landed-cost ADJUSTMENT of a PO (landedCostAdjustmentIdempotencyKey: kind + PO + a hash of the
  // adjustment itself). Different adjustments differ; the outbox retry of one adjustment rebuilds the same
  // adjustment and so the same key.
  COGS_JOURNAL: IDEMPOTENCY_KEY,
  STOCK_IN_TRANSIT: IDEMPOTENCY_KEY,
  // Shipment revaluations: `shipment-cogs-revalue:<shipment>:<cost layer>:<old>:<new>` — one per change.
  // Refunds: `sales-order-refund:<refund>:cogs-reversal` — fixed per refund.
  COGS_REVERSAL: IDEMPOTENCY_KEY,
  // `sales-order-refund:<refund>:unearned-reversal` — fixed per refund.
  UNEARNED_REV_REVERSAL: IDEMPOTENCY_KEY,
  // FxRevaluation/<date> holds several journals: `unrealised-fx:revaluation:<date>:<side>` and
  // `unrealised-fx:reversal:<date>:<prior row>`. Deterministic: a retry of either reproduces it.
  UNREALISED_FX_JOURNAL: IDEMPOTENCY_KEY,
  // PurchaseInvoice/<bill id> (one realised FX per bill payment, superseded like BILL_PAYMENT) or
  // Payment/<payment id> (one per receipt).
  REALISED_FX_JOURNAL: DOCUMENT,
  // ProductionOrder/<id>: one completion journal per production order.
  MANUFACTURING_JOURNAL: DOCUMENT,
  // ProductionOrder/<id> takes several retrospective cost edits: `MFG_RECLASS:<po>:<hash of old→new lines>`.
  // Different edits differ. The same edit re-saved hashes the same; a DIFFERENT later edit is a different
  // reclass, and the earlier refused one is not discharged by it (review H4).
  MANUFACTURING_RECLASS: IDEMPOTENCY_KEY,
  // DailyBatch/<batch reference>: the reference already names the batch and the journal kind is the type.
  DAILY_BATCH_REVENUE_DEFERRAL: DOCUMENT,
  DAILY_BATCH_INVENTORY_ALLOC: DOCUMENT,
  DAILY_BATCH_GROUP_B: DOCUMENT,
  DAILY_BATCH_INVENTORY_RECONCILIATION: DOCUMENT,
  DAILY_BATCH_COGS_RECONCILIATION: DOCUMENT,
  DAILY_BATCH_TRANSIT_RECONCILIATION: DOCUMENT,
  // Not enqueued anywhere in this build.
  STOCK_ALLOCATION: DOCUMENT,
}

export function accountingPostingKey(params: {
  type: AccountingSyncType | string
  referenceType: string
  referenceId: string
  idempotencyKey?: string
  payload?: Record<string, unknown>
}): AccountingPostingKey {
  const base = { type: String(params.type), referenceType: params.referenceType, referenceId: params.referenceId }
  const rule = (SCOPE_RULES as Record<string, ScopeRule | undefined>)[base.type] ?? IDEMPOTENCY_KEY
  return { ...base, scope: rule({ ...params, type: base.type }) }
}

/**
 * The key of the posting a STORED ROW carries, from exactly the fields the enqueue put there. The
 * idempotency key is `payload._idempotencyKey`, which both connector queues and the in-transaction enqueue
 * stamp verbatim from `params.idempotencyKey` — so this equals `accountingPostingKey(params)` for the row
 * those params created.
 */
export function accountingPostingKeyForRow(row: {
  type: string
  referenceType: string
  referenceId: string
  payload: unknown
}): AccountingPostingKey {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : undefined
  const idempotencyKey = typeof payload?._idempotencyKey === 'string' ? payload._idempotencyKey : undefined
  return accountingPostingKey({ ...row, idempotencyKey, payload })
}
