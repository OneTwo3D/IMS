import {
  wmsAmbiguousCreateMayBeReplayed,
  wmsAmbiguousCreateRefusal,
  wmsMissingOrderRepushRefusal,
} from './create-replay-policy'
import { wmsCreateOutcomeIsAmbiguous, wmsPushOrderReference } from './order-push-sweep'

/**
 * ONE READER FOR "MAY THIS PUSH BE RE-OPENED?", SHARED BY THE CONTROL AND THE ACTION (o3d-2k5r r5).
 *
 * THE DEFECT CLASS THIS BRANCH KEEPS HITTING is two readers of one question. An action enforces a
 * predicate; a surface renders a control from a state NAME, or from a hand-written condition that
 * happened to agree when it was written. They drift, and what the operator gets is a button that
 * always refuses — a remedy that cannot be performed, which is worse than no remedy at all because
 * it is indistinguishable from one that can.
 *
 * It had already happened twice on this branch. The exception inbox rendered Replay for every
 * blocked state except VALIDATION_FAILED, so a ShipHero AMBIGUOUS_CREATE row — the one state whose
 * whole point is that IMS must NOT re-dispatch it — got a button the action refuses every single
 * time, under a label calling it an ordinary push failure. And `getWmsOrderPushStateForSalesOrder`
 * wrote `state === 'DEAD_LETTER' || (AMBIGUOUS_CREATE && replayable)` by hand, which omits the
 * externalOrderId refusal entirely: a dead letter carrying a warehouse id is refused by the action
 * and was offered the button by the chip.
 *
 * So the refusals live HERE, once, and both the action and every surface that offers the control
 * read them from this function. The rule is not "the decision is written down somewhere both can
 * see" — it is that the surface CANNOT render a control the action would refuse, because the same
 * call produces both answers.
 *
 * WHAT IS NOT HERE, AND WHY THAT IS NOT A LOOPHOLE. The action also asks the warehouse (is the
 * order already there?) and the plugin state (is this connector even active?). Those are LIVE
 * readings, they cost a remote call, and their answer can change between render and click — so
 * they cannot gate a control without either lying a moment later or putting a WMS round trip on
 * every page render. The split is deliberate and it is the honest one: everything decidable from
 * the link's own columns gates the control, and what is left is a refusal the operator earns by
 * pressing a button that COULD have worked. `decideWmsPushReplay` answering `replayable: true` is
 * "pressing this can do something", never "pressing this will succeed".
 */

/** Every refusal derivable from the link's own columns — the ones a control must never render over. */
export type WmsPushReplayRefusal =
  /** Nothing was ever sent: the payload could not be built. There is no remote call to repeat. */
  | 'payload-invalid'
  /** Not a blocked push at all — a live queue, a settled link, a hold. */
  | 'not-a-blocked-push'
  /** The link names a warehouse order. Re-queueing creates a SECOND one. */
  | 'already-linked'
  /** A create may be in flight and this connector's create does not refuse a duplicate. */
  | 'create-not-repeatable'

export type WmsPushReplayDecision =
  | { replayable: true }
  | { replayable: false; reason: WmsPushReplayRefusal; guidance: string }

/** The columns every refusal above is derived from — named as a type so a caller cannot forget one. */
export type WmsPushReplayEvidence = {
  connector: string
  state: string
  attempts: number
  externalOrderId: string | null
  pushedAt: Date | null
}

export const WMS_PUSH_REPLAY_STATES = ['DEAD_LETTER', 'AMBIGUOUS_CREATE'] as const

/**
 * May `replayWmsOrderPush` possibly re-queue this link, on the evidence the link itself carries?
 *
 * `reference` is only used to compose the connector-policy refusal, which names the string an
 * operator has to search the WMS for.
 */
export function decideWmsPushReplay(link: WmsPushReplayEvidence, reference: string): WmsPushReplayDecision {
  // o3d-92fu: a payload-invalid push has nothing to re-queue — no remote call was ever made, and
  // the sweep's revalidation pass re-queues it for free once the payload builds.
  if (link.state === 'VALIDATION_FAILED') {
    return {
      replayable: false,
      reason: 'payload-invalid',
      guidance: 'This order could not be turned into a WMS payload at all (see the error on the push chip) — '
        + 'nothing was sent, so there is nothing to replay. Fix the order data and the push sweep re-queues it by itself.',
    }
  }
  if (!(WMS_PUSH_REPLAY_STATES as readonly string[]).includes(link.state)) {
    return {
      replayable: false,
      reason: 'not-a-blocked-push',
      guidance: 'Only dead-lettered or outcome-unknown pushes can be re-queued.',
    }
  }
  // o3d-bjc.8: a dead letter that still carries an external id is not a failed create — it is an
  // order that EXISTS in the WMS and could not be verified as ours. Re-queueing it means creating a
  // SECOND warehouse order.
  if (link.externalOrderId) {
    return {
      replayable: false,
      reason: 'already-linked',
      guidance: `This order is already linked to WMS order ${link.externalOrderId}, which could not be verified. `
        + 'Re-queueing would create a second warehouse order. Check the WMS first: if that order is ours, '
        + 'the link is already correct; if it is not, clear the link before re-pushing.',
    }
  }
  // o3d-2k5r r4 — the first of the two keys, and the one no probe can supply. See create-replay-policy.
  if (wmsCreateOutcomeIsAmbiguous(link) && !wmsAmbiguousCreateMayBeReplayed(link.connector)) {
    return {
      replayable: false,
      reason: 'create-not-repeatable',
      guidance: wmsAmbiguousCreateRefusal(link.connector, reference),
    }
  }
  return { replayable: true }
}

