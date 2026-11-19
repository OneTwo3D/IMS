/**
 * WOOCOMMERCE ORDER AMENDMENTS: THE WRITE STEP (o3d-zvec.7, owner decisions 2026-11-18), BEHIND `wc_order_amendment_write_enabled` (OFF).
 *
 * The read-only divergence detection (order-divergence.ts) reports what WooCommerce shows that IMS does not. This step ACTS on part of it, under three rules the owner set:
 *
 *  (a) LATEST EDIT WINS, per line. An order nobody edited in IMS has WooCommerce as the only editor, so WooCommerce wins. An order edited in IMS (`editedInImsAt`) keeps the IMS
 *      value of a line unless WooCommerce changed THAT line since the IMS edit: the line differs from the WooCommerce-facing baseline IMS stored before its first edit
 *      (`wcLineBaseline`) AND the payload was modified after the IMS edit. Modified time alone is not proof (IMS's own status and note writes bump it), so a line WooCommerce
 *      never changed stays IMS's, and an order with an IMS edit but no baseline is never overwritten.
 *  (b) A REDUCTION ON A PAID ORDER GOES THROUGH THE REFUND PATH. The paid amount is never edited. The reduced units become an IMS refund (`createRefund`, the same entry the
 *      storefront refund sync uses), which writes the credit note, releases the reservation, raises the shop-refund task and, for an order the warehouse holds, the refund note.
 *      Only UNSHIPPED units are reduced this way; a reduction that would reach shipped units is left on the divergence list for a person.
 *  (c) NOTHING FLOWS TO THE WAREHOUSE ONCE PICKING HAS STARTED. An order that is PICKING / PACKING in IMS, or whose warehouse order is no longer open for changes (the SAME gate an
 *      IMS edit asks), gets an operator task (WC_EDIT_AFTER_PICKING) naming what WooCommerce now shows. IMS sends nothing and changes nothing.
 *
 * WHAT IS NOT DONE (stays on the divergence list for a person): any change on an UNPAID order, an increase, a price change, an added line, shipping, discount and tax. Rewriting lines
 * and money in IMS from a payload would re-price the order by IMS's rounding and keep disagreeing with WooCommerce's own figures; that needs its own design. The IMS-to-WooCommerce
 * direction (writing an IMS edit back as order lines) is likewise not built: it needs its own echo guard that cannot swallow refunds (the o3d-uxv lesson).
 *
 * ONE ACTION PER SET OF DIFFERENCES: the divergence row carries `amendmentClaim` (the fingerprint of the differences), claimed with a conditional update before anything is written, so two
 * racing deliveries cannot both refund the same units. A failed refund releases the claim so the next delivery retries.
 */
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { INTERNAL_ACTION_BYPASS } from '@/lib/internal-action-bypass'
import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import { raiseWmsOperatorTask, warehouseOrderRef, wcEditAfterPickingQuery } from '@/lib/domain/wms/operator-tasks'
import { resolveOrderEditWmsGate } from '@/lib/domain/sales/order-edit-wms-gate'
import type { RefundRequestLine } from '@/lib/domain/sales/refund-service'
import { parseWcGmtInstant } from './receipt-settlement-rate'
import type { DivergenceDifference } from './order-divergence'
import type { WcFullOrder } from './types'

export const WC_ORDER_AMENDMENT_WRITE_SETTING = 'wc_order_amendment_write_enabled'
const QTY_EPS = toDecimal('0.0001')
const NO_PICKING_YET = new Set(['PENDING_PAYMENT', 'ON_HOLD', 'PROCESSING', 'ALLOCATED'])
const PICKING_STARTED = new Set(['PICKING', 'PACKING'])

export type AmendmentLine = {
  id: string
  externalLineItemId: number | null
  productId: string | null
  sku: string | null
  description: string
  qty: unknown
  totalForeign: unknown
  totalBase: unknown
}

