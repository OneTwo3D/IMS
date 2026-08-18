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
 * on the parked-refunds section of Sync → Exceptions. It takes a NET allocation across the order's own
 * lines, raises the credit note through the ordinary refund path (line-linked, so each line carries its
 * OWN VAT identity and the uniform-tax refusal does not apply), stamps the storefront refund id on it so
 * a later redelivery dedups instead of double-crediting, and marks the park resolved.
 *
 * Keep this text and that action in step: if the action moves or changes shape, this message is the
 * thing an operator will be following.
 */
export const REFUND_PARK_MANUAL_RESOLUTION_HINT =
  'To clear it: open Sync → Exceptions, find this row and use "Record manually" — allocate the refunded ' +
  'amount across the order lines it actually covers, entering NET (tax-exclusive) amounts, which are ' +
  're-grossed at each line\'s own VAT rate. You will need the storefront refund breakdown to do that: ' +
  'which items and which tax rates the refunded amount covered. That raises the IMS credit note against ' +
  'those lines and resolves this row. Retry cannot clear it — retrying re-runs the same conversion ' +
  'against the same order.'
