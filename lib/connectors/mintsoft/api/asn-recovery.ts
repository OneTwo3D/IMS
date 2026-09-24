import type { WmsAsnRef } from '@/lib/connectors/wms/types'

/**
 * WHICH REMOTE ASN, IF ANY, AN EARLIER ATTEMPT ALREADY CREATED (o3d-bhvu rounds 2 and 3).
 *
 * Both Mintsoft ASN creators (app/actions/mintsoft-sync.ts: createMintsoftPurchaseOrderAsn and
 * createMintsoftTransferAsn) run this before they push. A push whose response was lost has created
 * the ASN at the warehouse without IMS recording it, so the retry must find it rather than create a
 * second. Pure, so the decision can be tested on rows rather than on source text — the two creators
 * used to carry a copy of it each as a closure.
 *
 * THE MATCH: every ASN whose reference EQUALS the reservation's (trimmed; `POReference` is where Mintsoft
 * stores it — a prefix or a substring is not a match, so `PO-1` never claims `PO-10`), carrying EXACTLY as
 * many items as the reservation has lines, with each reservation line present by `SourceLineId`.
 *
 * THERE IS NO CALLBACK-URL MATCH ANY MORE (round 5, o3d-vcw8). Rounds 2–4 tried the reservation's
 * correlated callback URL first, "the strongest evidence there is". It was never evidence of anything: the
 * string "Callback" appears ZERO times in the entire Mintsoft API document, so no ASN can carry a
 * CallbackUrl and that branch could only ever match nothing. It is removed rather than left inert, because
 * an inert first branch reads as a correlation channel this integration has, and it has none. `POReference`
 * plus `Items[].SourceLineId` IS the correlation — both proven to round-trip verbatim on 2026-09-24.
 *
 * MORE THAN ONE CANDIDATE IS A REFUSAL, NOT A CHOICE (round 3, review M-b). Round 2 said "the most
 * recently created wins" and sorted on a `CreatedAt` that live ASN rows do not have (the swagger's ASN
 * model has `LastUpdated` only), so every row sorted equal and the LIST's order decided — and that order
 * is documented as unstable across pages. The same state could therefore adopt on one retry and refuse on
 * the next. There is no tie-break worth inventing here: two ASNs that both carry this reference and these
 * line ids mean the duplicate this whole path exists to prevent has already happened, so the attempt
 * fails naming both ids and an operator decides. Nothing here depends on the order of `asns`.
 *
 * ITEMS ARE COUNTED AS MINTSOFT RETURNED THEM, not as we could read them (round 3, review L-a). The list
 * normalizer drops an item that carries no usable `SourceLineId` — most of this tenant's ASNs come from
 * another integration and have none — so counting the normalized lines would let an ASN with an EXTRA
 * item pass as "exactly our lines". The raw `Items` array is the count.
 *
 * A QUANTITY THAT ONLY ROUNDING COULD EXPLAIN IS ALSO A REFUSAL (round 3, review L-b). Mintsoft types
 * `ASNItem.QuantityExpected` as int32, so a fractional IMS quantity cannot survive the round trip: 2.5
 * comes back as 2 or as 3 depending on a rounding rule Mintsoft does not publish. Returning "no match"
 * there would create a SECOND ASN at a live warehouse for the same lines, which is the worst outcome
 * available; adopting it would record an expectation IMS never asked for. So when the reference and the
 * whole line set match and the only difference is one an integer rounding of a FRACTIONAL expectation
 * could account for, the attempt fails naming the ASN, the line and both quantities. A quantity that
 * rounding cannot explain (a whole-number expectation against a different whole number) still means a
 * different ASN, and is not adopted.
 *
 * A QUANTITY MINTSOFT DID NOT RETURN IS UNRESOLVED, NOT "A DIFFERENT ASN" (round 4, Codex HIGH 1). The
 * list normalizer sets a line's quantity to null when the row carries no readable `QuantityExpected` —
 * the key absent, null, a string, a NaN. Reading that as a quantity mismatch answered a DEGRADED response
 * describing the very ASN an earlier attempt created with "no such ASN exists, create one", which is the
 * duplicate at a live warehouse this whole path exists to prevent. So a row that carries this reference
 * and exactly these `SourceLineId`s, with a quantity that cannot be read, is refused by name: not adopted
 * (the expectation is unknown), not created again. It outranks a readable mismatch on another line,
 * because until every line can be read the ASN cannot be told apart from ours. Operationally this BLOCKS
 * creation for that reservation until someone looks at the ASN in Mintsoft — deliberately, because the
 * alternative is a second inbound ASN nobody asked for.
 *
 * A LINE IDENTITY THAT CANNOT BE READ IS ALSO UNRESOLVED, ON ANY ROW CARRYING OUR REFERENCE (round 5,
 * Codex HIGH 2). The list normalizer DROPS an item whose `SourceLineId` it cannot use. For a row that
 * carries the reservation's `POReference`, dropping is the same fail-open the quantity case was: our own
 * ASN comes back with one item's `SourceLineId` degraded, `hasSameLineIdentity` no longer finds that line,
 * the row is read as somebody else's, and the creator pushes a SECOND ASN for lines this one already
 * covers. So every row carrying our reference is checked BEFORE the line sets are compared, and an item
 * whose identity is unreadable — not an object, or `SourceLineId` absent, null or blank — makes the whole
 * decision UNRESOLVED: refused by name, nothing adopted and nothing created. A DETERMINATE identity that
 * simply is not ours (a number, where every IMS source line id is a cuid string Mintsoft returns verbatim)
 * is NOT unreadable: it is another integration's item, it is dropped and it still counts (review L-a).
 *
 * AND THE WAREHOUSE IS CHECKED AFTER THE MATCH, NOT BEFORE IT (review M3). The list is read across the
 * whole tenant, so an ASN created by an earlier attempt while the product's binding pointed at another
 * warehouse is still found. Finding it there is not a licence to adopt it — the reservation is for the
 * CURRENT warehouse — and not a licence to create a second one either. So a match at a different
 * warehouse is refused with an error naming both, and an operator decides.
 *
 * WHAT IT STILL DOES NOT LOOK AT (o3d-54al): the ASN's status, and whether IMS has already mapped that
 * ASN id to another reservation.
 */
