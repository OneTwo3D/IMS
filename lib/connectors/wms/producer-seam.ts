import { db } from '@/lib/db'
import { findDurableShadowRecords, type DurableShadowRecord, type ShadowEvidenceClient } from '@/lib/domain/outbound-shadow/durable-evidence'
import { mintsoftDrainHold, mintsoftProducerSeam, type MintsoftSeamInput, type MintsoftShadow } from '@/lib/connectors/mintsoft/producer-seam'
import type { MintsoftHold } from '@/lib/connectors/mintsoft/producer-egress'
import type { OutboundConnector } from '@/lib/security/outbound-write-hold-constants'
import { explainProducerDisposition, type ProducerDecisionContext } from '@/lib/security/producer-disposition'
import { readProducerEnforcement } from '@/lib/security/producer-seam'
import { mintWmsWriteClearance } from './clearance'
import { isWmsConnectorId, type WmsConnectorId, type WmsWriteClearance, type WmsWriteOperation } from './types'

/**
 * THE GENERIC WAREHOUSE PRODUCER SEAM: WHAT A CONNECTOR-AGNOSTIC WMS FLOW ASKS BEFORE IT WRITES TO THE WAREHOUSE.
 *
 * The sweeps, the exception inbox, the refund note and the ASN and product flows are generic: they name no warehouse. The
 * producer-side hold (lib/security/producer-seam.ts) is per destination. This module is the one place that connects them, so
 * the generic layer asks `wmsProducerSeam(connectorId, ...)` and this file knows which destination that connector writes to. It
 * is on the connector-boundary allowlist for that reason, exactly as the registry is.
 *
 * Three questions, one answer shape (see lib/connectors/mintsoft/producer-seam.ts for the full account):
 *
 *   {@link wmsProducerSeam}            a producer asks, for ONE operation, before it claims, records or calls anything. The answer is
 *                                      `proceed: true` WITH A CLEARANCE, or a shadow WITHOUT ONE. Every warehouse write method takes the
 *                                      clearance as its last argument (WmsWriteClearance), so the compiler makes every caller handle the
 *                                      shadow before it can write, and a clearance for one operation cannot be used for another.
 *   {@link wmsProducerHold}            a pass over already-queued work asks whether the warehouse is in its live phase at all, before it
 *                                      re-opens or claims any of it.
 *   {@link wmsOrderCreateReArmShadow}  the operator actions that re-arm an order create ask here, and are refused with the shadow text.
 *
 * A connector this build does not register has no ownership map: nothing governs it, so the answer is `proceed` and the
 * behaviour is exactly what it was before the hold existed.
 */

/** The outbound destination each WMS connector writes to. TOTAL over the registered ids, so a new connector must be placed here. */
export const WMS_PRODUCER_DESTINATION = {
  mintsoft: 'mintsoft',
} as const satisfies Record<WmsConnectorId, OutboundConnector>

/**
 * The WMS connector ids whose warehouse writes land at an outbound destination (empty for a destination that is not a warehouse). The one
 * place generic code that must read "the push links of the warehouse destination" (the held-backlog retirement, `outbound:status`) learns
 * which connector id that is, so it names no connector.
 */
export function wmsConnectorIdsFor(destination: OutboundConnector): WmsConnectorId[] {
  return (Object.keys(WMS_PRODUCER_DESTINATION) as WmsConnectorId[]).filter((id) => WMS_PRODUCER_DESTINATION[id] === destination)
}

export type WmsShadow = MintsoftShadow

export type WmsSeamInput<Op extends WmsWriteOperation> = MintsoftSeamInput<Op>

export type WmsSeamAnswer<Op extends WmsWriteOperation> =
  | { proceed: true; clearance: WmsWriteClearance<Op> }
  | ({ proceed: false } & WmsShadow)

export type WmsProducerHold = MintsoftHold

export async function wmsProducerSeam<Op extends WmsWriteOperation>(
  connectorId: string,
  input: WmsSeamInput<Op>,
): Promise<WmsSeamAnswer<Op>> {
  // A connector this build does not register has no ownership map: nothing governs it, and it is cleared as before.
  if (!isWmsConnectorId(connectorId)) return { proceed: true, clearance: mintWmsWriteClearance<Op>() }
  return mintsoftProducerSeam(input)
}

/** Whether a pass over already-queued warehouse work must stand down. Pure; never throws. */
export function wmsProducerHold(connectorId: string, context?: ProducerDecisionContext): WmsProducerHold {
  if (!isWmsConnectorId(connectorId)) return { held: false }
  return mintsoftDrainHold(context)
}

/**
 * The earliest business-event (paid) time at which IMS may create a warehouse order, or null when there is no such floor to apply
 * (the hold is not enforced, the destination is not live yet, or anything is unreadable). An order paid before the floor belongs to the
 * writer that owned it then and can never be created by IMS, so the create query leaves it out instead of reselecting it every sweep
 * (a bounded batch of them would starve every later order). Not enforced: null, and the query is the legacy one.
 */
