import type { WmsAsnRef } from '@/lib/connectors/wms/types'
import {
  compareMintsoftAsnAgainstExpectation,
  describeMintsoftAsnDifference,
  isProofThatMintsoftAsnIsNotThisOne,
  readMintsoftAsnMapState,
  requireMintsoftAsnCreationVerdict,
  type MintsoftAsnCreationVerdict,
  type MintsoftAsnDifference,
  type MintsoftAsnExpectation,
  type MintsoftAsnMapKnowledge,
} from './asn-creation-rule'

/**
 * WHICH REMOTE ASN, IF ANY, AN EARLIER ATTEMPT ALREADY CREATED (o3d-bhvu rounds 2–6).
 *
 * Both Mintsoft ASN creators (app/actions/mintsoft-sync.ts: createMintsoftPurchaseOrderAsn and
 * createMintsoftTransferAsn) run this before they push. A push whose response was lost has created
 * the ASN at the warehouse without IMS recording it, so the retry must find it rather than create a
 * second. Pure, so the decision can be tested on rows rather than on source text — the two creators
 * used to carry a copy of it each as a closure.
 *
 * THE DECISION IS NOT MADE HERE. What one remote ASN IS, relative to a reservation, and which differences
 * are determinate evidence that it is not ours, live in `asn-creation-rule.ts` — the single statement of
 * the rule that the post-create read-back in `client.ts` goes through as well (round 6). This file does
 * only the part that is about a LIST rather than about one ASN: which rows are candidates at all, what two
 * candidates mean, and which named refusal an unresolved candidate deserves.
 *
 * THE MATCH: every ASN whose reference EQUALS the reservation's (trimmed; `POReference` is where Mintsoft
 * stores it — a prefix or a substring is not a match, so `PO-1` never claims `PO-10`), carrying EXACTLY as
 * many items as the reservation has lines, with each reservation line present by `SourceLineId` and each
 * line's `QuantityExpected` equal to the reservation's.
 *
 * THERE IS NO CALLBACK-URL MATCH ANY MORE (round 5, o3d-vcw8). Rounds 2–4 tried the reservation's
 * correlated callback URL first, "the strongest evidence there is". It was never evidence of anything: the
 * string "Callback" appears ZERO times in the entire Mintsoft API document, so no ASN can carry a
 * CallbackUrl and that branch could only ever match nothing. It is removed rather than left inert, because
 * an inert first branch reads as a correlation channel this integration has. `POReference` plus
 * `Items[].SourceLineId` IS the correlation — both proven to round-trip verbatim on 2026-09-24.
 *
 * MORE THAN ONE CANDIDATE IS A REFUSAL, NOT A CHOICE (round 3, review M-b). Round 2 said "the most
 * recently created wins" and sorted on a `CreatedAt` that live ASN rows do not have (the swagger's ASN
 * model has `LastUpdated` only), so every row sorted equal and the LIST's order decided — and that order
 * is documented as unstable across pages. The same state could therefore adopt on one retry and refuse on
 * the next. There is no tie-break worth inventing here: two ASNs that carry this reference and cannot be
 * ruled out mean the duplicate this whole path exists to prevent may already have happened, so the attempt
 * fails naming both ids and an operator decides. Nothing here depends on the order of `asns`.
 *
 * A QUANTITY THAT DIFFERS IS AN UNRESOLVED CONFLICT, NOT "A DIFFERENT ASN" (round 6, Codex HIGH 2). Rounds
 * 3–5 refused an unreadable quantity and a rounding-explainable one but still answered a plainly different
 * one with "no such ASN exists, create one". A reference and a whole line set that match, with a quantity
 * that does not, is exactly what an ASN created by a lost attempt looks like after the source quantity has
 * changed — and the reservation checks validate the CURRENT LOCAL quantities, never whether that remote
 * ASN exists. So it is refused by name, like every other unresolved state here.
 *
 * AN OVERLAPPING LINE SET IS NOT PROOF EITHER, UNLESS IMS HAS ALREADY MAPPED THAT ASN (round 7, Codex HIGH;
 * this is o3d-54al's already-mapped check, landed here because it is the mechanism the fix needs). Rounds
 * 2–6 answered a row carrying our reference over SOME of our lines with "somebody else's ASN, create one":
 * Mintsoft creates the ASN, IMS loses the response, the purchase order gains a line, and the retry covers
 * {a,b,c} where the ASN at the warehouse holds {a,b} — so a second inbound ASN went out for a and b. Round 6
 * left it permitted because the reference belongs to the ORDER and a second ASN over a different set of its
 * lines is how a partial delivery works. The map settles which of the two it is: a partial IMS has recorded
 * has a `wms_asn_maps` row and stays proof of absence, while an UNMAPPED overlap is precisely what a lost
 * response leaves behind and refuses by name. THE MATCHER STAYS PURE — the map lives in the database, so the
 * CALLER reads it (one helper in app/actions/mintsoft-sync.ts, used by both creators) and passes the ids in
 * as `criteria.mapKnowledge`; and if that read fails, `unreadable` is passed, which refuses rather than
 * permits.
 *
 * WHAT IT DOES NOT LOOK AT, ON PURPOSE: the ASN's STATUS. A COMPLETE, booked-in ASN carrying the same
 * reference and exactly the same line ids and quantities IS the ASN this attempt's lost create made, and
 * adopting it is right — creating a second one for goods already on the shelves is the failure this file
 * exists to prevent. What the status changes is not WHICH ASN this is but what is OWED once it has been
 * adopted, and that is the ADOPTER's business, not the matcher's: round 8 (Codex HIGH) moved it there.
 * The connector reads the status (`asn-status.ts` interprets it against the 13 statuses
 * `GET /api/ASN/Statuses` serves; anything else is unknown, and unknown is not open), the creators record
 * it and enqueue a booked-in recheck for an ASN the warehouse may already have received against, and a
 * status IMS cannot interpret refuses rather than being recorded as an ASN still to arrive. Before round 8
 * a recovered COMPLETE ASN was written down as OPEN and the attempt waited for a booked-in callback that
 * had already happened.
 */
