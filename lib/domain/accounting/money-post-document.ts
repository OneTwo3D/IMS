/**
 * o3d-0m56 round 6, Codex CRITICAL #2 — WHICH DOCUMENT a money post will settle, named the same
 * way everywhere that has to keep two posts off it.
 *
 * THE HOLE. Everything that excluded a second post — the advisory lock, and the query for rival
 * attempts — was keyed on the LOCAL SCOPE, `(connector, type, referenceType, referenceId)`. That
 * is where the row lives in IMS, not what it pays in the ledger, and the two come apart routinely:
 * a supplier invoice re-raised under a new PurchaseInvoice id, a bill payment queued against the
 * PurchaseOrder in one release and the PurchaseInvoice in the next, a sales invoice whose payment
 * row is re-created against a replacement order. In every one of those, two rows in DIFFERENT
 * scopes carry the SAME `accountingInvoiceId` — and they were serialized by neither the lock
 * (different key) nor the sibling query (different scope), so both could read an unsettled ledger
 * and both could post. That is a double payment, and it was carried as a "known residual" twice.
 *
 * THE KEY. The document identity is what the POST targets: the type (a bill and an invoice are
 * read from different endpoints and are different documents even if their ids collided), the
 * invoice/bill the money lands on, and — for a credit-note allocation — which credit note it is
 * drawn from, because two allocations of DIFFERENT credit notes onto one bill are two legitimate
 * settlements, not a duplicate.
 *
 * WHY THE SCOPE KEY IS NOT ALSO TAKEN BY THE LOCK. Two rows that share a scope but not a document
 * cannot duplicate each other — they settle different documents — so serializing them buys
 * nothing, and taking two pinned advisory locks per post would put two connections of a four-
 * connection pool behind one payment and risk starving the second acquisition while the first is
 * held. The document key strictly dominates for the exclusion. The sibling QUERY does take both,
 * in a defined order (scope arm first, document arm second), because there a second arm costs one
 * indexed predicate and preserves the contender an anchorless row in this scope has always been.
 */

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * CASE IS NOT PART OF A DOCUMENT'S IDENTITY (Codex round 7, HIGH #2).
 *
 * Both connectors' document ids are case-INSENSITIVE by construction: Xero's are GUIDs (hex and
 * hyphens — `4d8a…` and `4D8A…` address the same invoice, which is why the credit-note allocation
 * probe has always compared them with `toLowerCase`), and QuickBooks' are decimal strings, on
 * which case is not expressible at all. A key that keeps case therefore lets ONE document take
 * TWO locks, and the whole point of the document key was that it cannot.
 *
 * CAN THIS COLLIDE TWO GENUINELY DIFFERENT DOCUMENTS? No. Over the alphabet either connector
 * issues — [0-9a-f-] and [0-9] — lower-casing is injective, so two ids that differ only in case
 * are the same id and two ids that differ otherwise still differ afterwards. The claim is about
 * those two alphabets specifically: a connector that ever issued case-significant opaque ids
 * (base64, say) would need its own rule, and there is no such connector on this path.
 */
function documentIdentity(value: unknown): string {
  return str(value).toLowerCase()
}

/** The invoice/bill a post settles, or '' when the row records none (which no post survives). */
export function settlementDocumentId(payload: unknown): string {
  return str(asRecord(payload).accountingInvoiceId)
}

/**
 * The document arm of the sibling query: how a rival row holding THIS document's id is fetched
 * whatever case it is stored in — or `null` when this row names no document, in which case there
 * is nothing to match and the arm is left off entirely (an empty needle would match every row).
 *
 * WHY NOT `equals`, AND WHY NOT A LIST OF SPELLINGS (Codex round 8, HIGH #1). Round 7 emitted
 * three spellings — as-stored, lower, upper — and a MIXED-case id is in none of them, so a rival
 * holding `4D8a…` was never fetched and never judged. The argument that no connector issues one
 * is an assumption about a payload IMS does not control, made on the path that exists precisely
 * to catch what the scope key cannot see.
 *
 * VERIFIED AGAINST `onetwo3d_ims_dev` (Prisma 7.7.0, PostgreSQL), one mixed-case row per probe in
 * a rolled-back transaction:
 *
 *   - the three-spelling `equals` superset, asked in lower case, matched 0 rows — the hole, live;
 *   - `equals` + `mode: 'insensitive'` does not merely fail to fold case, it PANICS the query
 *     compiler (`PrismaClientRustPanicError: LIKE filter value should be String or Placeholder`,
 *     `sql-query-builder/src/filter/visitor.rs`), and a Rust panic is non-recoverable — inside the
 *     money-post lock that is worse than the bug;
 *   - `string_contains` + `mode: 'insensitive'` matched the mixed-case row, compiling to
 *     `LOWER(payload#>>ARRAY['accountingInvoiceId']) LIKE LOWER('%' || $1 || '%')
 *      AND JSONB_TYPEOF(payload#>ARRAY['accountingInvoiceId']) = 'string'`.
 *
 * `LOWER(...) LIKE LOWER(...)` covers EVERY casing rather than an enumerated few, which is what
 * the finding asked for: there is no spelling of the same id that escapes it.
 *
 * IT IS A SUPERSET, AND ONLY A SUPERSET. `string_contains` also matches rows whose id merely
 * CONTAINS this one, and Prisma does not escape LIKE metacharacters, so an id carrying `%` or `_`
 * would match more rows still. That can only ADD contenders: every row whose id is case-equal to
 * ours contains it, so none is ever dropped. What decides is `attemptCouldBeTheSameDocument`,
 * which folds case exactly as `documentIdentity` does here and rejects the extras. The row set it
 * runs over is already narrow — one connector, one type, `remoteAttemptedAt` set, which the
 * partial index covers.
 */
export function settlementDocumentIdFilter(
  payload: unknown,
): { path: string[]; string_contains: string; mode: 'insensitive' } | null {
  const id = settlementDocumentId(payload)
  return id === '' ? null : { path: ['accountingInvoiceId'], string_contains: id, mode: 'insensitive' }
}

/**
 * The document a money post targets, as one string.
 *
 * Deliberately the SAME value the settlement probe caches on, so the thing the lock excludes and
 * the thing the probe reads can never be two different documents.
 *
 * JSON-encoded rather than space-joined so the parts cannot run together: as one delimited string,
 * `{invoice: 'a b'}` and `{invoice: 'a', creditNote: 'b'}` produced the SAME key, and this value is
 * a CACHE key for the probe as well as a lock key — two different documents sharing it would hand
 * one of them the other's ledger reading, which is a false clear rather than merely extra
 * serialization.
 */
export function settlementDocumentKey(type: string, payload: unknown): string {
  const record = asRecord(payload)
  return JSON.stringify([
    str(type).toLowerCase(),
    documentIdentity(record.accountingInvoiceId),
    documentIdentity(record.creditNoteId),
  ])
}

export type MoneyPostDocument = {
  connector: string
  type: string
  referenceType: string
  referenceId: string
  /** From `settlementDocumentKey` — what the exclusion is actually keyed on. */
  documentKey: string
}

/**
 * Stable signed-int32 hash of a document, for the second `pg_try_advisory_lock` parameter.
 *
 * A collision costs two unrelated documents a little serialization and never costs correctness —
 * the lock only ever makes one document's posters wait for each other.
 */
export function moneyPostDocumentLockId(document: MoneyPostDocument): number {
  const value = `${document.connector} ${document.documentKey}`
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0
  }
  return hash
}
