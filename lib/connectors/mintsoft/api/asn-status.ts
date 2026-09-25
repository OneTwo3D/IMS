import type { WmsAsnStatus } from '@/app/generated/prisma/enums'

/**
 * WHAT A MINTSOFT ASN'S STATUS MEANS FOR IMS — stated ONCE, here, and the only place that answers it.
 * o3d-bhvu round 8 (Codex HIGH), round 9 (Codex HIGH).
 *
 * THE DEFECT ROUND 8 EXISTS TO CLOSE. `normalizeMintsoftAsnListRowForRecovery` never read the list row's
 * status (it set `status: null`) and the creators' status normalizer collapsed `null`, and anything else
 * it did not recognise, to `OPEN`. 198 of the tenant's 220 live ASNs are COMPLETE, so "the ASN a lost
 * create left behind has ALREADY been booked in" is the COMMON case: the retry adopted it, recorded it as
 * an ASN still to arrive, ran only the replay of receipt events that ALREADY EXIST — and a callback that
 * was never delivered left none — and reported a successful recovery while the goods on the warehouse's
 * shelves were in no IMS stock figure and no cost layer. `null` is UNKNOWN, and unknown was being spent as
 * the one value that means no stock movement is owed.
 *
 * THE DEFECT ROUND 9 EXISTS TO CLOSE — ONE INTERPRETER SERVING TWO VOCABULARIES. Round 8 enumerated the 13
 * statuses Mintsoft serves and refused everything outside them, and then, in the SAME function, consulted a
 * second table of IMS's OWN `WmsAsnStatus` names. IMS's vocabulary and Mintsoft's overlap TEXTUALLY —
 * `OPEN` above all — so a remote `ASNStatus.Name` of `OPEN`, with an `ASNStatusId` nobody recognised
 * sitting right beside it, was accepted as KNOWN, recorded as OPEN and skipped the receipt recheck. A
 * remote value borrowed the local meaning, which is the very defect class round 8 fixed: a name that
 * merely LOOKS known treated as proof of the remote state. Measured before the fix, all five of IMS's own
 * status names resolved as remote statuses, and `PARTIALLY_BOOKED_IN` / `BOOKED_IN` arriving from the wire
 * even INVENTED a receipt (recheck enqueued, 10 units landed) off a name Mintsoft never sends.
 *
 * SO THERE IS NOW EXACTLY ONE TABLE, AND IT IS MINTSOFT'S. IMS's own `WmsAsnStatus` names are resolved
 * HERE BY NOTHING: the table of them is deleted, not merely moved, so there is no second table for a
 * remote value to fall through to. IMS's vocabulary is the Prisma `WmsAsnStatus` enum, it is an OUTPUT of
 * this module (`wmsStatus`) and never an input, and the two vocabularies are proven DISJOINT at compile
 * time below.
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

/** The IMS `WmsAsnStatus` values a REMOTE ASN can map to. An OUTPUT of this module; never an input. */
export type MintsoftMappedAsnStatus = 'OPEN' | 'PARTIALLY_BOOKED_IN' | 'BOOKED_IN'

