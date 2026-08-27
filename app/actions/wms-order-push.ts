'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { decideWmsPushReplay } from '@/lib/domain/wms/push-recovery-affordance'
import { wmsCreateOutcomeIsAmbiguous, wmsPushOrderReference } from '@/lib/domain/wms/order-push-sweep'

/**
 * Read + recovery surface for the outbound WMS order push (Phase 8). Reads the
 * connector-agnostic WmsOrderPushLink; the replay action re-queues a
 * dead-lettered push for the next sweep. Connector-agnostic.
 */

export type WmsOrderPushStateView = {
  state: string
  externalOrderNumber: string | null
  attempts: number
  lastError: string | null
  pushedAt: string | null
  /**
   * Can an operator re-queue this push from here?
   *
   * o3d-2k5r r5 — DERIVED FROM `decideWmsPushReplay`, the same call `replayWmsOrderPush` refuses
   * on. It used to be a hand-written `state === 'DEAD_LETTER' || (AMBIGUOUS_CREATE && replayable)`,
   * which agreed with the action on the case it was written for and disagreed on another: a dead
   * letter carrying an externalOrderId is refused by the action every time and was offered the
   * button by this chip. A control and an action that answer the same question separately are the
   * defect, not the wording of either answer.
   */
  canRetry: boolean
  /**
   * Why not, when `canRetry` is false and the push is a blocked one — the manual reconciliation the
   * operator has instead. `null` for a link with nothing to say (a live queue, a settled push).
   */
  retryRefusal: string | null
}

export async function getWmsOrderPushStateForSalesOrder(salesOrderId: string): Promise<WmsOrderPushStateView | null> {
  await requireInternalUser()
  const link = await db.wmsOrderPushLink.findUnique({
    where: { orderId: salesOrderId },
    // Every column `decideWmsPushReplay` reads — the read is written against the evidence type so a
    // new refusal cannot be added to the rule and silently evaluated here against `undefined`.
    select: {
      state: true,
      connector: true,
      externalOrderId: true,
      externalOrderNumber: true,
      attempts: true,
      lastError: true,
      pushedAt: true,
      order: { select: { id: true, orderNumber: true, externalOrderNumber: true } },
    },
  })
  if (!link) return null
  const decision = decideWmsPushReplay(link, wmsPushOrderReference(link.order))
  return {
    state: link.state,
    externalOrderNumber: link.externalOrderNumber,
    attempts: link.attempts,
    lastError: link.lastError,
    pushedAt: link.pushedAt?.toISOString() ?? null,
    canRetry: decision.replayable,
    // 'not-a-blocked-push' is not a refusal an operator needs to read: there is no control on the
    // chip for a live queue or a settled push in the first place.
    retryRefusal: decision.replayable || decision.reason === 'not-a-blocked-push' ? null : decision.guidance,
  }
}

