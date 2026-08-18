/**
 * o3d-w00 (Codex r1 #3): the completion path for a refund that was QUARANTINED because IMS could not
 * determine, on its own, how to record it.
 *
 * Two refusals produce such a park, and neither is transient:
 *   - the monetary-only gross→net basis cannot be established (resolveMonetaryRefundVatRate), and
 *   - the order is not uniformly taxed, so an unattributed monetary SALE line cannot be posted under a
 *     single VAT identity (createSalesOrderRefund).
 *
 * In both cases the money has ALREADY left the storefront and no credit note exists, so no amount of
 * retrying can finish the job — retry re-runs the identical decision against the identical order. The
 * park therefore needs a human-completable end, and "record it against the specific lines it covers"
 * is only a real instruction if a screen exists that does exactly that AND resolves the park.
 *
 * It does: `recordRefundParkManually` in app/actions/sync-exceptions.ts, surfaced as "Record manually"
 * on the parked-refunds section of Sync → Exceptions. It takes a GROSS allocation across the order's own
 * lines AND its shipping charge, raises the credit note through the ordinary refund path (line-linked, so
 * each line carries its OWN VAT identity and the uniform-tax refusal does not apply), stamps the
 * storefront refund id on it so a later redelivery dedups instead of double-crediting, and marks the park
 * resolved.
 *
 * o3d-w00 (Codex r2 #2/#3): the amounts are GROSS and must add up to the refund the storefront made —
 * the credit note has to SETTLE the parked refund, and gross is the only figure an operator actually has.
 * Shipping is one of the targets, because a refund that included postage otherwise could not be described
 * at all. Say GROSS here, because this text is the instruction an operator follows.
 *
 * Keep this text and that action in step: if the action moves or changes shape, this message is the
 * thing an operator will be following.
 */
export const REFUND_PARK_MANUAL_RESOLUTION_HINT =
  'To clear it: open Sync → Exceptions, find this row and use "Record manually" — allocate the refunded ' +
  'amount across the order lines (and the shipping charge) it actually covers, entering GROSS ' +
  '(tax-inclusive) amounts that add up to the refund the storefront made. Each is converted to net at ' +
  'the VAT rate its credit will be posted at. You will need the storefront refund breakdown to do that: ' +
  'which items, which shipping, and which tax rates the refunded amount covered. That raises the IMS ' +
  'credit note against those parts of the order and resolves this row. Retry cannot clear it — retrying ' +
  're-runs the same conversion against the same order.'
