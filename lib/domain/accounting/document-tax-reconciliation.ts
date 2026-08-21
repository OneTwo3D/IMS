/**
 * A DOCUMENT IMS ALREADY KNOWS IS WRONG MUST NOT REACH THE LEDGER (o3d-cyn round 3).
 *
 * Round 2 established, per component, whether the accounting document will produce the tax the shop
 * actually charged (`reconcileWcDocumentTax`) and whether the shipping line can be given a tax type
 * at all (`resolveWcShippingTaxRate`). What it did with the answer was withhold the PAYMENT: the
 * invoice was still posted, at a total IMS had just computed to be wrong, and the only trace was an
 * activity-log line — and only when the order happened to be paid.
 *
 * THAT IS THE WRONG HALF TO WITHHOLD. The payment is recoverable: register it later and the ledger
 * is right. The invoice is not — once an AUTHORISED receivable is in Xero at the wrong total it is
 * on the VAT return, on the customer statement, and on the aged-debt report, and taking it back is a
 * credit note plus a re-post plus an explanation. Refusing to post is a delay; posting is damage.
 *
 * So the importer STAMPS the document instead of correcting it, and the poster REFUSES a stamped
 * document before any request is built. The refusal is an ordinary sync failure, which means:
 *
 *   - the row is visible on /sync with the reason on it, rather than silence;
 *   - `documentPosted` stays false, so `settlementStatus` says "the document sync is what to chase,
 *     not the payment" — which is now exactly true;
 *   - the remedy (map the shop's shipping tax rate in IMS, then re-import the order) produces a NEW
 *     payload with no marker, and that one posts.
 *
 * FAIL CLOSED ON THE MARKER'S SHAPE. The stamp travels through a `Json` column and back, so the
 * poster cannot assume it round-tripped as written. Anything at all under the key refuses; only its
 * ABSENCE posts. A marker that arrived unreadable is still a marker — the document was stamped
 * because it is wrong, and forgetting why does not make it right.
 */

/**
 * Payload key the stamp travels under. Underscore-prefixed like the payload's other control fields
 * (`_postingMode`, `_registerPayment`, `_idempotencyKey`), which the connectors read and never send.
 */
export const UNRECONCILED_TAX_PAYLOAD_KEY = '_taxUnreconciled'

export type UnreconciledTaxMarker = {
  /** Operator-facing sentence naming why the document will not total to the order, and what to do. */
  reason: string
}

export function buildUnreconciledTaxMarker(reason: string): UnreconciledTaxMarker {
  return { reason }
}

/**
 * Refuse to post a document the importer stamped as not totalling to its order.
 *
 * Returns `{ post: true }` for every payload without the key — which is every document IMS raises
 * itself and every imported one whose tax reconciles — so this can sit in front of the create and
 * the update without changing either.
 */
export function refuseUnreconciledDocument(
  payload: Record<string, unknown>,
): { post: true } | { post: false; reason: string } {
  if (!(UNRECONCILED_TAX_PAYLOAD_KEY in payload)) return { post: true }

  const marker = payload[UNRECONCILED_TAX_PAYLOAD_KEY]
  const stated =
    typeof marker === 'object' && marker !== null && typeof (marker as { reason?: unknown }).reason === 'string'
      ? (marker as { reason: string }).reason.trim()
      : ''

  return {
    post: false,
    reason:
      'NOTHING WAS SENT. This document was marked at import as one that will NOT total to its order: '
      + (stated
        // A stamp that did not survive the round trip is still a stamp — see the header.
        || 'the tax it would produce disagrees with the tax the shop charged, and the reason recorded with it '
          + 'could not be read back. Re-import the order to rebuild the document and the reason.')
      + ' Posting it would put a receivable in the ledger at a total nobody reconciles against, which a payment '
      + 'for the order total then PART-settles for ever. Fix the tax-rate mapping in IMS and re-import the order; '
      + 'the rebuilt document posts normally.',
  }
}