export async function replayWmsOrderPush(salesOrderId: string): Promise<{ success: boolean; error?: string }> {
  await requirePermission('sync')
  // o3d-2k5r r3: read the EXACT evidence the decision rests on, because the write below has to
  // require it back. `state`, `attempts`, `externalOrderId` and `pushedAt` are the four columns
  // every refusal here is derived from, and they are the four the compare-and-set names.
  const link = await db.wmsOrderPushLink.findUnique({
    where: { orderId: salesOrderId },
    select: {
      id: true,
      connector: true,
      state: true,
      attempts: true,
      externalOrderId: true,
      pushedAt: true,
      order: { select: { id: true, orderNumber: true, externalOrderNumber: true } },
    },
  })
  if (!link) return { success: false, error: 'No WMS push record for this order.' }
  const reference = wmsPushOrderReference(link.order)
  // o3d-2k5r r5 — EVERY REFUSAL DECIDABLE FROM THE LINK'S OWN COLUMNS, TAKEN FROM THE ONE RULE.
  //
  // Payload-invalid (o3d-92fu: nothing was sent, and the sweep re-queues it for free once the data
  // is fixed), not-a-blocked-push, already-linked (o3d-bjc.8: the link names a warehouse order, so
  // a re-queue is a SECOND one), and the connector's create-replay policy (o3d-2k5r r4). They were
  // four inline conditions here, and the surfaces that offer this button re-derived them by hand
  // and got them wrong. `decideWmsPushReplay` is now the only place they are written, and the
  // chip's `canRetry` and the exception inbox's Replay affordance are the SAME call — so a control
  // cannot render where this refuses.
  const decision = decideWmsPushReplay(link, reference)
  if (!decision.replayable) return { success: false, error: decision.guidance }

  // o3d-2k5r r3 — AUTHORITATIVE ABSENCE, on the same rule the sweep now applies.
  //
  // A dead letter with no external id is not "a create that demonstrably never happened". It is
  // MAX_ATTEMPTS creates that all THREW, and a throw is as consistent with a timeout on a request
  // the WMS went on to honour as with a rejection. `wmsCreateOutcomeIsAmbiguous` is the shared
  // predicate that says so, and every dead letter that reaches here satisfies it (attempts is at
  // MAX_ATTEMPTS by construction) — the call is written against the predicate rather than against
  // that arithmetic so the two cannot drift apart later.
  //
  // Re-queueing without an answer is what makes the warehouse pick the same order twice, so the
  // replay asks the WMS itself and refuses on anything short of a verifiable MISSING. This is
  // deliberately NOT an operator override: the person pressing the button is looking at the same
  // screen we are, and an operator assertion must not be promoted into system evidence (o3d-anu8).
  if (wmsCreateOutcomeIsAmbiguous(link)) {
    // o3d-2k5r r4 — THE FIRST OF TWO KEYS, and the one a probe cannot supply.
    //
    // `probeOrderPresence === 'MISSING'` says what the warehouse HOLDS when asked. It does not
    // exclude a create still on the wire, and no reading available to IMS does: a stopped process
    // resumes with no bound. What covers that case is the connector's own contract — a remote that
    // REFUSES a duplicate refuses the loser of any race, whoever it is. A connector without that
    // property is never re-dispatched from here, and the refusal names WMS-side actions a person
    // can actually perform rather than an IMS control that does not exist.
    // The connector's replay policy has already been applied by `decideWmsPushReplay` above — this
    // branch is only ever reached on a connector whose create refuses a duplicate.
    const pluginState = await getIntegrationPluginState()
    const activeConnectorId = WMS_CONNECTOR_IDS.find((id) => pluginState[id])
    if (!activeConnectorId || activeConnectorId !== link.connector) {
      return {
        success: false,
        error: 'This push belongs to a WMS connector that is not the active one, so its warehouse cannot be asked '
          + 'whether the order already exists. Re-enable that connector, or resolve the order in the WMS by hand.',
      }
    }
    const connector = getWmsConnector(activeConnectorId)
    if (!connector.probeOrderPresence) {
      return {
        success: false,
        error: 'A create was already dispatched for this order and its outcome was never recorded, and the active WMS '
          + 'connector cannot check whether that order exists. Re-queueing could create a second warehouse order — '
          + 'check the WMS and resolve it by hand.',
      }
    }
    let presence: 'FOUND' | 'MISSING' | 'AMBIGUOUS'
    try {
      presence = await connector.probeOrderPresence(reference)
    } catch (error) {
      return {
        success: false,
        error: `The WMS could not be asked whether order ${reference} already exists (${
          error instanceof Error ? error.message : String(error)
        }), so this push was not re-queued. Try again once the WMS is reachable.`,
      }
    }
    if (presence === 'FOUND') {
      return {
        success: false,
        error: `The WMS already holds an order under reference ${reference}. A create was dispatched before and its `
          + 'outcome was never recorded — re-queueing would create a second warehouse order. Link that order to this '
          + 'one, or cancel it in the WMS, before re-pushing.',
      }
    }
    if (presence === 'AMBIGUOUS') {
      return {
        success: false,
        error: `The WMS returned an ambiguous match for reference ${reference}, so it cannot confirm the order is `
          + 'absent. Resolve the ambiguity in the WMS before re-pushing.',
      }
    }
  }

  // Re-queue for the next sweep. The sweep's eligibility (ready + paid + bound)
  // still applies, so a no-longer-eligible order simply won't re-push.
  //
  // o3d-2k5r r3 — COMPARE-AND-SET ON THE EVIDENCE THAT WAS INSPECTED, not a bare update by id.
  //
  // This is the fourth writer that re-opens a create, and it was the only unguarded one. Between
  // the read above and this write, another replay can have re-queued the link and a sweep can have
  // settled it as SYNCED with a fresh external id and push stamp. A bare `update({ where: { id } })`
  // then reverted that settled link to PENDING_CREATE while KEEPING the new id — and
  // createCandidates selects on state alone, so the order was created in the warehouse a second
  // time. Requiring the four columns back means a stale replay matches nothing and is REPORTED as
  // stale rather than silently winning.
  const requeued = await db.wmsOrderPushLink.updateMany({
    where: {
      id: link.id,
      // The state that was INSPECTED, whichever of the two it was — a stale replay must match
      // nothing rather than convert a park it never looked at.
      state: link.state,
      attempts: link.attempts,
      externalOrderId: null,
      pushedAt: link.pushedAt,
    },
    // The replay re-creates the WMS order, so any dispatch dead-letter state
    // from the previous order must not carry over (6oyu.2).
    data: {
      state: 'PENDING_CREATE',
      attempts: 0,
      lastError: null,
      // o3d-2k5r r4: the dispatch stamp is what the claim rule reads as "a create left and we never
      // learned the outcome", so a re-queue that left it in place would be parked straight back by
      // the very next sweep. Clearing it is this action's positive statement that the evidence
      // above was obtained.
      lastAttemptAt: null,
      dispatchFailureCount: 0,
      dispatchLastError: null,
      dispatchDeadLetteredAt: null,
      // ...nor an unresolved-record quarantine (o3d-bjc.9): the unreadable
      // record belonged to the WMS order this replay is about to replace.
      dispatchUnresolvedCount: 0,
      dispatchUnresolvedError: null,
      dispatchUnresolvedAt: null,
    },
  })
  if (requeued.count === 0) {
    return {
      success: false,
      error: 'This push changed while you were looking at it — it is no longer the dead letter that was inspected. '
        + 'Reload the order and check its current push state before replaying.',
    }
  }

  await logActivity({
    entityType: 'SALES_ORDER',
    entityId: salesOrderId,
    action: 'wms_push_replay',
    tag: 'sync',
    level: 'INFO',
    description: 'Re-queued a dead-lettered WMS order push for retry',
  })
  revalidatePath(`/sales/${salesOrderId}`)
  return { success: true }
}
