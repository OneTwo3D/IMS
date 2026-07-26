/**
 * Which accounting-sync statuses an operator retry may reset (o3d-sref).
 *
 * Lives here rather than beside the retry actions because those files carry 'use server', and such a
 * module may only export ASYNC functions — a plain const there compiles under tsc but fails
 * `next build`, which is how o3d-1di reached CI.
 *
 * FAILED is the obvious one. CANCELLED_UNVERIFIED is here because it would otherwise have NO
 * operator path at all: the orphan sweep produces it, the delete guard blocks on it, and nothing
 * could clear it — an order stuck behind one would be permanently undeletable. Shipping a
 * fail-closed state with no exit is its own defect.
 *
 * Re-queueing it is SAFE rather than a duplicate-post risk, because both processors derive their
 * idempotency key deterministically from the ENTRY ID (buildXeroIdempotencyKey / buildQboRequestId).
 * Re-posting the same row therefore sends the same key, so the connector — the only party that
 * actually knows whether the first call landed — resolves the ambiguity: it returns the existing
 * document if it posted, or creates it if it did not. Either way the row terminalises with a real
 * externalTransactionId instead of an unanswerable question.
 *
 * CAVEAT: connector idempotency-key retention is finite. If the key has aged out, a re-post can
 * create a second document. That is why this is an explicit admin action rather than an automatic
 * sweep — tracked as o3d-wahn.
 *
 * Plain CANCELLED is deliberately NOT retryable: it is only produced for a provably pre-call row,
 * abandoned on purpose.
 */
export const RETRYABLE_ACCOUNTING_SYNC_STATUSES = ['FAILED', 'CANCELLED_UNVERIFIED'] as const
