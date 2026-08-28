/**
 * o3d-54p — OPERATOR RECOVERY for a STALE CROSS-ORDER WooCommerce refund park.
 *
 * THE STUCK STATE THIS EXISTS FOR.
 *
 * o3d-ee9/o3d-7yf made the refund CREATE and the park CREATE serialise on one advisory lock
 * (`hashtext('wc_refund:'||id)`) and, under it, fail CLOSED whenever the external refund id is
 * already parked as an actionable WooCommerce refund for a DIFFERENT order. Failing closed is the
 * right AUTOMATIC behaviour — silently resolving or moving a foreign park would destroy one order's
 * durable refund evidence and mis-block the other. But it left no way out of a park that is
 * genuinely stale (a bad historical order-link association, an order rebind, an import anomaly):
 *
 *   • createSalesOrderRefund for the TRUE owner throws on the foreign park, every time;
 *   • syncWcRefund refuses the same way, every sweep;
 *   • retryRefundSyncPark can only re-fetch the park's OWN recorded order — for a park sitting on
 *     the wrong order that fetch cannot contain the refund, so the retry can never resolve it and
 *     never reassign it;
 *   • actionable parks are retention-exempt (lib/data-retention.ts) and block the order delete
 *     guard (lib/domain/sales/order-delete-guard.ts) and the store-URL rebind (app/actions/wc-sync.ts).
 *
 * So the refund, its credit note and its restock are blocked indefinitely, and both orders are
 * undeletable, with no operator act that can change any of it. That is the shape this session kept
 * finding: a refusal with no reachable remedy.
 *
 * WHAT THE OPERATOR MAY NOW ASSERT, AND WHAT VERIFIES IT.
 *
 *   { outcome: 'REASSIGN', wcOrderId }  "this refund belongs to WooCommerce order N, not here"
 *   { outcome: 'DISMISS',  reason? }    "WooCommerce no longer has this refund on this order"
 *
 * Unlike o3d-nf9i's accounting settlement — where the fact (did the ledger take it?) is genuinely
 * uncomputable and the operator's word is the only source — WooCommerce IS the authority on which
 * order a refund belongs to, and it can be asked. So this action does NOT take the operator's word
 * for the ownership fact. It takes their word for WHICH ORDER TO CHECK, then checks it against
 * FRESH source data and refuses when the answer contradicts them. That is the settled rule
 * "verified evidence outranks an unverifiable assertion" applied where the evidence is reachable.
 *
 * The operator's assertion is still recorded with their name on it, because WHAT TO DO about a
 * genuine anomaly (move it, or write it off) is theirs and not the system's — and this module
 * prescribes nothing about which to choose.
 *
 * Pure functions only, exactly as connector-orphans.ts and sync-row-settlement.ts are, so the
 * decision vocabulary is unit-testable without a database or a WooCommerce store.
 */

/**
 * The park statuses an operator may recover.
 *
 * These are precisely the ACTIONABLE statuses — the set carried by the partial unique index
 * `shopping_sync_logs_active_refund_park_uq`, by REFUND_PARK_WHERE in the exception inbox, by the
 * order delete guard, and by the retention exemption. A park in any of them is blocking something;
 * a park outside them is already resolved and is not this action's business.
 *
 * QUARANTINED is included deliberately. It is the o3d-iup "monetary-only refund on a non-uniformly
 * taxed order" refusal — but the tax profile it was refused against is the profile of the order the
 * park is sitting on, which is exactly what is in question here. A quarantine computed against the
 * WRONG order carries no information about the right one.
 */
export const RECOVERABLE_REFUND_PARK_STATUSES = ['PENDING', 'FAILED', 'QUARANTINED'] as const

export type RecoverableRefundParkStatus = (typeof RECOVERABLE_REFUND_PARK_STATUSES)[number]

export function isRecoverableRefundParkStatus(status: string): status is RecoverableRefundParkStatus {
  return (RECOVERABLE_REFUND_PARK_STATUSES as readonly string[]).includes(status)
}

/**
 * WHAT THIS ROW IS — the value a refund park stamps into `recordKind` (o3d-xnwu r8, Codex HIGH).
 *
 * `entityType` says what the row is ABOUT (a sales order). This says what the row IS. They are
 * different questions and r7's predicate could only ask the first one, which is why it admitted a
 * held sales invoice — see {@link activeRefundParkWhere}.
 *
 * Written by `upsertRefundPark` and by nothing else, and read by every predicate that means "an
 * actionable refund park". It is an assertion the writer makes about its own row, never an
 * inference from what a row lacks.
 */
