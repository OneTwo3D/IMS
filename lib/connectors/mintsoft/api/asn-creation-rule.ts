import type { WmsAsnRef } from '@/lib/connectors/wms/types'

/**
 * THE RULE FOR CREATING AN ASN AT A LIVE WAREHOUSE — stated ONCE, here, and gone through by BOTH the
 * pre-create duplicate matcher (`asn-recovery.ts`, which both creators in `app/actions/mintsoft-sync.ts`
 * call) and the post-create read-back (`client.ts`). o3d-bhvu round 6.
 *
 *   A CREATE PROCEEDS ONLY ON A POSITIVE PROOF THAT THE ASN IS NOT ALREADY THERE. Every other outcome —
 *   a remote state that cannot be read, cannot be proven, or merely DIFFERS from what we hold — refuses by
 *   name and names the remote ASN id, so an operator can look at it in Mintsoft.
 *
 * WHY THE RULE IS IN ONE FILE. Six adversarial review rounds on this branch each found the SAME class of
 * defect in a different branch of the code: an unreadable `SourceLineId` (round 5), an unreadable
 * `QuantityExpected` (round 4), an unreadable ASN list (round 4), an ambiguous match (round 3), a
 * rounding-explainable quantity (round 3), a changed quantity and a changed warehouse (round 6). Each was
 * fixed where it was found, and the next round found the next one, because "what may we conclude from this
 * remote state?" was being answered independently in several places. It is answered once below:
 * `compareMintsoftAsnAgainstExpectation` says what the difference IS, `isProofThatMintsoftAsnIsNotThisOne`
 * says which differences are determinate evidence of absence — the ONLY inputs a proof of absence may be
 * built from — and `requireMintsoftAsnCreationVerdict` is the only function in the connector that answers
 * "yes, create one". Both consumers reach a decision only through those three, so a new permissive branch
 * cannot be written in a caller: it has to be written here, into an exhaustive switch, in the open.
 *
 * WHAT A PROOF OF ABSENCE ACTUALLY NEEDS — TWO THINGS, AND THEY ARE DIFFERENT QUESTIONS (round 7).
 *   (1) THIS REMOTE ASN IS A DIFFERENT CONSIGNMENT from the one about to be created. Only readable content
 *       that DIFFERS can establish that: another `POReference`, or a set of source lines that shares none of
 *       ours. Content that is IDENTICAL, INDISTINGUISHABLE (an int32 rounding of a fractional quantity) or
 *       UNREADABLE establishes nothing.
 *   (2) IT IS NOT THE ASN AN EARLIER ATTEMPT CREATED FOR THIS RESERVATION, i.e. not what a create whose
 *       response IMS lost left behind. A LOST RESPONSE IS EXACTLY THE CASE WHERE IMS HAS NO `wms_asn_maps`
 *       ROW FOR THE ASN — that is what "lost" means — so an ASN IMS has ALREADY MAPPED cannot be one, and an
 *       UNMAPPED one can be. `readMintsoftAsnMapState` below is that question, and NOTHING ELSE answers it.
 * For a different reference or a disjoint line set, (1) also gives (2): a lost create for THESE lines cannot
 * have produced an ASN over none of them. For an OVERLAPPING line set or a differing quantity, (1) holds and
 * (2) does not, and the map is the only thing that decides — which is why the table below takes it.
 *
 * THE COMPARISON IS THE SAME COMPARISON FOR BOTH CALLERS, because it is the same question asked twice:
 * "is THIS remote ASN the one this reservation asked for?" Before the push it is asked of every ASN in the
 * tenant (a yes means adopt, a proven no for all of them means create); after the push it is asked of the
 * ASN Mintsoft says it just created (only a yes may be recorded). What differs is the CONSEQUENCE, and
 * that is the only thing the two callers decide for themselves.
 */

/** What a reservation (or a create request) expects a Mintsoft ASN to be. */
export type MintsoftAsnExpectation = {
  reference: string
  /** Mintsoft's warehouse ID the reservation is for. */
  externalWarehouseId: string
  lines: ReadonlyArray<{ sourceLineId: string; expectedQty: number }>
}