export function wmsCreateObligationFloor(connectorId: string, context?: ProducerDecisionContext): Date | null {
  if (!isWmsConnectorId(connectorId)) return null
  try {
    const enforcement = readProducerEnforcement(context?.env ?? process.env)
    if (!enforcement.enforced || !enforcement.destinations.has(WMS_PRODUCER_DESTINATION[connectorId as WmsConnectorId])) return null
    // Asked with an obligation time that is never before any cut-off: LIVE then means the destination is live and IMS owns creates.
    const decision = explainProducerDisposition(WMS_PRODUCER_DESTINATION[connectorId as WmsConnectorId], 'order.create', new Date(8.64e15), context)
    return decision.disposition === 'LIVE' && decision.phase === 'P2' ? decision.cutoff : null
  } catch {
    return null
  }
}

/**
 * The operator actions that re-arm an order create (replay a dead letter, re-push a missing order) are producers of create
 * work. Null to go ahead (the hold is not enforced, or the decision is LIVE); `{ notice }` when the decision is SHADOW: nothing
 * was changed, a shadow record was kept, and `notice` is the single-sourced sentence to show the operator.
 */
export async function wmsOrderCreateReArmShadow(
  connectorId: string,
  orderId: string,
  context?: ProducerDecisionContext,
): Promise<{ notice: string } | null> {
  const seam = await wmsProducerSeam(connectorId, {
    operation: 'order.create',
    subjectType: 'SalesOrder',
    subjectId: orderId,
    payload: { orderId, kind: 'create-re-arm' },
    resolveObligationAt: async () => {
      const order = await db.salesOrder.findUnique({ where: { id: orderId }, select: { paidAt: true, createdAt: true } })
      return order?.paidAt ?? order?.createdAt ?? undefined
    },
    context,
  })
  return seam.proceed ? null : { notice: seam.notice }
}

/**
 * THE EVIDENCE READER: what IMS recorded about an order it did not push. A shadow is its own state, never a push state: the order
 * has no link, nothing was claimed or sent, and the record says only that IMS produced the work and kept it. It says nothing about
 * whether the warehouse already holds the order (another writer may have created it), which is why the sentence tells the operator
 * to look there. Null when the hold is not enforced for the connector (no read is made at all), when nothing was recorded, or when
 * the record cannot be read: an unreadable record is shown as no record, never as one.
 */
export type WmsOrderShadowEvidence = { occurrences: number; notice: string }

export const WMS_ORDER_SHADOW_NOTICE
  = 'Not sent by IMS: writes to the warehouse are held on this installation, so IMS kept a record of what it would have pushed and did not push this order. '
  + 'This does not say whether the warehouse already holds it (another writer may have created it): check the warehouse before acting.'

export async function wmsOrderCreateShadowEvidence(connectorId: string, orderId: string): Promise<WmsOrderShadowEvidence | null> {
  if (!isWmsConnectorId(connectorId)) return null
  const destination = WMS_PRODUCER_DESTINATION[connectorId]
  const enforcement = readProducerEnforcement(process.env)
  if (!enforcement.enforced || !enforcement.destinations.has(destination)) return null
  try {
    const records = await findDurableShadowRecords(db, destination, [{ subjectType: 'SalesOrder', exactIds: [orderId], operations: ['order.create'] }])
    if (records.length === 0) return null
    return { occurrences: records.reduce((sum, record) => sum + record.occurrences, 0), notice: WMS_ORDER_SHADOW_NOTICE }
  } catch (error) {
    console.error(`[producer-hold] could not read the shadow record of order ${orderId}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * THE DURABLE SHADOW RECORDS OF AN ORDER'S WAREHOUSE WRITES, for a destructive reader (the order hard delete). While the producer-side hold
 * stands for the warehouse a create is a shadow and writes no push link, so "no link" proves nothing was called: the writer that owns order
 * creation in the current phase may have made the warehouse order, and the record is the only evidence IMS holds.
 *
 * INDEPENDENT OF THE ENFORCEMENT SWITCH. The record outlives the switch: turning enforcement off does not make the bridge's warehouse order
 * go away, so the question is asked of the durable table whatever the environment says. An order with no record gets the legacy answer (an
 * empty list); the only cost with the switch off is one indexed read. A client that cannot run the read THROWS (it never reads as "none").
 */
export async function findOrderWarehouseShadowRecords(client: ShadowEvidenceClient, orderId: string): Promise<DurableShadowRecord[]> {
  const destinations = [...new Set(Object.values(WMS_PRODUCER_DESTINATION))]
  const found: DurableShadowRecord[] = []
  for (const destination of destinations) {
    found.push(...await findDurableShadowRecords(client, destination, [{ subjectType: 'SalesOrder', exactIds: [orderId] }]))
  }
  return found
}
