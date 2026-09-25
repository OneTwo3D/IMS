/**
 * WHAT A MINTSOFT ASN'S STATUS MEANS FOR IMS — stated ONCE, here, and the only place that answers it.
 * o3d-bhvu round 8 (Codex HIGH).
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `normalizeMintsoftAsnListRowForRecovery` never read the list row's
 * status (it set `status: null`) and the creators' status normalizer collapsed `null`, and anything else
 * it did not recognise, to `OPEN`. 198 of the tenant's 220 live ASNs are COMPLETE, so "the ASN a lost
 * create left behind has ALREADY been booked in" is the COMMON case: the retry adopted it, recorded it as
 * an ASN still to arrive, ran only the replay of receipt events that ALREADY EXIST — and a callback that
 * was never delivered left none — and reported a successful recovery while the goods on the warehouse's
 * shelves were in no IMS stock figure and no cost layer. `null` is UNKNOWN, and unknown was being spent as
 * the one value that means no stock movement is owed.
 *
 * WHY THIS IS AN ENUMERATED TABLE AND NOT THE `ExternalName` TRICK. Mintsoft's ORDER statuses carry an
 * `ExternalName` — a coarse grouping Mintsoft maintains itself — and `orders.ts` derives "shipped" from it
 * precisely so that a status Mintsoft adds later is classified by Mintsoft rather than by us. ASN statuses
 * DO NOT: `ASNStatus` is `{ Name, Colour, TextColour, ID, LastUpdated, LastUpdatedByUser }` and has no
 * `ExternalName` field at all (swagger read 2026-09-24 and confirmed live; recorded on bd o3d-vcw8). So
 * there is nothing on the wire to group by, and the honest alternative is to enumerate the statuses
 * Mintsoft actually serves and to treat EVERYTHING ELSE as unknown — which buys the same protection the
 * `ExternalName` grouping buys, from the other side: a fourteenth status cannot be silently absorbed into
 * a class it does not belong to, because it is not in the table and therefore reads as unknown.
 *
 * UNKNOWN IS NOT OPEN, AND IT IS NOT BOOKED IN EITHER. It is refused by the caller, by name, in the same
 * spirit as every other refusal on this branch: a remote state IMS cannot read is not permission to
 * assume the harmless one. Guessing OPEN loses the stock; guessing BOOKED_IN invents a receipt.
 *
 * TWO DIFFERENT QUESTIONS, KEPT APART ON PURPOSE:
 *   · `wmsStatus` — what IMS RECORDS on `wms_asn_maps.status`. It must be true of the warehouse.
 *   · `receiptMayHaveHappened` — whether goods may already have been received against this ASN, so a
 *     receipt reconciliation is OWED. It is deliberately wider than `wmsStatus !== 'OPEN'`: DELIVERED is
 *     recorded OPEN (the goods are at the dock, not booked in) but a recheck is still enqueued for it,
 *     because a recheck is idempotent — `processBookedInEvent` applies only the DELTA over each line's
 *     `lastProcessedReceivedQty`, so one that finds nothing received books nothing in — while a receipt
 *     that is never looked for is stock that never arrives in IMS. Over-asking costs a read; under-asking
 *     is the defect above.
 */

/** The IMS `WmsAsnStatus` values a REMOTE ASN can map to. `CREATE_*` are IMS-only and never come from Mintsoft. */
export type MintsoftMappedAsnStatus = 'OPEN' | 'PARTIALLY_BOOKED_IN' | 'BOOKED_IN'

export type MintsoftAsnStatusFact = {
  /** `ASNStatusId`, as `GET /api/ASN/Statuses` serves it. */
  readonly id: number
  /** `ASNStatus.Name`, verbatim (including Mintsoft's own spelling of AWAITNGAPPROVAL). */
  readonly name: string
  readonly wmsStatus: MintsoftMappedAsnStatus
  readonly receiptMayHaveHappened: boolean
}

/**
 * THE 13 ASN STATUSES `GET /api/ASN/Statuses` SERVED LIVE ON 2026-09-24 (ClientId 89, read-only GET;
 * recorded on bd o3d-vcw8). Not a guess and not the swagger's prose: the ids and names are what the
 * tenant answered. A status outside this table is `unknown`, which refuses.
 */
export const MINTSOFT_ASN_STATUSES: readonly MintsoftAsnStatusFact[] = [
  { id: 1, name: 'NEW', wmsStatus: 'OPEN', receiptMayHaveHappened: false },
  { id: 2, name: 'AWAITNGAPPROVAL', wmsStatus: 'OPEN', receiptMayHaveHappened: false },
  { id: 3, name: 'AWAITINGDELIVERY', wmsStatus: 'OPEN', receiptMayHaveHappened: false },
  { id: 4, name: 'BOOKEDIN', wmsStatus: 'BOOKED_IN', receiptMayHaveHappened: true },
  // Booked in with a count that did not agree: goods HAVE been received, so a receipt is owed, and how
  // much was received is the warehouse's answer to give — never this table's.
  { id: 5, name: 'DISCREPANCY', wmsStatus: 'PARTIALLY_BOOKED_IN', receiptMayHaveHappened: true },
  { id: 6, name: 'COMPLETE', wmsStatus: 'BOOKED_IN', receiptMayHaveHappened: true },
  { id: 7, name: 'PARTIALLYBOOKED', wmsStatus: 'PARTIALLY_BOOKED_IN', receiptMayHaveHappened: true },
  { id: 8, name: 'BOOKEDIN-PARTIAL', wmsStatus: 'PARTIALLY_BOOKED_IN', receiptMayHaveHappened: true },
  // At the dock, not yet booked in — so IMS records it OPEN, but a recheck is still asked for (see header).
  { id: 9, name: 'DELIVERED', wmsStatus: 'OPEN', receiptMayHaveHappened: true },
  { id: 10, name: 'SHIPPED', wmsStatus: 'OPEN', receiptMayHaveHappened: false },
  { id: 11, name: 'AWAITINGDELIVERY_LATE', wmsStatus: 'OPEN', receiptMayHaveHappened: false },
  // Put-away follows booking in, so the stock movement has already happened.
  { id: 12, name: 'AWAITINGPUTAWAY', wmsStatus: 'BOOKED_IN', receiptMayHaveHappened: true },
  { id: 13, name: 'ROBOTPUTAWAY', wmsStatus: 'BOOKED_IN', receiptMayHaveHappened: true },
]