export type AmendmentFacts = {
  orderNumber: string | null
  status: string
  paidAt: Date | null
  editedInImsAt: Date | null
  /** The WooCommerce-facing lines before IMS's first edit (SalesOrder.wcLineBaseline), or null. */
  baselineQtyByExternalLineId: ReadonlyMap<number, number> | null
  lines: ReadonlyArray<AmendmentLine>
  refundedQtyByLineId: ReadonlyMap<string, unknown>
  shippedQtyByLineId: ReadonlyMap<string, unknown>
}

export type PlannedReduction = { lineId: string; qty: number; productId: string | null; description: string; totalForeign: number; totalBase: number }

export type AmendmentPlan = {
  /** Units to take off through the refund path (paid orders only). */
  reductions: PlannedReduction[]
  /** Human text of every difference left for a person, and why. */
  leftForPerson: string[]
  /** Lines where the IMS value stands because IMS edited later. */
  imsWins: string[]
  /** What WooCommerce now shows for the changes the step does NOT apply (the refund path covers the rest): what the after-picking task tells the warehouse. */
  wcChanges: string[]
}

function round4(value: Decimal): number {
  return value.toDecimalPlaces(4).toNumber()
}

/** Latest edit wins, for one line: may the WooCommerce value replace the IMS one? */
function wcWinsLine(facts: AmendmentFacts, line: AmendmentLine, wcQty: number, wcModifiedAt: Date | null): boolean {
  if (facts.editedInImsAt === null) return true
  if (!facts.baselineQtyByExternalLineId || line.externalLineItemId === null) return false
  const baseline = facts.baselineQtyByExternalLineId.get(line.externalLineItemId)
  if (baseline === undefined) return false
  if (Math.abs(baseline - wcQty) < 0.0001) return false // WooCommerce never changed this line since IMS's edit: the IMS value stands
  return wcModifiedAt !== null && wcModifiedAt.getTime() > facts.editedInImsAt.getTime()
}