export type MintsoftAsnRecoveryCriteria = {
  reference: string
  /** Mintsoft's warehouse ID the reservation is for. */
  externalWarehouseId: string
  lines: ReadonlyArray<{ sourceLineId: string; expectedQty: number }>
}

/**
 * WHAT ONE `ASNItem`'S LINE IDENTITY IS, AND WHETHER IT CAN BE READ AT ALL — the single rule, used BOTH by
 * the list normalizer (which keeps `identified` items and drops the rest) and by the refusal below (which
 * treats `unreadable` on a row carrying our reference as "cannot be told apart from ours"). One function on
 * purpose: two copies of this rule would drift, and the drift would make the refusal vacuous.
 *
 * `foreign` is a DETERMINATE identity that cannot be one of ours. Every IMS source line id is a cuid — a
 * non-numeric string — and Mintsoft returns `SourceLineId` verbatim (proven live 2026-09-24, ASN 6117), so
 * a numeric `SourceLineId` belongs to another integration and says so definitively. Everything that is not
 * a usable string and not a finite number says nothing at all, and is `unreadable`.
 */
export type MintsoftAsnItemLineIdentity =
  | { kind: 'identified'; sourceLineId: string }
  | { kind: 'foreign' }
  | { kind: 'unreadable' }

export function readMintsoftAsnItemLineIdentity(item: unknown): MintsoftAsnItemLineIdentity {
  const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
  if (!record) return { kind: 'unreadable' }
  const value = record.SourceLineId
  if (typeof value === 'string') {
    return value.trim() ? { kind: 'identified', sourceLineId: value.trim() } : { kind: 'unreadable' }
  }
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'foreign' }
  return { kind: 'unreadable' }
}

export class MintsoftAsnRecoveryLineIdentityUnreadableError extends Error {
  constructor(externalAsnIds: readonly string[], reference: string) {
    super(
      `Mintsoft ASN${externalAsnIds.length > 1 ? 's' : ''} ${externalAsnIds.join(', ')} carr${externalAsnIds.length > 1 ? 'y' : 'ies'} `
      + `reference ${reference}, but came back with an item whose SourceLineId cannot be read (absent, null or `
      + 'blank). An ASN whose line identity cannot be read cannot be told apart from the one an earlier '
      + 'attempt created for these lines, so this is refused rather than answered with "no such ASN exists". '
      + 'Nothing was created and NO ASN WILL BE CREATED for this reservation until the items read back with '
      + 'their SourceLineIds: check the ASN in Mintsoft, then retry.',
    )
    this.name = 'MintsoftAsnRecoveryLineIdentityUnreadableError'
  }
}