/**
 * IMS'S OWN `WmsAsnStatus` NAMES, accepted because a `WmsAsnRef` does not always come from Mintsoft's
 * wire: the second-connector seam and the in-process fakes hand the creators a ref carrying an IMS-domain
 * status, and before round 8 the creators' normalizer passed exactly these five through. They are listed
 * separately from the live table so nobody reads them as something Mintsoft serves. `CREATE_PENDING` and
 * `CREATE_IN_FLIGHT` are IMS reservation states: no remote receipt can have happened against them.
 */
const IMS_ASN_STATUS_NAMES: ReadonlyMap<string, { wmsStatus: MintsoftMappedAsnStatus; receiptMayHaveHappened: boolean }> = new Map([
  ['CREATE_PENDING', { wmsStatus: 'OPEN' as const, receiptMayHaveHappened: false }],
  ['CREATE_IN_FLIGHT', { wmsStatus: 'OPEN' as const, receiptMayHaveHappened: false }],
  ['OPEN', { wmsStatus: 'OPEN' as const, receiptMayHaveHappened: false }],
  ['PARTIALLY_BOOKED_IN', { wmsStatus: 'PARTIALLY_BOOKED_IN' as const, receiptMayHaveHappened: true }],
  ['BOOKED_IN', { wmsStatus: 'BOOKED_IN' as const, receiptMayHaveHappened: true }],
])

export type MintsoftAsnReceiptState =
  | {
      kind: 'known'
      /** The status name this was read from, as it was read. */
      statusName: string
      wmsStatus: MintsoftMappedAsnStatus
      receiptMayHaveHappened: boolean
    }
  | { kind: 'unknown'; detail: string }

/**
 * WHAT ONE STATUS NAME MEANS. `null`, blank, and any name outside the two tables above are `unknown` —
 * there is no default arm that resolves to a status.
 */
export function interpretMintsoftAsnReceiptState(status: string | null | undefined): MintsoftAsnReceiptState {
  if (typeof status !== 'string') {
    return { kind: 'unknown', detail: 'the ASN came back with no readable status' }
  }
  const name = status.trim()
  if (!name) {
    return { kind: 'unknown', detail: 'the ASN came back with a blank status' }
  }
  const key = name.toUpperCase()
  const live = MINTSOFT_ASN_STATUSES.find((fact) => fact.name === key)
  if (live) {
    return { kind: 'known', statusName: live.name, wmsStatus: live.wmsStatus, receiptMayHaveHappened: live.receiptMayHaveHappened }
  }
  const ims = IMS_ASN_STATUS_NAMES.get(key)
  if (ims) {
    return { kind: 'known', statusName: key, wmsStatus: ims.wmsStatus, receiptMayHaveHappened: ims.receiptMayHaveHappened }
  }
  return {
    kind: 'unknown',
    detail: `the ASN came back with status "${name}", which is not one of the ${MINTSOFT_ASN_STATUSES.length} statuses `
      + 'Mintsoft published on 2026-09-24 (GET /api/ASN/Statuses)',
  }
}

const ASN_STATUS_NAME_KEYS = ['Status', 'status', 'AsnStatus', 'asnStatus', 'ASNStatus', 'asnstatus'] as const
const ASN_STATUS_ID_KEYS = ['ASNStatusId', 'AsnStatusId', 'asnStatusId', 'StatusId', 'statusId'] as const

function statusNameFromValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  // `ASNStatus` is an OBJECT on the wire (`{ Name, Colour, TextColour, ID, … }`), which is why the old
  // string-only key list read it as absent and every live ASN arrived here as `null`.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const name = (value as Record<string, unknown>).Name ?? (value as Record<string, unknown>).name
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  return null
}

/**
 * THE ASN'S STATUS NAME AS MINTSOFT SERVED IT, from a raw `ASN` record (a `GET /api/ASN/List` row or a
 * `GET /api/ASN/{id}` body), or `null` when nothing readable is there. A numeric `ASNStatusId` with no
 * name is resolved through the live table — and an id that is NOT in it returns `null` (i.e. unknown)
 * rather than a fabricated name.
 */
export function readMintsoftAsnStatusName(row: Record<string, unknown> | null | undefined): string | null {
  if (!row) return null
  for (const key of ASN_STATUS_NAME_KEYS) {
    const name = statusNameFromValue(row[key])
    if (name) return name
  }
  for (const key of ASN_STATUS_ID_KEYS) {
    const value = row[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) continue
    const fact = MINTSOFT_ASN_STATUSES.find((candidate) => candidate.id === value)
    if (fact) return fact.name
  }
  return null
}