/** Pure: what the write step would do. */
export function planWcOrderAmendment(wcOrder: Pick<WcFullOrder, 'line_items' | 'date_modified_gmt' | 'date_modified'>, differences: ReadonlyArray<DivergenceDifference>, facts: AmendmentFacts): AmendmentPlan {
  const plan: AmendmentPlan = { reductions: [], leftForPerson: [], imsWins: [], wcChanges: [] }
  const modified = (wcOrder.date_modified_gmt || wcOrder.date_modified) ? parseWcGmtInstant(String(wcOrder.date_modified_gmt || wcOrder.date_modified)) : null
  const wcModifiedAt = modified && !Number.isNaN(modified.getTime()) ? modified : null
  const wcQtyByLineId = new Map<number, number>()
  for (const item of (Array.isArray(wcOrder.line_items) ? wcOrder.line_items : []) as Array<{ id?: unknown; quantity?: unknown }>) {
    if (typeof item?.id === 'number' && typeof item.quantity === 'number') wcQtyByLineId.set(item.id, (wcQtyByLineId.get(item.id) ?? 0) + item.quantity)
  }
  const paid = facts.paidAt !== null

  const reducedLineIds = new Set<string>()
  for (const line of facts.lines) {
    if (line.externalLineItemId === null) continue
    const wcQty = wcQtyByLineId.get(line.externalLineItemId) ?? 0 // a line WooCommerce no longer has is a reduction to zero
    const imsQty = toDecimal(line.qty as never)
    if (imsQty.minus(wcQty).lte(QTY_EPS)) continue // not a reduction (equal, or an increase: not acted on)
    const label = `${line.sku ?? 'no SKU'}: WooCommerce ${wcQty}, IMS ${imsQty.toString()}`
    if (!wcWinsLine(facts, line, wcQty, wcModifiedAt)) {
      plan.imsWins.push(label)
      continue
    }
    if (!paid) {
      plan.leftForPerson.push(`${label} (order not paid: IMS does not rewrite the lines of an unpaid order from WooCommerce)`)
      plan.wcChanges.push(`${line.sku ?? 'no SKU'} quantity is now ${wcQty}`)
      continue
    }
    const refunded = toDecimal((facts.refundedQtyByLineId.get(line.id) ?? 0) as never)
    const shipped = toDecimal((facts.shippedQtyByLineId.get(line.id) ?? 0) as never)
    const wanted = imsQty.minus(wcQty).minus(refunded) // units still to take off
    if (wanted.lte(QTY_EPS)) continue // a refund already explains it
    const unshipped = imsQty.minus(refunded).minus(shipped)
    const take = wanted.lt(unshipped) ? wanted : unshipped
    if (take.lt(wanted.minus(QTY_EPS))) {
      plan.leftForPerson.push(`${label} (${shipped.toString()} unit(s) already shipped: only unshipped units go through the refund path)`)
      plan.wcChanges.push(`${line.sku ?? 'no SKU'} quantity is now ${wcQty}`)
    }
    if (take.lte(QTY_EPS)) continue
    const unitNet = toDecimal(line.totalForeign as never).div(imsQty)
    const unitBase = toDecimal(line.totalBase as never).div(imsQty)
    plan.reductions.push({
      lineId: line.id, qty: take.toNumber(), productId: line.productId, description: line.description || 'Order reduced in WooCommerce',
      totalForeign: round4(unitNet.times(take)), totalBase: round4(unitBase.times(take)),
    })
    reducedLineIds.add(line.id)
  }
  // Everything the plan neither refunds nor deliberately leaves to IMS stays on the divergence list, named.
  for (const diff of differences) {
    if (diff.field === 'LINE_QUANTITY' || diff.field === 'LINE_REMOVED') continue
    plan.leftForPerson.push(`${diff.label}: WooCommerce ${diff.woocommerce}, IMS ${diff.ims}`)
    if (diff.field === 'LINE_ADDED' || diff.field === 'LINE_PRODUCT') plan.wcChanges.push(`${diff.label}: WooCommerce ${diff.woocommerce}`)
  }
  return plan
}

export type AmendmentDeps = {
  isEnabled(): Promise<boolean>
  loadFacts(orderId: string): Promise<AmendmentFacts | null>
  /** Claim the differences (true when this call took the claim). */
  claim(orderId: string, fingerprint: string): Promise<boolean>
  releaseClaim(orderId: string, fingerprint: string): Promise<void>
  warehouseGate(orderId: string): Promise<{ ok: true; externalOrderId: string | null } | { ok: false; externalOrderId: string | null }>
  warehouseLink(orderId: string): Promise<{ connector: string; externalOrderId: string; externalOrderNumber: string | null } | null>
  createRefund(orderId: string, lines: RefundRequestLine[], reason: string): Promise<{ success: boolean; error?: string }>
  raiseTask(task: Parameters<typeof raiseWmsOperatorTask>[1]): Promise<boolean>
  log(entry: { orderId: string; level: 'INFO' | 'WARNING'; action: string; description: string; metadata?: Record<string, unknown> }): Promise<void>
}

