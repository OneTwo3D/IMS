/**
 * THE WAREHOUSE GATE OF AN ORDER EDIT.
 *
 * IMS's own status does not prove the warehouse can still take a change: the warehouse may have moved a pushed order past NEW while its status has not reached IMS yet, and the amendment pass then refuses (status NOT_NEW, the
 * AMENDMENT_NOT_APPLIED operator task) after the edit has already replaced the lines and the reservations. So an edit that changes what the warehouse has to pick asks the SAME gate the amendment pass asks
 * (the connector's probeOrderAmendable, which is updateOrder's own gate without the write) BEFORE it commits, and is refused when the warehouse order is not amendable or when that cannot be established.
 *
 * An order with no warehouse order yet (no link, or a link that has not minted an id) has nothing to amend: the push, when it happens, reads the edited order. ACCEPTED INTER-SYSTEM LIMIT: the answer is read before the
 * edit's transaction, so the warehouse can still move the order between the read and the commit; the amendment pass then records its refusal as it always did.
 */
import { db } from '@/lib/db'
import { getWmsConnector } from '@/lib/connectors/wms/registry'
import type { WmsConnectorId } from '@/lib/connectors/wms/types'

export const WMS_AMENDMENT_NOT_APPLIED = 'AMENDMENT_NOT_APPLIED'

export type OrderEditWmsGate =
  | { ok: true; /** The warehouse order id the answer was read for; null when the order has none yet. The edit's transaction re-checks it. */ externalOrderId: string | null }
  | { ok: false; error: string }

export type OrderEditWmsGateDeps = {
  readLink(orderId: string): Promise<{ connector: string; externalOrderId: string | null; orderNumber: string | null } | null>
  probe(connector: string, externalOrderId: string, expectedOrderNumber: string | null): Promise<{ amendable: true } | { amendable: false; status: string } | 'unsupported'>
}

const defaultDeps: OrderEditWmsGateDeps = {
  async readLink(orderId) {
    const link = await db.wmsOrderPushLink.findUnique({
      where: { orderId },
      select: { connector: true, externalOrderId: true, externalOrderNumber: true, order: { select: { orderNumber: true, externalOrderNumber: true } } },
    })
    if (!link) return null
    // The number the amendment pass expects the warehouse order to carry (wmsPushOrderReference's rule).
    return { connector: link.connector, externalOrderId: link.externalOrderId, orderNumber: link.order.orderNumber ?? link.order.externalOrderNumber ?? orderId }
  },
  async probe(connector, externalOrderId, expectedOrderNumber) {
    const c = getWmsConnector(connector as WmsConnectorId)
    if (!c.probeOrderAmendable) return 'unsupported'
    return c.probeOrderAmendable(externalOrderId, expectedOrderNumber)
  },
}

/** The dependencies the edit actions use. A holder (not a constant) so a test of the action can supply the warehouse's answer without a network; production never reassigns it. */
export const orderEditWmsGateDeps: { current: OrderEditWmsGateDeps } = { current: defaultDeps }

function refusal(what: string, why: string): OrderEditWmsGate {
  return {
    ok: false,
    error: `${WMS_AMENDMENT_NOT_APPLIED}: ${why} so the warehouse could not take this change to ${what}, and nothing was changed. `
      + 'Wait until the warehouse status has updated, then edit the order again, or cancel it and create a new one.',
  }
}

export async function resolveOrderEditWmsGate(orderId: string, scope: 'lines' | 'addresses and notes', deps: OrderEditWmsGateDeps = orderEditWmsGateDeps.current): Promise<OrderEditWmsGate> {
  const link = await deps.readLink(orderId)
  if (!link || !link.externalOrderId) return { ok: true, externalOrderId: null }
  const what = scope === 'lines' ? "this order's lines" : "this order's addresses and notes"
  let answer: Awaited<ReturnType<OrderEditWmsGateDeps['probe']>>
  try {
    answer = await deps.probe(link.connector, link.externalOrderId, link.orderNumber)
  } catch {
    return refusal(what, 'the warehouse could not be read just now, so IMS cannot tell whether its order is still open for changes,')
  }
  if (answer === 'unsupported') return refusal(what, 'the warehouse connector cannot report whether its order is still open for changes,')
  if (!answer.amendable) return refusal(what, `the warehouse order is no longer open for changes (warehouse answer: ${answer.status}),`)
  return { ok: true, externalOrderId: link.externalOrderId }
}
