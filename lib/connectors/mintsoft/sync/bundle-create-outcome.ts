import { isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'

/**
 * WHAT A FAILED MINTSOFT BUNDLE CREATE MEANS, AND WHAT IS SAID ABOUT IT - IN ONE PLACE.
 *
 * The bundle create is `PUT /api/Product/Bundle`. When it fails, the only failure that proves Mintsoft
 * received nothing is this installation's own outbound-write hold: the request was refused before it
 * left. EVERY other failure (a timeout, a dropped connection, a 5xx, a 4xx, a 200 with no usable id, a
 * refusal that came after a redirect hop) leaves the question open, because Mintsoft may have acted
 * before the answer was lost. The order create makes the same distinction (order-push.ts).
 *
 * WHAT A KEPT CLAIM MEANS. A claim row is `pending:<time>` until the moment before the request is
 * handed to Mintsoft, when it becomes `pending:sent:<time>`. A claim that never reached that mark never
 * sent anything and may be taken over once its lease has expired. A claim that did is STUCK: the time
 * that has passed proves nothing (an accepted create can outlive any lease), a lookup that finds no
 * bundle proves nothing (a 404 or an unreadable 200 is not an answer), so only a lookup that returns a
 * readable, complete bundle, or an operator who has looked in Mintsoft, resolves it. Nothing here ever
 * authorises another create by the clock.
 *
 * No imports from the database, the connector or the sync: the sync, the operator action, the page and
 * the tests read these words and this rule from here.
 */

/** How long an UNSENT claim is respected before another run may take it over. */
export const BUNDLE_CLAIM_LEASE_MS = 10 * 60 * 1000

export const BUNDLE_CLAIM_PREFIX = 'pending:'
/**
 * A claim created under the two-step format whose create request has NOT been handed over yet. This is the
 * ONLY claim shape that provably sent nothing, so the only one that may be retaken after its lease.
 */
export const BUNDLE_UNSENT_CLAIM_PREFIX = 'pending:unsent:'
/** A claim whose create request has been handed to Mintsoft (or was about to be). */
export const BUNDLE_SENT_CLAIM_PREFIX = 'pending:sent:'

export function isBundleClaimValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(BUNDLE_CLAIM_PREFIX)
}

/**
 * True for every claim that is NOT provably unsent: a `pending:sent:` claim, and a LEGACY `pending:<time>` claim
 * written before the two-step format existed (a crash after a successful PUT left exactly that shape). Stuck until a
 * complete lookup or an operator resolves it.
 */
export function isBundleSentClaimValue(value: string | null | undefined): boolean {
  return isBundleClaimValue(value) && !(value as string).startsWith(BUNDLE_UNSENT_CLAIM_PREFIX)
}

export function buildBundleUnsentClaimValue(now = Date.now()): string {
  return `${BUNDLE_UNSENT_CLAIM_PREFIX}${now}`
}

export function buildBundleSentClaimValue(now = Date.now()): string {
  return `${BUNDLE_SENT_CLAIM_PREFIX}${now}`
}

/**
 * The longest a create request can still be in flight after IMS handed it over, derived from the connector's own
 * limits: each request may take the fetch timeout on each of its (MAX_REDIRECTS + 1 = 6) hops, a proven-unprocessed
 * 401 may replay it once (x2), and the key refresh in between adds up to two more timed requests: 14 timed requests.
 * Plus a margin for the surrounding database work. A process that is stopped rather than dead (SIGSTOP, a paused
 * VM) can exceed any bound; that residual is not closed by a number.
 */
export const BUNDLE_CREATE_MAX_TIMED_REQUESTS = 14
export const BUNDLE_CREATE_IN_FLIGHT_MARGIN_MS = 5 * 60 * 1000
export const DEFAULT_CONNECTOR_FETCH_TIMEOUT_FOR_BUNDLES_MS = 30_000

export function bundleCreateInFlightWindowMs(fetchTimeoutMs: number = DEFAULT_CONNECTOR_FETCH_TIMEOUT_FOR_BUNDLES_MS): number {
  const timeout = Number.isFinite(fetchTimeoutMs) && fetchTimeoutMs > 0 ? fetchTimeoutMs : DEFAULT_CONNECTOR_FETCH_TIMEOUT_FOR_BUNDLES_MS
  return timeout * BUNDLE_CREATE_MAX_TIMED_REQUESTS + BUNDLE_CREATE_IN_FLIGHT_MARGIN_MS
}

/** The window in force for this process (reads the same environment variable the connector transport reads). */
export function currentBundleCreateInFlightWindowMs(env: Record<string, string | undefined> = process.env): number {
  return bundleCreateInFlightWindowMs(Number(env.CONNECTOR_FETCH_TIMEOUT_MS))
}

export function bundleReleaseWindowMinutes(windowMs: number): number {
  return Math.ceil(windowMs / 60_000)
}

/** Why "no bundle" cannot be confirmed yet. Shown on the page and returned by the action: one sentence. */
export function bundleReleaseTooSoonText(minutes: number): string {
  return `Cannot release yet: this create was sent less than ${minutes} minutes ago, and a request can stay in flight that long before it lands in Mintsoft. Releasing now could let a second create go out over the first. Try again later.`
}

