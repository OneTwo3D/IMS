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
 * Every spelling of this row's document id that a STORED payload could literally hold.
 *
 * The sibling query matches JSON with `equals`, which is byte-exact in PostgreSQL and cannot be
 * told to fold case — so the folding has to happen on the query side, by asking for the spellings
 * a connector actually issues. `settlementDocumentId` is kept as the first entry because the
 * common case is an exact match on the value this row itself carries.
 *
 * The result is a SUPERSET pre-filter, never the decision: every row it returns is still put
 * through `attemptCouldBeTheSameDocument`, which compares the same way this module does.
 */
export function settlementDocumentIdMatches(payload: unknown): string[] {
  const id = settlementDocumentId(payload)
  return id === '' ? [] : [...new Set([id, id.toLowerCase(), id.toUpperCase()])]
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
