import { db } from '@/lib/db'
import { getIntegrationPluginState } from '@/lib/integration-plugins'
import { WMS_CONNECTOR_IDS } from '@/lib/connectors/wms/types'
import { getWmsConnector, getWmsConnectorDef } from '@/lib/connectors/wms/registry'
import { resolveWmsOrderLookupConnector } from '@/lib/connectors/wms/order-lookup'

/**
 * Connector-agnostic WMS order-status sweep. Refreshes the cached snapshot for
 * in-flight sales orders linked to the active WMS connector's order-lookup
 * connector, so the sales-list chips read cached status instead of making a live
 * call per row. The detail view stays live (getWmsOrderStatusForSalesOrder).
 */

// Sales orders past these IMS statuses no longer need WMS status polling.
const TERMINAL_SALES_STATUSES = ['COMPLETED', 'DELIVERED', 'CANCELLED'] as const
const DEFAULT_STALE_MINUTES = 30
const DEFAULT_BATCH_SIZE = 50

export type WmsOrderStatusSweepResult = {
  skipped?: string
  scanned: number
  updated: number
  failed: number
}

/**
 * The exact lastError a snapshot carries when an AUTHORITATIVE lookup found no such order.
 *
 * Exported because order-delete-guard has to tell that apart from a lookup ERROR, which also
 * writes an empty externalOrderId — and a shared literal is the only thing stopping the two files
 * drifting into disagreement about which placeholder means "safe to delete" (o3d-eu0r).
 */
export const WMS_LOOKUP_NOT_FOUND = 'Order not found in WMS'

/**
 * The marker the delete guard accepts as authoritative absence — deliberately DISTINCT from the
 * legacy WMS_LOOKUP_NOT_FOUND above (o3d-eu0r).
 *
 * Rows written before the presence probe existed recorded EVERY null fetch as the legacy literal,
 * including AMBIGUOUS ones. Accepting that literal would keep letting a genuine warehouse order be
 * deleted on the strength of a snapshot that never distinguished the two. A new marker is
 * unforgeable by old rows: anything still carrying the legacy string is treated as unresolved and
 * fails closed until the sweep re-resolves it.
 *
 * Refreshing is NOT a safe compatibility mechanism on its own — the sweep is optional and
 * batch-limited, so it may simply not have reached an order before someone tries to delete it.
 */
export const WMS_LOOKUP_CONFIRMED_ABSENT = 'Order confirmed absent in WMS (presence-probed)'

/**
 * The lastError written when the lookup could not decide — several WMS orders match this
 * reference (merged/split candidates), so "no single order" is NOT "no order" (o3d-x9nc).
 *
 * Kept distinct from WMS_LOOKUP_NOT_FOUND because the delete guard must fail CLOSED on this:
 * an ambiguous result means a real warehouse order probably exists, it just cannot be named.
 */
export const WMS_LOOKUP_AMBIGUOUS = 'WMS lookup ambiguous — several orders match this reference'

/**
 * The lookup could not read a status, but a presence probe says the order IS there. A
 * contradiction rather than an absence, and it blocks deletion for the obvious reason.
 */
export const WMS_LOOKUP_PRESENT_NO_STATUS = 'WMS holds this order but its status could not be read'

