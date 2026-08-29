import { WMS_CONNECTOR_IDS, type WmsConnectorId, isWmsConnectorId } from '@/lib/connectors/wms/types'

/**
 * WHAT STANDS BETWEEN A SECOND CREATE AND A SECOND WAREHOUSE ORDER (o3d-2k5r r4).
 *
 * A create claim whose outcome was never written back is AMBIGUOUS: the request may have reached
 * the warehouse, or it may not. The question every retry path has to answer before it re-dispatches
 * is not "is the order there right now?" but "can this create be sent again WITHOUT the risk of a
 * second physical fulfilment?" — and those are different questions, because a request that is still
 * in flight is neither present nor proof of absence.
 *
 * A PRESENCE PROBE CANNOT ANSWER IT. `probeOrderPresence` reports what the warehouse HOLDS at the
 * instant it is asked. MISSING is consistent with "the create never arrived" and equally consistent
 * with "the create is on the wire and arrives in two seconds". Nothing IMS can read distinguishes
 * them, so nothing IMS can read licences a replay on its own.
 *
 * NEITHER CAN THE CLOCK. `connectorFetch` aborts a request at CONNECTOR_FETCH_TIMEOUT_MS, so a
 * request issued by a LIVE worker cannot outlive that ceiling — but the case this exists for is a
 * worker that is NOT live, and a process that is stopped rather than dead (SIGSTOP, a frozen VM, a
 * host paused mid-syscall) resumes and completes its request with no bound at all. A lease expiry
 * is a statement about TIME, not about OUTCOME. So no waiting period is offered here, because none
 * would be honest.
 *
 * WHAT CAN ANSWER IT IS THE REMOTE'S OWN CONTRACT. If the warehouse REFUSES a duplicate — if the
 * second create is rejected by the WMS rather than by a lookup we performed a moment earlier — then
 * a replay cannot mint a second order whatever else is in flight, because the loser of the race is
 * refused by the party that owns the data. That is a property of the connector, not of the sweep,
 * and it is the only property that makes an automatic retry safe.
 *
 * This table is a `Record` over `WmsConnectorId` on purpose: adding a connector fails `tsc` until
 * somebody has written down which of these answers is true of it. "No policy" is how the create
 * path went uncovered in the first place.
 */
export type WmsCreateReplayPolicy =
  /**
   * The REMOTE refuses a duplicate and the connector reconciles to the order that already exists.
   *
   * True of Mintsoft: `PUT /api/Order` answers `{Success:false, Message:'Order already exists'}`
   * for an order number it already holds, and `pushMintsoftOrder` then resolves the existing order
   * through a ClientId-scoped `Order/Search` and binds THAT id (proved by a read, so it does not
   * even need the ownership verification a fresh create does). A replay is therefore self-healing:
   * whichever request loses the race is refused, and the link ends up pointing at the one order the
   * warehouse holds. When the lookup cannot resolve exactly one row it THROWS rather than creating,
   * so the failure mode is a retry, never a duplicate.
   */
  | 'remote-refuses-duplicate'
  /**
   * The only dedupe is a lookup the CONNECTOR performs immediately before its own create, and the
   * two are separate operations.
   *
   * True of ShipHero: `order_create` does not enforce `partner_order_id` uniqueness, so
   * `pushShipheroOrder`'s `findShipheroOrderByPartnerId` preflight is all there is. It closes the
   * sequential case and cannot close the concurrent one — a preflight cannot see a request that is
   * still on the wire, and the create it guards is accepted regardless. Two winners create two
   * warehouse orders under one partner_order_id, and both get picked.
   *
   * So a create whose outcome is unknown is NEVER re-dispatched automatically on such a connector.
   * The park is the outcome, and the resolution is a person who can look at the WMS.
   */
  | 'client-side-dedupe-only'

export const WMS_CREATE_REPLAY_POLICY: Record<WmsConnectorId, WmsCreateReplayPolicy> = {
  mintsoft: 'remote-refuses-duplicate',
  shiphero: 'client-side-dedupe-only',
}

/** `null` for a connector id this build does not know — which is never treated as replay-safe. */
export function wmsCreateReplayPolicy(connectorId: string): WmsCreateReplayPolicy | null {
  return isWmsConnectorId(connectorId) ? WMS_CREATE_REPLAY_POLICY[connectorId] : null
}

/**
 * May a create whose outcome is UNKNOWN be dispatched again without a human?
 *
 * Fails closed on an unknown connector id: a link can outlive the connector that wrote it (a
 * renamed plugin, a row restored from a backup), and "we have never heard of this connector" is not
 * a reason to believe its warehouse refuses duplicates.
 */