export const WC_REFUND_PARK_RECORD_KIND = 'WC_REFUND_PARK'

/**
 * THE WITNESS — the activity-log action `recoverParkedWcRefund` writes when it recovers a park, and
 * the only evidence check 7 of the 20260822120000 migration's verify.sql has to join to (o3d-xnwu
 * r14, Codex HIGH).
 *
 * Check 7 exists because the ACCUSED ROW CAN BE MADE INNOCENT. The predecessor's held-invoice
 * writer overwrites a recovered park wholesale — payload, externalId, errorMessage, status — and
 * every check that reads the row alone then returns zero over a destroyed accounting payload. So
 * the evidence has to come from somewhere the second write cannot reach, and this entry is it: a
 * fact about the PAST, naming the row in `metadata.shoppingSyncLogId`.
 *
 * WHICH MAKES IT EVIDENCE, NOT HISTORY, AND EVIDENCE HAS TO BE AS DURABLE AS THE THING IT
 * WITNESSES. It was neither. It was written with `logActivity` AFTER the recovery transaction
 * committed — and `logActivity` swallows its own failures, so an ordinary transient write error
 * (not merely a crash) left the recovery committed with nothing to join to. And it is a WARNING,
 * which `purgeExpiredActivityLogs` deletes after 60 days by default, so a cutover run a quarter
 * after the recovery would find no witness for a row that really was recovered and the check would
 * go quiet — silently, and exactly for the oldest incidents.
 *
 * Both are closed, and it takes both:
 *
 *   1. THE WITNESS IS WRITTEN IN THE RECOVERY'S OWN TRANSACTION, with `logActivityInTransaction`,
 *      which does not catch. No recovery can commit without it; a witness write that fails takes
 *      the recovery down with it, and the operator sees a failure and retries. That is the right
 *      way round for a mutation whose only later audit is this row.
 *   2. IT IS EXEMPT FROM ACTIVITY-LOG RETENTION (lib/activity-log-cleanup.ts). Ageing it out does
 *      not expire a log line; it deletes the only proof that a recovered row was ever recovered,
 *      and switches off the one check a later overwrite cannot switch off.
 *
 * Named here, in the pure module the recovery vocabulary lives in, so that the writer, the
 * retention exemption and the tests all spell it the same way. verify.sql carries the same literal
 * and tests/prisma/shopping-sync-log-record-kind-verify.test.ts holds the two together.
 */
export const WC_REFUND_PARK_RECOVERED_ACTION = 'wc_refund_park_recovered'

