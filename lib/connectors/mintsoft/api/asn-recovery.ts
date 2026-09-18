import type { WmsAsnRef } from '@/lib/connectors/wms/types'

/**
 * WHICH REMOTE ASN, IF ANY, AN EARLIER ATTEMPT ALREADY CREATED (o3d-bhvu round 2, review M2).
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
 *      with EXACTLY as many lines, each reservation line present by `SourceLineId` at its expected
 *      quantity; the most recently created wins.
 *
 * AND THE WAREHOUSE IS CHECKED AFTER THE MATCH, NOT BEFORE IT (review M3). The list is read across the
 * whole tenant, so an ASN created by an earlier attempt while the product's binding pointed at another
 * warehouse is still found. Finding it there is not a licence to adopt it — the reservation is for the
 * CURRENT warehouse — and not a licence to create a second one either. So a match at a different
 * warehouse is refused with an error naming both, and an operator decides.
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

function rawString(raw: Record<string, unknown> | null | undefined, keys: readonly string[]): string | null {
  if (!raw) return null
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function quantitiesMatch(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null || right == null) return false
  return Math.abs(left - right) < 0.0001
}

function lineSetMatches(asn: WmsAsnRef, criteria: MintsoftAsnRecoveryCriteria): boolean {
  if (asn.lines.length !== criteria.lines.length) return false
  const lineBySourceId = new Map(asn.lines.map((line) => [line.sourceLineId, line]))
  return criteria.lines.every((line) => {
    const matched = lineBySourceId.get(line.sourceLineId)
    return Boolean(matched) && quantitiesMatch(matched?.quantity, line.expectedQty)
  })
}

export function findRecoverableMintsoftAsn(asns: readonly WmsAsnRef[], criteria: MintsoftAsnRecoveryCriteria): WmsAsnRef | null {
  const reference = criteria.reference.trim()
  const correlated = criteria.correlatedCallbackUrl
    ? asns.find((asn) => rawString(asn.raw, ['CallbackUrl', 'callbackUrl']) === criteria.correlatedCallbackUrl) ?? null
    : null
  const match = correlated ?? [...asns]
    .filter((asn) => rawString(asn.raw, ['POReference', 'Reference', 'reference']) === reference && lineSetMatches(asn, criteria))
    .sort((left, right) => createdAt(right) - createdAt(left))[0] ?? null
  if (!match) return null
  const remoteWarehouseId = rawString(match.raw, ['WarehouseId', 'warehouseId'])
  if (remoteWarehouseId !== criteria.externalWarehouseId.trim()) {
    throw new MintsoftAsnRecoveryWarehouseMismatchError(match.externalAsnId, remoteWarehouseId, criteria.externalWarehouseId)
  }
  return match
}

function createdAt(asn: WmsAsnRef): number {
  const parsed = Date.parse(rawString(asn.raw, ['CreatedAt', 'createdAt']) ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}
