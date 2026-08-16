import { AsyncLocalStorage } from 'node:async_hooks'

// ---------------------------------------------------------------------------
// WHICH CONNECTION ACTUALLY ISSUED THIS EXTERNAL ID (o3d-9kek r4 finding 2)
//
// THE DEFECT. The sync processor posted the document FIRST and then asked
// activeAccountingIdProvenance(connector) which tenant/realm was connected — reading whatever
// AccountingToken row happened to exist by then. A disconnect and re-auth to a different company in
// between (or a slow post straddling one) stamps a realm-A id with `quickbooks:realm-B`. Every
// downstream guard added in r3 — the sweep's namespace match, the (id, provenance) unique index,
// the resolver's holder lookup — then reasons correctly about a provenance that is a lie. Sampling
// again inside updateBackReference opened a second, independent window on the same entry.
//
// Provenance sampled after the fact is not provenance. It has to come from the auth snapshot the
// REQUEST was made with, and it has to be carried, not re-derived.
//
// WHY AN ASYNC-CONTEXT CAPTURE RATHER THAN A RETURN VALUE. The realm is known deep inside the HTTP
// client (it is in the URL: /v3/company/{realmId}/…), several layers below the push* helpers, and
// one logical entry makes SEVERAL requests — resolve/create the contact, resolve an account, then
// post the document. Threading a realm id back out through every push function's result type would
// have to be repeated for each of them and would silently regress the moment a new one is added
// without it. Recording it at the point of use covers every request through the client, including
// requests made by code that has never heard of this module.
//
// AsyncLocalStorage, not a module-level variable: two entries (or a cron sweep and a server action)
// can be in flight in one process, and a global would attribute one's realm to the other. Each
// captureIssuerProvenance call gets its own store.
//
// WHY "MORE THAN ONE OBSERVED" IS A REFUSAL AND NOT "TAKE THE LAST ONE". If the contact lookup went
// to realm A and the document POST went to realm B, the id we are about to store belongs to B while
// half the references inside it belong to A. Taking the last value would record a provenance that is
// technically correct about the id and wrong about the document. The whole entry is untrustworthy;
// refusing is the acceptable failure. A token REFRESH does not trip this — refreshing keeps the same
// tenantId, so every request in the entry still reports the same provenance string.
// ---------------------------------------------------------------------------

/** What was observed, if anything, while the captured work ran. */
export type IssuerProvenanceCapture =
  /** No request went to the connector at all — e.g. a local-only follow-up, or a skipped entry. */
  | { outcome: 'none' }
  /** Every request used the same connection. This is the only outcome an id may be stamped with. */
  | { outcome: 'single'; provenance: string }
  /**
   * The connection CHANGED mid-entry. Never resolvable into a single provenance, by construction:
   * that is the realm-switch race this exists to detect rather than to paper over.
   */
  | { outcome: 'conflicting'; observed: string[] }

type IssuerProvenanceStore = { observed: Set<string> }

const storage = new AsyncLocalStorage<IssuerProvenanceStore>()

/**
 * Record the connection a request is being made with. Called by the connector's HTTP client, at the
 * point it has resolved an auth snapshot and is about to use it — so what is recorded is the
 * connection the remote call actually went to, not one sampled before or after.
 *
 * A no-op outside a capture, so the client can call it unconditionally and paths that do not care
 * about provenance pay nothing.
 */
export function noteIssuerProvenance(provenance: string): void {
  storage.getStore()?.observed.add(provenance)
}

/**
 * Run `fn`, recording every connection its requests used.
 *
 * Returns the result alongside the capture rather than throwing on a conflict: the remote work has
 * already happened by then, and losing the result would lose the external id it produced — which is
 * the one thing that must never be dropped. The CALLER decides what an unusable capture means for
 * its row, and the QuickBooks processor's answer is to persist the id and refuse to attribute it.
 */
export async function captureIssuerProvenance<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; issuer: IssuerProvenanceCapture }> {
  const store: IssuerProvenanceStore = { observed: new Set() }
  const result = await storage.run(store, fn)
  return { result, issuer: summariseIssuerProvenance(store.observed) }
}

/** Exported for tests: the outcome rule, without needing to drive an async context to reach it. */
export function summariseIssuerProvenance(observed: Iterable<string>): IssuerProvenanceCapture {
  const values = [...observed]
  if (values.length === 0) return { outcome: 'none' }
  if (values.length === 1) return { outcome: 'single', provenance: values[0] }
  return { outcome: 'conflicting', observed: values.sort() }
}

/**
 * The provenance an id captured this way may be stamped with, or null when there is none to trust.
 *
 * `none` and `conflicting` both collapse to null on purpose. They are different situations — nothing
 * was posted, versus something was posted across a connection change — but they license exactly the
 * same action, which is none: an id whose issuer is unknown must not be attributed to the connection
 * that happens to be live now. Distinguishing them is the caller's job when it writes the reason
 * into the row.
 */
export function issuedProvenanceOrNull(capture: IssuerProvenanceCapture): string | null {
  return capture.outcome === 'single' ? capture.provenance : null
}

/** The operator-facing reason an id could not be attributed. Empty string when it could. */
export function issuerProvenanceRefusal(capture: IssuerProvenanceCapture): string {
  if (capture.outcome === 'single') return ''
  if (capture.outcome === 'none') {
    return 'the post recorded no connection at all, so which company issued this external id cannot be established'
  }
  return `the connection changed while this entry was posting (saw ${capture.observed.join(', ')}), `
    + 'so which company issued this external id cannot be established'
}
