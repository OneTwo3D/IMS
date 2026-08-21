/**
 * PERMISSIONS THAT MUST STILL HOLD AT THE INSTANT A REQUEST LEAVES THIS PROCESS (o3d-k26m.5 r6).
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ------------------------------------------------------------------------------------------------
 * `small2` stated the rule: A PERMISSION IS EVALUATED IN EXACTLY ONE PLACE, IMMEDIATELY BEFORE THE
 * ACT IT AUTHORISES. Round 5 of the invoice-number fence applied it by moving the ownership check out
 * of the caller and into a closure that `pushSalesInvoice` runs as its last statement before
 * `xeroPost`.
 *
 * THAT TURNED OUT NOT TO BE IMMEDIATELY BEFORE THE WRITE. `xeroPost` is not a socket; it is
 * `xeroFetch` → `getAccessToken()` (which can refresh a token over the network) → `xeroFetchWithAuth`
 * → `performRequest`, and `performRequest` opens with `waitForBudget` — a loop that SLEEPS until the
 * tenant has minute-budget — and then retries a 429 up to XERO_MAX_RETRIES times, sleeping as long as
 * XERO_MAX_RETRY_AFTER_MS (90s) between attempts. So "just before xeroPost" can be minutes before the
 * bytes move, and every one of those minutes is inside the gap round 5 set out to close. The check was
 * one layer higher than the act it authorises.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY AMBIENT, AND WHY THIS IS THE SIBLING'S SEAM RATHER THAN A SECOND ONE
 * ------------------------------------------------------------------------------------------------
 * The sibling branch `o3d-batch-realm` hit exactly this shape for a different question — is the
 * organisation this request is addressed to the one the queued row was raised against? — and answered
 * it by establishing the posting intent ambiently (`AsyncLocalStorage`) and reaching the verdict
 * INSIDE `performRequest`, against `auth.tenantId`, as the last statement before the socket. It then
 * DELETED its earlier pre-check rather than keeping it as a harmless early refusal, on the ground that
 * a refusal produced from a stale read is as wrong as a permission produced from one.
 *
 * This module is that seam, generalised by one step so both questions are asked at one point rather
 * than at two. The mechanism — ambient scope, evaluated inside `performRequest` — is single; what it
 * carries is a list, because "which ledger may this reach" and "is this number still ours to write"
 * are two questions, not two answers to one. TWO PLACEMENTS WOULD BE THE DEFECT; two entries in one
 * placement are not.
 *
 * ON MERGE WITH `o3d-batch-realm`, COLLAPSE THE TWO CALLS INTO ONE. That branch's
 * `accountingPostingIntentRefusal(connector, auth.tenantId)` should be registered here — an
 * `withAccountingEgressAuthorization` around the body of `processEntry`, whose `authorize` returns
 * that function's refusal — and its bespoke call in `performRequest` deleted, leaving exactly one
 * evaluation site. Its verdict is a pure function of an `auth` that is fixed for the whole call, so
 * being re-asked per attempt (see below) is idempotent and costs one string comparison.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY A PARAMETER WOULD NOT DO
 * ------------------------------------------------------------------------------------------------
 * `pushSalesInvoice` already takes the check as a parameter; that is not the problem and it stays. The
 * parameter cannot reach `performRequest` without being threaded through `xeroPost` → `xeroFetch` →
 * `xeroFetchWithAuth`, i.e. through the signature of every Xero call in the codebase, so that every
 * unrelated caller carries a field it never sets. Ambient scope puts the value where the evaluation
 * is without touching a single transport signature.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THE SCOPE IS NARROW, AND WHY THAT IS THE OPPOSITE CHOICE FROM `realm`
 * ------------------------------------------------------------------------------------------------
 * `realm` establishes its intent around the WHOLE entry, deliberately, because its question ("is this
 * the right ledger?") has the same answer for every call the entry makes and the danger is an arm that
 * forgets to ask.
 *
 * The invoice-number authorisation is the opposite: it TAKES AN EXCLUSIVE SLOT and stamps the
 * database. Establishing it around the whole entry would mean the contact lookup and every item lookup
 * took the slot too — which is round 4's placement, the one round 5 removed, reintroduced from the
 * other end. So a caller scopes it around the ONE call whose write it authorises, and nothing else in
 * the entry sees it. Narrow scope is a property of that particular authorisation, not of this seam.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export type AccountingEgressAuthorization = {
  /** The connector whose egress this authorises, e.g. `'xero'`. Requests by others ignore it. */
  connector: string
  /** Short identifier, used only in diagnostics and tests. Never part of a verdict. */
  name: string
  /**
   * Why the request about to be sent must not be — or `null` to let it through.
   *
   * Called immediately before the bytes move, ON EVERY ATTEMPT (see `accountingEgressRefusal`). It may
   * read and write the database; it must not perform the act it is authorising.
   */
  authorize: () => Promise<string | null>
}

