/**
 * Which accounting CONNECTION a queued payload was composed for (o3d-19gy, o3d-gfh, o3d-s36z).
 *
 * THE DEFECT. An `AccountingSyncLog` row is composed at one moment and posted at another, and between
 * those two moments an operator can disconnect and reconnect to a DIFFERENT organisation. The payload
 * carries naked external ids — `accountingInvoiceId`, `bankAccountId`, contact and item ids, account
 * codes, tax types — every one of them issued by, or meaningful only within, the connection that was
 * live at ENQUEUE time. The connector is then resolved AGAIN by the processor, from whatever is
 * connected now, and nothing compares the two. The likely outcome is a rejected post, which is visible.
 * The bad outcome is an id that HAPPENS to exist in the new organisation, and money lands on an
 * unrelated invoice or bank account.
 *
 * WHAT IS RECORDED, AND WHY IT IS ONLY THE TENANT. The stamp is `"<connector>:<tenantId>"` — deliberately
 * the SAME string `accountingContactProvenance` / `accountingItemProvenance` already use, so the
 * existing `accountingIdProvenanceMatches` is the comparison and there is one format to reason about
 * rather than two. `AccountingToken.connectionGeneration` is a finer identity and is NOT used here: a
 * re-consent to the SAME organisation mints a fresh generation, and that happens routinely (Xero
 * re-creates the Demo company every ~28 days, and widening the granted scopes re-consents without any
 * disconnect at all). Every id in the payload is still perfectly valid across such a re-consent, so
 * matching on the generation would refuse a queue's worth of legitimate work every time an operator did
 * something ordinary — and a guard that cries wolf on the ordinary path is a guard that gets switched
 * off. The tenant is the boundary that actually changes what an id MEANS.
 *
 * WHERE IT LIVES, AND WHY THERE IS NO MIGRATION. In the payload, beside `_postingMode` and
 * `_idempotencyKey`, which are the same kind of fact and are already carried there. That also makes it
 * queryable — Prisma's `payload: { path: [...], equals: ... }` works on it exactly as the idempotency
 * check already does. o3d-s36z asks for a durable COLUMN on `AccountingSyncLog`; this is not that, and
 * the difference is not cosmetic: retention compacts an expired unresolved row to a tombstone that keeps
 * the external id and DROPS the payload (`backReferenceEvidenceTombstone`), so a payload-carried stamp
 * does not survive the retention horizon. See the report on o3d-s36z for what that leaves open.
 *
 * WHAT AN UNSTAMPED PAYLOAD MEANS. "Enqueued before this shipped", and nothing else — the stamp is
 * written by every writer that creates a row (see the callers of `stampAccountingPayloadConnection`), so
 * after one deploy the unstamped population only shrinks. Those rows are ALLOWED through, which is the
 * one place this deliberately does not fail closed: the alternative is to fail every payment already
 * queued at the moment of the deploy, and an operator who has to hand-re-drive a queue of real payments
 * because of a guard is an operator who turns the guard off. o3d-s36z's "legacy unstamped rows
 * QUARANTINED rather than assumed current" is the right rule for the HISTORICAL population that a
 * durable column would cover, spanning months of already-posted rows; the in-flight queue drains within
 * one cron cycle and is a different population with a different cost.
 */

import { accountingIdProvenanceMatches } from './accounting-id-provenance'

/** The payload key. Underscore-prefixed like `_postingMode`, so it cannot collide with a document field. */
export const ACCOUNTING_PAYLOAD_CONNECTION_KEY = '_connectionProvenance'

/**
 * Add the connection stamp to a payload about to be queued.
 *
 * A null/blank provenance (no token for this connector) adds NOTHING rather than a sentinel: an empty
 * stamp would be indistinguishable from an unstamped legacy row to a reader, and inventing a third state
 * that means the same as the second is how a guard acquires a hole. Enqueueing while disconnected is
 * already an ordinary, recoverable state — the row simply waits.
 */
export function stampAccountingPayloadConnection<T extends Record<string, unknown>>(
  payload: T,
  provenance: string | null,
): T & Record<string, unknown> {
  if (!provenance) return payload
  return { ...payload, [ACCOUNTING_PAYLOAD_CONNECTION_KEY]: provenance }
}

/** The connection stamp on a stored payload, or null when the row carries none. */
export function readAccountingPayloadConnection(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[ACCOUNTING_PAYLOAD_CONNECTION_KEY]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Why this queued row must NOT be posted to the connection now active — or null when it may be.
 *
 * Answered BEFORE any remote call, from two values that are both already in hand, so the refusal costs
 * nothing and nothing has been sent when it fires. It cannot make the enqueue-to-post window atomic —
 * a rebinding that commits between this check and the request still exists, and closing THAT is the
 * remaining half of o3d-gfh — but it turns a window measured in hours into one measured in the
 * milliseconds of a single call, and it is the only check that sees the reconnect at all.
 *
 * `activeProvenance` of null means no token for this connector. That is NOT treated as a mismatch: the
 * post is about to fail with "Not connected" anyway, and manufacturing a second, differently-worded
 * failure for the ordinary disconnected state would bury the one refusal that means something.
 */
export function accountingPayloadConnectionRefusal(params: {
  payload: unknown
  activeProvenance: string | null
  type: string
  referenceType: string
  referenceId: string
}): string | null {
  const stamped = readAccountingPayloadConnection(params.payload)
  if (stamped === null) return null
  if (params.activeProvenance === null) return null
  if (accountingIdProvenanceMatches(stamped, params.activeProvenance)) return null

  return (
    `Refused to post ${params.type} for ${params.referenceType} ${params.referenceId}: it was queued for `
    + `accounting connection ${stamped}, and this instance is now connected to ${params.activeProvenance}. `
    + 'The external ids in this payload — the invoice or bill id, the bank account, the contact and item '
    + 'ids, the account codes and tax types — were all issued by, or only mean anything in, the '
    + 'organisation it was queued for. Posting it now would either be rejected outright or, worse, land '
    + 'on whatever unrelated document happens to hold the same id in the new organisation. Nothing was '
    + 'sent. If the reconnection was deliberate, this row belongs to the previous ledger: settle it '
    + 'there, or cancel it and re-queue the work from the source document so the payload is rebuilt '
    + 'against the organisation that is connected now.'
  )
}