export type MintsoftAsnRecoveryCriteria = MintsoftAsnExpectation & {
  /**
   * WHICH OF THE REMOTE ASN IDS IMS HAS ALREADY RECORDED, or the fact that it could not find out. Required,
   * not optional: a caller that forgets it cannot compile, because defaulting it would default to either
   * "nothing is mapped" (an operator for every legitimate second partial) or "everything is" (the duplicate
   * this exists to prevent), and neither is a safe silent default.
   */
  mapKnowledge: MintsoftAsnMapKnowledge
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
      `Mintsoft ASNs ${externalAsnIds.join(', ')} all carry reference ${reference} and cannot be ruled out as the `
      + 'ASN an earlier attempt created for these lines. Refusing both to adopt one of them arbitrarily — the list '
      + 'order decides which, and it is not stable — and to create a third; resolve the duplicate in Mintsoft, '
      + 'then retry.',
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

/**
 * ROUND 6, CODEX HIGH 2. The reference and every line identity match; a quantity does not. That is what an
 * ASN created by an attempt whose response IMS lost looks like once the source quantity has changed, and
 * it is also what an operator's edit at the warehouse looks like, and what a later partial over the same
 * lines looks like. Answering it with "no such ASN exists" pushed a SECOND inbound ASN for lines the first
 * already covers.
 */
export class MintsoftAsnRecoveryQuantityConflictError extends Error {
  constructor(externalAsnId: string, sourceLineId: string, expectedQty: number, remoteQty: number) {
    super(
      `Mintsoft ASN ${externalAsnId} carries this reference and exactly these lines, but line ${sourceLineId} `
      + `expects ${remoteQty} where the reservation expects ${expectedQty}. A quantity that differs is not `
      + 'evidence of a different ASN: an ASN an earlier attempt created, whose quantity has changed since (in '
      + 'IMS or at the warehouse), looks exactly like this. Refusing both to adopt it — the reservation is for '
      + `${expectedQty} — and to create a second one. NO ASN WILL BE CREATED for this reservation until an `
      + 'operator reconciles that ASN in Mintsoft (edit or delete it), then retry.',
    )
    this.name = 'MintsoftAsnRecoveryQuantityConflictError'
  }
}

/**
 * ROUND 7, CODEX HIGH. A row carrying our reference that already covers SOME of the lines this reservation is
 * about to send, which IMS has NO map row for. That is what a create whose response was lost leaves behind,
 * and answering it with "no such ASN exists" made the warehouse expect the same goods twice.
 */
export class MintsoftAsnRecoveryLineSetOverlapError extends Error {
  constructor(externalAsnId: string, reference: string, sharedSourceLineIds: readonly string[], description: string) {
    super(
      `Mintsoft ASN ${externalAsnId} carries reference ${reference} and IMS has no ASN map row for it, and `
      + `${description}. An ASN IMS never recorded is exactly what a create whose response was lost leaves `
      + `behind, and this one already covers source line ${sharedSourceLineIds.join(', ')} — so answering "no `
      + 'such ASN exists" would make the warehouse expect the same goods twice. Refusing both to adopt it (its '
      + 'line set is not this reservation\'s) and to create a second one. NO ASN WILL BE CREATED for this '
      + 'reservation until an operator reconciles that ASN in Mintsoft (book it in or delete it), then retry. An '
      + 'ASN IMS has ALREADY MAPPED does not block anything: a legitimate second partial for this order still '
      + 'goes through.',
    )
    this.name = 'MintsoftAsnRecoveryLineSetOverlapError'
  }
}

/**
 * ROUND 7. The decision needed the ASN map — is this row a partial IMS has recorded, or the ASN a lost create
 * left behind? — and the map could not be read. The rule of this branch, applied to IMS's own state for once:
 * unreadable is not permission.
 */
export class MintsoftAsnRecoveryMapUnreadableError extends Error {
  constructor(externalAsnId: string, reference: string, description: string, detail: string) {
    super(
      `Mintsoft ASN ${externalAsnId} carries reference ${reference} and ${description}, and IMS could not read its `
      + `own ASN map to tell whether it has already recorded that ASN (${detail}). Whether this row is a partial `
      + 'IMS knows about or the ASN an earlier attempt created and IMS never recorded is exactly what the map '
      + 'answers, so nothing here can prove this ASN is not the one that attempt created. Nothing was created and '
      + 'NO ASN WILL BE CREATED for this reservation until the ASN map reads back, then retry.',
    )
    this.name = 'MintsoftAsnRecoveryMapUnreadableError'
  }
}

/** The refusal for a candidate the rule leaves unresolved, named for what the difference actually is. */
function refusalFor(
  asn: WmsAsnRef,
  difference: MintsoftAsnDifference,
  criteria: MintsoftAsnRecoveryCriteria,
): Error {
  // ROUND 7: two kinds are unresolved ONLY because the map could not answer them (see
  // `isProofThatMintsoftAsnIsNotThisOne`), so when that is why, the refusal says so rather than blaming the
  // difference. It changes the NAME of the refusal, never whether one happens: both branches refuse.
  if (criteria.mapKnowledge.kind === 'unreadable' && (difference.kind === 'linesOverlap' || difference.kind === 'quantity')) {
    return new MintsoftAsnRecoveryMapUnreadableError(
      asn.externalAsnId,
      criteria.reference.trim(),
      describeMintsoftAsnDifference(difference, criteria),
      criteria.mapKnowledge.detail,
    )
  }
  switch (difference.kind) {
    case 'linesOverlap':
      return new MintsoftAsnRecoveryLineSetOverlapError(
        asn.externalAsnId,
        criteria.reference.trim(),
        difference.sharedSourceLineIds,
        describeMintsoftAsnDifference(difference, criteria),
      )
    case 'quantityUnreadable':
      return new MintsoftAsnRecoveryQuantityUnreadableError(asn.externalAsnId, difference.sourceLineId, difference.expectedQty)
    case 'quantity':
      return new MintsoftAsnRecoveryQuantityConflictError(asn.externalAsnId, difference.sourceLineId, difference.expectedQty, difference.remoteQty)
    case 'quantityRounded':
      return new MintsoftAsnRecoveryQuantityRoundedError(asn.externalAsnId, difference.sourceLineId, difference.expectedQty, difference.remoteQty)
    case 'warehouse':
      return new MintsoftAsnRecoveryWarehouseMismatchError(asn.externalAsnId, difference.remoteWarehouseId, criteria.externalWarehouseId)
    case 'lineIdentityUnreadable':
      return new MintsoftAsnRecoveryLineIdentityUnreadableError([asn.externalAsnId], criteria.reference.trim())
    case 'same':
    case 'reference':
    case 'linesUnrelated':
      // Ruled out or adopted before this point. Refusing rather than falling through to "create" keeps the
      // rule true of a difference kind added later that nobody wired up here.
      return new Error(
        `Mintsoft ASN ${asn.externalAsnId} carries reference ${criteria.reference.trim()} and this code cannot say `
        + `what it is (${difference.kind}). Refusing to create another ASN for this reservation; check it in Mintsoft.`,
      )
  }
}

/**
 * THE RECOVER-OR-CREATE VERDICT. `absenceProven` is reached only when EVERY row in the list was ruled out
 * by `isProofThatMintsoftAsnIsNotThisOne` — there is no other way out of this function that permits a
 * create.
 */
export function decideMintsoftAsnCreation(
  asns: readonly WmsAsnRef[],
  criteria: MintsoftAsnRecoveryCriteria,
): MintsoftAsnCreationVerdict {
  const reference = criteria.reference.trim()
  const unresolved = asns
    .map((asn) => ({
      asn,
      difference: compareMintsoftAsnAgainstExpectation(asn, criteria),
      // ROUND 7: the ONLY thing IMS's own records contribute, read here and nowhere else in this file.
      mapState: readMintsoftAsnMapState(asn, criteria.mapKnowledge),
    }))
    .filter(({ difference, mapState }) => !isProofThatMintsoftAsnIsNotThisOne(difference, mapState))

  // BEFORE anything else, because a row we cannot key is a row we cannot EXCLUDE (round 5, Codex HIGH 2),
  // and every such row is named, in SORTED order, so the refusal does not depend on the list's page order.
  const unreadable = unresolved
    .filter(({ difference }) => difference.kind === 'lineIdentityUnreadable')
    .map(({ asn }) => asn.externalAsnId)
    .sort()
  if (unreadable.length > 0) {
    return { kind: 'refused', error: new MintsoftAsnRecoveryLineIdentityUnreadableError(unreadable, reference) }
  }

  if (unresolved.length > 1) {
    return {
      kind: 'refused',
      error: new MintsoftAsnRecoveryAmbiguousMatchError(unresolved.map(({ asn }) => asn.externalAsnId).sort(), reference),
    }
  }

  const candidate = unresolved[0]
  if (!candidate) return { kind: 'absenceProven' }
  if (candidate.difference.kind === 'same') return { kind: 'existingAsn', asn: candidate.asn }
  return { kind: 'refused', error: refusalFor(candidate.asn, candidate.difference, criteria) }
}

/** The ASN an earlier attempt created, or `null` meaning a create is permitted — through the one gate. */
export function findRecoverableMintsoftAsn(
  asns: readonly WmsAsnRef[],
  criteria: MintsoftAsnRecoveryCriteria,
): WmsAsnRef | null {
  return requireMintsoftAsnCreationVerdict(decideMintsoftAsnCreation(asns, criteria))
}
