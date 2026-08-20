/**
 * WHAT A CONNECTOR'S IDEMPOTENCY KEY IS WORTH — TO AN OPERATOR *AND* TO A WORKER (o3d-wahn).
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
 * AND THE AUTOMATIC PATH IS NO BETTER — THE SAME ARITHMETIC CONDEMNS IT (round 2, finding 1). The
 * sentence above was written about the manual control, but nothing in it is specific to a human. Put
 * the real numbers side by side:
 *
 *   in-request 429 retry (connectors/xero/api.ts)   <= XERO_MAX_RETRIES (3) waits of at most
 *                                                   XERO_MAX_RETRY_AFTER_MS (90s) = 4m30s worst case,
 *                                                   same `init`, same Idempotency-Key header.
 *                                                   INSIDE the window. Also the case that needs it
 *                                                   least: a 429 was refused before Xero processed it.
 *
 *   row/outbox retry (integrations/outbox.ts)       DEFAULT_RETRY_BASE_DELAY_MS = 5 MINUTES for the
 *                                                   first retry, doubling to 10, 20, 40 (capped 60),
 *                                                   and only claimable on the next 5-minute
 *                                                   `accounting-sync` cron tick. Measured from the
 *                                                   FIRST call — which happened before that backoff
 *                                                   started — the first retry sits at or past the
 *                                                   six-minute line and every later one is far past it.
 *
 * So the retries that could actually duplicate something — the ones where the first attempt may have
 * REACHED Xero (a timeout, a dropped response, a crash between the post and its local record) are
 * never retried in-process; they come back minutes later through the outbox. The deterministic key
 * has never protected them. Any comment or runbook line that says a retry is safe "because the key is
 * deterministic" is stating a premise that expired before the retry was scheduled.
 *
 * WHAT ACTUALLY PROTECTS AN AUTOMATIC RETRY, then, operation by operation — none of it the key:
 *
 *  1. SALES_INVOICE create. Xero's `POST /Invoices` is UPDATE-OR-CREATE keyed on InvoiceNumber, and
 *     the sales push sends the order number (connectors/xero/invoices.ts). A re-post therefore
 *     REPLACES the invoice it already created rather than adding a second. This is real, and it is
 *     the same property that made o3d-6l3 dangerous on the purchase side, where the number is not
 *     ours and not unique: what is an overwrite hazard for a bill is duplicate protection here.
 *
 *  2. Everything else — bill create (PUT /Invoices, create-only), `POST /Payments`, credit-note
 *     allocation, `POST /ManualJournals` — has no natural key Xero deduplicates on. What stands
 *     between a retry and a duplicate is entirely LOCAL: the `externalTransactionId` written on the
 *     sync log in the same transaction as its mirrored event, which makes the next attempt take the
 *     `if (entry.externalTransactionId)` short-circuit and post nothing. That record is the
 *     protection, which is why the pool bound must never be allowed to deny it — see
 *     `persistAfterRemoteWrite` (lib/db/post-remote-persist.ts).
 *
 *  3. When even that record is lost (the post landed, the process died before it committed), NOTHING
 *     PREVENTS the duplicate. Nothing probes Xero before re-posting: the payment branch calls
 *     `POST /Payments` directly, with no prior GET. What is left is detection, after the fact and
 *     needing a human:
 *       - `settlementStatus` (domain/accounting/settlement-status.ts) — reads the payment sync row
 *         back against the document total and returns OVER_SETTLED / PARTIALLY_SETTLED / LEDGER_*
 *         with `discrepancy: true`;
 *       - the `accounting-payment-poll` (every 15 minutes) and `accounting-payment-reconcile` (daily) crons,
 *         which ask Xero its current status for every locally-linked document;
 *       - the reconciliation report's `duplicate_external_reference` / `event_without_source`
 *         findings (domain/accounting/reconciliation.ts).
 *     Say that plainly rather than implying a guarantee: for a money-moving follow-up the last
 *     preventive control is `planFollowUpEnqueue`'s refusal on an ambiguous token history, and after
 *     that the ledger is the only witness.
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
