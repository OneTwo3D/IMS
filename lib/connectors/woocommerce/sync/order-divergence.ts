/**
 * WOOCOMMERCE-VS-IMS ORDER DIVERGENCE: DETECT AND REPORT, WRITE NOTHING TO THE ORDER (the read-only first step of the order-amendment design).
 *
 * The update path of `importWcOrder` refreshes six fields of an order IMS already holds and never rebuilds its lines or money. A quantity, price,
 * shipping, discount or tax edited in WooCommerce after import therefore leaves IMS invoicing and the warehouse picking the original. The older
 * edit-drift row (order-edit-drift.ts) notices a changed quantity or total; this compares the rest as well (unit prices, added and removed lines,
 * shipping, discount, tax) and does it against refunds, so a refund is never reported as an edit.
 *
 * WHAT IT NEVER DOES (the detection itself; the separate write step in order-amendment.ts is behind `wc_order_amendment_write_enabled`, off by default)
 *   - It writes to `wc_order_divergences` only. Not to the order (so `SalesOrder.updatedAt` never moves and the order never becomes a warehouse
 *     amend candidate), not to WooCommerce, not to the warehouse, not to the ledger.
 *   - It does not touch status handling, the echo guard or the refund sync. It runs after the existing update, behind a setting that is OFF by default,
 *     and a failure of any kind is caught and logged: it can never fail or delay the delivery whose real work already committed.
 *
 * THE COMPARISON BASIS (decided once, here)
 *   WooCommerce side: the order.updated payload. IMS side: the stored order and lines, minus what IMS has ALREADY recorded as refunded.
 *   Every figure is the amount EXCLUDING tax unless named otherwise, in the order's own currency, compared in exact decimal.
 *     lines      matched on the WooCommerce line id: quantity, SKU, unit price ex-tax (payload subtotal / quantity, which is what the importer stored),
 *                plus lines only one side has.
 *     shipping   payload `shipping_total`                   vs `shippingForeign`
 *     discount   payload `discount_total`                   vs the sum of the line discounts plus the order-level discount
 *     tax        payload `total_tax`                        vs `taxForeign`
 *     total      payload `total` (tax included)             vs `totalForeign`
 *
 * NET OF REFUNDS (the double-counting hazard). A line a customer returns or a shop removes is usually a refund, which already flows through the
 * refund sync and already reversed its cost of goods. Reporting the same event as an edit as well would be a second signal for one fact. So a
 * quantity (or a whole line) that WooCommerce shows LOWER than IMS is explained, and not reported, when the IMS refund lines recorded for that line
 * account for the whole of the gap; the same share of that line's net, tax and discount is then taken out of the IMS-side order figures before they
 * are compared. WooCommerce's own `total`, `total_tax` and `discount_total` are never reduced by a refund, and neither are IMS's stored figures, so a
 * refund on its own moves neither side. A refund the payload names that IMS has not recorded yet is the one case where the comparison cannot be made
 * safely (the refund sync runs after the import in the same delivery): detection is DEFERRED for that delivery and the next delivery or poll compares.
 *
 * TOLERANCE. Half a minor unit of the order currency (`ledgerMatchEpsilon`: 0.005 in a two-decimal currency), strictly below one minor unit, so a
 * genuine one-penny difference is reported and storage rounding (IMS keeps four decimals, a unit price six) is not. When a line was only PARTLY
 * explained by a refund its share of tax and discount is pro rata and the order-level tolerance is widened to one whole minor unit for that comparison.
 * Quantities are compared to 0.0001 (the stored precision).
 *
 * NOT COMPARED (so nothing is guessed): an order in another currency than the payload (the paid-block row carries that), a cancelled or erased order,
 * the discount when the order carries store credit or its stored discount does not say it was allocated into the lines (older rows), and any figure the
 * payload does not state. Fee lines carry no WooCommerce line id and are compared only through the order figures.
 */

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import type { Prisma } from '@/app/generated/prisma/client'
import { logActivity } from '@/lib/activity-log'
import { currencyMinorUnits, ledgerMatchEpsilon, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import type { WcFullOrder } from './types'
import { applyWcOrderAmendment } from './order-amendment'

export const WC_ORDER_DIVERGENCE_SETTING = 'wc_order_divergence_detection_enabled'
export const WC_ORDER_DIVERGED_ACTION = 'wc_order_diverged'
/** The operator-facing name of the record (a label on the exceptions page and in the activity log). */
export const WC_ORDER_DIVERGED = 'WC_ORDER_DIVERGED'

const QTY_EPS = toDecimal('0.0001')

export type DivergenceField = 'LINE_QUANTITY' | 'LINE_PRICE' | 'LINE_PRODUCT' | 'LINE_ADDED' | 'LINE_REMOVED' | 'SHIPPING' | 'DISCOUNT' | 'TAX' | 'TOTAL'

/** One field-level difference. SKUs, quantities and amounts only (strings, already formatted); never customer data. */
export type DivergenceDifference = {
  field: DivergenceField
  /** What an operator reads, with the field named. */
  label: string
  woocommerce: string
  ims: string
}

export type StoredOrderForDivergence = {
  currency: string
  status: string
  erasedAt: Date | null
  shippingForeign: unknown
  taxForeign: unknown
  totalForeign: unknown
  discountAmount: unknown
  discountModel: string | null
  storeCreditForeign: unknown
  lines: ReadonlyArray<{
    id: string
    externalLineItemId: number | null
    sku: string | null
    qty: unknown
    unitPriceForeign: unknown
    discountAmount: unknown
    taxForeign: unknown
    totalForeign: unknown
  }>
}

export type RefundFactsForDivergence = {
  /** Storefront refund ids IMS has recorded for this order. */
  recordedExternalRefundIds: ReadonlyArray<number>
  /** Quantity IMS has recorded as refunded, per sales order line id. */
  refundedQtyByLineId: ReadonlyMap<string, unknown>
}

export type DivergenceVerdict =
  | { kind: 'compared'; differences: DivergenceDifference[] }
  /** Nothing was compared, and an open record must be left exactly as it is (a refund is still arriving). */
  | { kind: 'deferred'; reason: string }
  /** The order is not one this compares (ended, erased, another currency): an open record is closed. */
  | { kind: 'not-comparable'; reason: string }

function money(value: unknown): Decimal | null {
  if (value === undefined || value === null || String(value).trim() === '') return null
  try {
    return toDecimal(value as never)
  } catch {
    return null
  }
}

function fmt(value: Decimal, dp: number): string {
  return value.toDecimalPlaces(dp).toFixed(dp)
}

/** A unit price: the currency's own decimals, or four when it has more (a unit price is stored to six). */
function fmtUnit(value: Decimal, dp: number): string {
  const rounded = value.toDecimalPlaces(4)
  return rounded.decimalPlaces() <= dp ? rounded.toFixed(dp) : rounded.toFixed(4)
}

function fmtQty(value: Decimal): string {
  return value.toDecimalPlaces(4).toString()
}

function sku(value: string | null | undefined): string {
  const t = (value ?? '').trim()
  return t === '' ? 'no SKU' : t
}

/**
 * Pure: the differences between the payload and the stored order, net of the refunds IMS has recorded. See the file header for the basis.
 */
export function compareWcOrderWithIms(
  wcOrder: Pick<WcFullOrder, 'currency' | 'line_items' | 'shipping_total' | 'discount_total' | 'total_tax' | 'total'> & { refunds?: ReadonlyArray<{ id?: unknown }> },
  stored: StoredOrderForDivergence,
  refunds: RefundFactsForDivergence,
): DivergenceVerdict {
  if (stored.erasedAt) return { kind: 'not-comparable', reason: 'the order was erased' }
  if (stored.status === 'CANCELLED') return { kind: 'not-comparable', reason: 'the order is cancelled' }
  if (wcOrder.currency && wcOrder.currency !== stored.currency) return { kind: 'not-comparable', reason: 'the currencies differ' }

  const recorded = new Set(refunds.recordedExternalRefundIds)
  const pending = (Array.isArray(wcOrder.refunds) ? wcOrder.refunds : []).filter((r) => typeof r?.id === 'number' && !recorded.has(r.id))
  if (pending.length > 0) return { kind: 'deferred', reason: 'a refund on the WooCommerce order is not recorded in IMS yet' }

  const dp = currencyMinorUnits(stored.currency)
  const half = ledgerMatchEpsilon(stored.currency)
  const one = toDecimal(1).div(toDecimal(10).pow(dp))
  const differences: DivergenceDifference[] = []

  // The IMS-side order figures, reduced by whatever a refund explains (below).
  let imsTax = money(stored.taxForeign) ?? toDecimal(0)
  let imsTotal = money(stored.totalForeign) ?? toDecimal(0)
  let imsDiscount = (money(stored.discountAmount) ?? toDecimal(0))
  for (const line of stored.lines) imsDiscount = imsDiscount.plus(money(line.discountAmount) ?? 0)
  let partlyExplained = false

  type Agg = { sku: string; qty: Decimal; refunded: Decimal; extension: Decimal; tax: Decimal; net: Decimal; discount: Decimal }
  const ims = new Map<number, Agg>()
  for (const line of stored.lines) {
    if (line.externalLineItemId === null || line.externalLineItemId === undefined) continue
    const qty = money(line.qty) ?? toDecimal(0)
    const prior = ims.get(line.externalLineItemId)
    const refunded = money(refunds.refundedQtyByLineId.get(line.id)) ?? toDecimal(0)
    ims.set(line.externalLineItemId, {
      sku: prior?.sku && prior.sku.trim() !== '' ? prior.sku : (line.sku ?? ''),
      qty: (prior?.qty ?? toDecimal(0)).plus(qty),
      refunded: (prior?.refunded ?? toDecimal(0)).plus(refunded),
      extension: (prior?.extension ?? toDecimal(0)).plus(qty.times(money(line.unitPriceForeign) ?? 0)),
      tax: (prior?.tax ?? toDecimal(0)).plus(money(line.taxForeign) ?? 0),
      net: (prior?.net ?? toDecimal(0)).plus(money(line.totalForeign) ?? 0),
      discount: (prior?.discount ?? toDecimal(0)).plus(money(line.discountAmount) ?? 0),
    })
  }

  const wc = new Map<number, { sku: string; qty: Decimal; subtotal: Decimal | null }>()
  if (Array.isArray(wcOrder.line_items)) {
    for (const item of wcOrder.line_items as Array<{ id?: unknown; quantity?: unknown; sku?: unknown; subtotal?: unknown }>) {
      if (typeof item?.id !== 'number' || typeof item.quantity !== 'number') continue
      const prior = wc.get(item.id)
      const subtotal = money(item.subtotal)
      wc.set(item.id, {
        sku: typeof item.sku === 'string' && item.sku.trim() !== '' ? item.sku : (prior?.sku ?? ''),
        qty: (prior?.qty ?? toDecimal(0)).plus(item.quantity),
        subtotal: prior?.subtotal != null && subtotal !== null ? prior.subtotal.plus(subtotal) : (prior?.subtotal ?? subtotal),
      })
    }
    const ids = [...new Set([...wc.keys(), ...ims.keys()])].sort((a, b) => a - b)
    for (const id of ids) {
      const w = wc.get(id)
      const i = ims.get(id)
      if (w && !i) {
        const unit = w.subtotal !== null && w.qty.gt(0) ? w.subtotal.div(w.qty) : null
        differences.push({
          field: 'LINE_ADDED',
          label: `Item ${sku(w.sku)} was added in WooCommerce`,
          woocommerce: `${fmtQty(w.qty)} x ${sku(w.sku)}${unit ? ` at ${fmtUnit(unit, dp)} each` : ''}`,
          ims: 'not on the order',
        })
        continue
      }
      if (!w && i) {
        if (i.refunded.gte(i.qty.minus(QTY_EPS))) {
          // The whole line is gone from WooCommerce and IMS has refunded all of it: one event, already handled by the refund.
          imsTax = imsTax.minus(i.tax)
          imsTotal = imsTotal.minus(i.net).minus(i.tax)
          imsDiscount = imsDiscount.minus(i.discount)
          continue
        }
        differences.push({
          field: 'LINE_REMOVED',
          label: `Item ${sku(i.sku)} was removed in WooCommerce`,
          woocommerce: 'not on the order',
          ims: `${fmtQty(i.qty)} x ${sku(i.sku)}`,
        })
        continue
      }
      if (!w || !i) continue

      if (i.sku.trim() !== '' && w.sku.trim() !== '' && i.sku.trim().toLowerCase() !== w.sku.trim().toLowerCase()) {
        differences.push({ field: 'LINE_PRODUCT', label: `Item on line ${id} was changed to another product`, woocommerce: sku(w.sku), ims: sku(i.sku) })
      }

      if (w.qty.minus(i.qty).abs().gt(QTY_EPS)) {
        const gap = i.qty.minus(w.qty)
        if (gap.gt(0) && i.refunded.gt(0) && gap.minus(i.refunded).abs().lte(QTY_EPS)) {
          // WooCommerce shows fewer than IMS holds and IMS has refunded exactly that many: the refund is the explanation, not an edit.
          const share = gap.div(i.qty)
          if (share.lt(1)) partlyExplained = true
          imsTax = imsTax.minus(i.tax.times(share))
          imsTotal = imsTotal.minus(i.net.plus(i.tax).times(share))
          imsDiscount = imsDiscount.minus(i.discount.times(share))
        } else {
          differences.push({
            field: 'LINE_QUANTITY',
            label: `Quantity of ${sku(w.sku || i.sku)} changed in WooCommerce`,
            woocommerce: fmtQty(w.qty),
            ims: fmtQty(i.qty),
          })
        }
      }

      if (w.subtotal !== null && w.qty.gt(0) && i.qty.gt(0)) {
        const imsUnit = i.extension.div(i.qty)
        const wcUnit = w.subtotal.div(w.qty)
        // The extension at WooCommerce's quantity, so a rounded unit price and a changed quantity do not look like a price change.
        if (w.subtotal.minus(imsUnit.times(w.qty)).abs().gt(half)) {
          differences.push({
            field: 'LINE_PRICE',
            label: `Unit price (excluding tax) of ${sku(w.sku || i.sku)} changed in WooCommerce`,
            woocommerce: fmtUnit(wcUnit, dp),
            ims: fmtUnit(imsUnit, dp),
          })
        }
      }
    }
  }

  const tol = partlyExplained ? one : half
  const compare = (field: DivergenceField, label: string, wcValue: unknown, imsValue: Decimal, tolerance: Decimal) => {
    const w = money(wcValue)
    if (w === null) return // the payload states nothing: nothing to compare
    if (w.minus(imsValue).abs().gt(tolerance)) differences.push({ field, label, woocommerce: fmt(w, dp), ims: fmt(imsValue, dp) })
  }

  compare('SHIPPING', 'Shipping (excluding tax) changed in WooCommerce', wcOrder.shipping_total, money(stored.shippingForeign) ?? toDecimal(0), half)
  const storeCredit = money(stored.storeCreditForeign) ?? toDecimal(0)
  if (stored.discountModel === 'LINE_ALLOCATED' && storeCredit.eq(0)) {
    compare('DISCOUNT', 'Discount (excluding tax) changed in WooCommerce', wcOrder.discount_total, imsDiscount, tol)
  }
  compare('TAX', 'Tax total changed in WooCommerce', wcOrder.total_tax, imsTax, tol)
  compare('TOTAL', 'Order total (including tax) changed in WooCommerce', wcOrder.total, imsTotal, tol)

  return { kind: 'compared', differences }
}

/** The order of the differences is stable, so the same difference seen again hashes the same. */
export function divergenceFingerprint(differences: ReadonlyArray<DivergenceDifference>): string {
  return createHash('sha256').update(JSON.stringify(differences)).digest('hex').slice(0, 40)
}

/** One readable sentence per difference, e.g. "Quantity of RED-M changed in WooCommerce: WooCommerce 3, IMS 2". */
export function describeDivergence(differences: ReadonlyArray<DivergenceDifference>, currency: string): string {
  return differences.map((d) => {
    const moneyField = d.field === 'LINE_PRICE' || d.field === 'SHIPPING' || d.field === 'DISCOUNT' || d.field === 'TAX' || d.field === 'TOTAL'
    return `${d.label}: WooCommerce ${d.woocommerce}${moneyField ? ` ${currency}` : ''}, IMS ${d.ims}${moneyField ? ` ${currency}` : ''}`
  }).join('; ')
}

/**
 * DEFERRED COMPARISONS AWAITING A REFUND. A delivery whose payload names a refund IMS has not recorded yet is deferred (above): the comparison cannot be made safely until the refund sync has run.
 * The deferral is PERSISTED (`wc_order_divergence_rechecks`, one row per order, removed by any later comparison that completes), so it survives a restart and is the same in every mode:
 *   - the refund sweep of a webhook / reconcile run repeats the comparison straight away (`rerunDeferredWcOrderDivergence`, same payload);
 *   - the ordinary poll runs no refund sweep, so `drainDeferredWcOrderDivergences` (called by every order sweep, poll included) re-reads each deferred order live and compares again, a few per run;
 *   - a row that stays deferred (the refund never arrives) is dropped after `RECHECK_MAX_ATTEMPTS` attempts or `RECHECK_MAX_AGE_DAYS` days, so the table is bounded and nothing grows with the order history.
 *
 * NOTE (follow-up, deliberately not used here): PR #975 adds `sales_orders.edited_in_ims_at` and is not merged. Nothing in this module depends on that column. Once it has landed, the comparison could
 * use it to tell an IMS-side edit from a WooCommerce-side one; until then it must stay out of this file.
 */
export const RECHECK_MAX_ATTEMPTS = 20
export const RECHECK_MAX_AGE_DAYS = 14
export const RECHECK_PER_RUN = 25

export const divergenceSeams: { readLiveOrder?: (externalOrderId: string) => Promise<WcFullOrder | null> } = {}

async function readLiveOrder(externalOrderId: string): Promise<WcFullOrder | null> {
  if (divergenceSeams.readLiveOrder) return divergenceSeams.readLiveOrder(externalOrderId)
  try {
    const { wcFetch } = await import('../api')
    const { data, error } = await wcFetch(`/orders/${externalOrderId}`)
    if (error || !data || typeof data !== 'object' || !('status' in data)) return null
    return data as WcFullOrder
  } catch {
    return null
  }
}

/** Repeat a comparison that was deferred for an unrecorded refund. Call it after the refund sweep of the same delivery; a no-op for an order whose comparison was not deferred. Never throws. */
export async function rerunDeferredWcOrderDivergence(wcOrder: WcFullOrder): Promise<void> {
  try {
    const row = await db.wcOrderDivergenceRecheck.findFirst({ where: { externalOrderId: String(wcOrder.id) }, select: { orderId: true } })
    if (!row) return
    await surfaceWcOrderDivergence(row.orderId, wcOrder)
  } catch (e) {
    console.error('wc_order_divergence: could not repeat a deferred comparison', e instanceof Error ? e.constructor.name : typeof e)
  }
}

/**
 * Resolve deferred comparisons by a live read, for the runs that do not sweep refunds (the ordinary poll). Bounded per run, oldest first; a row that is still deferred counts an attempt and is dropped at the
 * attempt or age cap. Never throws.
 */
export async function drainDeferredWcOrderDivergences(limit: number = RECHECK_PER_RUN): Promise<{ examined: number; resolved: number; dropped: number }> {
  const out = { examined: 0, resolved: 0, dropped: 0 }
  try {
    if (!(await isWcOrderDivergenceDetectionEnabled())) {
      // Detection is off: nothing is owed, so nothing is kept.
      out.dropped = (await db.wcOrderDivergenceRecheck.deleteMany({})).count
      return out
    }
    const cutoff = new Date(Date.now() - RECHECK_MAX_AGE_DAYS * 86_400_000)
    out.dropped += (await db.wcOrderDivergenceRecheck.deleteMany({ where: { OR: [{ deferredAt: { lt: cutoff } }, { attempts: { gte: RECHECK_MAX_ATTEMPTS } }] } })).count
    const rows = await db.wcOrderDivergenceRecheck.findMany({ orderBy: { lastAttemptAt: 'asc' }, take: Math.max(1, limit) })
    for (const row of rows) {
      out.examined++
      await db.wcOrderDivergenceRecheck.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, lastAttemptAt: new Date() } })
      const live = await readLiveOrder(row.externalOrderId)
      if (!live) continue
      await surfaceWcOrderDivergence(row.orderId, live)
      if ((await db.wcOrderDivergenceRecheck.count({ where: { id: row.id } })) === 0) out.resolved++
    }
  } catch (e) {
    console.error('wc_order_divergence: could not drain deferred comparisons', e instanceof Error ? e.constructor.name : typeof e)
  }
  return out
}

