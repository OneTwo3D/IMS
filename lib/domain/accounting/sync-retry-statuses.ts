/**
 * Which accounting-sync rows an operator retry may reset (o3d-sref).
 *
 * Lives here rather than beside the retry actions because those files carry 'use server', and such a
 * module may only export ASYNC functions — a plain const there compiles under tsc but fails
 * `next build`, which is how o3d-1di reached CI.
 *
 * FAILED is the obvious case. A row flagged remoteEffectUnverified must be reachable too, or it has
 * NO operator path at all: the orphan sweep produces it, the delete guard blocks on it, and nothing
 * else could clear it — so an order stuck behind one would be permanently undeletable. Shipping a
 * fail-closed state with no exit is its own defect.
 *
 * Re-queueing such a row is SAFE rather than a duplicate-post risk, because both processors derive
 * their idempotency key deterministically from the ENTRY ID (buildXeroIdempotencyKey /
 * buildQboRequestId). Re-posting the same row sends the same key, so the connector — the only party
 * that actually knows whether the first call landed — resolves the ambiguity: it returns the existing
 * document if it posted, or creates it if it did not. Either way the row terminalises with a real
 * externalTransactionId instead of an unanswerable question.
 *
 * CAVEAT: connector idempotency-key retention is finite and we have established neither window. If a
 * key has aged out, a re-post can create a second document. That is why this is an explicit
 * admin-only, per-entry action rather than an automatic sweep — tracked as o3d-wahn.
 *
 * A row that is CANCELLED and NOT flagged stays non-retryable: it was provably pre-call, and
 * abandoned on purpose.
 */
export function accountingSyncRetryWhere(connector: string, entryId?: string) {
  const eligible = {
    OR: [
      { status: 'FAILED' as const },
      { remoteEffectUnverified: true },
    ],
  }
  return entryId
    ? { AND: [{ id: entryId }, { connector }, eligible] }
    : { AND: [{ connector }, eligible] }
}