/**
 * WHAT IMS ALREADY KNOWS ABOUT THE REMOTE ASN IDS IT IS LOOKING AT (o3d-54al, the mechanism round 7's fix
 * needs). `wms_asn_maps` holds one row per ASN IMS has recorded, keyed `@@unique(connector, externalAsnId)`.
 *
 * WHY MAPPED-NESS IS THE RIGHT DISCRIMINATOR, AND NOT A PROXY FOR ONE. The failure this whole path exists to
 * prevent is a create whose RESPONSE was lost: Mintsoft made the ASN and IMS never recorded it. "Never
 * recorded it" IS "there is no `wms_asn_maps` row for that ASN id" — the two are the same fact, not
 * correlated facts. So an ASN that HAS a row is, by definition, not what a lost create left behind: it is an
 * ASN IMS wrote down (an earlier partial for this order, or one belonging to another source), and the
 * creators' own reservation logic already accounts for it — `reserveAsn` returns the existing ASN outright
 * when IMS holds an OPEN map row for this source, so the mapped rows that reach this comparison at all are
 * ones IMS has already reconciled. An UNMAPPED ASN carrying our reference over our lines is the opposite: the
 * one state a lost response produces.
 *
 * THIS IS WHY AN OVERLAP CAN BE REFUSED WITHOUT BREAKING MULTI-ASN ORDERS. A purchase order is delivered in
 * parts, and every ASN for it carries the SAME `POReference` (it is the ORDER's reference), so "this row
 * overlaps our lines" cannot on its own mean "duplicate" — round 6 said so and left the overlap permitted
 * for that reason. Mapped-ness separates the two populations exactly: the legitimate earlier partials are
 * the ones IMS mapped, and they stay proof of absence; only an unmapped overlap refuses.
 *
 * `unreadable` IS NOT `unmapped`. If the map could not be read, IMS does not know which of the two it is
 * looking at, and the rule of this branch applies unchanged: unreadable is not permission.
 */
export type MintsoftAsnMapKnowledge =
  | { kind: 'readable'; mappedExternalAsnIds: ReadonlySet<string> }
  | { kind: 'unreadable'; detail: string }

export type MintsoftAsnMapState = 'mapped' | 'unmapped' | 'unknown'

/**
 * PURE, like the rest of this file: the map is in the database, so the CALLER reads it (both creators, via
 * one helper, before they decide) and passes what it found in. Nothing here touches a database, which is
 * what keeps the one statement of the rule testable on rows.
 */
export function readMintsoftAsnMapState(asn: WmsAsnRef, knowledge: MintsoftAsnMapKnowledge): MintsoftAsnMapState {
  if (knowledge.kind === 'unreadable') return 'unknown'
  return knowledge.mappedExternalAsnIds.has(asn.externalAsnId) ? 'mapped' : 'unmapped'
}

/**
 * WHAT ONE `ASNItem`'S LINE IDENTITY IS, AND WHETHER IT CAN BE READ AT ALL — the single rule, used BOTH by
 * the list normalizer (which keeps `identified` items and drops the rest) and by the refusals below (which
 * treat `unreadable` on a row carrying our reference as "cannot be told apart from ours"). One function on
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

/**
 * THE EXPECTED QUANTITY MINTSOFT HOLDS FOR ONE ITEM, read from the RAW item and from `QuantityExpected`
 * alone — `null` when it cannot be read (the key absent, `null`, a string, `NaN`, `Infinity`), which is
 * never "zero" and never "some other quantity".
 *
 * IT IS DELIBERATELY NOT `WmsAsnLineRef.quantity`. That field means EXPECTED on a duplicate-recovery row
 * and RECEIVED on a booked-in read (`normalizeMintsoftAsnLine` reads `Quantity`/`ReceivedQty`/…), so
 * comparing it against a reservation would compare a received quantity with an expectation on one of the
 * two paths and call a half-booked ASN a match. Both callers read the raw `ASNItem` through this function.
 */