export function wmsAmbiguousCreateMayBeReplayed(connectorId: string): boolean {
  return wmsCreateReplayPolicy(connectorId) === 'remote-refuses-duplicate'
}

/**
 * Why an ambiguous create is NOT being re-dispatched, and what a person can actually do about it.
 *
 * Every action named here has to be performable BY THE PERSON READING IT — the failure mode this
 * repository keeps hitting is a remedy that does not exist. Both actions below are WMS-side and
 * need no IMS control: cancel the duplicate where it lives, or leave it to be fulfilled and let the
 * ordinary reconcile bind it. Neither asks IMS to promote an operator's assertion into evidence
 * (o3d-anu8).
 */
export function wmsAmbiguousCreateRefusal(connectorId: string, reference: string): string {
  const policy = wmsCreateReplayPolicy(connectorId)
  if (policy === 'remote-refuses-duplicate') {
    // Only reachable when this is called for a connector that IS replay-safe — the caller has
    // decided not to replay for some OTHER reason (the order is no longer eligible, say).
    return `A WMS create was dispatched for ${reference} and its outcome was never recorded. It was not re-queued on this pass.`
  }
  return (
    `A WMS create was dispatched for ${reference} and its outcome was never recorded, and ${connectorId}'s create `
    + 'is not safe to repeat: it does not refuse a duplicate, so a second create would be a second warehouse order '
    + 'under the same reference and the goods would be picked twice. IMS will not retry this by itself. Open the WMS '
    + `and look for ${reference}: if an order is there, it is the one this sale is being fulfilled by — cancel any `
    + 'duplicate and leave the survivor for the dispatch sweep to reconcile; if no order is there, cancel and re-create '
    + 'this sales order in IMS so the push starts from a clean claim.'
  )
}

/**
 * o3d-2k5r r5 — why a MISSING_IN_WMS finding is NOT being re-pushed automatically.
 *
 * A different situation from the one above and the same rule. Here a create DID succeed and IMS
 * holds the warehouse id; the reconcile then found the warehouse no longer reports that order. Only
 * one of the two readings makes a re-push safe. "The order was deleted/purged and nothing is there"
 * makes it a clean re-create. "The order is there and the lookup missed it" — a renumbering, a
 * client-scope change, an eventually-consistent index, a create still settling — makes the re-push a
 * SECOND warehouse order under the same reference. A presence probe cannot separate them, because
 * it is the very lookup whose answer is in doubt.
 *
 * On a connector whose own create refuses a duplicate, that does not matter: the second create is
 * refused by the party that owns the data and the connector binds the order that already exists. On
 * one whose only dedupe is a client-side preflight, nothing stands between the re-push and a double
 * pick — so IMS does not offer it, and the finding stays OPEN where a person can see it.
 */
export function wmsMissingOrderRepushRefusal(connectorId: string, reference: string): string {
  return (
    `${connectorId}'s create does not refuse a duplicate, so IMS will not re-push order ${reference} on the `
    + 'strength of a lookup that came back empty: if that order is in fact still in the warehouse, a re-push is a '
    + 'second order under the same reference and the goods are picked twice. Open the WMS and search for '
    + `${reference}. If it is genuinely gone, re-create it there and the dispatch sweep will reconcile it; if it `
    + 'is there, the finding is a lookup fault and the next reconcile run resolves it by itself. This finding '
    + 'stays open meanwhile.'
  )
}

/** Every connector id this policy covers — exported so a test can assert the table is exhaustive. */
export const WMS_CREATE_REPLAY_POLICY_IDS = WMS_CONNECTOR_IDS