export const defaultAmendmentDeps: AmendmentDeps = {
  async isEnabled() {
    const row = await db.setting.findUnique({ where: { key: WC_ORDER_AMENDMENT_WRITE_SETTING }, select: { value: true } })
    return row?.value === 'true'
  },
  async loadFacts(orderId) {
    const order = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true, status: true, paidAt: true, editedInImsAt: true, wcLineBaseline: true, erasedAt: true, isQuote: true,
        lines: { select: { id: true, externalLineItemId: true, productId: true, sku: true, description: true, qty: true, totalForeign: true, totalBase: true } },
      },
    })
    if (!order || order.erasedAt || order.isQuote) return null
    const lineIds = order.lines.map((l) => l.id)
    const refundLines = await db.salesOrderRefundLine.findMany({ where: { salesOrderLineId: { in: lineIds } }, select: { salesOrderLineId: true, qty: true } })
    const refunded = new Map<string, unknown>()
    for (const row of refundLines) if (row.salesOrderLineId) refunded.set(row.salesOrderLineId, toDecimal(refunded.get(row.salesOrderLineId) as never ?? 0).plus(toDecimal(row.qty)))
    const shipRows = await db.shipmentLine.findMany({ where: { lineId: { in: lineIds }, shipment: { status: 'SHIPPED' } }, select: { lineId: true, qty: true } })
    const shipped = new Map<string, unknown>()
    for (const row of shipRows) shipped.set(row.lineId, toDecimal(shipped.get(row.lineId) as never ?? 0).plus(toDecimal(row.qty)))
    let baseline: Map<number, number> | null = null
    const raw = order.wcLineBaseline as { lines?: Array<{ externalLineItemId?: unknown; qty?: unknown }> } | null
    if (raw && Array.isArray(raw.lines)) {
      baseline = new Map()
      for (const entry of raw.lines) if (typeof entry.externalLineItemId === 'number' && typeof entry.qty === 'number') baseline.set(entry.externalLineItemId, entry.qty)
    }
    return {
      orderNumber: order.orderNumber, status: order.status, paidAt: order.paidAt, editedInImsAt: order.editedInImsAt,
      baselineQtyByExternalLineId: baseline, lines: order.lines, refundedQtyByLineId: refunded, shippedQtyByLineId: shipped,
    }
  },
  async claim(orderId, fingerprint) {
    const { count } = await db.wcOrderDivergence.updateMany({
      where: { orderId, resolvedAt: null, OR: [{ amendmentClaim: null }, { amendmentClaim: { not: fingerprint } }] },
      data: { amendmentClaim: fingerprint },
    })
    return count === 1
  },
  async releaseClaim(orderId, fingerprint) {
    await db.wcOrderDivergence.updateMany({ where: { orderId, amendmentClaim: fingerprint }, data: { amendmentClaim: null } })
  },
  async warehouseGate(orderId) {
    const gate = await resolveOrderEditWmsGate(orderId, 'lines')
    return gate.ok ? { ok: true, externalOrderId: gate.externalOrderId } : { ok: false, externalOrderId: null }
  },
  async warehouseLink(orderId) {
    const link = await db.wmsOrderPushLink.findUnique({ where: { orderId }, select: { connector: true, externalOrderId: true, externalOrderNumber: true } })
    return link?.externalOrderId ? { connector: link.connector, externalOrderId: link.externalOrderId, externalOrderNumber: link.externalOrderNumber } : null
  },
  async createRefund(orderId, lines, reason) {
    const { createRefund } = await import('@/app/actions/sales')
    return createRefund(orderId, lines, reason, undefined, { internalBypassToken: INTERNAL_ACTION_BYPASS, enforcePerTargetBalances: true })
  },
  async raiseTask(task) {
    return raiseWmsOperatorTask(db, task)
  },
  async log(entry) {
    await logActivity({ entityType: 'SALES_ORDER', entityId: entry.orderId, action: entry.action, tag: 'sync', level: entry.level, description: entry.description, metadata: entry.metadata, resolveUser: false })
  },
}

export type AmendmentOutcome =
  | { kind: 'off' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'applied'; refundedLines: number; taskRaised: boolean }
  | { kind: 'refund-failed'; error: string }

/**
 * Act on a divergence the detection just recorded. Never throws (the delivery's real work is committed); every outcome is returned for tests and logged.
 */