export function bundleReleaseLookupRefusalText(kind: 'found' | 'unreadable' | 'failed' | 'no-product-link', detail?: string): string {
  switch (kind) {
    case 'found':
      return `Not released: Mintsoft now returns a bundle for this product${detail ? ` (id ${detail})` : ''}. Link it instead.`
    case 'unreadable':
      return 'Not released: IMS checked Mintsoft just now and could not read the answer, so it cannot tell whether a bundle exists. Nothing was changed.'
    case 'failed':
      return `Not released: IMS could not check Mintsoft just now (${detail ?? 'the lookup failed'}). Nothing was changed.`
    case 'no-product-link':
      return 'Not released: this product has no Mintsoft product link, so IMS cannot check Mintsoft for its bundle. Nothing was changed.'
  }
}

/**
 * What the create step throws when the worker's claim was no longer exactly the one it recorded, checked and
 * refreshed immediately before the request: the request was NOT sent and the claim belongs to someone else now.
 */
export const BUNDLE_CLAIM_CHANGED_TEXT = 'Mintsoft bundle claim changed, create not sent: this run no longer holds the claim (an operator resolved it or another run took over), so it sent nothing.'

export type BundleCreateFailureKind = 'not-sent' | 'claim-changed' | 'maybe-sent'

/** `not-sent` only for the hold; `claim-changed` for the fence; everything else may have reached Mintsoft. */
export function classifyBundleCreateFailure(message: string | null | undefined): BundleCreateFailureKind {
  if (typeof message === 'string' && message.includes(BUNDLE_CLAIM_CHANGED_TEXT)) return 'claim-changed'
  return isOutboundWriteHeldText(message) ? 'not-sent' : 'maybe-sent'
}

/** A create that finished after its claim had changed hands: its result is recorded, never written over the link. */
export function bundleLateResultText(sku: string, externalBundleId: string): string {
  return `A Mintsoft bundle create for ${sku} finished after its claim had changed hands (an operator resolved it or another run took over). Mintsoft returned bundle ${externalBundleId}; IMS did not overwrite the link. If that bundle is not the one now linked for ${sku}, it may be a duplicate: check ${BUNDLE_CLAIM_RESOLUTION_PLACE} and Mintsoft.`
}

/** The limit no number closes, stated wherever an operator is asked to rely on the window. */
export function bundlePausedWorkerResidualText(minutes: number): string {
  return `A sync process that was paused or frozen for longer than ${minutes} minutes after sending could still complete after a release; IMS checks its claim immediately before sending and refuses to overwrite a link afterwards, but Mintsoft offers no idempotency, so a duplicate in that case cannot be ruled out.`
}

/** What a lookup after a possibly-sent create found. Only `bound` and `differs` are answers. */
export type BundleReconciliation =
  | { kind: 'bound' }
  | { kind: 'differs' }
  | { kind: 'not-found' }
  | { kind: 'incomplete'; detail: string }
  | { kind: 'lookup-failed'; detail: string }

/** Where an operator resolves a kept claim. */
export const BUNDLE_CLAIM_RESOLUTION_PLACE = 'Sync > Mintsoft > Bundles'

function lookupSentence(reconciliation: BundleReconciliation): string {
  switch (reconciliation.kind) {
    case 'bound':
      return 'IMS then looked the bundle up in Mintsoft, found one that matches this product, and linked it.'
    case 'differs':
      return 'IMS then looked the bundle up in Mintsoft and found one whose components differ from this product, so it linked nothing.'
    case 'not-found':
      return 'IMS then looked the bundle up in Mintsoft and found none, which does not show that none was created.'
    case 'incomplete':
      return `IMS then looked the bundle up in Mintsoft and the answer was incomplete (${reconciliation.detail}), so it linked nothing.`
    case 'lookup-failed':
      return `IMS then tried to look the bundle up in Mintsoft and could not (${reconciliation.detail}).`
  }
}

/**
 * The one operator sentence for a bundle create that may have been sent. It states what is known (a
 * request was sent, no usable answer came back), what IMS did (looked once, did not create again, kept its
 * claim), and where it is resolved. It never says Mintsoft holds no bundle.
 */
export function bundleCreateMaybeSentText(sku: string, detail: string, reconciliation: BundleReconciliation): string {
  const head = `Mintsoft bundle create for ${sku} may have reached Mintsoft: the request was sent and the answer was not usable (${detail}). ${lookupSentence(reconciliation)}`
  if (reconciliation.kind === 'bound') return head
  return `${head} ${bundleStuckTail(sku)}`
}

/** The sentence shared by every report of a stuck claim. */
export function bundleStuckTail(sku: string): string {
  return `IMS has not created it again and will not while this claim stands: waiting does not make another create safe. Look for the bundle for ${sku} in Mintsoft, then resolve the claim on ${BUNDLE_CLAIM_RESOLUTION_PLACE} (link the Mintsoft bundle if it exists, or confirm that you found none).`
}

/** The text of a claim found stuck on a LATER run (the first run's detail is no longer known). */
export function bundleStuckClaimText(sku: string, reconciliation: BundleReconciliation): string {
  return `An earlier Mintsoft bundle create for ${sku} may have reached Mintsoft and its outcome was never recorded. ${lookupSentence(reconciliation)} ${bundleStuckTail(sku)}`
}

/** Text for the confirmation next to the operator's "none found" action: it is the operator's statement, not evidence. */
export function bundleAbsentConfirmationText(sku: string, windowMinutes: number): string {
  return `Confirm only if you have searched Mintsoft for a bundle with SKU ${sku} and found none. IMS cannot check this for you: if one exists, the next bundle sync will create a second. ${bundlePausedWorkerResidualText(windowMinutes)}`
}

/** Audit wording for the operator's statement. It records who said what, never that it is true. */
export function bundleAbsentAuditText(sku: string): string {
  return `An operator stated that no Mintsoft bundle for ${sku} exists and released the kept create claim; IMS did not verify the statement.`
}
