/**
 * WOOCOMMERCE ORDER AMENDMENTS: THE WRITE STEP (o3d-zvec.7, owner decisions 2026-11-18), BEHIND `wc_order_amendment_write_enabled` (OFF).
 *
 * The read-only divergence detection (order-divergence.ts) reports what WooCommerce shows that IMS does not. This step ACTS on part of it, under three rules the owner set:
 *
 *  (a) LATEST EDIT WINS, per line. An order nobody edited in IMS has WooCommerce as the only editor, so WooCommerce wins. An order edited in IMS (`editedInImsAt`) keeps the IMS
 *      value of a line unless WooCommerce changed THAT line: the line differs from the WooCommerce-facing baseline IMS stored before its first edit (`wcLineBaseline`). The
 *      modified time is NOT used: IMS's own write-backs (status, notes, tracking) bump it, and the two clocks differ. An order with an IMS edit but no baseline is never overwritten.
 *  (b) A REDUCTION ON A PAID ORDER GOES THROUGH THE REFUND PATH. The paid amount is never edited. The reduced units become an IMS refund (`createRefund`, the same entry the
 *      storefront refund sync uses), which writes the credit note, releases the reservation, raises the shop-refund task and, for an order the warehouse holds, the refund note.
 *      Only UNSHIPPED units are reduced this way; a reduction that would reach shipped units is left on the divergence list for a person.
 *  (c) NOTHING FLOWS TO THE WAREHOUSE ONCE PICKING HAS STARTED, AND NOTHING IS REFUNDED THEN EITHER. An order that is PICKING / PACKING in IMS, or whose warehouse order is no longer open
 *      for changes (the SAME gate an IMS edit asks), gets an operator task (WC_EDIT_AFTER_PICKING) naming what WooCommerce now shows. The gate is asked BEFORE any refund (a reduction too, not
 *      only the changes the step does not apply), and a gate that cannot be read fails closed the same way. IMS sends nothing and refunds nothing.
 *
 * WHAT IS NOT DONE (stays on the divergence list for a person): any change on an UNPAID order, an increase, a price change, an added line, shipping, discount and tax. Rewriting lines
 * and money in IMS from a payload would re-price the order by IMS's rounding and keep disagreeing with WooCommerce's own figures; that needs its own design. The IMS-to-WooCommerce
 * direction (writing an IMS edit back as order lines) is likewise not built: it needs its own echo guard that cannot swallow refunds (the o3d-uxv lesson).
 *
 * ONE ACTION PER SET OF UNITS. The whole step for an order runs under a per-order lock (`withOrderLock`: a transaction-scoped advisory lock on the order id). It is NOT the order row lock:
 * createRefund takes that lock in its own transaction, so holding it here would wait on itself. Inside the lock the refunded quantities, the divergence row and the stale check are read
 * again, the refund delta is computed from those values, and the claim covers the units (fingerprint plus the planned units), so a delivery with a DIFFERENT fingerprint (the same reduction
 * plus a shipping change) finds the units already refunded and refunds nothing. The refund transaction re-checks, under the order row lock, that the line's refunded total plus this refund
 * does not exceed the reduction WooCommerce shows. A failed refund, or a throw after the claim was taken, releases the claim so the next delivery retries.
 *
 * A STALE delivery (older than the WooCommerce modified time already stored) is ignored by this step, as the core update ignores it for the fields it protects. A reduction that WooCommerce
 * later RESTORES leaves the refund standing (IMS refunds are never undone automatically): the step raises an operator task instead, so a person decides.
 */
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { WC_AMENDMENT_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'
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
/** The reason recorded on a refund this step creates: how a later run tells its own refunds from the shop's. */
export const WC_AMENDMENT_REFUND_REASON = 'Order reduced in WooCommerce after payment (IMS amendment, latest edit wins)'
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
  /** The part of `refundedQtyByLineId` that this step's own refunds account for. */
  amendmentRefundedQtyByLineId?: ReadonlyMap<string, unknown>
  shippedQtyByLineId: ReadonlyMap<string, unknown>
  /** The WooCommerce modified time already stored (the core update's stale-delivery reference), or null. */
  externalUpdatedAt?: Date | null
  /** The order-level discount (what the refund path reverses server-side for a public refund). Above zero, this step does not refund. */
  orderDiscount?: unknown
}

