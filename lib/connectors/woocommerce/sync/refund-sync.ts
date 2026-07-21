/**
 * WooCommerce → IMS refund sync.
 */

import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { wcFetch } from '../api'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { roundQuantity, toDecimal, type DecimalInput } from '@/lib/domain/math/decimal'
import { isExternalRefundIdUniqueConflict } from '@/lib/domain/sales/refund-idempotency'
import type { WcRefund, WcRefundLineItem } from './types'
import type { createRefund as createRefundAction } from '@/app/actions/sales'

type CreateRefundAction = typeof createRefundAction

export type WcRefundSyncDependencies = {
  db?: Pick<typeof db, 'salesOrder' | 'salesOrderRefund' | 'warehouse' | 'shoppingSyncLog'>
  createRefund?: CreateRefundAction
  logActivity?: typeof logActivity
}

/**
 * o3d-6oyu.18: recorded on the shoppingSyncLog row when a WooCommerce refund is
 * suppressed because the payment poller had already charged the whole order back.
 * Doubles as the dedup key — `order.updated` re-runs syncRefundsForOrder, and without
 * it every subsequent order update would re-log the same warning forever.
 */
export const WC_REFUND_SUPPRESSED_BY_CHARGEBACK =
  'WooCommerce refund suppressed: the order was already charged back by the payment poller — no duplicate credit note raised'

function roundDecimalNumber(value: DecimalInput, precision: number): number {
  return roundQuantity(value, precision).toNumber()
}

function divideRoundedNumber(value: DecimalInput, divisor: DecimalInput, precision: number): number {
  return roundDecimalNumber(toDecimal(value).div(toDecimal(divisor)), precision)
}

function parseDecimalAbs(value: string | number | null | undefined) {
  const decimal = toDecimal(value ?? 0)
  return decimal.lt(0) ? decimal.neg() : decimal
}