const scope = new AsyncLocalStorage<readonly AccountingEgressAuthorization[]>()

/**
 * Run `fn` with `authorization` applying to every connector request made inside it.
 *
 * Nesting ACCUMULATES rather than the innermost winning. These are preconditions on an irreversible
 * write, and a narrower statement of what is being posted does not repeal a wider one — if an outer
 * scope says this row is no longer ours, an inner scope saying the number is still ours does not make
 * the write safe. Every authorisation in scope must clear, in the order they were established, and the
 * FIRST refusal is the one reported (so the outermost, most general reason is the one an operator
 * sees).
 */
export function withAccountingEgressAuthorization<T>(
  authorization: AccountingEgressAuthorization,
  fn: () => Promise<T>,
): Promise<T> {
  const outer = scope.getStore() ?? []
  return scope.run([...outer, authorization], fn)
}

/** The authorisations a `connector` request made right now would have to clear. Diagnostics and tests. */
export function currentAccountingEgressAuthorizations(connector: string): readonly AccountingEgressAuthorization[] {
  return (scope.getStore() ?? []).filter((entry) => entry.connector === connector)
}

/**
 * THE authorising evaluation. Why the request about to be sent must not be — or `null`.
 *
 * Called from exactly one place per connector, immediately before that connector's request leaves.
 *
 * `null` when there is no authorisation in scope. That is not "absence reads as permission": the
 * absent thing is the QUESTION, not the answer. A request made outside any scope is a request nobody
 * attached a precondition to, and inventing one here would refuse every reference-data read in the
 * codebase. What must never happen — and does not — is an authorisation being IN scope and failing to
 * be asked, or throwing and being read as a pass: a throw propagates out of `performRequest` and
 * aborts the call, which is the fail-closed direction.
 *
 * ONCE PER ATTEMPT, NOT ONCE PER CALL. `realm` evaluates its tenant question once for the whole call
 * and is right to: its input is a fixed `auth`, so the verdict cannot change across the retry loop.
 * The inputs HERE can. An invoice-number slot is a lease and a rate-limit retry can outlive it: the
 * budget wait blocks until the minute window clears, then a 429 sleeps up to 90 seconds, up to four
 * attempts. A permission taken on attempt 0 and spent on attempt 3 is precisely the "true when taken,
 * false when spent" defect this whole fence exists to remove, one level further down. Re-asking also
 * REFRESHES what the authorisation staked — the invoice-number stamp's lease is re-taken on each
 * attempt, so a rival cannot slip in behind a retry — and it re-checks, in the database, that the row
 * is still this worker's to post from. An authorisation whose inputs are fixed pays one redundant
 * evaluation for this; an authorisation whose inputs are a lease would otherwise be unsound.
 */
export async function accountingEgressRefusal(connector: string): Promise<string | null> {
  const entries = scope.getStore()
  if (!entries || entries.length === 0) return null

  for (const entry of entries) {
    if (entry.connector !== connector) continue
    const refusal = await entry.authorize()
    if (refusal) return refusal
  }
  return null
}