export type PlannedReduction = { lineId: string; qty: number; productId: string | null; description: string; totalForeign: number; totalBase: number }

/** The most the lines of one WooCommerce item may have refunded in all (what WooCommerce shows reduced), re-checked inside the refund transaction. */
export type RefundQtyCap = { lineIds: string[]; maxQty: number }

export type AmendmentPlan = {
  /** Units to take off through the refund path (paid orders only). */
  reductions: PlannedReduction[]
  /** Human text of every difference left for a person, and why. */
  leftForPerson: string[]
  /** Lines where the IMS value stands because IMS edited later. */
  imsWins: string[]
  /** What WooCommerce now shows for the changes the step does NOT apply (the refund path covers the rest): what the after-picking task tells the warehouse. */
  wcChanges: string[]
  /** What WooCommerce shows for each planned reduction: told to the warehouse instead of refunding when picking has started. */
  reductionChanges: string[]
  /** One cap per WooCommerce item that has a reduction. */
  caps: RefundQtyCap[]
  /** A reduction WooCommerce has since undone (it shows more units than IMS holds after this step's refunds): the refund stands, a person decides. */
  restores: string[]
}

function round4(value: Decimal): number {
  return value.toDecimalPlaces(4).toNumber()
}

/** Latest edit wins, for one WooCommerce item: may the WooCommerce value replace the IMS one? Baseline comparison only (no modified time: IMS's own write-backs bump it). */
function wcWinsLine(facts: AmendmentFacts, externalLineItemId: number, wcQty: number): boolean {
  if (facts.editedInImsAt === null) return true
  if (!facts.baselineQtyByExternalLineId) return false
  const baseline = facts.baselineQtyByExternalLineId.get(externalLineItemId)
  if (baseline === undefined) return false
  return Math.abs(baseline - wcQty) >= 0.0001 // WooCommerce never changed this line since IMS's edit: the IMS value stands
}

