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

/**
 * WHICH PAYLOAD FIELDS IDENTIFY THE DOCUMENT — PER TYPE (Codex round 9, HIGH #1).
 *
 * THE HOLE. The key was the UNION of every anchor a money payload can hold: `accountingInvoiceId`
 * AND `creditNoteId`, for every type. For a PAYMENT `creditNoteId` is not part of the document's
 * identity at all — it is not in the body the connector sends, and neither probe dereferences it
 * on a payment branch (Xero fetches `Invoices/{accountingInvoiceId}`, QuickBooks
 * `bill|invoice/{accountingInvoiceId}`). So two payment rows settling ONE invoice, one of which
 * happens to carry a `creditNoteId` and one of which does not, produced two DIFFERENT keys: two
 * advisory locks, two cached probe readings, and — through `attemptCouldBeTheSameDocument`, which
 * compared the same union — two disjoint contender sets. That is precisely the cross-scope double
 * post the document key was introduced to close, reopened by an irrelevant field. `payload` is
 * untyped JSON that IMS does not validate on the way in, so "no writer sets it today" is a
 * statement about the current call sites, not about the data.
 *
 * THE RULE. A key carries exactly the anchors that identify THE DOCUMENT THIS POST WILL SETTLE:
 * a payment against an invoice or a bill is identified by that invoice or bill; a credit-note
 * allocation is identified by the PAIR, because two allocations of DIFFERENT credit notes onto one
 * bill are two legitimate settlements rather than a duplicate. Stated the checkable way: a type's
 * anchors are exactly the payload fields its probe dereferences to address and filter the ledger
 * reading. That is what makes one rule serve both consumers — under-keying is safe for the LOCK
 * (extra serialization) and dangerous for the probe CACHE (one document handed another's reading),
 * over-keying is the reverse, and the anchors-are-what-the-probe-reads rule is the fixed point of
 * the two.
 *
 * A type absent from the table falls back to the invoice/bill alone, which is what both probes do
 * for every non-allocation type. That is a floor, not a licence: `money-post-lock.test.ts` asserts
 * every money-moving type has an EXPLICIT entry, so a new one cannot inherit the default by
 * accident.
 */
const DOCUMENT_ANCHOR_FIELDS: Record<string, readonly string[]> = {
  INVOICE_PAYMENT: ['accountingInvoiceId'],
  BILL_PAYMENT: ['accountingInvoiceId'],
  PURCHASE_CREDIT_NOTE_ALLOCATION: ['accountingInvoiceId', 'creditNoteId'],
}

const DEFAULT_DOCUMENT_ANCHOR_FIELDS: readonly string[] = ['accountingInvoiceId']

/**
 * The payload fields that identify the document a post of `type` settles.
 *
 * The ONE definition: the lock key, the probe cache key, the sibling query's document arm and the
 * contender comparison all read it, so none of them can decide "same document?" on a different set
 * of fields from the others.
 */
export function documentAnchorFields(type: string): readonly string[] {
  return DOCUMENT_ANCHOR_FIELDS[str(type).toUpperCase()] ?? DEFAULT_DOCUMENT_ANCHOR_FIELDS
}

/**
 * Whether `type` states its anchors rather than inheriting the default.
 *
 * Exported for the test that holds the table against `MONEY_MOVING_SYNC_TYPES`: the default is a
 * floor for types nothing here has had to think about, and a money type reaching it by accident is
 * exactly the failure this rule was written to end.
 */
export function hasExplicitDocumentAnchors(type: string): boolean {
  return Object.hasOwn(DOCUMENT_ANCHOR_FIELDS, str(type).toUpperCase())
}

/** One anchor's value on a payload, trimmed — '' when the row records none. */
function anchorValue(payload: unknown, field: string): string {
  return str(asRecord(payload)[field])
}

/**
 * The document arms of the sibling query: how a rival row holding THIS document's anchors is
 * fetched whatever case they are stored in — one arm per anchor this row actually names, OR'd
 * together, and empty when it names none (an empty needle would match every row).
 *
 * ONE ARM PER ANCHOR, OR'D, AND THAT IS DELIBERATE (round 9, HIGH #1). The arms are the same
 * per-type anchors the key and the comparison use, so a type anchored somewhere other than
 * `accountingInvoiceId` cannot leave this pre-filter blind. They are OR'd rather than AND'd
 * because this is a PRE-FILTER whose only job is never to miss a rival: a row that really is this
 * document matches EVERY anchor, so it matches the OR — while an AND would silently drop rivals
 * whenever one anchor is absent from the rival's payload but present on ours. The extras the OR
 * lets through are rejected by `attemptCouldBeTheSameDocument`, which is the thing that decides.
 *
 * A BLANK anchor contributes NO arm rather than an empty needle: `string_contains: ''` matches
 * every row that stores a string there and no row that omits the field, which would be a filter
 * pretending to be a match. With no anchor at all there is nothing to fetch on, and such a post is
 * refused by the probe anyway ('the row records no document id to check').
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
export type SettlementDocumentAnchorFilter = { path: string[]; string_contains: string; mode: 'insensitive' }

export function settlementDocumentAnchorFilters(
  type: string,
  payload: unknown,
): SettlementDocumentAnchorFilter[] {
  return documentAnchorFields(type)
    .map((field) => ({ field, id: anchorValue(payload, field) }))
    .filter(({ id }) => id !== '')
    .map(({ field, id }) => ({ path: [field], string_contains: id, mode: 'insensitive' as const }))
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
 *
 * THE ANCHORS ARE THIS TYPE'S, not every anchor the payload happens to hold (round 9, HIGH #1) —
 * see DOCUMENT_ANCHOR_FIELDS. The type is the FIRST element and a type's anchor list has a fixed
 * length, so two types cannot produce the same array even where their anchor values coincide.
 */
export function settlementDocumentKey(type: string, payload: unknown): string {
  return JSON.stringify([
    str(type).toLowerCase(),
    ...documentAnchorFields(type).map((field) => documentIdentity(anchorValue(payload, field))),
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