export async function syncWcRefund(
  externalOrderId: number,
  wcRefund: WcRefund,
  dependencies: WcRefundSyncDependencies = {},
): Promise<{ success: boolean; error?: string }> {
  const client = dependencies.db ?? db
  const writeActivity = dependencies.logActivity ?? logActivity
  try {
    // Find the IMS order
    const so = await client.salesOrder.findFirst({
      where: {
        shoppingLinks: {
          some: {
            connector: 'woocommerce',
            externalOrderId: String(externalOrderId),
          },
        },
      },
      select: {
        id: true,
        externalOrderNumber: true,
        fxRateToBase: true,
        totalBase: true,
        taxRatePercent: true,
        lines: { select: { id: true, productId: true, externalLineItemId: true, description: true, qty: true, totalBase: true } },
      },
    })
    if (!so) return { success: false, error: `IMS order not found for WC order ${externalOrderId}` }

    // Check if already processed
    const existing = await client.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id } })
    if (existing) return { success: true } // already synced

    // o3d-iup: a refund we deliberately PARKED (a monetary-only refund the order can't tax uniformly)
    // creates no SalesOrderRefund, so without this guard the sweep would re-import and re-refuse it every
    // run. A QUARANTINED log means it is awaiting operator resolution — treat it as handled, not retryable.
    const parked = await client.shoppingSyncLog.findFirst({
      where: { entityType: 'SalesOrder', externalId: String(wcRefund.id), status: 'QUARANTINED' },
    })
    if (parked) return { success: true }

    const fxRate = toDecimal(so.fxRateToBase).gt(0) ? toDecimal(so.fxRateToBase) : toDecimal(1)
    const refundAmountForeign = parseDecimalAbs(wcRefund.amount)

    // Determine if restock is needed
    // Restock if any refund line item has qty != 0
    const hasQtyRefund = wcRefund.line_items.some((l) => Math.abs(l.quantity) > 0)

    // Reconciliation is done on a GROSS (tax-inclusive) basis because
    // wcRefund.amount is the gross amount refunded, whereas WooCommerce reports
    // line/shipping `total` ex-tax with `total_tax` separate. We accumulate the
    // gross of every line we map and compare that to wcRefund.amount. The refund
    // LINES we store stay net (matching the order lines); createRefund grosses
    // them back up via the order's tax rate.
    let mappedGrossForeign = toDecimal(0)

    // Map refund lines
    const refundLines: {
      lineId?: string
      productId: string | null
      description: string
      qty: number
      totalForeign?: number
      totalBase: number
      lineKind?: 'sale' | 'shipping'
    }[] = []

    if (wcRefund.line_items.length > 0 && hasQtyRefund) {
      // Line-item refund with quantities
      for (const rl of wcRefund.line_items) {
        const qty = Math.abs(rl.quantity)
        if (qty === 0) continue

        // Match on the ORDER line the refund refers to — NOT rl.id.
        //
        // WooCommerce mints a NEW order-item id for every refund line, so rl.id is the
        // refund line's own id and never equals externalLineItemId (set from the ORDER
        // line's id on import, field-mapping.ts:209). Measured against a live store:
        // order line 92771 -> refund line 92774, with meta _refunded_item_id = "92771".
        // The previous `l.externalLineItemId === rl.id` could therefore never match, so
        // every Woo-side refund lost its line link, createRefund rejected it for having
        // no shipped stock source, and the refund vanished with no error recorded —
        // syncRefundsForOrder only returns a count, so nothing surfaced the failure.
        const imsLine = so.lines.find((l) => l.externalLineItemId === refundedOrderLineId(rl))
        const refundTotal = parseDecimalAbs(rl.total)
        const refundGbp = divideRoundedNumber(refundTotal, fxRate, 4)
        mappedGrossForeign = mappedGrossForeign.add(refundTotal).add(parseDecimalAbs(rl.total_tax))

        refundLines.push({
          lineId: imsLine?.id,
          productId: imsLine?.productId ?? null,
          description: rl.name || imsLine?.description || 'Refund item',
          qty,
          totalForeign: roundDecimalNumber(refundTotal, 4),
          totalBase: refundGbp,
          lineKind: 'sale',
        })
      }
    }

    for (const shippingLine of wcRefund.shipping_lines ?? []) {
      const shippingRefundTotal = parseDecimalAbs(shippingLine.total)
      if (shippingRefundTotal.lte(0.000001)) continue
      mappedGrossForeign = mappedGrossForeign.add(shippingRefundTotal).add(parseDecimalAbs(shippingLine.total_tax))
      refundLines.push({
        productId: null,
        description: shippingLine.method_title || 'Shipping refund',
        qty: 0,
        totalForeign: roundDecimalNumber(shippingRefundTotal, 4),
        totalBase: divideRoundedNumber(shippingRefundTotal, fxRate, 4),
        lineKind: 'shipping',
      })
    }

    if (refundLines.length === 0) {
      // Monetary-only refund (no line items / shipping to break down): the money returned to the customer
      // is GROSS (tax-inclusive), but every refund line is stored NET (o3d-w00) — the credit note grosses
      // it back up via the snapshotted tax type. So convert the gross refund to net using the order's VAT
      // rate here; a non-taxable order (rate 0) leaves it unchanged. The gross accumulator below stays
      // GROSS, because the amount-mismatch reconciliation checks against wcRefund.amount which is gross.
      const vatRate = toDecimal(so.taxRatePercent ?? 0).div(100)
      const netForeign = toDecimal(refundAmountForeign).div(toDecimal(1).add(vatRate))
      refundLines.push({
        productId: null,
        description: wcRefund.reason || 'WooCommerce refund',
        qty: 0,
        totalForeign: roundDecimalNumber(netForeign, 4),
        totalBase: divideRoundedNumber(netForeign, fxRate, 4),
        lineKind: 'sale',
      })
      mappedGrossForeign = refundAmountForeign
    }

    const mappedGrossRounded = roundDecimalNumber(mappedGrossForeign, 4)
    if (refundLines.length > 0 && toDecimal(mappedGrossRounded).sub(refundAmountForeign).abs().gt(0.01)) {
      const error = `WooCommerce refund ${wcRefund.id} amount mismatch: mapped ${toDecimal(mappedGrossRounded).toFixed(2)} but refund total is ${refundAmountForeign.toDecimalPlaces(2).toFixed(2)}`
      await client.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'PENDING',
          entityType: 'SalesOrder',
          entityId: so.id,
          externalId: String(wcRefund.id),
          payload: wcRefund as never,
          errorMessage: error,
        },
      })
      return {
        success: false,
        error,
      }
    }

    // Find return warehouse (default return warehouse)
    let returnWarehouseId: string | undefined
    if (hasQtyRefund) {
      const returnWh = await client.warehouse.findFirst({
        where: { defaultReturnWarehouse: true, active: true },
        select: { id: true },
      })
      returnWarehouseId = returnWh?.id
    }

    // Use the createRefund action
    const createRefund = dependencies.createRefund
      ?? (await import('@/app/actions/sales')).createRefund
    let result: Awaited<ReturnType<CreateRefundAction>>
    try {
      result = await createRefund(
        so.id,
        refundLines.filter((l) => l.qty > 0 || l.totalBase > 0),
        wcRefund.reason || 'WooCommerce refund',
        returnWarehouseId,
        { internalBypassToken: INTERNAL_ACTION_BYPASS, externalRefundId: wcRefund.id },
      )
    } catch (error) {
      if (!isExternalRefundIdUniqueConflict(error)) throw error
      await client.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'SYNCED',
          entityType: 'SalesOrder',
          entityId: so.id,
          externalId: String(wcRefund.id),
          errorMessage: 'Duplicate WooCommerce refund delivery deduped by external refund id',
          syncedAt: new Date(),
        },
      })
      await writeActivity({
        entityType: 'SALES_ORDER',
        entityId: so.id,
        action: 'refund_sync_deduped',
        tag: 'sync',
        level: 'INFO',
        description: `WC refund ${wcRefund.id} already synced; duplicate delivery was deduped`,
        metadata: { externalRefundId: wcRefund.id, parentOrderId: externalOrderId },
        resolveUser: false,
      })
      return { success: true }
    }

    // o3d-6oyu.18: the refund transaction refused this credit note because a payment-poller
    // CHARGEBACK for the same order committed first — the other half of the concurrent
    // double-reversal race (a Xero payment removal and this WC refund inside one poll cycle).
    // A chargeback unwinds the WHOLE remaining order, so posting this refund's credit note on
    // top would double-reverse it. Treat it as handled, NOT as a failure: a FAILED row would
    // dead-letter into the exceptions inbox and be retried forever against a condition that can
    // never clear. The reversal itself is not lost — the poller already raised the credit note
    // and alerted admins; this WARNING records that the Woo-side refund needs reconciling.
    if (result.conflict === 'prior-chargeback') {
      const alreadyRecorded = await client.shoppingSyncLog.findFirst({
        where: {
          entityType: 'SalesOrder',
          externalId: String(wcRefund.id),
          errorMessage: WC_REFUND_SUPPRESSED_BY_CHARGEBACK,
        },
        select: { id: true },
      })
      // o3d-1sc3: suppressing the duplicate CREDIT NOTE is right; suppressing the STOCK
      // RETURN is not. A chargeback performs no restock because it assumes the customer kept
      // the goods — but a Woo refund carrying QUANTITY lines is at least evidence that units
      // were refunded, and the chargeback path will never account for them. Marking the whole
      // delivery SYNCED at WARNING therefore buried a possible inventory gap behind a note
      // about a credit note.
      //
      // What this does NOT do, deliberately: assert that goods physically came back, or raise
      // a WmsReturnsInbox row. WooCommerce's refund line carries a refunded QUANTITY and no
      // received/restocked signal, so quantity alone cannot prove a physical return — and the
      // returns inbox is currently scoped to a single WMS connector — its loader, its status
      // action and its restock action all filter on that one connector — so a row written here
      // would be invisible and unresolvable. Claiming an actionable record that no screen shows
      // would be worse than the WARNING it replaced. Generalising that inbox is o3d-92rl;
      // establishing what actually proves a physical return on the WooCommerce side is o3d-etbf.
      const refundedUnits = refundLines
        .filter((line) => line.lineKind === 'sale' && line.qty > 0)
        .reduce((sum, line) => sum + line.qty, 0)

      if (!alreadyRecorded) {
        await client.shoppingSyncLog.create({
          data: {
            direction: 'FROM_CONNECTOR',
            status: 'SYNCED',
            entityType: 'SalesOrder',
            entityId: so.id,
            externalId: String(wcRefund.id),
            errorMessage: WC_REFUND_SUPPRESSED_BY_CHARGEBACK,
            syncedAt: new Date(),
          },
        })
        const returnedNote = refundedUnits > 0
          ? ` This refund covered ${refundedUnits} unit(s): the chargeback path performs no restock, so if those units came back they are NOT on hand in IMS. Verify and adjust stock manually.`
          : ''
        await writeActivity({
          entityType: 'SALES_ORDER',
          entityId: so.id,
          action: 'refund_sync_suppressed_by_chargeback',
          tag: 'sync',
          // A quantity-bearing refund may owe an inventory movement nothing else will make,
          // so it needs action rather than a note. A monetary-only suppression owes nothing.
          level: refundedUnits > 0 ? 'ERROR' : 'WARNING',
          description: `WooCommerce refund ${wcRefund.id} on order #${so.externalOrderNumber} was not recorded — the order was already charged back by the payment poller, and a second credit note would double-reverse it. Reconcile the Woo refund manually.${returnedNote} ${result.error ?? ''}`.trim(),
          metadata: {
            externalRefundId: wcRefund.id,
            parentOrderId: externalOrderId,
            refundedUnits,
          },
          resolveUser: false,
        })
      }
      return { success: true }
    }

    if (!result.success) {
      // o3d-iup: a deliberate refusal (result.quarantine) is PARKED, not a transient failure — record it
      // as QUARANTINED so the sweep dedup skips it (no per-sweep re-refusal loop) and FAILED dashboards
      // don't treat it as retryable. The refusal message already tells the operator to resolve it in IMS
      // and not to issue another Woo refund.
      const quarantined = result.quarantine === true
      await client.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: quarantined ? 'QUARANTINED' : 'FAILED',
          entityType: 'SalesOrder',
          entityId: so.id,
          externalId: String(wcRefund.id),
          errorMessage: result.error,
          syncedAt: new Date(),
        },
      })
      return { success: false, error: result.error }
    }

    await client.shoppingSyncLog.create({
      data: {
        direction: 'FROM_CONNECTOR',
        status: 'SYNCED',
        entityType: 'SalesOrder',
        entityId: so.id,
        externalId: String(wcRefund.id),
        syncedAt: new Date(),
      },
    })

    await writeActivity({
      entityType: 'SALES_ORDER',
      entityId: so.id,
      action: 'refund_synced',
      tag: 'sync',
      level: 'INFO',
      description: `Synced WC refund for order #${so.externalOrderNumber} — ${refundAmountForeign.toFixed(2)} ${hasQtyRefund ? '(with restock)' : '(monetary only)'}`,
      metadata: { externalRefundId: wcRefund.id, amount: refundAmountForeign, hasRestock: hasQtyRefund },
      resolveUser: false,
    })

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * Check for new refunds on synced orders and process them.
 */