/**
 * THE ONE PREDICATE THAT SAYS "THIS ROW IS AN ACTIVE REFUND PARK" — AND IT SAYS SO POSITIVELY
 * (o3d-xnwu r7, Codex HIGH).
 *
 * Every column here is written by IMS. `connector`, `direction` and `entityType` are literals the
 * refund sync supplies; `entityId` is the IMS sales-order id a park is BY DEFINITION attached to;
 * `status` is the actionable set; `recordKind` is the row's own statement of which family it
 * belongs to. Nothing an operator can type into WooCommerce appears in it, and nothing is decided
 * by ABSENCE. That is the whole point of the shape.
 *
 * AND IT IS REFUND-SPECIFIC, WHICH r7 WAS NOT (o3d-xnwu r8, Codex HIGH). r7 was right that the
 * definition had to be positive, and right that `entityId` was the column separating a park from
 * the pending-FX queue and the admission-refusal queue — both of which have none. It was wrong that
 * this made the predicate a REFUND predicate. A held sales invoice (o3d-k26m.6,
 * `holdWcSalesInvoiceForMissingNumber`) writes the same connector, the same direction, the same
 * `SalesOrder` entity type, PENDING, and the IMS order id in `entityId`, so it satisfied all five
 * clauses. The recovery inbox listed an invoice hold as a refund park and offered "Wrong order" and
 * "Dismiss" on it — a REASSIGN would have moved an invoice payload onto another order as a PENDING
 * park, and a DISMISS would have closed a hold on an invoice nothing then posts.
 *
 * WHY A NEW COLUMN AND NOT AN EXISTING ONE. There was no existing one. `shopping_sync_logs` carries
 * connector, direction, status, entityType, entityId, externalId, payload, errorMessage, syncedAt
 * and createdAt — no action, no reason code, no kind — and the hold matches this park on every one
 * of the five that are not free text. `syncedAt` happens to differ (a park is written with one, a
 * hold with NULL), and was rejected: it means "when this synced", so an unsettled PENDING park
 * carrying one is an accident of the writer rather than a distinction, and a recovery inbox built
 * on it would empty itself the day somebody tidied it up.
 *
 * AND NOT THE PAYLOAD, WHICH IS THE DEFECT r7 FIXED. The park's payload is the STORE'S. The hold's
 * marker lives at `payload.reason`, and `reason` on a WooCommerce refund is free text a human types
 * — so excluding holds by it would let an operator who wrote `missing_wc_invoice_number` hide their
 * own park, exactly as `missing_fx_rate` did. The collision runs both ways and the other way
 * WRITES, which is why `heldSalesInvoiceQueueWhere` now carries its own `recordKind` too.
 *
 * WHAT IT REPLACED, and why the replacement is not a tidy-up. The exception inbox used to select
 * parks by excluding rows whose payload's top-level `reason` was the pending-FX queue marker. A
 * refund park PERSISTS THE RAW WOOCOMMERCE REFUND, and `reason` is a free-text field a human types
 * when they issue a refund in WooCommerce. So an operator who typed that exact string hid their own
 * park from the only page that can recover it — and since a foreign park now HOLDS the refund
 * delivery, that was a permanent hold with no visible way out. An inbox that decides what to show by
 * exclusion is one bad guess away from hiding the thing an operator needs.
 *
 * The pending-FX queue rows the exclusion was aimed at are told apart by a column instead, and by
 * the one that cannot collide: they carry NO `entityId` (there is no IMS order yet — that is why
 * they are queued), and `pendingFxQueueWhere` now says so explicitly. The two sets are disjoint by
 * construction rather than by a guess about payload contents.
 *
 * ONE DEFINITION, three readers: the exception inbox, the refund sync's cross-order guard, and the
 * park upsert. They must agree with each other and with the partial unique index
 * `shopping_sync_logs_active_refund_park_uq`, and three hand-written copies could not.
 */
export function activeRefundParkWhere(): {
  connector: string
  direction: 'FROM_CONNECTOR'
  entityType: string
  entityId: { not: null }
  recordKind: typeof WC_REFUND_PARK_RECORD_KIND
  status: { in: RecoverableRefundParkStatus[] }
} {
  return {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    // A park is evidence ABOUT AN IMS ORDER, so it always names one. This is also what the partial
    // unique index requires, and what separates a park from the row families that have NO entityId
    // (a failed import, a pending-FX queue row, an admission refusal).
    entityId: { not: null },
    // …and this is what separates it from the one family that DOES have one: the held sales
    // invoice. The row says which family it belongs to; nothing here infers it (r8).
    recordKind: WC_REFUND_PARK_RECORD_KIND,
    status: { in: [...RECOVERABLE_REFUND_PARK_STATUSES] },
  }
}

/**
 * The status a resolved park carries.
 *
 * SYNCED is not a claim that this refund posted — it is this table's established "an operator
 * resolved it" terminal, and lib/data-retention.ts says so in as many words ("It must persist until
 * an operator resolves it (which flips it to SYNCED, after which it expires normally)").
 * resolveActionableParks and retryRefundSyncPark already write it for the same purpose.
 *
 * The DIFFERENCE between "the refund landed" and "the park was dismissed" is carried in
 * errorMessage: a landing CLEARS it to null, a dismissal REPLACES it with the recovery note. So a
 * SYNCED park with a non-null errorMessage beginning REFUND_PARK_RECOVERY_NOTE_PREFIX is a
 * dismissal and reads as one, without a new enum value rippling through the partial unique index,
 * the delete guard, the retention predicate and every dashboard that knows this enum.
 */
export const RESOLVED_REFUND_PARK_STATUS = 'SYNCED' as const

/**
 * The status a REASSIGNED park lands on.
 *
 * PENDING, not the status it had: the park's recorded failure was computed against the wrong order,
 * so carrying it across would describe the new owner with the old order's arithmetic. PENDING is
 * also the only actionable status the refund sweep's dedup does NOT skip (syncWcRefund treats a
 * QUARANTINED park as handled), so the reassigned park is immediately retryable on its true owner —
 * which is the whole point of moving it rather than deleting it.
 */