type MintsoftAsnStatusFactShape = {
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
 *
 * `as const satisfies` and NOT a `readonly MintsoftAsnStatusFactShape[]` annotation, deliberately: the
 * annotation would widen `name` to `string`, and the literal union it produces is what gives the split
 * below its compile-time teeth (see `MintsoftWireAsnStatusName`).
 */
export const MINTSOFT_ASN_STATUSES = [
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
] as const satisfies readonly MintsoftAsnStatusFactShape[]

/** One of the 13 names Mintsoft published — as a LITERAL union, not `string`. */
export type MintsoftWireAsnStatusName = (typeof MINTSOFT_ASN_STATUSES)[number]['name']

export type MintsoftAsnStatusFact = (typeof MINTSOFT_ASN_STATUSES)[number]

/**
 * COMPILE-TIME: THE TWO VOCABULARIES ARE DISJOINT (o3d-bhvu round 9).
 *
 * `Extract` of IMS's `WmsAsnStatus` enum against Mintsoft's 13 wire names must be `never`. Adding any
 * IMS status name to the table above — which is exactly the mutation that reopens round 9's finding, and
 * exactly what the deleted IMS table did by another route — makes `_VOCABULARIES_ARE_DISJOINT` resolve to
 * `never` and this line stops compiling. It is not a convention and not a comment; it is `tsc`.
 */
type _VOCABULARIES_ARE_DISJOINT = [Extract<WmsAsnStatus, MintsoftWireAsnStatusName>] extends [never] ? true : never
const _vocabulariesAreDisjoint: _VOCABULARIES_ARE_DISJOINT = true
void _vocabulariesAreDisjoint

export type MintsoftAsnReceiptState =
  | {
      kind: 'known'
      /**
       * The status name this was read from. Typed as the LITERAL union of Mintsoft's 13 names, so a
       * `known` state CANNOT be constructed for a name outside the table without a cast — which is what
       * stops a second, permissive resolution arm from being added back.
       */
      statusName: MintsoftWireAsnStatusName
      wmsStatus: MintsoftMappedAsnStatus
      receiptMayHaveHappened: boolean
    }
  | { kind: 'unknown'; detail: string }

/**
 * The prefix `readMintsoftAsnWireStatusField` puts on a status string it could NOT resolve, so the reason
 * travels to the operator through `WmsAsnRef.status` (a `string | null`) instead of being flattened to
 * `null`. `interpretMintsoftWireAsnStatus` has an arm for it that can only ever answer `unknown`. Its
 * colon and space mean it can never collide with a status name, and the disjointness of marker and table
 * is asserted in tests/mintsoft-recovered-asn-receipt.test.ts.
 */
export const MINTSOFT_ASN_STATUS_UNREADABLE_MARKER = 'MINTSOFT_ASN_STATUS_UNREADABLE: '

/**
 * WHAT ONE STATUS NAME FROM MINTSOFT'S WIRE MEANS — MINTSOFT'S VOCABULARY ONLY.
 *
 * `null`, blank, an unresolvable-reading marker, and any name outside the 13-status table are `unknown`;
 * there is no default arm that resolves to a status, and — round 9 — no second table of IMS's own names
 * for a remote value to fall through to. Feeding this IMS's `OPEN`, `BOOKED_IN`, `CREATE_PENDING` or any
 * other `WmsAsnStatus` value yields `unknown`, because Mintsoft does not serve those words.
 */
export function interpretMintsoftWireAsnStatus(status: string | null | undefined): MintsoftAsnReceiptState {
  if (typeof status !== 'string') {
    return { kind: 'unknown', detail: 'the ASN came back with no readable status' }
  }
  const name = status.trim()
  if (!name) {
    return { kind: 'unknown', detail: 'the ASN came back with a blank status' }
  }
  if (name.startsWith(MINTSOFT_ASN_STATUS_UNREADABLE_MARKER)) {
    return {
      kind: 'unknown',
      detail: name.slice(MINTSOFT_ASN_STATUS_UNREADABLE_MARKER.length).trim() || 'the ASN’s status could not be read',
    }
  }
  const live = MINTSOFT_ASN_STATUSES.find((fact) => fact.name === name.toUpperCase())
  if (live) {
    return { kind: 'known', statusName: live.name, wmsStatus: live.wmsStatus, receiptMayHaveHappened: live.receiptMayHaveHappened }
  }
  return {
    kind: 'unknown',
    detail: `the ASN came back with status "${name}", which is not one of the ${MINTSOFT_ASN_STATUSES.length} statuses `
      + 'Mintsoft published on 2026-09-24 (GET /api/ASN/Statuses). IMS’s own WmsAsnStatus names are not '
      + 'accepted here either: this reads Mintsoft’s vocabulary and nothing else',
  }
}

const ASN_STATUS_NAME_KEYS = ['Status', 'status', 'AsnStatus', 'asnStatus', 'ASNStatus', 'asnstatus'] as const
const ASN_STATUS_ID_KEYS = ['ASNStatusId', 'AsnStatusId', 'asnStatusId', 'StatusId', 'statusId'] as const
const NESTED_STATUS_ID_KEYS = ['ID', 'Id', 'id'] as const

/** One thing the wire said about this ASN's status, and the status (if any) it resolves to. */
type WireStatusSignal = {
  /** The wire field it came from, for the operator's message (e.g. `ASNStatus.Name`). */
  readonly source: string
  /** What was there, verbatim. */
  readonly seen: string
  /** The status it names in Mintsoft's table — `null` when it names none. */
  readonly fact: MintsoftAsnStatusFact | null
}

export type MintsoftAsnWireStatusReading =
  | { kind: 'resolved'; fact: MintsoftAsnStatusFact }
  /** Nothing about a status was on the wire at all. Refused by the caller as unknown. */
  | { kind: 'absent' }
  /** Something was there and it does not resolve, or the fields disagree. Refused, with the reason. */
  | { kind: 'unreadable'; detail: string }

function nameSignal(source: string, value: string): WireStatusSignal {
  const seen = value.trim()
  const upper = seen.toUpperCase()
  return { source, seen, fact: MINTSOFT_ASN_STATUSES.find((fact) => fact.name === upper) ?? null }
}

function idSignal(source: string, value: number): WireStatusSignal {
  return { source, seen: String(value), fact: MINTSOFT_ASN_STATUSES.find((fact) => fact.id === value) ?? null }
}

/**
 * EVERY STATUS SIGNAL THE ROW CARRIES — not the first one that reads, which is the precedence contest
 * round 9 removed. Live Mintsoft serves three of them on one ASN (`ASNStatus.Name`, `ASNStatus.ID` and
 * `ASNStatusId`; ASN 6114 read 2026-09-24 served 3/AWAITINGDELIVERY on all three, bd o3d-vcw8).
 */
function collectWireStatusSignals(row: Record<string, unknown>): WireStatusSignal[] {
  const signals: WireStatusSignal[] = []
  for (const key of ASN_STATUS_NAME_KEYS) {
    const value = row[key]
    if (typeof value === 'string') {
      if (value.trim()) signals.push(nameSignal(key, value))
      continue
    }
    // `ASNStatus` is an OBJECT on the wire (`{ Name, Colour, TextColour, ID, … }`), which is why the old
    // string-only key list read it as absent and every live ASN arrived here as `null`.
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const nested = value as Record<string, unknown>
    const nestedName = nested.Name ?? nested.name
    if (typeof nestedName === 'string' && nestedName.trim()) signals.push(nameSignal(`${key}.Name`, nestedName))
    for (const idKey of NESTED_STATUS_ID_KEYS) {
      const nestedId = nested[idKey]
      if (typeof nestedId === 'number' && Number.isInteger(nestedId)) {
        signals.push(idSignal(`${key}.${idKey}`, nestedId))
        break
      }
    }
  }
  for (const key of ASN_STATUS_ID_KEYS) {
    const value = row[key]
    if (typeof value === 'number' && Number.isInteger(value)) signals.push(idSignal(key, value))
  }
  return signals
}

function describeSignals(signals: readonly WireStatusSignal[]): string {
  return signals.map((signal) => `${signal.source} = "${signal.seen}"${signal.fact ? ` (${signal.fact.name})` : ''}`).join(', ')
}

/**
 * THE ASN'S STATUS, READ FROM A RAW MINTSOFT `ASN` RECORD (a `GET /api/ASN/List` row or a
 * `GET /api/ASN/{id}` body) — and only from Mintsoft's own fields.
 *
 * WHY A DISAGREEMENT REFUSES (o3d-bhvu round 9). Round 8 read the name first and used `ASNStatusId` only
 * as a FALLBACK, so an id nobody recognises sitting beside a recognised name was silently discarded, and
 * two recognised fields naming DIFFERENT statuses were silently resolved by precedence. Both are evidence
 * that the wire shape is not what this code thinks it is — and the two directions are not symmetric in
 * cost: preferring the one that owes a receipt writes a `wms_asn_maps.status` that may be false of the
 * warehouse, and preferring the one that owes none loses the stock. Neither is available, because there
 * is no basis for choosing. So EVERY signal present must resolve in the 13-status table, and all of them
 * must name the SAME status; anything else is `unreadable` and the caller refuses before any write. This
 * costs nothing against the live tenant: all 220 live ASNs sit in one of the 13 statuses (per-status
 * counts, bd o3d-vcw8) and ASN 6114 served the same status on all three fields.
 */
export function readMintsoftAsnWireStatus(row: Record<string, unknown> | null | undefined): MintsoftAsnWireStatusReading {
  if (!row) return { kind: 'absent' }
  const signals = collectWireStatusSignals(row)
  if (signals.length === 0) return { kind: 'absent' }

  const unresolved = signals.filter((signal) => signal.fact === null)
  if (unresolved.length > 0) {
    return {
      kind: 'unreadable',
      detail: `Mintsoft served ${describeSignals(unresolved)}, which names no status in the `
        + `${MINTSOFT_ASN_STATUSES.length}-status table GET /api/ASN/Statuses published on 2026-09-24`
        + (signals.length > unresolved.length ? ` (alongside ${describeSignals(signals.filter((signal) => signal.fact !== null))})` : ''),
    }
  }

  const distinct = new Map<number, MintsoftAsnStatusFact>()
  for (const signal of signals) {
    if (signal.fact) distinct.set(signal.fact.id, signal.fact)
  }
  const facts = [...distinct.values()]
  const only = facts[0]
  if (!only) return { kind: 'absent' }
  if (facts.length > 1) {
    return {
      kind: 'unreadable',
      detail: `Mintsoft’s own ASN status fields DISAGREE — ${describeSignals(signals)} — so the state of this ASN `
        + 'at the warehouse is not what this code thinks it reads',
    }
  }
  return { kind: 'resolved', fact: only }
}

/**
 * The value the connector puts on `WmsAsnRef.status`: the resolved wire name, `null` when the wire said
 * nothing about a status, or a marked, deliberately unresolvable string carrying WHY it could not be read
 * (see `MINTSOFT_ASN_STATUS_UNREADABLE_MARKER`) so the refusal names the fields that disagreed.
 */
export function readMintsoftAsnWireStatusField(row: Record<string, unknown> | null | undefined): string | null {
  const reading = readMintsoftAsnWireStatus(row)
  if (reading.kind === 'resolved') return reading.fact.name
  if (reading.kind === 'unreadable') return `${MINTSOFT_ASN_STATUS_UNREADABLE_MARKER}${reading.detail}`
  return null
}
