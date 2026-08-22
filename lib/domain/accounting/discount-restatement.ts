/**
 * o3d-y14 r4 finding 1 — THE DURABLE PROOF THAT A ROW'S ORDER-LEVEL DISCOUNT WAS RESTATED,
 * and of what the ledger held at the instant it was.
 *
 * WHY A COLUMN EXISTS AT ALL. `resolvePostedOrderDiscount` has to answer, for a chargeback that will
 * become a real credit note, "what order-level discount did the document for this order actually
 * charge?". For a row nobody restated the answer is trivially the column. For a row the o3d-y14
 * backfill restated the column is deliberately NOT what the document charged, so the answer has to
 * come from somewhere else — and where it cannot, the only safe answer is "I don't know", never "the
 * column".
 *
 * THE STATE THAT FORCED THIS. An earlier revision read the absence of every ledger trace — no
 * mirrored `AccountingEvent`, no `accountingInvoiceId`, no surviving SYNCED sync log — as "nothing
 * ever posted for this order, so the column stands". Every one of those three can go missing while a
 * real invoice sits in Xero:
 *
 *   - the mirrored event is created on a BEST-EFFORT basis (`queueXeroSync` catches a mirror failure,
 *     logs it and lets the enqueue commit), and invoices posted before mirroring existed never had one;
 *   - `accountingInvoiceId` is written AFTER the post, in a separate step, and o3d-9kek exists
 *     precisely because that write can fail — the document is real and the column says NULL;
 *   - the SYNCED sync log is DELETED by `purgeExpiredData` past the retention horizon, and a
 *     chargeback follows a payment dispute, which routinely arrives months after the invoice.
 *
 * So "no evidence" and "no invoice" are different states with opposite consequences, and nothing
 * that can be pruned may be used to tell them apart. This column is written in the SAME `UPDATE` as
 * the restatement itself, so it exists for exactly the rows the question is about, it records the
 * posting evidence the backfill read UNDER ITS OWN LOCK, and nothing prunes it.
 *
 * WHAT ITS ABSENCE MEANS, and why that is safe. NULL means "this row's order-level discount was
 * never restated", which covers every native, manual and pre-column order, every order the fixed
 * WooCommerce importer wrote, and every row the backfill's stamp-only pass marked as ALREADY correct
 * (that pass changes no amount, so its column still says what any document for it charged). For all
 * of them the live column is the posted figure by construction, and the resolver never queries the
 * ledger at all.
 *
 * That reading is only sound because the marker and the amount move together: `applyWcCouponCorrection`
 * writes them in one compare-and-set `UPDATE`, so there is no window in which a restated row is
 * markerless. A restatement written by anything OTHER than that function — a hand-run UPDATE, an
 * older build of the backfill — would be invisible here, which is the one assumption this design
 * rests on and the reason the backfill refuses to run its apply phase without the reviewed allowlist.
 */

/** The `kind` discriminator stored in the column. Anything else is not a marker this code wrote. */
export const DISCOUNT_RESTATEMENT_KIND = 'order-discount-restatement'

/** Bumped only if the shape changes incompatibly; an unknown version is refused, never guessed at. */
export const DISCOUNT_RESTATEMENT_VERSION = 1

/** Which corrective process restated the row. One value today; recorded so a second one is legible. */
export type DiscountRestatementReason = 'o3d-y14-wc-coupon'

/**
 * What the accounting system held for this order at the instant of the restatement, copied from the
 * evidence the backfill read under the sales-order row lock.
 */
export type DiscountRestatementLedgerEvidence = {
  /** `SalesOrder.accountingInvoiceId` at that instant. */
  accountingInvoiceId: string | null
  /**
   * External ids of SYNCED sales-invoice sync logs at that instant. NOT redundant with the column
   * above: o3d-9kek is a post that succeeded and never wrote its id back, so a real document lives
   * here and NULL lives there.
   */
  postedInvoiceExternalIds: string[]
  /**
   * The Group A1 batch that had already deferred this order's revenue from the pre-restatement
   * amount. Recorded because it is part of the manual-adjustment handoff — but see
   * `restatementHadPostedInvoice`: it is NOT an invoice and says nothing about what any document
   * charged, so it does not gate the chargeback.
   */
  revenueDeferredBatchRef: string | null
}

export type DiscountRestatement = {
  kind: typeof DISCOUNT_RESTATEMENT_KIND
  version: typeof DISCOUNT_RESTATEMENT_VERSION
  reason: DiscountRestatementReason
  /** ISO instant of the restating write. */
  at: string
  /** The order-level discount before the restatement, in the order's own currency. */
  from: number
  /** And after. */
  to: number
  currency: string
  ledger: DiscountRestatementLedgerEvidence
}

