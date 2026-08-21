/**
 * WooCommerce → IMS refund sync.
 */

import { Prisma } from '@/app/generated/prisma/client'
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
  db?: Pick<typeof db, 'salesOrder' | 'salesOrderRefund' | 'warehouse' | 'shoppingSyncLog' | '$transaction'>
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

// o3d-7yf: when a refund finally lands (a successful retry or a verified same-order dedup), RESOLVE this
// order's lingering actionable park instead of only appending a separate SYNCED log. The partial unique
// index excludes SYNCED rows, so a fresh SYNCED log never collides with — nor clears — the old PENDING/
// FAILED park; left alone it keeps counting in the exception inbox, blocks deletion/rebind, and evades
// retention forever. Scoped to THIS order + refund. QUARANTINED is left untouched: it is an operator-gated
// refusal that never reaches a successful auto-sync (the preflight returns it as handled first).
async function resolveActionableParks(
  client: Pick<typeof db, 'shoppingSyncLog'>,
  soId: string,
  externalId: string,
): Promise<void> {
  await client.shoppingSyncLog.updateMany({
    where: {
      connector: 'woocommerce',
      direction: 'FROM_CONNECTOR',
      entityType: 'SalesOrder',
      externalId,
      entityId: soId,
      status: { in: ['PENDING', 'FAILED'] },
    },
    data: { status: 'SYNCED', syncedAt: new Date(), errorMessage: null },
  })
}