/** Pure: what the write step would do. */
export function planWcOrderAmendment(wcOrder: Pick<WcFullOrder, 'line_items'>, differences: ReadonlyArray<DivergenceDifference>, facts: AmendmentFacts): AmendmentPlan {
  const plan: AmendmentPlan = { reductions: [], leftForPerson: [], imsWins: [], wcChanges: [], reductionChanges: [], caps: [], restores: [] }
  const wcQtyByLineId = new Map<number, number>()
  for (const item of (Array.isArray(wcOrder.line_items) ? wcOrder.line_items : []) as Array<{ id?: unknown; quantity?: unknown }>) {
    if (typeof item?.id === 'number' && typeof item.quantity === 'number') wcQtyByLineId.set(item.id, (wcQtyByLineId.get(item.id) ?? 0) + item.quantity)
  }
  const paid = facts.paidAt !== null
  // IMS lines are added up per WooCommerce item id (the detection does the same): the reduction is spread over them.
  const groups = new Map<number, AmendmentLine[]>()
  for (const line of facts.lines) {
    if (line.externalLineItemId === null) continue
    groups.set(line.externalLineItemId, [...(groups.get(line.externalLineItemId) ?? []), line])
  }
  const num = (map: ReadonlyMap<string, unknown> | undefined, id: string) => toDecimal((map?.get(id) ?? 0) as never)

  for (const [externalId, lines] of groups) {
    const wcQty = wcQtyByLineId.get(externalId) ?? 0 // a line WooCommerce no longer has is a reduction to zero
    const imsQty = lines.reduce((sum, l) => sum.plus(toDecimal(l.qty as never)), toDecimal(0))
    const sku = lines[0]!.sku ?? 'no SKU'
    const refundedTotal = lines.reduce((sum, l) => sum.plus(num(facts.refundedQtyByLineId, l.id)), toDecimal(0))
    const amendRefunded = lines.reduce((sum, l) => sum.plus(num(facts.amendmentRefundedQtyByLineId, l.id)), toDecimal(0))
    if (imsQty.minus(wcQty).lte(QTY_EPS)) {
      // Not a reduction. WooCommerce showing MORE than IMS holds after this step's own refunds is a reduction it has undone: the refund stands and a person decides.
      if (amendRefunded.gt(QTY_EPS) && toDecimal(wcQty).minus(imsQty.minus(amendRefunded)).gt(QTY_EPS) && wcWinsLine(facts, externalId, wcQty)) {
        plan.restores.push(`${sku}: WooCommerce shows ${wcQty} again, IMS refunded ${amendRefunded.toString()} unit(s) of it after an earlier reduction`)
      }
      continue
    }
    const label = `${sku}: WooCommerce ${wcQty}, IMS ${imsQty.toString()}`
    if (!wcWinsLine(facts, externalId, wcQty)) {
      plan.imsWins.push(label)
      continue
    }
    if (!paid) {
      plan.leftForPerson.push(`${label} (order not paid: IMS does not rewrite the lines of an unpaid order from WooCommerce)`)
      plan.wcChanges.push(`${sku} quantity is now ${wcQty}`)
      continue
    }
    const wanted = imsQty.minus(wcQty).minus(refundedTotal) // units still to take off, over all the IMS lines of this item
    if (wanted.lte(QTY_EPS)) continue // a refund already explains it
    const room = lines.map((l) => {
      const free = toDecimal(l.qty as never).minus(num(facts.refundedQtyByLineId, l.id)).minus(num(facts.shippedQtyByLineId, l.id))
      return { line: l, free: free.gt(0) ? free : toDecimal(0) }
    })
    const unshipped = room.reduce((sum, r) => sum.plus(r.free), toDecimal(0))
    const take = wanted.lt(unshipped) ? wanted : unshipped
    if (take.lt(wanted.minus(QTY_EPS))) {
      const shipped = lines.reduce((sum, l) => sum.plus(num(facts.shippedQtyByLineId, l.id)), toDecimal(0))
      plan.leftForPerson.push(`${label} (${shipped.toString()} unit(s) already shipped: only unshipped units go through the refund path)`)
      plan.wcChanges.push(`${sku} quantity is now ${wcQty}`)
    }
    if (take.lte(QTY_EPS)) continue
    let left = take
    for (const { line, free } of room) {
      if (left.lte(QTY_EPS)) break
      const part = left.lt(free) ? left : free
      if (part.lte(QTY_EPS)) continue
      const lineQty = toDecimal(line.qty as never)
      plan.reductions.push({
        lineId: line.id, qty: part.toNumber(), productId: line.productId, description: line.description || 'Order reduced in WooCommerce',
        totalForeign: round4(toDecimal(line.totalForeign as never).div(lineQty).times(part)), totalBase: round4(toDecimal(line.totalBase as never).div(lineQty).times(part)),
      })
      left = left.minus(part)
    }
    plan.reductionChanges.push(`${sku} quantity is now ${wcQty}`)
    plan.caps.push({ lineIds: lines.map((l) => l.id), maxQty: imsQty.minus(wcQty).toNumber() })
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
  /** Run `fn` holding the per-order amendment lock (see the header). Everything that reads facts, claims and refunds runs inside it. */
  withOrderLock<T>(orderId: string, fn: () => Promise<T>): Promise<T>
  loadFacts(orderId: string): Promise<AmendmentFacts | null>
  /** Claim the differences for these units (true when this call took the claim). Refused when the divergence row is gone, resolved, or no longer carries this fingerprint. */
  claim(orderId: string, fingerprint: string, claimKey: string): Promise<boolean>
  releaseClaim(orderId: string, claimKey: string): Promise<void>
  warehouseGate(orderId: string): Promise<{ ok: true; externalOrderId: string | null } | { ok: false; externalOrderId: string | null }>
  warehouseLink(orderId: string): Promise<{ connector: string; externalOrderId: string; externalOrderNumber: string | null } | null>
  createRefund(orderId: string, lines: RefundRequestLine[], reason: string, caps: RefundQtyCap[]): Promise<{ success: boolean; error?: string }>
  raiseTask(task: Parameters<typeof raiseWmsOperatorTask>[1]): Promise<boolean>
  log(entry: { orderId: string; level: 'INFO' | 'WARNING'; action: string; description: string; metadata?: Record<string, unknown> }): Promise<void>
}

export const defaultAmendmentDeps: AmendmentDeps = {
  async isEnabled() {
    const row = await db.setting.findUnique({ where: { key: WC_ORDER_AMENDMENT_WRITE_SETTING }, select: { value: true } })
    return row?.value === 'true'
  },
  async withOrderLock(orderId, fn) {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WC_AMENDMENT_LOCK_NAMESPACE}::int, hashtext(${orderId}))`
      return fn()
    }, { timeout: 120_000, maxWait: 60_000 })
  },
  async loadFacts(orderId) {
    const order = await db.salesOrder.findUnique({
      where: { id: orderId },
      select: {
        orderNumber: true, status: true, paidAt: true, editedInImsAt: true, wcLineBaseline: true, erasedAt: true, isQuote: true, externalUpdatedAt: true, discountAmount: true,
        lines: { select: { id: true, externalLineItemId: true, productId: true, sku: true, description: true, qty: true, totalForeign: true, totalBase: true } },
      },
    })
    if (!order || order.erasedAt || order.isQuote) return null
    const lineIds = order.lines.map((l) => l.id)
    const refundLines = await db.salesOrderRefundLine.findMany({ where: { salesOrderLineId: { in: lineIds } }, select: { salesOrderLineId: true, qty: true, refund: { select: { reason: true } } } })
    const refunded = new Map<string, unknown>()
    const amendmentRefunded = new Map<string, unknown>()
    for (const row of refundLines) {
      if (!row.salesOrderLineId) continue
      refunded.set(row.salesOrderLineId, toDecimal(refunded.get(row.salesOrderLineId) as never ?? 0).plus(toDecimal(row.qty)))
      if (row.refund.reason === WC_AMENDMENT_REFUND_REASON) amendmentRefunded.set(row.salesOrderLineId, toDecimal(amendmentRefunded.get(row.salesOrderLineId) as never ?? 0).plus(toDecimal(row.qty)))
    }
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
      baselineQtyByExternalLineId: baseline, lines: order.lines, refundedQtyByLineId: refunded, amendmentRefundedQtyByLineId: amendmentRefunded, shippedQtyByLineId: shipped,
      externalUpdatedAt: order.externalUpdatedAt, orderDiscount: order.discountAmount,
    }
  },
  async claim(orderId, fingerprint, claimKey) {
    const { count } = await db.wcOrderDivergence.updateMany({
      where: { orderId, resolvedAt: null, fingerprint, OR: [{ amendmentClaim: null }, { amendmentClaim: { not: claimKey } }] },
      data: { amendmentClaim: claimKey },
    })
    return count === 1
  },
  async releaseClaim(orderId, claimKey) {
    await db.wcOrderDivergence.updateMany({ where: { orderId, amendmentClaim: claimKey }, data: { amendmentClaim: null } })
  },
  async warehouseGate(orderId) {
    const gate = await resolveOrderEditWmsGate(orderId, 'lines')
    return gate.ok ? { ok: true, externalOrderId: gate.externalOrderId } : { ok: false, externalOrderId: null }
  },
  async warehouseLink(orderId) {
    const link = await db.wmsOrderPushLink.findUnique({ where: { orderId }, select: { connector: true, externalOrderId: true, externalOrderNumber: true } })
    return link?.externalOrderId ? { connector: link.connector, externalOrderId: link.externalOrderId, externalOrderNumber: link.externalOrderNumber } : null
  },
  async createRefund(orderId, lines, reason, caps) {
    const { createRefund } = await import('@/app/actions/sales')
    return createRefund(orderId, lines, reason, undefined, { internalBypassToken: INTERNAL_ACTION_BYPASS, enforcePerTargetBalances: true, maxRefundedQtyByLines: caps })
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

function claimKeyOf(fingerprint: string, plan: { reductions: PlannedReduction[] }, items: string[]): string {
  const units = plan.reductions.map((r) => `${r.lineId}=${r.qty}`).sort().join(',')
  return `${fingerprint}|${createHash('sha256').update(`${units}\n${items.join('\n')}`).digest('hex').slice(0, 16)}`
}

function operatorQuery(orderRef: string, warehouseRef: string, items: string[]): string {
  return `IMS order ${orderRef} (warehouse order ${warehouseRef}): WooCommerce now shows: ${items.join('; ')}. IMS changed nothing and refunded nothing for this automatically. Please check the order and decide what to do.`
}

/**
 * Act on a divergence the detection just recorded. Never throws (the delivery's real work is committed); every outcome is returned for tests and logged.
 */
export async function applyWcOrderAmendment(orderId: string, wcOrder: WcFullOrder, differences: ReadonlyArray<DivergenceDifference>, fingerprint: string, deps: AmendmentDeps = defaultAmendmentDeps): Promise<AmendmentOutcome> {
  let claimedKey: string | null = null
  try {
    if (!(await deps.isEnabled())) return { kind: 'off' }
    return await deps.withOrderLock(orderId, async (): Promise<AmendmentOutcome> => {
      // EVERYTHING BELOW IS READ AGAIN UNDER THE LOCK: another delivery may have refunded the same units while this one waited.
      const facts = await deps.loadFacts(orderId)
      if (!facts) return { kind: 'skipped', reason: 'the order is erased, a quote or gone' }
      if (!NO_PICKING_YET.has(facts.status) && !PICKING_STARTED.has(facts.status)) return { kind: 'skipped', reason: `the order is ${facts.status}` }
      // A STALE or out-of-order delivery drives nothing (the core update protects its fields the same way).
      const incoming = parseWcGmtInstant(String(wcOrder.date_modified_gmt || wcOrder.date_modified || ''))
      if (incoming && !Number.isNaN(incoming.getTime()) && facts.externalUpdatedAt && incoming.getTime() < facts.externalUpdatedAt.getTime()) {
        return { kind: 'skipped', reason: 'a newer WooCommerce delivery has already been stored (stale delivery)' }
      }

      const plan = planWcOrderAmendment(wcOrder, differences, facts)
      if (plan.reductions.length === 0 && plan.wcChanges.length === 0 && plan.restores.length === 0) {
        return { kind: 'skipped', reason: plan.imsWins.length > 0 ? 'the IMS edit is the latest on every changed line' : 'nothing the write step acts on' }
      }

      let toRefund = plan.reductions
      const manual: string[] = [...plan.restores]
      // AN ORDER-LEVEL DISCOUNT: the internal refund cut states its own amounts and neither reverses the discount nor holds the refund to what was paid. IMS does not guess: a person decides.
      if (toRefund.length > 0 && toDecimal((facts.orderDiscount ?? 0) as never).gt(0)) {
        manual.push(...plan.reductionChanges.map((c) => `${c} (the order carries an order-level discount, so IMS does not work out the refund)`))
        toRefund = []
      }

      // PICKING HAS STARTED when IMS says so, or when the warehouse order is no longer open for changes (the gate an IMS edit asks). ASKED BEFORE ANY REFUND, and failing closed:
      // a gate that cannot be read is treated as started.
      let pickingStarted = PICKING_STARTED.has(facts.status)
      const link = await deps.warehouseLink(orderId)
      if (!pickingStarted && link && (toRefund.length > 0 || plan.wcChanges.length > 0 || plan.reductionChanges.length > 0)) {
        try {
          pickingStarted = !(await deps.warehouseGate(orderId)).ok
        } catch {
          pickingStarted = true
        }
      }
      let afterPicking: string[] = []
      if (pickingStarted) {
        afterPicking = [...plan.wcChanges, ...(toRefund.length > 0 ? plan.reductionChanges : [])]
        toRefund = []
      }
      const operatorItems = manual
      if (toRefund.length === 0 && afterPicking.length === 0 && operatorItems.length === 0) return { kind: 'skipped', reason: 'the changes are left for a person and the warehouse has not started on the order' }

      const claimKey = claimKeyOf(fingerprint, { reductions: toRefund }, [...afterPicking, ...operatorItems])
      if (!(await deps.claim(orderId, fingerprint, claimKey))) return { kind: 'skipped', reason: 'these differences were already acted on' }
      claimedKey = claimKey

      let refundedLines = 0
      if (toRefund.length > 0) {
        const lines: RefundRequestLine[] = toRefund.map((r) => ({
          lineId: r.lineId, productId: r.productId, description: r.description, qty: r.qty, totalForeign: r.totalForeign, totalBase: r.totalBase, lineKind: 'sale',
        }))
        const result = await deps.createRefund(orderId, lines, WC_AMENDMENT_REFUND_REASON, plan.caps)
        if (!result.success) {
          await deps.releaseClaim(orderId, claimKey)
          claimedKey = null
          await deps.log({ orderId, level: 'WARNING', action: 'wc_order_amendment_refund_failed', description: `IMS could not record the refund for the quantity reduced in WooCommerce: ${result.error ?? 'unknown reason'}. Nothing was changed; the next delivery retries.` })
          return { kind: 'refund-failed', error: result.error ?? 'unknown reason' }
        }
        refundedLines = lines.length
        await deps.log({ orderId, level: 'INFO', action: 'wc_order_amendment_refunded', description: `A paid order was reduced in WooCommerce. IMS recorded the reduction through the refund path (${lines.map((l) => `${l.qty} unit(s)`).join(', ')}); the paid amount was not edited.`, metadata: { lines: toRefund } })
      }

      let taskRaised = false
      if (afterPicking.length > 0 || operatorItems.length > 0) {
        if (link) {
          const ref = warehouseOrderRef(link.externalOrderNumber, link.externalOrderId)
          const payload = { orderNumber: facts.orderNumber, externalOrderNumber: link.externalOrderNumber }
          if (afterPicking.length > 0) {
            taskRaised = await deps.raiseTask({
              connector: link.connector, orderId, externalOrderId: link.externalOrderId, reason: 'WC_EDIT_AFTER_PICKING',
              queryText: wcEditAfterPickingQuery(ref, facts.orderNumber ?? orderId, afterPicking), payload, dedupeBasis: `wc-edit:${fingerprint}`,
            })
          }
          if (operatorItems.length > 0) {
            taskRaised = (await deps.raiseTask({
              connector: link.connector, orderId, externalOrderId: link.externalOrderId, reason: 'WC_EDIT_AFTER_PICKING',
              queryText: operatorQuery(facts.orderNumber ?? orderId, ref, operatorItems), payload, dedupeBasis: `wc-manual:${createHash('sha256').update(operatorItems.join('\n')).digest('hex').slice(0, 16)}`,
            })) || taskRaised
          }
        }
        await deps.log({
          orderId, level: 'WARNING', action: 'wc_order_amendment_after_picking',
          description: `WooCommerce changed the order and IMS did not apply it (${pickingStarted ? 'the warehouse has started on the order, so nothing was sent or refunded' : 'a person has to decide'}). ${link ? 'An operator task was raised.' : 'There is no warehouse order, so no task could be raised.'}`,
          metadata: { changes: [...afterPicking, ...operatorItems] },
        })
      }
      return { kind: 'applied', refundedLines, taskRaised }
    })
  } catch (error) {
    // A throw after the claim was taken (a rejected import, a task insert that failed) must not leave the claim behind: the next delivery would skip these differences for good. A repeat is safe (the refunded quantities are read again under the lock).
    if (claimedKey) await deps.releaseClaim(orderId, claimedKey).catch(() => undefined)
    console.error('wc_order_amendment: could not apply', error instanceof Error ? error.constructor.name : typeof error)
    return { kind: 'skipped', reason: 'an error (logged)' }
  }
}