export type DiscountRestatementRead =
  /** The column is NULL: this row was never restated. */
  | { present: false }
  | { present: true; ok: true; value: DiscountRestatement }
  /** Present but not a marker this code can read. NEVER treated as absent — see the header. */
  | { present: true; ok: false; detail: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Build the marker for one restated order. Exported so the writer (the backfill) and the reader
 * (`resolvePostedOrderDiscount`) cannot drift into two different shapes.
 */
export function buildDiscountRestatement(input: {
  reason: DiscountRestatementReason
  at: Date
  from: number
  to: number
  currency: string
  ledger: DiscountRestatementLedgerEvidence
}): DiscountRestatement {
  return {
    kind: DISCOUNT_RESTATEMENT_KIND,
    version: DISCOUNT_RESTATEMENT_VERSION,
    reason: input.reason,
    at: input.at.toISOString(),
    from: input.from,
    to: input.to,
    currency: input.currency,
    ledger: {
      accountingInvoiceId: input.ledger.accountingInvoiceId,
      postedInvoiceExternalIds: [...input.ledger.postedInvoiceExternalIds],
      revenueDeferredBatchRef: input.ledger.revenueDeferredBatchRef,
    },
  }
}

/**
 * Read `SalesOrder.discountRestatement`.
 *
 * Every field is checked rather than cast. A marker that cannot be fully read is reported as
 * unreadable, not silently narrowed to its readable parts and not treated as absent: absent means
 * "never restated", which is the one conclusion a damaged marker must never be able to produce.
 */
export function readDiscountRestatement(value: unknown): DiscountRestatementRead {
  if (value === null || value === undefined) return { present: false }
  if (!isRecord(value)) return { present: true, ok: false, detail: 'it is not an object' }
  if (value.kind !== DISCOUNT_RESTATEMENT_KIND) {
    return { present: true, ok: false, detail: `its kind is ${JSON.stringify(value.kind)}` }
  }
  if (value.version !== DISCOUNT_RESTATEMENT_VERSION) {
    return { present: true, ok: false, detail: `its version is ${JSON.stringify(value.version)}` }
  }
  if (value.reason !== 'o3d-y14-wc-coupon') {
    return { present: true, ok: false, detail: `its reason is ${JSON.stringify(value.reason)}` }
  }
  if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) {
    return { present: true, ok: false, detail: `its timestamp is ${JSON.stringify(value.at)}` }
  }
  if (!isFiniteNumber(value.from) || !isFiniteNumber(value.to)) {
    return {
      present: true,
      ok: false,
      detail: `its amounts are ${JSON.stringify(value.from)} -> ${JSON.stringify(value.to)}`,
    }
  }
  if (typeof value.currency !== 'string' || !value.currency.trim()) {
    return { present: true, ok: false, detail: `its currency is ${JSON.stringify(value.currency)}` }
  }
  const ledger = value.ledger
  if (!isRecord(ledger)) {
    return { present: true, ok: false, detail: 'it records no ledger evidence' }
  }
  const invoiceId = ledger.accountingInvoiceId
  if (invoiceId !== null && typeof invoiceId !== 'string') {
    return { present: true, ok: false, detail: `its accountingInvoiceId is ${JSON.stringify(invoiceId)}` }
  }
  const externalIds = ledger.postedInvoiceExternalIds
  if (!Array.isArray(externalIds) || externalIds.some((id) => typeof id !== 'string')) {
    return {
      present: true,
      ok: false,
      detail: `its postedInvoiceExternalIds are ${JSON.stringify(externalIds)}`,
    }
  }
  const batchRef = ledger.revenueDeferredBatchRef
  if (batchRef !== null && typeof batchRef !== 'string') {
    return { present: true, ok: false, detail: `its revenueDeferredBatchRef is ${JSON.stringify(batchRef)}` }
  }

  return {
    present: true,
    ok: true,
    value: {
      kind: DISCOUNT_RESTATEMENT_KIND,
      version: DISCOUNT_RESTATEMENT_VERSION,
      reason: 'o3d-y14-wc-coupon',
      at: value.at,
      from: value.from,
      to: value.to,
      currency: value.currency,
      ledger: {
        accountingInvoiceId: invoiceId,
        postedInvoiceExternalIds: externalIds as string[],
        revenueDeferredBatchRef: batchRef,
      },
    },
  }
}

/**
 * Did a SALES INVOICE exist for this order when it was restated?
 *
 * Both invoice signals count, for the reason the backfill reads both: `accountingInvoiceId` alone
 * answers "no" about a document that exists whenever the back-reference write failed (o3d-9kek).
 *
 * The revenue-deferral batch reference deliberately does NOT count. A Group A1 journal is
 * `subtotal + shipping − discount` posted against the batch, not a sales invoice, and it carries no
 * order-discount line for a credit note to mirror — so an order that had only a batch deferral has
 * no earlier DOCUMENT figure to recover, and its live column is still the one a credit note reverses.
 * It is recorded on the marker because it is part of the operator's manual-adjustment handoff.
 */
export function restatementHadPostedInvoice(restatement: DiscountRestatement): boolean {
  return !!restatement.ledger.accountingInvoiceId || restatement.ledger.postedInvoiceExternalIds.length > 0
}
