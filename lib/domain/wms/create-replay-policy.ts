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

/** Every connector id this policy covers — exported so a test can assert the table is exhaustive. */
export const WMS_CREATE_REPLAY_POLICY_IDS = WMS_CONNECTOR_IDS