export class MintsoftAsnRecoveryWarehouseMismatchError extends Error {
  constructor(externalAsnId: string, remoteWarehouseId: string | null, expectedWarehouseId: string) {
    super(
      `Mintsoft ASN ${externalAsnId} already exists for this reference and these lines, but at warehouse `
      + `${remoteWarehouseId ?? '(none)'} rather than warehouse ${expectedWarehouseId}. Refusing both to adopt it and `
      + 'to create a second one; resolve the ASN in Mintsoft or restore the warehouse binding, then retry.',
    )
    this.name = 'MintsoftAsnRecoveryWarehouseMismatchError'
  }
}

export class MintsoftAsnRecoveryAmbiguousMatchError extends Error {
  constructor(externalAsnIds: readonly string[], reference: string) {
    super(
      `Mintsoft ASNs ${externalAsnIds.join(', ')} all carry reference ${reference} and this reservation's lines. `
      + 'Refusing both to adopt one of them arbitrarily — the list order decides which, and it is not stable — '
      + 'and to create a third; resolve the duplicate in Mintsoft, then retry.',
    )
    this.name = 'MintsoftAsnRecoveryAmbiguousMatchError'
  }
}

export class MintsoftAsnRecoveryQuantityRoundedError extends Error {
  constructor(externalAsnId: string, sourceLineId: string, expectedQty: number, remoteQty: number) {
    super(
      `Mintsoft ASN ${externalAsnId} carries this reference and these lines, but line ${sourceLineId} expects `
      + `${remoteQty} where the reservation expects ${expectedQty}. Mintsoft stores an ASN item quantity as a `
      + 'whole number, so this difference is what rounding a fractional expectation looks like and cannot be '
      + 'told apart from a different ASN. Refusing both to adopt it and to create a second one; resolve the ASN '
      + 'in Mintsoft, then retry (o3d-vcw8 covers the create contract that loses the fraction).',
    )
    this.name = 'MintsoftAsnRecoveryQuantityRoundedError'
  }
}

export class MintsoftAsnRecoveryQuantityUnreadableError extends Error {
  constructor(externalAsnId: string, sourceLineId: string, expectedQty: number) {
    super(
      `Mintsoft ASN ${externalAsnId} carries this reference and these lines, but line ${sourceLineId} came `
      + `back with no readable expected quantity where the reservation expects ${expectedQty}. An ASN whose `
      + 'quantity cannot be read cannot be told apart from the one an earlier attempt created, so this is '
      + 'refused rather than answered with "no such ASN exists". Nothing was created and NO ASN WILL BE '
      + 'CREATED for this reservation until the ASN reads back completely: check it in Mintsoft (or re-run '
      + 'once the list serves QuantityExpected again), then retry.',
    )
    this.name = 'MintsoftAsnRecoveryQuantityUnreadableError'
  }
}

function rawString(raw: Record<string, unknown> | null | undefined, keys: readonly string[]): string | null {
  if (!raw) return null
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/**
 * How many items Mintsoft returned for this ASN, not how many of them we could read. Falls back to the
 * normalized lines only when the raw row carries no `Items` array at all, which the list reader already
 * refuses upstream (MintsoftAsnListIncompleteError).
 */
function remoteItemCount(asn: WmsAsnRef): number {
  const items = asn.raw?.Items
  return Array.isArray(items) ? items.length : asn.lines.length
}

function quantitiesMatch(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null || right == null) return false
  return Math.abs(left - right) < 0.0001
}

/**
 * Could an integer store of a fractional expectation have produced this remote quantity? True for any
 * rounding rule Mintsoft might use — nearest, floor, truncate or ceiling — which is the point: we do not
 * know which it uses, so anything within one whole unit of a fractional expectation is indistinguishable
 * from our own ASN and must not be answered with "create another one".
 */
function roundingCouldExplain(expectedQty: number, remoteQty: number | null | undefined): boolean {
  if (remoteQty == null) return false
  if (Number.isInteger(expectedQty)) return false
  if (!Number.isInteger(remoteQty)) return false
  return Math.abs(remoteQty - expectedQty) < 1
}

type LineVerdict =
  | { kind: 'match' }
  | { kind: 'different' }
  | { kind: 'unreadable'; sourceLineId: string; expectedQty: number }
  | { kind: 'rounded'; sourceLineId: string; expectedQty: number; remoteQty: number }

/** Same reference and same line identity — the quantities are judged separately. */
function hasSameLineIdentity(asn: WmsAsnRef, criteria: MintsoftAsnRecoveryCriteria): boolean {
  if (remoteItemCount(asn) !== criteria.lines.length) return false
  const bySourceId = new Map(asn.lines.map((line) => [line.sourceLineId, line]))
  return criteria.lines.every((line) => bySourceId.has(line.sourceLineId))
}

