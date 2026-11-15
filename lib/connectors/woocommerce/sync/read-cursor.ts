/**
 * THE `modified_after` PULL CURSORS ARE TAKEN AT READ START, NOT AT COMMIT.
 *
 * A sweep that stamped `new Date()` when it COMMITTED left a window between its last WooCommerce
 * read and that stamp: an order modified in it was never read by this run, yet fell behind the next
 * run's `modified_after`. With the webhook missed it was never processed. So every pull cursor is
 * now the time the run STARTED (before its first WooCommerce read), less an overlap, and nothing
 * later is ever committed.
 *
 * THE OVERLAP (120 s) covers the two things a bare start time cannot:
 *   - PRECISION: WooCommerce `date_modified` is second precision and `modified_after` is compared
 *     with `>`/`>=` semantics that differ across versions, so an order stamped in the same second as
 *     the cursor must still be read: at least 1-2 s.
 *   - CLOCK SKEW: the IMS host and the WooCommerce host are different machines (and the order's
 *     modified time is set when the row is written, which can trail the HTTP request that caused it
 *     by the length of the write). NTP-synced hosts agree to well under a second; two minutes is a
 *     deliberately generous bound that still costs only the handful of orders touched in two minutes
 *     per sweep.
 *
 * Re-reading the overlap is safe: order import is idempotent (an order IMS holds takes the update
 * path, `shopping_order_links` is unique on connector + externalOrderId), and product sync upserts
 * by SKU.
 */
export const WC_PULL_CURSOR_OVERLAP_MS = 120_000

/** The cursor a run may commit: its read-start time less the overlap, as an ISO string. */
export function wcPullCursorCandidate(readStartedAtMs: number): string {
  return new Date(readStartedAtMs - WC_PULL_CURSOR_OVERLAP_MS).toISOString()
}

/** The later of a stored cursor and a candidate. A cursor never moves backwards through a commit. */
export function laterCursor(current: string | null | undefined, candidate: string): string {
  const currentMs = current ? Date.parse(current) : NaN
  return Number.isFinite(currentMs) && currentMs > Date.parse(candidate) ? (current as string) : candidate
}

type RawClient = { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => PromiseLike<number> }

/**
 * Write `max(stored, candidate)` to a cursor setting in ONE statement.
 *
 * A read-then-upsert let two overlapping sweeps (or a sweep and a webhook advance) both read the same
 * stored value and the older candidate land last, moving the cursor backwards. The comparison now
 * happens inside the upsert, under the row lock the conflicting insert takes. Values are ISO
 * timestamps held as text, compared as timestamptz; a stored value that is not an ISO timestamp is
 * replaced by the candidate. `$executeRaw`, not `$queryRaw` (the statement returns no rows).
 *
 * Intended REWINDS (selection widening, refusal watermark) never go through here: they lower only the
 * `modified_after` a run reads from and write their own settings directly.
 */
export async function advancePullCursor(client: RawClient, key: string, candidate: string): Promise<void> {
  await client.$executeRaw`
    INSERT INTO settings (key, value, "updatedAt")
    VALUES (${key}, ${candidate}, NOW())
    ON CONFLICT (key) DO UPDATE
    SET value = CASE
          WHEN settings.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' AND settings.value::timestamptz >= EXCLUDED.value::timestamptz
            THEN settings.value
          ELSE EXCLUDED.value
        END,
        "updatedAt" = NOW()`
}

/**
 * Whether a sweep that read `covering` has read everything a sweep of `covered` would. Only then may its
 * position be carried to the other sweep's cursor (a reconcile to the poll cursor). An empty `covered` is
 * "reads nothing", which proves nothing, so it never covers.
 */
export function statusListCovers(covering: readonly string[], covered: readonly string[]): boolean {
  return covered.length > 0 && covered.every((status) => covering.includes(status))
}
