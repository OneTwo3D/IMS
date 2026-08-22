/**
 * The queued row a Xero/accounting request is being made ON BEHALF OF, so the connection check can be
 * made against the tenant that is actually about to go out on the wire (o3d-gfh, Codex r1 finding 3).
 *
 * THE GAP THIS CLOSES. `accountingPayloadConnectionVerdict` compares the row's origin stamp against "the
 * connection now active". Until now the processor obtained that second value by reading the
 * `AccountingToken` row itself, at the top of `processEntry`, and the request obtained it AGAIN, from its
 * own `getAccessToken()`, some time later. Two independent selections of the same thing: checked at T1,
 * used at T2. A disconnect-and-reconnect committing between them — and a rate-limited entry can sit
 * between them for tens of seconds, sleeping on a Retry-After — passed a check against organisation B and
 * then addressed the request to organisation C. The window is small and it is the whole incident: o3d-t74p
 * was days of syncs aimed at a ledger nobody had decided to aim them at.
 *
 * `invnum` closed this exact shape by moving the check into a closure run immediately before the request
 * left, and `small2` stated the rule it comes from: A PERMISSION IS EVALUATED IN EXACTLY ONE PLACE,
 * IMMEDIATELY BEFORE THE ACT IT AUTHORISES. So the authorising evaluation now happens inside
 * `performRequest`, against `auth.tenantId` — the very string that will be written into the
 * `Xero-Tenant-Id` header of the request being sent — and there is no longer any gap for a rebinding to
 * land in, because the auth that is checked and the auth that is used are one object.
 *
 * WHY AN AMBIENT INTENT RATHER THAN A PARAMETER. The alternative is threading an `authorize` callback
 * from `processEntry` through thirty case arms and nine connector modules to twenty-odd call sites. This
 * file's own sibling comment already says why that fails: "a check the next arm has to remember to repeat
 * is one the next arm will forget". An intent established once at the top of `processEntry` covers every
 * remote call that entry makes — the write, and equally the contact/item lookups that cache ids from the
 * response — including calls made by code added later that has never heard of this rule. It is the same
 * argument the release-receipt control makes for living on a database trigger: cover the writers the
 * repo does not know about.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. A Xero call made outside a queued row — a UI action, the poller,
 * the tax-rate sweep — has no stamped payload, so there is nothing to compare and no intent is set. That
 * is a different question, and it has a different answer: `tenant-guard.ts` decides which organisations
 * this instance may address at all, on every use of the stored token. This file only answers "does the
 * row in hand belong to the ledger this request is about to reach". Absence of an intent therefore means
 * "not a queued post", not "checked and fine" — and the two are never merged, because a request with no
 * intent has no row whose origin could be checked.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { accountingIdProvenanceFor } from './accounting-id-provenance'
import { accountingPayloadConnectionVerdict } from './accounting-connection-provenance'

export type AccountingPostingIntent = {
  /** The connector whose queue this row belongs to, e.g. `'xero'`. */
  connector: string
  /** The stored payload, exactly as it came out of the database — including its origin stamp. */
  payload: unknown
  /**
   * o3d-dzip: the row's `connectionProvenance` column — the half of its origin record that survives
   * retention's payload compaction. Read from the SAME `findUnique` as `payload`
   * (readClaimedSyncLogOriginRecord), so the pair can never be assembled from two moments.
   *
   * REQUIRED, not optional, and that is the point: an intent built without it would silently narrow
   * every verdict back to the payload, and a compacted row would go back to reading as
   * `no-origin-recorded` while looking exactly like a checked one. The compiler is what stops a call
   * site being added that forgets.
   */
  connectionProvenance: string | null
  /**
   * o3d-dzip (Codex r1 finding 1): the row's `backReferenceEvidenceCompactedAt`, from that same
   * `findUnique`. It is the only durable evidence that a SILENT payload is silent because retention
   * emptied it rather than because something rewrote it, and without it the verdict cannot accept the
   * column alone. REQUIRED for the same reason as the column: an intent that omitted it would turn
   * every compacted row back into a refusal while still looking checked.
   */
  backReferenceEvidenceCompactedAt: Date | null
  type: string
  referenceType: string
  referenceId: string
}

const postingIntent = new AsyncLocalStorage<AccountingPostingIntent>()

/**
 * Run `fn` with every accounting request inside it attributed to this queued row.
 *
 * Nesting is allowed and the INNERMOST wins, which is the right direction: a nested intent can only ever
 * be a narrower, more specific statement of what is being posted.
 */
export function withAccountingPostingIntent<T>(intent: AccountingPostingIntent, fn: () => Promise<T>): Promise<T> {
  return postingIntent.run(intent, fn)
}

/** The row the current request is being made for, or null outside a queued post. */
export function currentAccountingPostingIntent(): AccountingPostingIntent | null {
  return postingIntent.getStore() ?? null
}

/**
 * THE authorising evaluation. Why the request about to be sent to `tenantId` must not be — or null.
 *
 * Called from exactly one place, immediately before the request leaves. `connector` and `tenantId` come
 * from the resolved auth the outgoing request is built from, so the value checked and the value used are
 * the same value rather than two reads of one row.
 *
 * Returns null when there is no intent: this request is not a queued post, so this rule has nothing to
 * say about it. That is not the "absence reads as permission" hole — the absent thing here is the
 * QUESTION, not the answer. When there IS a row, every way of failing to read it refuses; see
 * `accountingPayloadConnectionVerdict`.
 */
export function accountingPostingIntentRefusal(connector: string, tenantId: string | null | undefined): string | null {
  const intent = currentAccountingPostingIntent()
  if (!intent) return null
  // A request made under a Xero auth cannot authorise a QuickBooks row and vice versa. Comparing the
  // stamps would catch it anyway (the stamp carries the connector), but stopping here keeps the refusal
  // wording honest about which connector is speaking.
  if (intent.connector !== connector) return null

  return accountingPayloadConnectionVerdict({
    payload: intent.payload,
    connectionProvenance: intent.connectionProvenance,
    backReferenceEvidenceCompactedAt: intent.backReferenceEvidenceCompactedAt,
    activeProvenance: accountingIdProvenanceFor(connector, tenantId),
    type: intent.type,
    referenceType: intent.referenceType,
    referenceId: intent.referenceId,
  }).refusal
}