export const REASSIGNED_REFUND_PARK_STATUS = 'PENDING' as const

/** Every recovery note starts with this, so a resolved park's provenance is greppable. */
export const REFUND_PARK_RECOVERY_NOTE_PREFIX = 'Recovered by operator:'

export type RefundParkRecoveryAssertion =
  | { outcome: 'REASSIGN'; wcOrderId: number }
  | { outcome: 'DISMISS'; reason?: string }

export type RefundParkRecoveryOutcome = RefundParkRecoveryAssertion['outcome']

export type RefundParkRecoveryRefusalCode =
  /** The row is not (or is no longer) an actionable refund park. */
  | 'park_not_actionable'
  /** The row is gone, or moved off the order the operator was looking at, between view and write. */
  | 'park_moved'
  /** The operator named the order the park is ALREADY on. */
  | 'asserted_order_is_parked_order'
  /** WooCommerce could not be asked. Nothing was changed. */
  | 'wc_lookup_failed'
  /** WooCommerce's refund list for that order MOVED while it was being read, so it proves nothing. */
  | 'wc_refund_list_unstable'
  /** WooCommerce lists this refund on the parked order after all — the park is not stale. */
  | 'wc_confirms_current_owner'
  /** WooCommerce does not list this refund on the order the operator named. */
  | 'refund_not_in_asserted_order'
  /** That WooCommerce order is not linked to any IMS order, so there is nothing to reassign to. */
  | 'asserted_order_not_linked'
  /** The parked order has no WooCommerce link, so a dismissal cannot be verified against WC. */
  | 'parked_order_not_linked'
  /** A SalesOrderRefund for this refund now exists on the parked order — this is not a stale park. */
  | 'refund_already_landed'
  /** A SalesOrderRefund for this refund exists on some OTHER order than the reassign target. */
  | 'refund_landed_elsewhere'
  /** The target order was deleted under us; a park must never be written onto a gone order. */
  | 'target_order_missing'
  /** The supplied arguments are not a recovery this action understands. */
  | 'unrecognised_outcome'

export type RefundParkRecoveryRefusal = { code: RefundParkRecoveryRefusalCode; message: string }

/** The subset of the park row every decision below is made against. */
export type RefundParkView = {
  id: string
  status: string
  /** The IMS order the park currently sits on. Never null for a refund park (index predicate). */
  entityId: string
  /** The WooCommerce refund id, as stored (a string column). */
  externalId: string
}

/**
 * What WooCommerce said, just now, about one order's refunds.
 *
 * `refundIds` is the COMPLETE list WooCommerce returned for that order. An empty list is a real
 * answer ("that order has no refunds"), which is why a failed fetch must be represented as a
 * refusal and never as an empty evidence object — see refuseOnLookupFailure.
 */
export type WcOrderRefundEvidence = {
  wcOrderId: number
  refundIds: readonly number[]
  fetchedAt: Date
}

export function wcOrderListsRefund(evidence: WcOrderRefundEvidence, externalRefundId: number): boolean {
  return evidence.refundIds.includes(externalRefundId)
}

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Whether the per-row recovery control applies at all, and the reason when it does not.
 *
 * ONE implementation, so the exception inbox and the server action cannot disagree about which rows
 * get a control — a row offered a button it cannot use looks identical to one that works until it
 * is clicked. This is a UI AFFORDANCE, not a permission and not a guarantee: whether a recovery
 * lands is decided at write time, under the per-refund advisory lock, against the state then.
 */
export function describeRefundParkRecoverability(
  row: { status: string; externalId: string | null; entityId: string | null },
): { recoverable: boolean; notRecoverableReason: string | null } {
  if (!isRecoverableRefundParkStatus(row.status)) {
    return {
      recoverable: false,
      notRecoverableReason:
        `This park is ${row.status}: it is already resolved, so there is nothing blocking the refund `
        + 'and nothing to recover.',
    }
  }
  if (!trimmed(row.externalId)) {
    return {
      recoverable: false,
      notRecoverableReason:
        'This row records no WooCommerce refund id, so there is no refund to look up in WooCommerce and '
        + 'no ownership question to answer.',
    }
  }
  if (!trimmed(row.entityId)) {
    return {
      recoverable: false,
      notRecoverableReason:
        'This row is not attached to an order, so it is not a refund park — it cannot be blocking one '
        + "order's refund on behalf of another.",
    }
  }
  return { recoverable: true, notRecoverableReason: null }
}

