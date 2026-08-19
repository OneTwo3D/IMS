/**
 * WHAT A CONNECTOR'S IDEMPOTENCY KEY IS WORTH WHEN AN OPERATOR PRESSES RETRY (o3d-wahn).
 *
 * Re-queueing a failed accounting sync row is safe ONLY while the connector still remembers the
 * idempotency key the first attempt sent. Our keys are deterministic — `buildXeroIdempotencyKey`
 * derives them from the entry id — so a re-post sends the SAME key, and the connector, the only party
 * that knows whether the first call landed, returns the existing document instead of creating a
 * second one. Past the connector's retention window that argument evaporates: the same key is treated
 * as a brand new request, and a first call that DID land quietly becomes a duplicate invoice or
 * payment in the ledger. o3d-wahn was filed because nobody had established the window.
 *
 * XERO'S WINDOW IS SIX MINUTES. Not hours, not a day — six minutes, from the vendor's own
 * documentation:
 *
 *   "Idempotency keys are intended to help resolve transient issues only and so keys are stored for
 *    6 minutes from the time of the first call, after which they expire. Repeating the same key after
 *    expiry won't produce this error and will instead be processed as a new key, this should be
 *    avoided."
 *   — https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/
 *
 * THAT IS THE FINDING, and it inverts the assumption the retry was built on. The window is designed
 * for an automatic retry moments after a network blip; it is far shorter than any human notices a
 * failure, opens /sync and presses a button. A row only becomes FAILED after its automatic retries are
 * exhausted, so by the time the manual control is even offered the key has long since expired. A
 * manual retry therefore gets NO duplicate protection from the connector, essentially always.
 *
 * WHICH IS WHY THIS DOES NOT REFUSE. Enforcing the window against `processingStartedAt` would refuse
 * every retry the UI offers and delete the only remedy an operator has for a row that failed for a
 * reason they have since fixed. The obligation is discharged the other way the issue allows: say so
 * at the control, in the operator's own terms, so the check they have to make — look in Xero first —
 * is stated rather than assumed. `isWithinXeroIdempotencyWindow` is here for the rare genuinely-fresh
 * row, and to keep the comparison the issue asked for a real one rather than a rhetorical one.
 *
 * QUICKBOOKS' `RequestId` window is deliberately NOT recorded here. It is unestablished, and this
 * helper says nothing about connectors whose window nobody has verified rather than guessing one —
 * a caution quoting a made-up number is worse than no caution, because it would be believed.
 */

/** Xero's Idempotency-Key retention, from the vendor documentation quoted above. */
export const XERO_IDEMPOTENCY_KEY_RETENTION_MS = 6 * 60 * 1000

/** The page the window above is quoted from; cited in the UI so the claim is checkable. */
export const XERO_IDEMPOTENCY_RETENTION_DOC_URL =
  'https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/'

/**
 * Is this row's first attempt recent enough that Xero would still recognise its idempotency key?
 *
 * `processingStartedAt` is when the attempt reached the connector, which is what the window is
 * measured from. A row with no stamp has no attempt to be idempotent about — treated as OUTSIDE the
 * window, because "we do not know when it was posted" must never read as "it is safe".
 */
export function isWithinXeroIdempotencyWindow(
  processingStartedAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!processingStartedAt) return false
  const started = typeof processingStartedAt === 'string' ? new Date(processingStartedAt) : processingStartedAt
  if (Number.isNaN(started.getTime())) return false
  const age = now.getTime() - started.getTime()
  return age >= 0 && age < XERO_IDEMPOTENCY_KEY_RETENTION_MS
}

/**
 * The caution to show beside a retry control, or null when we have not established a window for that
 * connector and so have nothing honest to say.
 */
export function accountingRetryDuplicateCaution(connector: string | null | undefined): string | null {
  if (connector !== 'xero') return null
  return 'Xero remembers an idempotency key for only 6 minutes, so a row that has been failed for '
    + 'longer is re-posted as a NEW request. If the original attempt actually reached Xero, re-queueing '
    + 'it creates a SECOND document. Check Xero for the invoice, bill or payment before re-queueing.'
}