export async function applyWcOrderAmendment(orderId: string, wcOrder: WcFullOrder, differences: ReadonlyArray<DivergenceDifference>, fingerprint: string, deps: AmendmentDeps = defaultAmendmentDeps): Promise<AmendmentOutcome> {
  try {
    if (!(await deps.isEnabled())) return { kind: 'off' }
    const facts = await deps.loadFacts(orderId)
    if (!facts) return { kind: 'skipped', reason: 'the order is erased, a quote or gone' }
    if (!NO_PICKING_YET.has(facts.status) && !PICKING_STARTED.has(facts.status)) return { kind: 'skipped', reason: `the order is ${facts.status}` }

    const plan = planWcOrderAmendment(wcOrder, differences, facts)
    if (plan.reductions.length === 0 && plan.wcChanges.length === 0) {
      return { kind: 'skipped', reason: plan.imsWins.length > 0 ? 'the IMS edit is the latest on every changed line' : 'nothing the write step acts on' }
    }
    // PICKING HAS STARTED when IMS says so, or when the warehouse order is no longer open for changes (the gate an IMS edit asks). The warehouse is asked only when there is something to tell it.
    let pickingStarted = PICKING_STARTED.has(facts.status)
    if (!pickingStarted && plan.wcChanges.length > 0 && (await deps.warehouseLink(orderId))) pickingStarted = !(await deps.warehouseGate(orderId)).ok
    const afterPicking = pickingStarted ? plan.wcChanges : []
    if (plan.reductions.length === 0 && afterPicking.length === 0) return { kind: 'skipped', reason: 'the changes are left for a person and the warehouse has not started on the order' }

    if (!(await deps.claim(orderId, fingerprint))) return { kind: 'skipped', reason: 'these differences were already acted on' }

    let refundedLines = 0
    if (plan.reductions.length > 0) {
      const lines: RefundRequestLine[] = plan.reductions.map((r) => ({
        lineId: r.lineId, productId: r.productId, description: r.description, qty: r.qty, totalForeign: r.totalForeign, totalBase: r.totalBase, lineKind: 'sale',
      }))
      const result = await deps.createRefund(orderId, lines, 'Order reduced in WooCommerce after payment (IMS amendment, latest edit wins)')
      if (!result.success) {
        await deps.releaseClaim(orderId, fingerprint)
        await deps.log({ orderId, level: 'WARNING', action: 'wc_order_amendment_refund_failed', description: `IMS could not record the refund for the quantity reduced in WooCommerce: ${result.error ?? 'unknown reason'}. Nothing was changed; the next delivery retries.` })
        return { kind: 'refund-failed', error: result.error ?? 'unknown reason' }
      }
      refundedLines = lines.length
      await deps.log({ orderId, level: 'INFO', action: 'wc_order_amendment_refunded', description: `A paid order was reduced in WooCommerce. IMS recorded the reduction through the refund path (${lines.map((l) => `${l.qty} unit(s)`).join(', ')}); the paid amount was not edited.`, metadata: { lines: plan.reductions } })
    }

    let taskRaised = false
    if (afterPicking.length > 0) {
      const link = await deps.warehouseLink(orderId)
      if (link) {
        taskRaised = await deps.raiseTask({
          connector: link.connector,
          orderId,
          externalOrderId: link.externalOrderId,
          reason: 'WC_EDIT_AFTER_PICKING',
          queryText: wcEditAfterPickingQuery(warehouseOrderRef(link.externalOrderNumber, link.externalOrderId), facts.orderNumber ?? orderId, afterPicking),
          payload: { orderNumber: facts.orderNumber, externalOrderNumber: link.externalOrderNumber },
          dedupeBasis: `wc-edit:${fingerprint}`,
        })
      }
      await deps.log({ orderId, level: 'WARNING', action: 'wc_order_amendment_after_picking', description: `The order was edited in WooCommerce after the warehouse started picking it. IMS sent nothing to the warehouse${link ? ' and raised an operator task' : ' (there is no warehouse order)'}.`, metadata: { changes: afterPicking } })
    }
    return { kind: 'applied', refundedLines, taskRaised }
  } catch (error) {
    console.error('wc_order_amendment: could not apply', error instanceof Error ? error.constructor.name : typeof error)
    return { kind: 'skipped', reason: 'an error (logged)' }
  }
}
