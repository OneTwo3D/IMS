import { isOutboundWriteHeldText } from '@/lib/security/outbound-write-hold-constants'

/**
 * WHAT A FAILED MINTSOFT BUNDLE CREATE MEANS, AND WHAT IS SAID ABOUT IT - IN ONE PLACE.
 *
 * The bundle create is `PUT /api/Product/Bundle`. When it fails, the only failure that proves Mintsoft
 * received nothing is this installation's own outbound-write hold: the request was refused before it
 * left. EVERY other failure (a timeout, a dropped connection, a 5xx, a 4xx, a 200 with no usable id, a
 * refusal that came after a redirect hop) leaves the question open, because Mintsoft may have acted
 * before the answer was lost. The order create makes the same distinction (order-push.ts), and for the
 * same reason: a claim released over a request that may have landed is a second create waiting to happen.
 *
 * No imports from the database, the connector or the sync: the sync, its tests and anything that reports
 * on a kept claim read these words and this rule from here.
 */

/** How long a claim is respected before another run may take it over (after looking the bundle up). */
export const BUNDLE_CLAIM_LEASE_MS = 10 * 60 * 1000

export type BundleCreateFailureKind = 'not-sent' | 'maybe-sent'

/** `not-sent` only for the hold; everything else may have reached Mintsoft. */
export function classifyBundleCreateFailure(message: string | null | undefined): BundleCreateFailureKind {
  return isOutboundWriteHeldText(message) ? 'not-sent' : 'maybe-sent'
}

/** What the immediate lookup after a possibly-sent create found. */
export type BundleReconciliation =
  | { kind: 'bound' }
  | { kind: 'differs' }
  | { kind: 'not-found' }
  | { kind: 'lookup-failed'; detail: string }

function leaseMinutes(): number {
  return Math.round(BUNDLE_CLAIM_LEASE_MS / 60_000)
}

/**
 * The one operator sentence for a bundle create that may have been sent. It states what is known (a
 * request was sent, no usable answer came back), what IMS did (looked once, did not create again, kept its
 * claim), and what it will do next. It never says Mintsoft holds no bundle, and it gives no instruction
 * that is unsafe if a bundle does exist.
 */
export function bundleCreateMaybeSentText(sku: string, detail: string, reconciliation: BundleReconciliation): string {
  const looked = (() => {
    switch (reconciliation.kind) {
      case 'bound':
        return `IMS then looked the bundle up in Mintsoft, found one that matches this product, and linked it.`
      case 'differs':
        return 'IMS then looked the bundle up in Mintsoft and found one whose components differ from this product, so it linked nothing.'
      case 'not-found':
        return 'IMS then looked the bundle up in Mintsoft and found none yet, which does not show that none was created.'
      case 'lookup-failed':
        return `IMS then tried to look the bundle up in Mintsoft and could not (${reconciliation.detail}).`
    }
  })()
  if (reconciliation.kind === 'bound') {
    return `Mintsoft bundle create for ${sku} may have reached Mintsoft: the request was sent and the answer was not usable (${detail}). ${looked}`
  }
  return `Mintsoft bundle create for ${sku} may have reached Mintsoft: the request was sent and the answer was not usable (${detail}). ${looked} IMS has not created it again and keeps its claim on this product for ${leaseMinutes()} minutes; after that it looks the bundle up again before it sends another create. Look for the bundle in Mintsoft before running bundle sync for this product again.`
}
