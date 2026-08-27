'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requireInternalUser, requirePermission } from '@/lib/auth/server'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
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
  /** Dead-lettered pushes can be re-queued by an operator. */
  canRetry: boolean
}

export async function getWmsOrderPushStateForSalesOrder(salesOrderId: string): Promise<WmsOrderPushStateView | null> {
  await requireInternalUser()
  const link = await db.wmsOrderPushLink.findUnique({
    where: { orderId: salesOrderId },
    select: { state: true, externalOrderNumber: true, attempts: true, lastError: true, pushedAt: true },
  })
  if (!link) return null
  return {
    state: link.state,
    externalOrderNumber: link.externalOrderNumber,
    attempts: link.attempts,
    lastError: link.lastError,
    pushedAt: link.pushedAt?.toISOString() ?? null,
    canRetry: link.state === 'DEAD_LETTER',
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
  // o3d-92fu: a payload-invalid push has nothing to re-queue. Re-queueing would set
  // PENDING_CREATE, the next sweep would fail to build the payload again and park it straight
  // back — and in between the order would be undeletable again, because PENDING_CREATE blocks
  // the hard-delete guard and VALIDATION_FAILED (at zero remote attempts) deliberately does
  // not. The sweep's revalidation pass re-queues it automatically once the data is fixed.
  if (link.state === 'VALIDATION_FAILED') {
    return {
      success: false,
      error: 'This order could not be turned into a WMS payload at all (see the error on the push chip) — '
        + 'nothing was sent, so there is nothing to replay. Fix the order data and the push sweep re-queues it by itself.',
    }
  }
  if (link.state !== 'DEAD_LETTER') return { success: false, error: 'Only dead-lettered pushes can be re-queued.' }
  // o3d-bjc.8: a dead letter that still carries an external id is not a failed
  // create — it is an order that EXISTS in the WMS and could not be verified as
  // ours (or was found to be someone else's). Re-queueing it means creating a
  // SECOND warehouse order, which is exactly the duplicate fulfilment the
  // PENDING_VERIFY state exists to prevent. That call needs a human who has
  // looked at the WMS.
  if (link.externalOrderId) {
    return {
      success: false,
      error: `This order is already linked to WMS order ${link.externalOrderId}, which could not be verified. `
        + 'Re-queueing would create a second warehouse order. Check the WMS first: if that order is ours, '
        + 'the link is already correct; if it is not, clear the link before re-pushing.',
    }
  }

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
    const reference = wmsPushOrderReference(link.order)
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
      state: 'DEAD_LETTER',
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