/**
 * What this blocked row IS, for the operator reading the table.
 *
 * Derived from the same evidence as the decision rather than from the state name, because the two
 * disagreed: an AMBIGUOUS_CREATE row was labelled "Push failed", which is precisely wrong — nothing
 * is known to have failed, and the danger is that it SUCCEEDED and IMS never heard.
 */
export function describeBlockedWmsPush(link: WmsPushReplayEvidence): string {
  if (link.state === 'VALIDATION_FAILED') return 'Payload invalid'
  if (link.externalOrderId) return 'Linked, unverified'
  if (link.state === 'AMBIGUOUS_CREATE') return 'Create outcome unknown'
  return 'Push failed'
}

/**
 * o3d-2k5r r5 — the SAME question, asked by the MISSING_IN_WMS re-push.
 *
 * `repushMissingWmsOrder` resets a SYNCED/MERGED link to PENDING_CREATE so the sweep creates the
 * order again. It had been reviewed as "already correct" because it probes the warehouse first —
 * but a probe is one key, and this is the writer with the sharpest need for the second one. What it
 * re-opens is not a create that failed; it is a create that SUCCEEDED, whose order the warehouse
 * has since stopped reporting. "Stopped reporting" and "was never there" are not the same fact, and
 * on a connector whose create does not refuse a duplicate the difference is a second physical
 * fulfilment.
 *
 * So it takes both keys, from this one rule, and it is the same rule the sweep and the dead-letter
 * replay take. A connector that cannot supply the second key gets no button and no write.
 */
export type WmsMissingRepushDecision =
  | { repushable: true }
  | { repushable: false; reason: 'create-not-repeatable'; guidance: string }

export function decideWmsMissingRepush(input: { connector: string; reference: string }): WmsMissingRepushDecision {
  if (!wmsAmbiguousCreateMayBeReplayed(input.connector)) {
    return {
      repushable: false,
      reason: 'create-not-repeatable',
      guidance: wmsMissingOrderRepushRefusal(input.connector, input.reference),
    }
  }
  return { repushable: true }
}

/**
 * THE ROW THE EXCEPTION INBOX RENDERS, built here rather than in the action (o3d-2k5r r5).
 *
 * Not tidiness. The affordance is only worth anything if the row the CLIENT receives carries it,
 * and a mapping written inline in a `'use server'` module that reads ten other models is a mapping
 * no test can reach — which is how the client came to be deciding this for itself in the first
 * place. Built here, "the row says what the action would do" is one assertion.
 */
export type BlockedWmsPushRowInput = WmsPushReplayEvidence & {
  orderId: string
  lastError: string | null
  lastAttemptAt: Date | null
  order: { id: string; orderNumber: string | null; externalOrderNumber: string | null }
}

export function buildBlockedWmsPushRow(link: BlockedWmsPushRowInput) {
  const decision = decideWmsPushReplay(link, wmsPushOrderReference(link.order))
  return {
    orderId: link.orderId,
    orderNumber: link.order.orderNumber,
    connector: link.connector,
    state: link.state,
    attempts: link.attempts,
    lastError: link.lastError,
    lastAttemptAt: link.lastAttemptAt?.toISOString() ?? null,
    replayable: decision.replayable,
    replayRefusal: decision.replayable ? null : decision.guidance,
    why: describeBlockedWmsPush(link),
  }
}

/** The same, for an order-reconciliation drift finding. Only MISSING_IN_WMS ever had a control. */
export type OrderReconcileDriftRowInput = {
  orderId: string
  category: string
  connector: string
  detail: string | null
  externalOrderNumber: string | null
  lastSeenAt: Date
  order: { id: string; orderNumber: string | null; externalOrderNumber: string | null }
}

export function buildOrderReconcileDriftRow(row: OrderReconcileDriftRowInput) {
  const decision = row.category === 'MISSING_IN_WMS'
    ? decideWmsMissingRepush({ connector: row.connector, reference: wmsPushOrderReference(row.order) })
    : null
  return {
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    externalOrderNumber: row.externalOrderNumber,
    category: row.category,
    detail: row.detail,
    foundAt: row.lastSeenAt.toISOString(),
    connector: row.connector,
    repushable: decision?.repushable === true,
    repushRefusal: decision && !decision.repushable ? decision.guidance : null,
  }
}