export async function isWcOrderDivergenceDetectionEnabled(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: WC_ORDER_DIVERGENCE_SETTING }, select: { value: true } })
  return row?.value === 'true'
}

/**
 * Compare and record, behind the setting. Read-only against the order. Best effort by design: any failure is logged and swallowed, because the
 * delivery's real work (the six-field update, the paid step, the refunds) has already committed and nothing here may fail or delay it.
 */
export async function surfaceWcOrderDivergence(orderId: string, wcOrder: WcFullOrder): Promise<void> {
  try {
    if (!(await isWcOrderDivergenceDetectionEnabled())) return
    const stored = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        currency: true, status: true, erasedAt: true, shippingForeign: true, taxForeign: true, totalForeign: true, discountAmount: true, discountModel: true, storeCreditForeign: true,
        externalOrderNumber: true,
        lines: { select: { id: true, externalLineItemId: true, sku: true, qty: true, unitPriceForeign: true, discountAmount: true, taxForeign: true, totalForeign: true } },
      },
    })
    if (!stored) return
    const refundRows = await db.salesOrderRefund.findMany({
      where: { orderId },
      select: { externalRefundId: true, lines: { select: { salesOrderLineId: true, qty: true } } },
    })
    const refundedQtyByLineId = new Map<string, Decimal>()
    const recordedExternalRefundIds: number[] = []
    for (const refund of refundRows) {
      if (refund.externalRefundId !== null) recordedExternalRefundIds.push(refund.externalRefundId)
      for (const line of refund.lines) {
        if (!line.salesOrderLineId) continue
        refundedQtyByLineId.set(line.salesOrderLineId, (refundedQtyByLineId.get(line.salesOrderLineId) ?? toDecimal(0)).plus(toDecimal(line.qty)))
      }
    }
    const verdict = compareWcOrderWithIms(wcOrder, stored, { recordedExternalRefundIds, refundedQtyByLineId })
    if (verdict.kind === 'deferred') {
      // Remembered durably, so a run that sweeps no refunds (the poll) still repeats the comparison. A row already there keeps its age and attempt count.
      await db.wcOrderDivergenceRecheck.upsert({ where: { orderId }, create: { orderId, externalOrderId: String(wcOrder.id) }, update: {} })
      return
    }
    await db.wcOrderDivergenceRecheck.deleteMany({ where: { orderId } })
    const now = new Date()
    if (verdict.kind === 'not-comparable' || verdict.differences.length === 0) {
      await db.wcOrderDivergence.updateMany({
        where: { orderId, resolvedAt: null },
        data: { resolvedAt: now, resolution: verdict.kind === 'not-comparable' ? `Not compared: ${verdict.reason}.` : 'A later WooCommerce delivery matched the IMS order again.' },
      })
      return
    }
    const fingerprint = divergenceFingerprint(verdict.differences)
    const existing = await db.wcOrderDivergence.findUnique({ where: { orderId }, select: { id: true, fingerprint: true, resolvedAt: true } })
    if (existing && existing.resolvedAt === null && existing.fingerprint === fingerprint) {
      await db.wcOrderDivergence.update({ where: { id: existing.id }, data: { lastSeenAt: now, seenCount: { increment: 1 } } })
      // The write step (off by default) retries a difference it has not yet acted on (a failed refund released its claim); one already acted on is skipped by its claim.
      await applyWcOrderAmendment(orderId, wcOrder, verdict.differences, fingerprint)
      return
    }
    const data = {
      externalOrderId: String(wcOrder.id),
      externalOrderNumber: stored.externalOrderNumber ?? wcOrder.number ?? null,
      differences: verdict.differences as unknown as Prisma.InputJsonValue,
      fingerprint,
    }
    // A new difference (or a reopened one) is a new episode on the same row: the age restarts and the count starts again.
    await db.wcOrderDivergence.upsert({
      where: { orderId },
      create: { orderId, ...data },
      update: { ...data, seenCount: 1, firstSeenAt: now, lastSeenAt: now, resolvedAt: null, resolution: null, amendmentClaim: null },
    })
    await logActivity({
      entityType: 'SALES_ORDER',
      entityId: orderId,
      action: WC_ORDER_DIVERGED_ACTION,
      tag: 'sync',
      level: 'WARNING',
      description: `WooCommerce order ${wcOrder.number} no longer matches the IMS order. IMS has changed nothing (not the order, WooCommerce or the warehouse); it is listed under Sync > Exceptions for a person to decide. ${describeDivergence(verdict.differences, stored.currency)}`,
      metadata: { connector: 'woocommerce', externalOrderId: String(wcOrder.id), differences: verdict.differences },
      resolveUser: false,
    })
    // THE WRITE STEP, behind `wc_order_amendment_write_enabled` (off by default; order-amendment.ts). A no-op while it is off, and it never throws.
    await applyWcOrderAmendment(orderId, wcOrder, verdict.differences, fingerprint)
  } catch (e) {
    console.error('wc_order_divergence: could not compare or record', e instanceof Error ? e.constructor.name : typeof e)
  }
}