export async function runWmsOrderStatusSweep(
  options?: { batchSize?: number; staleMinutes?: number },
): Promise<WmsOrderStatusSweepResult> {
  const state = await getIntegrationPluginState()
  const connectorId = WMS_CONNECTOR_IDS.find((id) => state[id])
  if (!connectorId) return { skipped: 'No WMS connector enabled', scanned: 0, updated: 0, failed: 0 }

  const connector = getWmsConnector(connectorId)
  if (!connector.fetchOrderStatus) {
    return { skipped: 'Active WMS connector has no order-status support', scanned: 0, updated: 0, failed: 0 }
  }

  const lookupConnector = await resolveWmsOrderLookupConnector(connectorId)
  if (!lookupConnector) return { skipped: 'No order-lookup connector resolved', scanned: 0, updated: 0, failed: 0 }

  const staleMinutes = options?.staleMinutes ?? DEFAULT_STALE_MINUTES
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000)
  const connectorLabel = getWmsConnectorDef(connectorId).label

  const orders = await db.salesOrder.findMany({
    where: {
      status: { notIn: [...TERMINAL_SALES_STATUSES] },
      shoppingLinks: { some: { connector: lookupConnector, externalOrderNumber: { not: null } } },
      OR: [
        { wmsOrderStatus: { is: null } },
        { wmsOrderStatus: { fetchedAt: { lt: staleBefore } } },
      ],
    },
    select: {
      id: true,
      shoppingLinks: {
        where: { connector: lookupConnector },
        select: { externalOrderNumber: true },
        take: 1,
      },
      // Last status pushed to the storefront, to push only on change (G4). Tracked
      // separately from `status` so a failed push isn't masked by the change gate.
      wmsOrderStatus: { select: { wcPushedStatus: true } },
    },
    take: batchSize,
    orderBy: { updatedAt: 'desc' },
  })

  let updated = 0
  let failed = 0

  for (const order of orders) {
    const reference = order.shoppingLinks[0]?.externalOrderNumber?.trim()
    if (!reference) continue

    try {
      const status = await connector.fetchOrderStatus(reference)
      const tracking = status?.tracking.find((entry) => entry.trackingNumber || entry.carrier)

      // fetchOrderStatus returns null for BOTH "no such order" and "several candidates match"
      // (merged/split references). Those are opposite conclusions for anything that acts on the
      // snapshot — the delete guard treats an authoritative MISSING as safe and must fail closed
      // on AMBIGUOUS — so resolve it with probeOrderPresence, which already reports the
      // distinction, rather than recording both as not-found (o3d-x9nc).
      //
      // Only on the null path, so a found order costs no extra call. A connector without
      // probeOrderPresence stays on the conservative reading: unresolved, so the guard blocks.
      //
      // COST: both current connectors re-run the same underlying search inside the probe —
      // Mintsoft repeats Order/Search, ShipHero repeats a credit-consuming GraphQL query — so a
      // batch of missing orders would otherwise double its remote requests every sweep, against a
      // quota. An order already CONFIRMED absent and still absent has nothing new to learn, so it
      // is not re-probed; the steady state (a stable set of orders the WMS has never held) costs
      // one probe each, once, instead of one per sweep.
      //
      // The residual is deliberate: the FIRST sweep after an order goes missing still pays for a
      // probe, which is exactly when the answer is worth having.
      let notFoundReason: string = WMS_LOOKUP_CONFIRMED_ABSENT
      if (!status) {
        const known = await db.wmsOrderStatusSnapshot.findUnique({
          where: { orderId: order.id },
          select: { externalOrderId: true, lastError: true },
        })
        const alreadyConfirmedAbsent = known
          && !known.externalOrderId
          && known.lastError === WMS_LOOKUP_CONFIRMED_ABSENT

        if (alreadyConfirmedAbsent) {
          // Keep the existing verdict; nothing to re-resolve.
        } else if (!connector.probeOrderPresence) {
          notFoundReason = 'WMS lookup could not be confirmed — connector cannot probe presence'
        } else {
          try {
            const presence = await connector.probeOrderPresence(reference)
            if (presence === 'AMBIGUOUS') notFoundReason = WMS_LOOKUP_AMBIGUOUS
            // FOUND after a null fetch is a CONTRADICTION, not ambiguity: the order is there but
            // its status could not be read. Distinct marker so the reason stays truthful, and it
            // blocks for the same reason — the warehouse holds this order.
            else if (presence === 'FOUND') notFoundReason = WMS_LOOKUP_PRESENT_NO_STATUS
          } catch (probeError) {
            notFoundReason = `WMS presence probe failed: ${
              probeError instanceof Error ? probeError.message : String(probeError)
            }`
          }
        }
      }

      const fields = status
        ? {
            connector: connectorId,
            connectorLabel,
            externalOrderId: status.externalOrderId,
            externalOrderNumber: status.externalOrderNumber,
            status: status.status,
            statusLabel: status.statusLabel,
            isSplit: status.isSplit,
            partCount: status.partCount,
            isMerged: status.isMerged,
            mergedOrderNumbers: status.mergedOrderNumbers,
            deepLinkUrl: status.deepLinkUrl,
            trackingNumber: tracking?.trackingNumber ?? null,
            carrier: tracking?.carrier ?? null,
            lastError: null,
          }
        : {
            connector: connectorId,
            connectorLabel,
            externalOrderId: '',
            externalOrderNumber: reference,
            status: '',
            statusLabel: 'Unknown',
            isSplit: false,
            partCount: null,
            isMerged: false,
            mergedOrderNumbers: [],
            deepLinkUrl: null,
            trackingNumber: null,
            carrier: null,
            lastError: notFoundReason,
          }

      await db.wmsOrderStatusSnapshot.upsert({
        where: { orderId: order.id },
        create: { orderId: order.id, ...fields },
        update: { ...fields, fetchedAt: new Date() },
      })
      if (status) updated += 1

      // G6: clear the courier-pending review flag once the order is actually despatched
      // (a tracking NUMBER is present) — that's the point the courier is final and operator
      // verification is moot. Deliberately NOT keyed on carrier alone: the fallback default
      // courier yields a CourierServiceName immediately, so clearing on the name would drop
      // the flag while the order is still pre-despatch and still on the default courier.
      // updateMany is a no-op when there's no link or the flag is already clear.
      if (status && tracking?.trackingNumber) {
        await db.wmsOrderPushLink
          .updateMany({ where: { orderId: order.id, courierPending: true }, data: { courierPending: false } })
          .catch(() => {})
      }

      // G4: surface the WMS status in the storefront admin (the companion plugin renders
      // `_oti_wms_*` meta). Push only when it changed vs the LAST SUCCESSFUL push — so a
      // transient WC failure retries next tick instead of being permanently skipped.
      // Best-effort: a failed push must not fail the status sweep, but it is logged and
      // wcPushedStatus is left unchanged so it's re-attempted.
      if (status && status.status && status.status !== order.wmsOrderStatus?.wcPushedStatus) {
        try {
          const { pushWmsOrderStatusToShopping } = await import('@/lib/shopping')
          const pushResult = await pushWmsOrderStatusToShopping(order.id, {
            status: status.status,
            statusLabel: status.statusLabel,
            connectorLabel,
            deepLinkUrl: status.deepLinkUrl,
          })
          if (pushResult.success) {
            await db.wmsOrderStatusSnapshot.update({
              where: { orderId: order.id },
              data: { wcPushedStatus: status.status },
            }).catch(() => {})
          } else if (!pushResult.skipped) {
            console.warn(`[wms-order-status-sweep] storefront WMS-status push failed for order ${order.id}: ${pushResult.error}`)
          }
        } catch (pushError) {
          console.error('[wms-order-status-sweep] storefront WMS-status push errored', pushError)
        }
      }
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : 'WMS order-status sweep failed'
      await db.wmsOrderStatusSnapshot
        .upsert({
          where: { orderId: order.id },
          create: {
            orderId: order.id,
            connector: connectorId,
            connectorLabel,
            externalOrderId: '',
            externalOrderNumber: reference,
            status: '',
            statusLabel: 'Unknown',
            lastError: message,
          },
          update: { fetchedAt: new Date(), lastError: message },
        })
        .catch(() => {})
    }
  }

  return { scanned: orders.length, updated, failed }
}