// o3d-7yf: record a refund park deduplicated by externalId. Repeated deliveries of the same unresolved
// WooCommerce refund (an amount mismatch re-imported every sweep, a still-failing retry) must keep ONE
// current row, not append a fresh one each time — unbounded copies would grow the table and crowd real
// QUARANTINED refunds out of the 50-row exception inbox. Updates the existing actionable park in place.
async function upsertRefundPark(
  client: Pick<typeof db, '$transaction'>,
  input: { soId: string; externalId: string; status: 'PENDING' | 'FAILED' | 'QUARANTINED'; errorMessage: string; payload?: unknown },
): Promise<void> {
  // Match the partial unique index shopping_sync_logs_active_refund_park_uq EXACTLY (connector, direction,
  // entityType, actionable status, externalId, and entityId NOT NULL) so this can never pick up an
  // order-import failure log (same connector/type but no entityId) that happens to share an externalId.
  const parkWhere: Prisma.ShoppingSyncLogWhereInput = {
    connector: 'woocommerce',
    direction: 'FROM_CONNECTOR',
    entityType: 'SalesOrder',
    externalId: input.externalId,
    entityId: { not: null },
    status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
  }
  const data = {
    connector: 'woocommerce' as const,
    direction: 'FROM_CONNECTOR' as const,
    status: input.status,
    entityType: 'SalesOrder',
    entityId: input.soId,
    externalId: input.externalId,
    errorMessage: input.errorMessage,
    syncedAt: new Date(),
    ...(input.payload !== undefined ? { payload: input.payload as never } : {}),
  }
  // o3d-7yf finding 2: create/update the park under the SAME order row lock deleteSalesOrder takes
  // (lockSalesOrder = SELECT ... FOR UPDATE). A refund sweep could otherwise read the order, deletion
  // observe no park, and the sweep then insert an actionable park after the check/delete — orphaning it.
  // Under the lock we re-verify the order still exists; if it was deleted, we do NOT write an orphaned
  // park (the refund is for a gone order — surfaced by the caller's earlier resolve failing next time).
  await client.$transaction(async (tx) => {
    // o3d-ee9: take the per-refund advisory lock FIRST (before the order row lock — matching
    // createSalesOrderRefund's order so the two can't deadlock). This serializes the park write against a
    // concurrent refund CREATE for the same refund id on ANY order, closing the window where a refund could
    // commit on order A while a stale actionable park is written for order B.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wc_refund:${input.externalId}`}))`
    // Under that lock, re-read whether the refund has now LANDED (on any order). If a SalesOrderRefund exists
    // for this external id, a park (which asserts the refund is unresolved) would be contradictory — skip it.
    const landed = await tx.salesOrderRefund.findFirst({ where: { externalRefundId: Number(input.externalId) }, select: { id: true } })
    if (landed) return

    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "sales_orders" WHERE id = ${input.soId} FOR UPDATE`
    if (rows.length === 0) return

    // The order row lock SERIALIZES every park write for this refund's order, so the findFirst reliably
    // sees an already-committed park and no two deliveries can race the create. (The partial unique index
    // shopping_sync_logs_active_refund_park_uq stays as a DB backstop.)
    const existing = await tx.shoppingSyncLog.findFirst({ where: parkWhere, orderBy: { createdAt: 'desc' }, select: { id: true, entityId: true } })
    if (existing) {
      if (existing.entityId !== input.soId) {
        // The index is keyed by (connector, externalId), so an actionable park for this refund id on a
        // DIFFERENT order is a genuine anomaly (a WC refund id maps to one order). Fail CLOSED — never
        // move A's durable refund evidence onto B's row, which would let A be deleted and mis-block B.
        throw new Error(`WooCommerce refund ${input.externalId} is already parked for a different order (${existing.entityId}); refusing to move it.`)
      }
      await tx.shoppingSyncLog.update({ where: { id: existing.id }, data })
    } else {
      await tx.shoppingSyncLog.create({ data })
    }
  })
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

    // Check if already processed. externalRefundId is GLOBALLY unique, so a matching refund may belong to
    // ANOTHER order — o3d-7yf: verify ownership. Same order => idempotent success; different order => fail
    // closed rather than silently reporting "handled" and leaving THIS order without its refund.
    const existing = await client.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id }, select: { orderId: true } })
    if (existing) {
      if (existing.orderId === so.id) {
        // Already synced. A prior delivery may have committed the refund but then failed a post-commit step
        // and written a FAILED park — every later delivery lands here, so resolve that lingering park now
        // rather than leaving it actionable forever (inbox / deletion+rebind guard / retention exemption).
        await resolveActionableParks(client, so.id, String(wcRefund.id))
        return { success: true }
      }
      return { success: false, error: `WooCommerce refund ${wcRefund.id} already exists on a different order (${existing.orderId}); refusing to apply it here.` }
    }

    // o3d-iup: a refund we deliberately PARKED (a monetary-only refund the order can't tax uniformly)
    // creates no SalesOrderRefund, so without this guard the sweep would re-import and re-refuse it every
    // run. o3d-7yf: check EVERY actionable park (the index keeps at most one per externalId), scoped by
    // order. A park for refund X on a DIFFERENT order fails closed (never apply X to two orders). This
    // order's QUARANTINED park is "handled" (awaiting operator resolution — not retryable); a PENDING/FAILED
    // park is this order's own retryable state, so fall through and let the sync re-attempt it.
    const parked = await client.shoppingSyncLog.findFirst({
      where: {
        connector: 'woocommerce',
        direction: 'FROM_CONNECTOR',
        entityType: 'SalesOrder',
        externalId: String(wcRefund.id),
        entityId: { not: null },
        status: { in: ['PENDING', 'FAILED', 'QUARANTINED'] },
      },
      select: { entityId: true, status: true },
    })
    if (parked && parked.entityId !== so.id) {
      return { success: false, error: `WooCommerce refund ${wcRefund.id} is already parked for a different order (${parked.entityId}); refusing to process it for this order.` }
    }
    if (parked && parked.status === 'QUARANTINED') {
      return { success: true } // this order's quarantined park — handled, not retryable
    }

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
      await upsertRefundPark(client, {
        soId: so.id,
        externalId: String(wcRefund.id),
        status: 'PENDING',
        errorMessage: error,
        payload: wcRefund,
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
      // o3d-7yf: the unique violation may be a CROSS-ORDER race — the refund that won the externalRefundId
      // could belong to another order. Verify ownership before recording a SYNCED dedup log for THIS order;
      // otherwise the loser is falsely marked synced while its refund lives on a different order.
      const winner = await client.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id }, select: { orderId: true } })
      if (winner && winner.orderId !== so.id) {
        return { success: false, error: `WooCommerce refund ${wcRefund.id} was concurrently created on a different order (${winner.orderId}); refusing to mark it synced here.` }
      }
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
      // The verified same-order refund exists — resolve any lingering actionable park for it too.
      await resolveActionableParks(client, so.id, String(wcRefund.id))
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
      await upsertRefundPark(client, {
        soId: so.id,
        externalId: String(wcRefund.id),
        status: quarantined ? 'QUARANTINED' : 'FAILED',
        errorMessage: result.error ?? 'refund sync failed',
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
    // A same-order PENDING/FAILED park intentionally fell through to this retry — now that it landed, clear it.
    await resolveActionableParks(client, so.id, String(wcRefund.id))

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

/**
 * WooCommerce pages `/orders/{id}/refunds` at TEN unless asked otherwise, and 100 is the most
 * it will serve. Asking for the maximum is not an optimisation here — see
 * `fetchAllWcRefundsForOrder`.
 */
const WC_REFUND_PAGE_SIZE = 100

async function logIncompleteRefundRead(
  externalOrderId: number,
  failedPage: number,
  readSoFar: number,
  detail: string,
): Promise<void> {
  try {
    await logActivity({
      entityType: 'SYNC',
      action: 'wc_refund_read_incomplete',
      tag: 'sync',
      level: 'WARNING',
      description: `Reading refunds for WooCommerce order ${externalOrderId} stopped at page ${failedPage} `
        + `after ${readSoFar} refund(s): ${detail}. Refunds beyond that point are not in IMS yet, so the `
        + 'order may show a smaller refunded amount than the store does, and a 3PL dispatch for it can be '
        + 'refused as uncovered until the next sweep reads them. The sweep re-reads the order from the '
        + 'first page each time, so this clears itself once the store responds.',
      metadata: { externalOrderId, failedPage, readSoFar, error: detail },
      resolveUser: false,
    })
  } catch {
    // Telemetry must never turn a partial read into a thrown sweep.
  }
}

/**
 * EVERY refund on the order, not the first page of them (o3d-okbd).
 *
 * `/orders/{id}/refunds` takes the collection parameters and defaults `per_page` to 10,
 * newest first. The sweep asked for the path with no parameters at all, so on an order with
 * more than ten refunds it read the ten most recent and returned as though that were the lot —
 * silently, because a short page and a capped page look identical from the caller's side.
 *
 * Ten is not a hypothetical ceiling. A partial refund per line item reaches it on an ordinary
 * multi-line order, and WooCommerce writes one refund per "Refund" press, not one per order.
 *
 * WHY IT MATTERS BEYOND THE MISSING ROWS. `findExternalFulfillmentShortfall` nets refunded
 * quantity out of the demand a 3PL dispatch has to cover, reading the refund lines IMS holds.
 * Refunds that never arrived are demand that is never netted, so the coverage check refuses a
 * dispatch that is in fact complete — and the refusal is permanent, since redelivery re-reads
 * the same truncated page. The truncation therefore does not merely lose refund history; it
 * blocks fulfilment on the orders that have the most of it.
 *
 * Bounded twice over: by `x-wp-totalpages` when the store reports it, and by a page that comes
 * back shorter than it asked for, so a store that reports no total (or an implausible one)
 * still terminates.
 *
 * A page that FAILS returns what was read so far together with the error, which is the same
 * leniency the single-page version had for a failed fetch — the caller syncs what it has, and
 * the next sweep re-reads the order from the start, because nothing here is cursored. It is
 * also LOGGED, here rather than at the call site, because this is the only frame that knows
 * the read was short: one page further up, a partial list and a complete one are the same
 * value, which is exactly how the ten-refund truncation stayed invisible for as long as it
 * did.
 */
export async function fetchAllWcRefundsForOrder(
  externalOrderId: number,
): Promise<{ refunds: WcRefund[]; error?: string }> {
  const refunds: WcRefund[] = []
  let page = 1
  for (;;) {
    const { data, totalPages, error } = await wcFetch(`/orders/${externalOrderId}/refunds`, {
      per_page: String(WC_REFUND_PAGE_SIZE),
      page: String(page),
    })
    if (error || !data || !Array.isArray(data)) {
      const detail = error
        ?? (data ? 'WooCommerce returned a non-list refund page' : 'WooCommerce returned no refund data')
      await logIncompleteRefundRead(externalOrderId, page, refunds.length, detail)
      return { refunds, error: detail }
    }

    refunds.push(...(data as WcRefund[]))
    // A page shorter than the one asked for is the last page, whatever any header claims.
    if (data.length < WC_REFUND_PAGE_SIZE) return { refunds }
    const reportedPages = Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1
    if (page >= reportedPages) return { refunds }
    page += 1
  }
}

export async function syncRefundsForOrder(externalOrderId: number): Promise<number> {
  // Every page of refunds on the order, not just the first (o3d-okbd).
  const { refunds } = await fetchAllWcRefundsForOrder(externalOrderId)
  let synced = 0

  for (const refund of refunds) {
    // o3d-7yf: BOTH the already-synced check and the parked-refund skip live in syncWcRefund now, scoped to
    // the resolved IMS order id. An externalId-only pre-skip HERE (the sweep has only the WC order id) would
    // repeat the cross-order leak — a refund/park owned by another order would wrongly skip this one.
    // syncWcRefund is idempotent for an already-synced or parked refund, so it is the single scoped authority.
    const result = await syncWcRefund(externalOrderId, refund)
    if (result.success) synced++
  }

  return synced
}
