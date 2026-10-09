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
/** A claim whose create request has been handed to Mintsoft (or was about to be). Starts with the claim prefix. */
export const BUNDLE_SENT_CLAIM_PREFIX = 'pending:sent:'

export function isBundleClaimValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(BUNDLE_CLAIM_PREFIX)
}

/** True for a claim whose create may have reached Mintsoft: stuck until a complete lookup or an operator resolves it. */
export function isBundleSentClaimValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(BUNDLE_SENT_CLAIM_PREFIX)
}

export function buildBundleSentClaimValue(now = Date.now()): string {
  return `${BUNDLE_SENT_CLAIM_PREFIX}${now}`
}

export type BundleCreateFailureKind = 'not-sent' | 'maybe-sent'

/** `not-sent` only for the hold; everything else may have reached Mintsoft. */
export function classifyBundleCreateFailure(message: string | null | undefined): BundleCreateFailureKind {
  return isOutboundWriteHeldText(message) ? 'not-sent' : 'maybe-sent'
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
export function bundleAbsentConfirmationText(sku: string): string {
  return `Confirm only if you have searched Mintsoft for a bundle with SKU ${sku} and found none. IMS cannot check this for you: if one exists, the next bundle sync will create a second.`
}

/** Audit wording for the operator's statement. It records who said what, never that it is true. */
export function bundleAbsentAuditText(sku: string): string {
  return `An operator stated that no Mintsoft bundle for ${sku} exists and released the kept create claim; IMS did not verify the statement.`
}
