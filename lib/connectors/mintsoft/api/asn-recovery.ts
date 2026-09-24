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
 * THE MATCH, in the order it is decided:
 *   1. an ASN whose CallbackUrl is the reservation's correlated callback URL (the strongest evidence —
 *      Mintsoft's ASN model carries no CallbackUrl today, so this is inert until o3d-vcw8 settles how
 *      correlation travels);
 *   2. otherwise, every ASN whose reference EQUALS the reservation's (trimmed; `POReference` is where
 *      Mintsoft stores it — a prefix or a substring is not a match, so `PO-1` never claims `PO-10`),
 *      carrying EXACTLY as many items as the reservation has lines, with each reservation line present
 *      by `SourceLineId`.
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
  correlatedCallbackUrl: string | null
  lines: ReadonlyArray<{ sourceLineId: string; expectedQty: number }>
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
  | { kind: 'rounded'; sourceLineId: string; expectedQty: number; remoteQty: number }

/** Same reference and same line identity — the quantities are judged separately. */
function hasSameLineIdentity(asn: WmsAsnRef, criteria: MintsoftAsnRecoveryCriteria): boolean {
  if (remoteItemCount(asn) !== criteria.lines.length) return false
  const bySourceId = new Map(asn.lines.map((line) => [line.sourceLineId, line]))
  return criteria.lines.every((line) => bySourceId.has(line.sourceLineId))
}

function judgeQuantities(asn: WmsAsnRef, criteria: MintsoftAsnRecoveryCriteria): LineVerdict {
  const bySourceId = new Map(asn.lines.map((line) => [line.sourceLineId, line]))
  let rounded: LineVerdict | null = null
  for (const line of criteria.lines) {
    const remote = bySourceId.get(line.sourceLineId)?.quantity ?? null
    if (quantitiesMatch(remote, line.expectedQty)) continue
    if (roundingCouldExplain(line.expectedQty, remote)) {
      rounded ??= { kind: 'rounded', sourceLineId: line.sourceLineId, expectedQty: line.expectedQty, remoteQty: remote as number }
      continue
    }
    return { kind: 'different' }
  }
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

export function findRecoverableMintsoftAsn(asns: readonly WmsAsnRef[], criteria: MintsoftAsnRecoveryCriteria): WmsAsnRef | null {
  const reference = criteria.reference.trim()
  // The correlated callback URL is the strongest evidence there is — it is OURS, on that ASN — so it is
  // adopted on its own terms, without re-judging lines it was never matched on.
  const correlated = criteria.correlatedCallbackUrl
    ? theOnlyOne(asns.filter((asn) => rawString(asn.raw, ['CallbackUrl', 'callbackUrl']) === criteria.correlatedCallbackUrl), reference)
    : null
  if (correlated) return atTheRightWarehouse(correlated, criteria)
  const match = theOnlyOne(
    asns.filter((asn) => rawString(asn.raw, ['POReference', 'Reference', 'reference']) === reference && hasSameLineIdentity(asn, criteria)),
    reference,
  )
  if (!match) return null
  const quantities = judgeQuantities(match, criteria)
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