export function readMintsoftAsnItemExpectedQuantity(item: unknown): number | null {
  const record = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null
  const value = record?.QuantityExpected
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * EVERY WAY A REMOTE ASN CAN FAIL TO BE THE ONE EXPECTED. One difference is reported — the first by the
 * precedence in `compareMintsoftAsnAgainstExpectation` — because the callers act on one verdict, and every
 * one of them names what an operator has to look at.
 */
export type MintsoftAsnDifference =
  | { kind: 'same' }
  | { kind: 'reference'; remoteReference: string | null }
  | { kind: 'lineIdentityUnreadable' }
  /** Readable, and it shares NO source line with the reservation: another consignment entirely. */
  | { kind: 'linesUnrelated'; missingSourceLineIds: string[]; remoteItemCount: number }
  /**
   * Readable, and it covers SOME of the reservation's source lines but not exactly them — the ASN at the
   * warehouse holds {a,b} while the reservation now covers {a,b,c}, or the other way round. Round 7's Codex
   * HIGH: this used to be proof of absence, and a second inbound ASN went out for a and b.
   */
  | { kind: 'linesOverlap'; sharedSourceLineIds: string[]; missingSourceLineIds: string[]; remoteItemCount: number }
  | { kind: 'quantityUnreadable'; sourceLineId: string; expectedQty: number }
  | { kind: 'quantity'; sourceLineId: string; expectedQty: number; remoteQty: number }
  | { kind: 'quantityRounded'; sourceLineId: string; expectedQty: number; remoteQty: number }
  | { kind: 'warehouse'; remoteWarehouseId: string | null }

/** Every kind the union has, so a test can prove the tables below cover all of them and not a subset. */
export const MINTSOFT_ASN_DIFFERENCE_KINDS = [
  'same',
  'reference',
  'lineIdentityUnreadable',
  'linesUnrelated',
  'linesOverlap',
  'quantityUnreadable',
  'quantity',
  'quantityRounded',
  'warehouse',
] as const satisfies ReadonlyArray<MintsoftAsnDifference['kind']>

const REFERENCE_KEYS = ['POReference', 'Reference', 'reference'] as const
const WAREHOUSE_KEYS = ['WarehouseId', 'warehouseId'] as const

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
 * The items Mintsoft returned, not the ones we could read. The normalizers drop an item they cannot key, so
 * counting normalized lines would let an ASN with an EXTRA item pass as "exactly our lines" (round 3,
 * review L-a). `null` when the row carries no `Items` array at all — which the list reader already refuses
 * upstream (`MintsoftAsnListIncompleteError`), and which the by-id read cannot produce for a mappable ASN.
 */
function remoteItems(asn: WmsAsnRef): unknown[] | null {
  const items = asn.raw?.Items
  return Array.isArray(items) ? items : null
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

/**
 * IS THIS REMOTE ASN THE ONE EXPECTED, AND IF NOT, HOW NOT?
 *
 * PRECEDENCE, and why it is this way round:
 *   1. the reference, because everything below is only asked of an ASN carrying OUR reference;
 *   2. a line identity that cannot be READ, before the line sets are compared — comparing first is what let
 *      a degraded `SourceLineId` read as "a different ASN" and pushed a second ASN for the same lines
 *      (round 5, Codex HIGH 2);
 *   3. the exact item set: every expected line present, and no item beyond them;
 *   4. the quantities, unreadable before merely different before rounding-explainable, so that while ANY
 *      line cannot be read the ASN cannot be told apart from ours (round 4, Codex HIGH 1);
 *   5. the warehouse, which is only meaningful once this is the same ASN at all (review M3).
 */
export function compareMintsoftAsnAgainstExpectation(
  asn: WmsAsnRef,
  expectation: MintsoftAsnExpectation,
): MintsoftAsnDifference {
  const remoteReference = rawString(asn.raw, REFERENCE_KEYS)
  if (remoteReference !== expectation.reference.trim()) return { kind: 'reference', remoteReference }

  const items = remoteItems(asn)
  if (items?.some((item) => readMintsoftAsnItemLineIdentity(item).kind === 'unreadable')) {
    return { kind: 'lineIdentityUnreadable' }
  }

  const remoteItemCount = items ? items.length : asn.lines.length
  const bySourceLineId = new Map(asn.lines.map((line) => [line.sourceLineId, line]))
  const missingSourceLineIds = expectation.lines
    .map((line) => line.sourceLineId)
    .filter((sourceLineId) => !bySourceLineId.has(sourceLineId))
  if (missingSourceLineIds.length > 0 || remoteItemCount !== expectation.lines.length) {
    // WHICH of our lines this row DOES cover is the whole question (round 7): sharing none of them is
    // determinate evidence of another consignment, sharing some is the lost-response shape.
    const sharedSourceLineIds = expectation.lines
      .map((line) => line.sourceLineId)
      .filter((sourceLineId) => bySourceLineId.has(sourceLineId))
    return sharedSourceLineIds.length > 0
      ? { kind: 'linesOverlap', sharedSourceLineIds, missingSourceLineIds, remoteItemCount }
      : { kind: 'linesUnrelated', missingSourceLineIds, remoteItemCount }
  }

  let unreadable: MintsoftAsnDifference | null = null
  let different: MintsoftAsnDifference | null = null
  let rounded: MintsoftAsnDifference | null = null
  for (const line of expectation.lines) {
    const remoteQty = readMintsoftAsnItemExpectedQuantity(bySourceLineId.get(line.sourceLineId)?.raw)
    if (remoteQty == null) {
      unreadable ??= { kind: 'quantityUnreadable', sourceLineId: line.sourceLineId, expectedQty: line.expectedQty }
      continue
    }
    if (quantitiesMatch(remoteQty, line.expectedQty)) continue
    if (roundingCouldExplain(line.expectedQty, remoteQty)) {
      rounded ??= { kind: 'quantityRounded', sourceLineId: line.sourceLineId, expectedQty: line.expectedQty, remoteQty }
      continue
    }
    different ??= { kind: 'quantity', sourceLineId: line.sourceLineId, expectedQty: line.expectedQty, remoteQty }
  }
  if (unreadable) return unreadable
  if (different) return different
  if (rounded) return rounded

  const remoteWarehouseId = rawString(asn.raw, WAREHOUSE_KEYS)
  if (remoteWarehouseId !== expectation.externalWarehouseId.trim()) return { kind: 'warehouse', remoteWarehouseId }

  return { kind: 'same' }
}

/**
 * WHICH DIFFERENCES ARE DETERMINATE EVIDENCE THAT THIS REMOTE ASN IS NOT THE ONE AN EARLIER ATTEMPT CREATED
 * FOR THIS RESERVATION — the ONLY things a proof of absence may be built from. Everything else is
 * unresolved and refuses. This table is the rule; adding a `true` to it is the only way to widen what may
 * be created, and it cannot be done anywhere else.
 *
 * IT TAKES THE MAP STATE because of the two conditions a proof of absence needs (see the file header): a
 * difference in READABLE CONTENT can show this is a different consignment, but only `wms_asn_maps` can show
 * it is not the ASN a lost create left behind. Exactly two kinds need the second answer — `linesOverlap` and
 * `quantity` — and for them `mapped` is the whole of it. `unmapped` and `unknown` both refuse, for different
 * reasons that the refusals name: one is the lost-response shape, the other is a map IMS could not read, and
 * an unreadable map is not permission.
 */
export function isProofThatMintsoftAsnIsNotThisOne(
  difference: MintsoftAsnDifference,
  mapState: MintsoftAsnMapState,
): boolean {
  switch (difference.kind) {
    case 'reference':
      // Mintsoft stores and returns `POReference` verbatim (proven live 2026-09-24), and it is the field
      // both creators put the reservation's reference in. Another reference is another purchase order or
      // transfer: determinate, and the only reason the tenant-wide scan is affordable at all. Needs no map:
      // a create for THIS reference cannot have produced a row carrying another one.
      return true
    case 'linesUnrelated':
      // Every identity on the row was READABLE (that is checked first), so the item set is known exactly,
      // and it shares NOTHING with this reservation's set. A source line id is an IMS primary key: it never
      // changes under a reservation, and Mintsoft returns it verbatim, so an ASN over none of our lines is
      // an ASN for other goods — a different consignment, and not one a lost create for THESE lines made.
      //
      // The one shape this leaves (bounded, and stated rather than hidden): if EVERY line of the purchase
      // order were deleted and re-added between a lost create and the retry, the reservation's ids would all
      // be new and the ASN the lost create made would share none of them. It needs an operator to replace
      // every line of an order that already has an ASN in flight; o3d-54al records it.
      return true
    case 'linesOverlap':
      // ROUND 7, CODEX HIGH. This used to be `true` — one `lines` kind covered both, and "the sets differ"
      // was read as "not ours". The reachable sequence: Mintsoft creates the ASN, IMS loses the response,
      // the purchase order GAINS a line, and the retry's reservation (whose pending lines are refreshed from
      // the order's current outstanding lines) covers {a,b,c} while the ASN at the warehouse holds {a,b}.
      // Answering "create one" sends a second inbound ASN for a and b, and the warehouse expects the same
      // goods twice.
      //
      // The map is what makes refusing it affordable. Every ASN for a purchase order carries the ORDER's
      // reference, so a second ASN over a different set of the same order's lines is how a partial delivery
      // works; refusing every overlap would mean no order could have two ASNs without an operator (which is
      // why round 6 left this permitted). An ASN IMS has MAPPED is a partial IMS has already recorded — it
      // cannot be what a lost create left behind, because "lost" means unrecorded — so it stays proof of
      // absence. An UNMAPPED overlap is the lost-response shape itself, and refuses by name.
      return mapState === 'mapped'
    case 'same':
      // The ASN we were looking for. Not absence: the caller adopts it (or, after a create, records it).
      return false
    case 'quantity':
      // ROUND 6, CODEX HIGH 2. This used to return "no match", i.e. "create another one". It is the same
      // ASN by reference and by every line identity, with a quantity that differs. Three states produce
      // that: an ASN a lost create really did make, whose source quantity has changed since; an ASN an
      // operator edited at the warehouse; and a later partial for the same lines. Answering "create" turns
      // the first two into a second inbound ASN at a live warehouse for lines that are already expected.
      // ROUND 7 supplies what round 6 said was missing and left to o3d-54al: the third state is the one IMS
      // has MAPPED, and it is proof of absence again, so a legitimate later partial over the same lines no
      // longer needs an operator. Unmapped — the first two states — still refuses by name.
      return mapState === 'mapped'
    case 'quantityRounded':
      // `ASNItem.QuantityExpected` is int32, so a fractional expectation cannot survive the round trip
      // (review L-b). INDISTINGUISHABLE from our own ASN, so the first condition a proof of absence needs
      // is not met and the map cannot supply it: mapped or not, this row may be carrying our own quantity.
      return false
    case 'quantityUnreadable':
      // A quantity Mintsoft did not return says nothing at all (round 4, Codex HIGH 1).
      return false
    case 'lineIdentityUnreadable':
      // An item we cannot key is a row we cannot EXCLUDE (round 5, Codex HIGH 2). Not even a map row makes
      // it excludable: what this ASN covers is unknown, so whether creating another duplicates it is unknown.
      return false
    case 'warehouse':
      // The rebind case (review M3): the same ASN — our reference, our exact lines, our exact quantities —
      // at the warehouse the binding pointed at before. Identical content, so it is not a different
      // consignment at all, whether or not IMS has mapped it. Finding it elsewhere is not a licence to adopt
      // it and not a licence to create a second one.
      return false
  }
}

/** One human phrase per difference, for the refusals. `expectation` supplies what was asked for. */
export function describeMintsoftAsnDifference(
  difference: MintsoftAsnDifference,
  expectation: MintsoftAsnExpectation,
): string {
  switch (difference.kind) {
    case 'same':
      return 'it is the ASN that was asked for'
    case 'reference':
      return `it carries POReference ${difference.remoteReference == null ? '(none)' : `"${difference.remoteReference}"`}`
        + ` where "${expectation.reference.trim()}" was sent`
    case 'lineIdentityUnreadable':
      return 'it carries an item whose SourceLineId cannot be read (absent, null or blank), so its lines '
        + 'cannot be told apart from the ones that were sent'
    case 'linesUnrelated':
      return (difference.missingSourceLineIds.length > 0
        ? `it carries none of the source lines that were sent (not ${difference.missingSourceLineIds.join(', ')})`
        : 'it carries an item that was not sent')
        + ` (sent ${expectation.lines.length} item(s), it holds ${difference.remoteItemCount})`
    case 'linesOverlap':
      return `it already covers source line ${difference.sharedSourceLineIds.join(', ')}`
        + (difference.missingSourceLineIds.length > 0
          ? ` but not ${difference.missingSourceLineIds.join(', ')}`
          : ', plus an item that was not sent')
        + ` (sent ${expectation.lines.length} item(s), it holds ${difference.remoteItemCount})`
    case 'quantityUnreadable':
      return `line ${difference.sourceLineId} came back with no readable QuantityExpected where `
        + `${difference.expectedQty} was sent`
    case 'quantity':
      return `line ${difference.sourceLineId} expects ${difference.remoteQty} where ${difference.expectedQty} was sent`
    case 'quantityRounded':
      return `line ${difference.sourceLineId} expects ${difference.remoteQty} where ${difference.expectedQty} was `
        + 'sent, which is what Mintsoft storing a fractional quantity as a whole number looks like'
    case 'warehouse':
      return `it is at warehouse ${difference.remoteWarehouseId ?? '(none)'} rather than warehouse `
        + `${expectation.externalWarehouseId.trim()}`
  }
}

/**
 * WHAT MAY BE DONE ABOUT THE REMOTE STATE. `absenceProven` is the only verdict that lets an ASN be created
 * at a live warehouse, and it can only be reached by ruling every candidate out with
 * `isProofThatMintsoftAsnIsNotThisOne`.
 */
export type MintsoftAsnCreationVerdict =
  | { kind: 'absenceProven' }
  | { kind: 'existingAsn'; asn: WmsAsnRef }
  | { kind: 'refused'; error: Error }

/**
 * THE GATE. The only place in the Mintsoft connector that answers "create one" (by returning `null`) or
 * "this is it" (by returning the ASN); everything else throws the refusal it was given, by name.
 */
export function requireMintsoftAsnCreationVerdict(verdict: MintsoftAsnCreationVerdict): WmsAsnRef | null {
  switch (verdict.kind) {
    case 'refused':
      throw verdict.error
    case 'existingAsn':
      return verdict.asn
    case 'absenceProven':
      return null
  }
}

/**
 * THE POST-CREATE SIDE OF THE SAME GATE. Mintsoft has just reported this ASN created for this request, so
 * there is no "different ASN" answer available here and no proof of absence to reach: ANY difference is
 * unresolved, and the ASN id is named so it can be reconciled (it exists at the warehouse, and
 * `DELETE /api/ASN/{id}` is the only way to remove it).
 */
export function requireMintsoftAsnIsTheOneRequested(
  created: WmsAsnRef,
  expectation: MintsoftAsnExpectation,
  refuse: (detail: string) => Error,
): WmsAsnRef {
  const difference = compareMintsoftAsnAgainstExpectation(created, expectation)
  const confirmed = requireMintsoftAsnCreationVerdict(
    difference.kind === 'same'
      ? { kind: 'existingAsn', asn: created }
      : { kind: 'refused', error: refuse(describeMintsoftAsnDifference(difference, expectation)) },
  )
  // `existingAsn` always returns the ASN; the gate's create arm is unreachable from here because no
  // verdict built above can be `absenceProven`.
  return confirmed ?? created
}