/**
 * The ORDER line item a refund line refers to.
 *
 * WooCommerce records it as the `_refunded_item_id` meta on the refund line; the line's
 * own `id` is a fresh order-item id and matches nothing on our side. Falls back to
 * rl.id so a store (or a stub) that does not emit the meta still behaves as before
 * rather than losing the link entirely.
 */
export function refundedOrderLineId(rl: WcRefundLineItem): number {
  const meta = (rl.meta_data ?? []).find((m) => m.key === '_refunded_item_id')
  const id = Number(meta?.value)
  return Number.isFinite(id) && id > 0 ? id : rl.id
}

export async function syncRefundsForOrder(externalOrderId: number): Promise<number> {
  // Fetch refunds from WC
  const { data, error } = await wcFetch(`/orders/${externalOrderId}/refunds`)
  if (error || !data) return 0

  const refunds = data as WcRefund[]
  let synced = 0

  for (const refund of refunds) {
    // Check if already synced
    const exists = await db.salesOrderRefund.findFirst({ where: { externalRefundId: refund.id } })
    if (exists) continue

    // o3d-iup: skip a refund we deliberately PARKED — it has no SalesOrderRefund row, so without this it
    // would be re-imported and re-refused every sweep. It stays parked until an operator resolves it.
    const parked = await db.shoppingSyncLog.findFirst({
      where: { entityType: 'SalesOrder', externalId: String(refund.id), status: 'QUARANTINED' },
    })
    if (parked) continue

    const result = await syncWcRefund(externalOrderId, refund)
    if (result.success) synced++
  }

  return synced
}