/**
 * o3d-2k5r r6 — THE SAME QUESTION, ASKED BY THE HOLD/RELEASE CYCLE.
 *
 * The hold pass cancels a pushed order in the WMS and parks the link HELD; the release pass later
 * clears `externalOrderId` and the dispatch stamp so the order re-enters the create queue. That
 * release is a CREATE RE-OPEN in every way that matters, and it was the one writer on this branch
 * that took neither key.
 *
 * WHAT MADE IT UNSAFE. The hold pass treats `cancelled` and `NOT_FOUND` as the same success. On
 * Mintsoft that is nearly harmless. On ShipHero `NOT_FOUND` IS ONLY A LOOKUP RESULT: the order was
 * not returned by a query we ran, which is consistent with "there is no such order" and equally
 * consistent with "the lookup missed a live order" (a renumbering, a client-scope change, an
 * eventually-consistent index). If the second reading is the true one, the release clears the id,
 * the create pass pushes again, ShipHero's create does not refuse the duplicate, and the goods are
 * picked twice. The state compare-and-set the release already has prevents a stale LOCAL write and
 * says nothing whatever about the remote.
 *
 * THE TWO KEYS, unchanged from the rest of this file:
 *
 *   1. AFFIRMATIVE REMOTE-CANCELLATION EVIDENCE — the warehouse itself said it cancelled the
 *      order. That is `cancelled: true` from `cancelOrder`, and it is persisted as the link's
 *      `cancelledAt` stamp. From this revision that stamp is written ONLY on a confirmed
 *      cancellation; `NOT_FOUND` leaves it null, because stamping "cancelled at 09:04" for an
 *      order the warehouse merely failed to return is the absence-read-as-an-answer bug written
 *      into a column.
 *   2. THE CONNECTOR'S OWN CREATE CONTRACT — where key 1 is absent, the only thing that can make a
 *      re-create safe is a remote that refuses a duplicate. `wmsAmbiguousCreateMayBeReplayed`.
 *
 * A link that has neither is PARKED for manual reconciliation rather than released, and the park
 * happens at the HOLD, so the order never sits in a state whose only exit is a write nothing will
 * ever be allowed to make.
 *
 * THE ONE RESIDUE, STATED RATHER THAN PAPERED OVER. A HELD link written BEFORE this revision
 * carries `cancelledAt` whichever answer the WMS gave, so for those rows the stamp is not evidence
 * and this rule cannot tell. Closing that would need a column to distinguish them, i.e. a
 * migration, and none is applied on this branch. The exposure is bounded: it is only unsafe on a
 * connector with no remote duplicate refusal, which today means ShipHero alone — and ShipHero has
 * no live deployment (the repo is the deploy). On Mintsoft such a row releases, re-creates, and the
 * remote refuses any duplicate, which is the outcome the rule would have chosen anyway.
 *
 * WHAT THE PROBE IS FOR, AND WHAT IT IS NOT FOR. Where key 1 is absent and key 2 holds, the
 * release still asks the warehouse whether it holds the order (`probeOrderPresence`), because a
 * re-create against a LIVE order — even one a remote duplicate-refusal makes safe from a double
 * pick — would bind IMS to an order that was supposed to be held. The probe is therefore a
 * refusal-only signal on that path: FOUND or AMBIGUOUS blocks, MISSING merely fails to block. It
 * is never asked on the confirmed-cancellation path, where a cancelled-but-still-listed order
 * would otherwise block every legitimate release for ever.
 */
export type WmsHeldReleaseDecision =
  /** The warehouse said it cancelled the order. Nothing is outstanding; re-create it. */
  | { release: true; evidence: 'remote-cancellation-confirmed'; probeRequired: false }
  /**
   * No confirmed cancellation, but this connector's create refuses a duplicate — so a re-create
   * cannot mint a second warehouse order however the lookup was wrong. Still gated on the probe
   * not FINDING the order.
   */
  | { release: true; evidence: 'create-refused-remotely'; probeRequired: true }
  /** Neither key. A person has to look at the warehouse. */
  | { release: false; reason: 'cancellation-unconfirmed'; guidance: string }

export function decideWmsHeldRelease(input: {
  connector: string
  /** `cancelOrder` answered `cancelled: true` — persisted as the link's `cancelledAt` stamp. */
  remoteCancellationConfirmed: boolean
  reference: string
}): WmsHeldReleaseDecision {
  if (input.remoteCancellationConfirmed) {
    return { release: true, evidence: 'remote-cancellation-confirmed', probeRequired: false }
  }
  if (wmsAmbiguousCreateMayBeReplayed(input.connector)) {
    return { release: true, evidence: 'create-refused-remotely', probeRequired: true }
  }
  return {
    release: false,
    reason: 'cancellation-unconfirmed',
    guidance: wmsHeldReleaseRefusal(input.connector, input.reference),
  }
}

/**
 * Why a held order is NOT being re-created, and the manual reconciliation to do instead.
 *
 * As everywhere else in this file, every action named has to be performable by the person reading
 * it, without an IMS control that does not exist.
 */
export function wmsHeldReleaseRefusal(connectorId: string, reference: string): string {
  return (
    `Order ${reference} was put on hold in IMS and ${connectorId} did not CONFIRM cancelling the warehouse order — `
    + 'it reported only that it could not find one, which is a lookup result and not proof the order is gone. '
    + `${connectorId}'s create does not refuse a duplicate either, so releasing the hold could push a second `
    + 'warehouse order under the same reference and the goods would be picked twice. IMS will not do that by '
    + `itself. Open the WMS and search for ${reference}: if an order is there, cancel it there and then re-create `
    + 'this sales order in IMS so the push starts from a clean claim; if no order is there, re-create the sales '
    + 'order in IMS. This link is parked for manual reconciliation meanwhile.'
  )
}