/**
 * Every line is judged before a verdict is reached — no early return — because an UNREADABLE quantity on
 * one line must outrank a readable mismatch on another (Codex HIGH 1). Precedence: unreadable, then a
 * difference rounding cannot explain, then one it can, then a match.
 */
function judgeQuantities(asn: WmsAsnRef, criteria: MintsoftAsnRecoveryCriteria): LineVerdict {
  const bySourceId = new Map(asn.lines.map((line) => [line.sourceLineId, line]))
  let unreadable: LineVerdict | null = null
  let different = false
  let rounded: LineVerdict | null = null
  for (const line of criteria.lines) {
    // null is "Mintsoft did not give us a number", never "zero" and never "some other quantity": the
    // normalizer only produces it for an absent, null, non-numeric or non-finite QuantityExpected, and
    // the line itself is present by SourceLineId (hasSameLineIdentity already required that).
    const remote = bySourceId.get(line.sourceLineId)?.quantity ?? null
    if (remote == null) {
      unreadable ??= { kind: 'unreadable', sourceLineId: line.sourceLineId, expectedQty: line.expectedQty }
      continue
    }
    if (quantitiesMatch(remote, line.expectedQty)) continue
    if (roundingCouldExplain(line.expectedQty, remote)) {
      rounded ??= { kind: 'rounded', sourceLineId: line.sourceLineId, expectedQty: line.expectedQty, remoteQty: remote }
      continue
    }
    different = true
  }
  if (unreadable) return unreadable
  if (different) return { kind: 'different' }
  return rounded ?? { kind: 'match' }
}

/** One candidate, or a refusal naming them all. Never "whichever the list happened to put first". */
function theOnlyOne(candidates: readonly WmsAsnRef[], reference: string): WmsAsnRef | null {
  if (candidates.length === 0) return null
  if (candidates.length > 1) {
    throw new MintsoftAsnRecoveryAmbiguousMatchError(candidates.map((asn) => asn.externalAsnId), reference)
  }
  return candidates[0] ?? null
}

/**
 * Every row carrying our reference whose items we cannot all key. Named in SORTED order, so which ASN the
 * refusal names does not depend on the list's order (which is not stable across pages — review M-b).
 */
function unreadableLineIdentityAsnIds(sameReference: readonly WmsAsnRef[]): string[] {
  return sameReference
    .filter((asn) => {
      const items = asn.raw?.Items
      if (!Array.isArray(items)) return false
      return items.some((item) => readMintsoftAsnItemLineIdentity(item).kind === 'unreadable')
    })
    .map((asn) => asn.externalAsnId)
    .sort()
}

export function findRecoverableMintsoftAsn(asns: readonly WmsAsnRef[], criteria: MintsoftAsnRecoveryCriteria): WmsAsnRef | null {
  const reference = criteria.reference.trim()
  const sameReference = asns.filter((asn) => rawString(asn.raw, ['POReference', 'Reference', 'reference']) === reference)
  // BEFORE the line sets are compared, because a row we cannot key is a row we cannot EXCLUDE (round 5,
  // Codex HIGH 2). Comparing first would let the missing line read as "a different ASN" and create a second.
  const unreadable = unreadableLineIdentityAsnIds(sameReference)
  if (unreadable.length > 0) {
    throw new MintsoftAsnRecoveryLineIdentityUnreadableError(unreadable, reference)
  }
  const match = theOnlyOne(
    sameReference.filter((asn) => hasSameLineIdentity(asn, criteria)),
    reference,
  )
  if (!match) return null
  const quantities = judgeQuantities(match, criteria)
  if (quantities.kind === 'unreadable') {
    throw new MintsoftAsnRecoveryQuantityUnreadableError(match.externalAsnId, quantities.sourceLineId, quantities.expectedQty)
  }
  if (quantities.kind === 'different') return null
  if (quantities.kind === 'rounded') {
    throw new MintsoftAsnRecoveryQuantityRoundedError(match.externalAsnId, quantities.sourceLineId, quantities.expectedQty, quantities.remoteQty)
  }
  return atTheRightWarehouse(match, criteria)
}

function atTheRightWarehouse(match: WmsAsnRef, criteria: MintsoftAsnRecoveryCriteria): WmsAsnRef {
  const remoteWarehouseId = rawString(match.raw, ['WarehouseId', 'warehouseId'])
  if (remoteWarehouseId !== criteria.externalWarehouseId.trim()) {
    throw new MintsoftAsnRecoveryWarehouseMismatchError(match.externalAsnId, remoteWarehouseId, criteria.externalWarehouseId)
  }
  return match
}