/**
 * What the operator needs to know BEFORE asserting. Facts, not a recommendation — the choice
 * between moving a refund and writing the park off is theirs.
 */
export function describeRefundParkRecoveryCaveat(outcome: RefundParkRecoveryOutcome): string {
  if (outcome === 'REASSIGN') {
    return 'IMS will ask WooCommerce which refunds that order actually has, right now, and refuse if this '
      + 'refund is not one of them. If it is, the park moves to that order as PENDING and becomes '
      + 'retryable there — the refund itself has still not been applied, and the credit note and restock '
      + 'have still not posted.'
  }
  return 'IMS will ask WooCommerce which refunds THIS order actually has, right now — twice, refusing if '
    + 'the two answers differ, because WooCommerce pages that list by position and a refund created or '
    + 'deleted mid-read can fall between two pages — and refuse if this refund is still one of them. '
    + 'Dismissing only removes a park WooCommerce contradicts — it does not '
    + 'apply the refund anywhere. If the money did leave the business, the refund still has to reach its '
    + 'true order, so reassign it instead wherever that order is known.'
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export function refuseOnLookupFailure(wcOrderId: number, error: string | undefined): RefundParkRecoveryRefusal {
  return {
    code: 'wc_lookup_failed',
    message:
      `WooCommerce could not be asked about order ${wcOrderId}, so nothing was changed and the park is `
      + `exactly as it was${error ? ` (${error})` : ''}. This recovery is only ever made against a fresh `
      + 'answer from WooCommerce — it will not fall back to the payload stored on the park, which is the '
      + 'evidence that is in doubt.',
  }
}

/**
 * o3d-54p round 5 — OFFSET PAGING OVER A LIVE COLLECTION IS NOT A SNAPSHOT.
 *
 * WHAT THE PAGE RULES CANNOT REACH. The walk in app/actions/sync-exceptions.ts is now careful about
 * every property of a page it can observe: only an EMPTY page ends it, a non-empty page of any
 * length advances, and banking fewer rows than the store itself said exist refuses. All of that is
 * about the pages. NONE of it is about the collection they are cut out of.
 *
 * WooCommerce serves that collection BY POSITION — `?page=2&per_page=100` means "rows 100 to 199 of
 * whatever is there when you ask". So the moment a refund is created or deleted between two
 * requests, every later row moves to a different offset, and a row can pass through the boundary
 * unserved:
 *
 *   • A REFUND DELETED BEHIND THE CURSOR shifts everything after it DOWN one place. The row that was
 *     going to be first on the next page is now last on the page already read, and NOBODY EVER SERVES
 *     IT. Every page is full, the walk ends cleanly on an empty page, and the list is one row short.
 *   • AND THE STATED-TOTAL GUARD CANNOT SEE IT. The list still holds the id of the row that was
 *     deleted — it was banked before the delete — so it is one id too long by exactly the amount it
 *     is one id too short. 250 rows stated, 250 rows banked, one of them gone from the store and one
 *     of them never read. The arithmetic balances precisely because two errors of one cancel.
 *   • A REFUND CREATED shifts the other way (WooCommerce lists refunds newest first) and produces the
 *     opposite artefact: a row served TWICE. That one loses nothing — but it is proof that the
 *     collection moved under the read, and the read that moves one way can move the other.
 *
 * SO COMPLETENESS IS NOT ESTABLISHED FROM ONE WALK AT ALL, and the honest statement is that it
 * cannot be: no property of a sequence of offset pages distinguishes "this is the whole collection"
 * from "this is the whole collection minus the row that moved past me". Two things establish it
 * instead, and a DISMISSAL — the one outcome that turns an absence into a write-off — requires them:
 *
 *   1. A REPEATED ID INSIDE ONE WALK REFUSES. It is direct proof of motion, from the walk itself.
 *   2. THE WALK IS RUN TWICE AND THE TWO ANSWERS MUST AGREE, id for id and count for count. A read
 *      that lost a row lost it BECAUSE another row was deleted, and the deleted row is still in its
 *      list; the second read cannot serve a refund the store no longer has, so the two lists differ
 *      and the recovery refuses. Agreement is not a snapshot either, but it is the strongest thing a
 *      client of a position-paged collection can obtain: it says the collection was not changing.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. A store that trims the same middle page on EVERY read and
 * states no total is still undetectable — both reads agree, both are short, and nothing in either
 * answer says so. That residue was flagged in round 4 and is unchanged: it is a store that lies the
 * same way twice, not a collection that moved.
 *
 * WHY ONLY THE DISMISSAL PAYS FOR THIS. A REASSIGN is authorised by PRESENCE — "WooCommerce lists
 * this refund on the order you named". A short list can only fail to contain something, so the worst
 * an incomplete read can do to a reassign is refuse one that should have been allowed, which the
 * operator can retry. A DISMISS is authorised by ABSENCE, and an incomplete list produces absence
 * out of nothing.
 */
export type WcOrderRefundRead = {
  /** Every id banked by ONE walk, in the order the store served them. */
  refundIds: readonly number[]
  /** The smallest count that walk saw the store state, or null if it never stated one. */
  statedTotal: number | null
}

function describeIdSample(ids: readonly number[]): string {
  const shown = ids.slice(0, 5)
  const tail = ids.length > shown.length ? ` and ${ids.length - shown.length} more` : ''
  return `${ids.length === 1 ? 'refund' : 'refunds'} ${shown.join(', ')}${tail}`
}

function describeStatedTotal(total: number | null): string {
  return total === null ? 'no total at all' : `a total of ${total}`
}

/**
 * Whether two reads of one order's refunds agree, and how they differ when they do not.
 *
 * Sets, not sequences: WooCommerce is free to order a page differently between two requests, and an
 * order that is not a difference in CONTENT is not evidence that anything moved. The stated total is
 * compared too — a store that says 250 once and 251 the next time is telling us plainly that the
 * collection changed between them, even when both walks happened to serve the same ids.
 */
export function describeRefundReadDisagreement(
  first: WcOrderRefundRead,
  second: WcOrderRefundRead,
): string | null {
  const firstIds = new Set(first.refundIds)
  const secondIds = new Set(second.refundIds)
  const onlyFirst = [...firstIds].filter((id) => !secondIds.has(id)).sort((a, b) => a - b)
  const onlySecond = [...secondIds].filter((id) => !firstIds.has(id)).sort((a, b) => a - b)
  if (onlyFirst.length > 0 || onlySecond.length > 0) {
    const parts: string[] = []
    if (onlyFirst.length > 0) parts.push(`the first read listed ${describeIdSample(onlyFirst)} and the second did not`)
    if (onlySecond.length > 0) parts.push(`the second read listed ${describeIdSample(onlySecond)} and the first did not`)
    return parts.join(', and ')
  }
  if (first.statedTotal !== second.statedTotal) {
    return `both reads listed the same ${first.refundIds.length} refunds, but WooCommerce stated `
      + `${describeStatedTotal(first.statedTotal)} on the first read and `
      + `${describeStatedTotal(second.statedTotal)} on the second`
  }
  return null
}

/**
 * The refusal for a refund list that MOVED while it was being read.
 *
 * Deliberately NOT refuseOnLookupFailure: WooCommerce answered every request, and telling an
 * operator it "could not be asked" would send them to look for an outage that is not there. What
 * happened is that the thing they are asking about changed while the question was being answered,
 * and the remedy is to ask again rather than to fix anything.
 */
export function refuseUnstableRefundList(wcOrderId: number, detail: string): RefundParkRecoveryRefusal {
  return {
    code: 'wc_refund_list_unstable',
    message:
      `WooCommerce's refund list for order ${wcOrderId} changed while this check was reading it `
      + `(${detail}), so nothing was changed and the park is exactly as it was. WooCommerce serves that `
      + 'list one page at a time BY POSITION, so a refund created or deleted mid-read shifts every later '
      + 'page — and a refund can fall through the gap without any page looking short. A list that is not '
      + 'being changed reads the same way twice, so try this recovery again in a moment; if it keeps '
      + 'happening, that order is being refunded right now and the park should be left alone until it '
      + 'settles.',
  }
}

/**
 * The verified refusals for a REASSIGN, in the order that produces the most useful message.
 *
 * `parkedOrderEvidence` may be null: a parked order with no WooCommerce link cannot be asked about,
 * and that does not block a reassign — the assertion is about the TARGET order, and the target's own
 * evidence is what establishes ownership.
 */
export function refuseReassign(input: {
  park: RefundParkView
  externalRefundId: number
  /** Fresh evidence for the order the operator named. */
  targetEvidence: WcOrderRefundEvidence
  /** The IMS order that WooCommerce order maps to, or null when nothing links to it. */
  targetOrderId: string | null
  /** The order that already holds a SalesOrderRefund for this refund id, if any. */
  landedOnOrderId: string | null
}): RefundParkRecoveryRefusal | null {
  const { park, externalRefundId, targetEvidence, targetOrderId, landedOnOrderId } = input

  if (!wcOrderListsRefund(targetEvidence, externalRefundId)) {
    return {
      code: 'refund_not_in_asserted_order',
      message:
        `WooCommerce does not list refund ${externalRefundId} on order ${targetEvidence.wcOrderId}. `
        + `That order has ${targetEvidence.refundIds.length === 0 ? 'no refunds at all' : `refunds ${targetEvidence.refundIds.join(', ')}`}. `
        + 'Nothing was changed. Open the refund in WooCommerce and read its parent order number off the '
        + 'refund itself before asserting one here.',
    }
  }
  if (!targetOrderId) {
    return {
      code: 'asserted_order_not_linked',
      message:
        `WooCommerce order ${targetEvidence.wcOrderId} does have refund ${externalRefundId}, but no IMS `
        + 'order is linked to it, so there is no order to move the park to. Import or re-link that order '
        + 'first, then recover this park.',
    }
  }
  if (targetOrderId === park.entityId) {
    return {
      code: 'asserted_order_is_parked_order',
      message:
        'That WooCommerce order is the one this park is already on, so WooCommerce agrees with the park '
        + 'and there is nothing stale to recover. Use Retry to re-attempt the refund here.',
    }
  }
  if (landedOnOrderId && landedOnOrderId === park.entityId) {
    return {
      code: 'refund_already_landed',
      message:
        `Refund ${externalRefundId} has already been applied to the order this park is on, so the park is `
        + 'a leftover rather than a cross-order anomaly. Use Retry, which resolves a park whose refund has '
        + 'landed.',
    }
  }
  if (landedOnOrderId && landedOnOrderId !== targetOrderId) {
    return {
      code: 'refund_landed_elsewhere',
      message:
        `Refund ${externalRefundId} is already recorded against IMS order ${landedOnOrderId}, which is `
        + 'neither this park\'s order nor the one you named. Nothing was changed: moving the park would '
        + 'point a third order at a refund that is already accounted for somewhere else. Resolve that '
        + 'contradiction before recovering this park.',
    }
  }
  if (landedOnOrderId && landedOnOrderId === targetOrderId) {
    return {
      code: 'refund_landed_elsewhere',
      message:
        `Refund ${externalRefundId} has already been applied to IMS order ${targetOrderId} — the order you `
        + 'named — so moving this park there would re-open work that is already done. Dismiss the park '
        + 'instead: WooCommerce will confirm it does not belong on the order it is sitting on.',
    }
  }
  return null
}

/** The verified refusals for a DISMISS. */
export function refuseDismiss(input: {
  park: RefundParkView
  externalRefundId: number
  /** Fresh evidence for the PARKED order — the only thing a dismissal is verified against. */
  parkedEvidence: WcOrderRefundEvidence | null
  landedOnOrderId: string | null
}): RefundParkRecoveryRefusal | null {
  const { park, externalRefundId, parkedEvidence, landedOnOrderId } = input

  if (!parkedEvidence) {
    return {
      code: 'parked_order_not_linked',
      message:
        'This park\'s order has no WooCommerce link, so WooCommerce cannot be asked whether the refund '
        + 'belongs to it and the dismissal cannot be verified. Nothing was changed. Reassign the park to '
        + 'the WooCommerce order that really holds this refund instead.',
    }
  }
  if (wcOrderListsRefund(parkedEvidence, externalRefundId)) {
    return {
      code: 'wc_confirms_current_owner',
      message:
        `WooCommerce still lists refund ${externalRefundId} on order ${parkedEvidence.wcOrderId}, which is `
        + 'the order this park is on. The park is not stale — it is a refund that has not been applied '
        + 'yet. Nothing was changed; use Retry.',
    }
  }
  if (landedOnOrderId && landedOnOrderId === park.entityId) {
    return {
      code: 'refund_already_landed',
      message:
        `Refund ${externalRefundId} has already been applied to this park's own order, so this is a `
        + 'leftover park rather than a false one. Use Retry, which resolves it against the refund that '
        + 'landed.',
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// What each outcome writes
// ---------------------------------------------------------------------------

/**
 * The note written onto the park, and repeated in the audit.
 *
 * It states the VERIFIED fact and the operator's act separately, because they are separate things:
 * WooCommerce supplied the ownership, the operator supplied the decision.
 */
export function refundParkRecoveryNote(
  assertion: RefundParkRecoveryAssertion,
  evidence: WcOrderRefundEvidence,
  externalRefundId: number,
): string {
  if (assertion.outcome === 'REASSIGN') {
    return `${REFUND_PARK_RECOVERY_NOTE_PREFIX} reassigned from a stale cross-order park. WooCommerce `
      + `confirmed refund ${externalRefundId} on order ${evidence.wcOrderId} at `
      + `${evidence.fetchedAt.toISOString()}. The refund has NOT been applied yet — retry it here.`
  }
  const reason = trimmed(assertion.reason)
  return `${REFUND_PARK_RECOVERY_NOTE_PREFIX} dismissed as a stale cross-order park. WooCommerce order `
    + `${evidence.wcOrderId} did NOT list refund ${externalRefundId} at ${evidence.fetchedAt.toISOString()}, `
    + `so this park does not describe this order.${reason ? ` ${reason}` : ''}`
}

/**
 * The patch for a REASSIGN.
 *
 * `payload` is DELIBERATELY ABSENT — not cleared. It holds the WooCommerce refund body the original
 * delivery parked, which is the same refund whichever order it belongs to, and it is the only copy
 * IMS has of what WooCommerce sent. Destroying it as a side effect of correcting the order link
 * would throw away evidence about a refund whose money has already left the business.
 *
 * The row keeps its id, so the exception inbox shows one row that MOVED rather than one that
 * vanished and another that appeared — and the partial unique index is untouched, because it is
 * keyed on (connector, externalId), neither of which changes.
 */
export function buildRefundParkReassignData(targetOrderId: string, note: string, now: Date) {
  return {
    entityId: targetOrderId,
    status: REASSIGNED_REFUND_PARK_STATUS,
    errorMessage: note,
    syncedAt: now,
  }
}

/**
 * The patch for a DISMISS.
 *
 * entityId is left alone: the park stays attached to the order it was wrongly recorded against, so
 * the false association remains readable in the activity log and on the row itself. Only its
 * ACTIONABILITY is removed — which is what unblocks the true owner's refund create, the two orders'
 * deletes and the store rebind.
 */
export function buildRefundParkDismissData(note: string, now: Date) {
  return {
    status: RESOLVED_REFUND_PARK_STATUS,
    errorMessage: note,
    syncedAt: now,
  }
}

/**
 * Whether a resolved park was dismissed by an operator rather than resolved by a refund landing.
 * Exported for readers (and tests) that must tell the two apart without re-deriving the convention.
 */
export function isDismissedRefundPark(row: { status: string; errorMessage: string | null }): boolean {
  return row.status === RESOLVED_REFUND_PARK_STATUS
    && trimmed(row.errorMessage).startsWith(REFUND_PARK_RECOVERY_NOTE_PREFIX)
}

/** Server actions take untrusted arguments; narrow to the domain union or reject. */
export function normalizeRefundParkRecoveryAssertion(input: unknown): RefundParkRecoveryAssertion | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as { outcome?: unknown; wcOrderId?: unknown; reason?: unknown }
  if (candidate.outcome === 'REASSIGN') {
    // A non-integer would reach the WooCommerce URL as `NaN` and fetch a 404 that this action would
    // then report as "WooCommerce could not be asked" — a refusal that names the wrong cause.
    if (typeof candidate.wcOrderId !== 'number' || !Number.isSafeInteger(candidate.wcOrderId) || candidate.wcOrderId <= 0) {
      return null
    }
    return { outcome: 'REASSIGN', wcOrderId: candidate.wcOrderId }
  }
  if (candidate.outcome === 'DISMISS') {
    if (candidate.reason !== undefined && typeof candidate.reason !== 'string') return null
    return { outcome: 'DISMISS', ...(candidate.reason ? { reason: candidate.reason } : {}) }
  }
  return null
}
