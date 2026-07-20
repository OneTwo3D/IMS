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

/** Rounding tolerance when reconciling order tax against the sum of its line tax. */
const TAX_RECONCILE_EPSILON = 0.01

/**
 * Is this order taxed uniformly enough that a bare monetary amount can be split into net + VAT?
 *
 * All three are required (o3d-w00), and anything unproven fails CLOSED:
 *  1. the lines account for the ENTIRE order gross — no shipping/discount value with its own (possibly
 *     zero) tax treatment sitting outside them;
 *  2. every line carries the SAME EXPLICIT tax rate — a null taxRateId is ignorance, not uniformity; and
 *  3. the order's tax reconciles to the lines' tax.
 * A wholly untaxed order that satisfies (1) trivially qualifies: the ratio is 1, so normalising is a no-op.
 */
function isUniformlyTaxedOrder(
  lines: Array<{ taxRateId: string | null; taxBase: DecimalInput; totalBase: DecimalInput; taxRate: { name: string } | null }>,
  orderTax: ReturnType<typeof toDecimal>,
  orderGross: ReturnType<typeof toDecimal>,
  orderTaxRateName: string | null,
): boolean {
  const lineTaxTotal = lines.reduce((sum, line) => sum.add(toDecimal(line.taxBase)), toDecimal(0))
  // Order lines store NET, so their net + their tax must account for the ENTIRE order gross. Any value
  // left over is something charged outside the lines — shipping, a discount — whose own tax treatment we
  // cannot see here. Crucially this catches ZERO-RATED extras too: £120 taxable goods plus £10 zero-rated
  // shipping leaves orderTax equal to the line tax (a false proof of uniformity), yet the goods:gross
  // ratio it implies would post a £130 refund as £110 net that the 20% credit-note type re-grosses to
  // £132. Reconciling the gross is what makes "uniform" mean uniform across the whole order.
  const lineGrossTotal = lines.reduce(
    (sum, line) => sum.add(toDecimal(line.totalBase)).add(toDecimal(line.taxBase)),
    toDecimal(0),
  )
  if (orderGross.sub(lineGrossTotal).abs().gt(TAX_RECONCILE_EPSILON)) return false
  // The credit note posts this line under the tax type resolved from the ORDER's taxRateName, not from
  // the lines we just validated — and those can legitimately differ (zero-rated lines under a standard
  // order default; a reverse-charge order whose per-line swap an unmapped line would lose). If they do
  // not name the SAME rate, the amount we store would be grossed up under a rate we never proved, so
  // refuse rather than post a wrong credit.
  if (lines.some((line) => (line.taxRate?.name ?? null) !== orderTaxRateName)) return false
  // A wholly untaxed order is then safe — the ratio is 1, so normalising is a no-op.
  if (orderTax.abs().lte(TAX_RECONCILE_EPSILON) && lineTaxTotal.abs().lte(TAX_RECONCILE_EPSILON)) return true
  if (lines.length === 0) return false
  // FAIL CLOSED on an unmapped rate. A null taxRateId means we do not know what rate applies, and Woo
  // can retain a monetary tax amount on a line whose rate never mapped — so several null-rate lines are
  // NOT evidence of one rate, they are evidence of ignorance. Anything taxed must be explicit.
  if (lines.some((line) => line.taxRateId === null)) return false
  if (new Set(lines.map((line) => line.taxRateId)).size > 1) return false
  return orderTax.sub(lineTaxTotal).abs().lte(TAX_RECONCILE_EPSILON)
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
        // taxBase is needed to normalise a monetary-only refund to the NET basis (see below).
        taxBase: true,
        // The credit note resolves an unmapped line's tax type from THIS name, so it must match the
        // lines' own rate or the amount we store would be grossed up under a different rate.
        taxRateName: true,
        // taxRateId + per-line taxBase let us prove the order is UNIFORMLY taxed before inferring the
        // VAT split of a monetary-only refund (see below).
        lines: { select: { id: true, productId: true, externalLineItemId: true, description: true, qty: true, totalBase: true, taxRateId: true, taxBase: true, taxRate: { select: { name: true } } } },
      },
    })
    if (!so) return { success: false, error: `IMS order not found for WC order ${externalOrderId}` }

    // Check if already processed
    const existing = await client.salesOrderRefund.findFirst({ where: { externalRefundId: wcRefund.id } })
    if (existing) return { success: true } // already synced

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
      // Monetary-only refund (a goodwill amount with no line/shipping breakdown). wcRefund.amount is the
      // money actually returned to the customer, i.e. TAX-INCLUSIVE. Refund lines are stored NET
      // everywhere else (the line/shipping branches above store the ex-tax `total`, accumulating tax only
      // into mappedGrossForeign), and the credit note re-applies VAT via taxType with
      // lineAmountsIncludeTax: false. Storing the gross here therefore broke two things at once:
      //   - the refund basis was inconsistent BETWEEN refunds on one order, so the disposition /
      //     over-refund maths could not use a single canonical total (o3d-w00);
      //   - the credit note grossed the already-gross amount up AGAIN — a £120 monetary refund on a
      //     20% order posted £120 + £24 VAT = £144, crediting VAT that was never charged.
      // Normalise to NET using the order's own goods:gross proportion — but ONLY when the order is
      // unambiguously taxed at a SINGLE rate, because a bare amount carries no VAT breakdown and the
      // credit note posts an unmapped line under ONE order-level taxType (sales.ts fallbackCnTaxType).
      // On a mixed-rate order (say £100 @20% + £100 zero-rated) a blended ratio is simply wrong: it
      // would turn a £110 refund into a £100 net line that the credit note re-grosses at 20% to £120,
      // and the split it assumed would depend on which refund happened to be recorded first. Nothing in
      // the payload can resolve that, so refuse and let a human refund against specific lines.
      const orderGross = toDecimal(so.totalBase)
      const orderTax = toDecimal(so.taxBase)
      const orderNet = orderGross.sub(orderTax)
      if (!isUniformlyTaxedOrder(so.lines, orderTax, orderGross, so.taxRateName ?? null)) {
        // NOTE the wording: this money has ALREADY been returned to the customer in WooCommerce. Telling
        // an operator to "re-issue the refund" would have them pay twice. The refund must instead be
        // recorded in the IMS against specific lines so its VAT split is explicit, quoting the Woo refund
        // id below so the two can be reconciled. (A first-class manual-resolution path that preserves
        // externalRefundId is tracked separately.)
        const error =
          `WooCommerce refund ${wcRefund.id} is monetary-only (no line breakdown) and this order's tax ` +
          `treatment is not uniform, so its VAT split cannot be determined safely. DO NOT issue another ` +
          `WooCommerce refund — the customer has already been paid. Record this refund in the IMS ` +
          `against the specific lines it covers, referencing Woo refund ${wcRefund.id}.`
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
        return { success: false, error }
      }
      const netRatio = orderGross.gt(0) && orderNet.gt(0) ? orderNet.div(orderGross) : toDecimal(1)
      const netAmountForeign = refundAmountForeign.mul(netRatio)
      refundLines.push({
        productId: null,
        description: wcRefund.reason || 'WooCommerce refund',
        qty: 0,
        totalForeign: roundDecimalNumber(netAmountForeign, 4),
        totalBase: divideRoundedNumber(netAmountForeign, fxRate, 4),
        lineKind: 'sale',
      })
      // The mapped GROSS still equals the full refunded amount — that is what the amount-mismatch check
      // below reconciles against, exactly as the line-based branches do (net line + tax into the gross).
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

    if (!result.success) {
      await client.shoppingSyncLog.create({
        data: {
          direction: 'FROM_CONNECTOR',
          status: 'FAILED',
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

    const result = await syncWcRefund(externalOrderId, refund)
    if (result.success) synced++
  }

  return synced
}
