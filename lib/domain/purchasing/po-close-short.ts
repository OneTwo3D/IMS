import type { Prisma, PurchaseOrderStatus } from '@/app/generated/prisma/client'
import { loadPurchaseOrderLineLandedQty, PO_LANDED_QTY_EPSILON } from '@/lib/domain/inventory/po-line-landed-quantity'
import { findLiveAsnBlocks, type LiveAsnBlock } from '@/lib/domain/wms/po-receipt-asn-guard'
import { validatePurchaseOrderStatusTransition } from '@/lib/domain/workflows/action-guards'
import { roundQuantity, toDecimal } from '@/lib/domain/math/decimal'
import { logActivity } from '@/lib/activity-log'
import {
  CONTRIBUTING_LANDED_COST_LINK_WHERE,
  logLandedCostCreditFloorActivities,
  queueLandedCostAdjustmentJournals,
  recalculateDirectLandedCosts,
  type LandedCostRecalcResult,
} from '@/lib/domain/purchasing/landed-cost-service'

/**
 * CLOSING A PURCHASE ORDER, AND CANCELLING A PART-RECEIVED ONE, ARE ONE OPERATION: DROP WHAT HAS NOT ARRIVED, KEEP WHAT HAS.
 *
 * The owner's ruling: cancelling a part-received order behaves like close-short. The unreceived balance stops being expected;
 * the received stock, its quantities (`qtyReceived`), its cost layers and every journal already posted stay exactly as they
 * are. Taking received goods back out of stock is the supplier-return flow's job and nothing here does it.
 *
 * The order ends in CLOSED, not CANCELLED, when anything has landed: CANCELLED is read as "nothing happened" by committed-spend
 * analytics, the bill gate and the returns/billing guards, and an order that owns live stock must not look like that. The line
 * `qty` is left as ordered; "expects nothing more" is carried by the status (`PO_STATUSES_EXPECTING_NOTHING`).
 *
 * LOCKING. The caller holds the `purchase_orders` row FOR UPDATE (the global order is PO -> ASN header -> ASN lines, and every
 * writer of a line's received/landed state takes the PO row first), so the facts read here cannot move before the status write.
 * Nothing is written to a connector; nothing is posted to the ledger: an unreceived balance has no ledger footprint.
 */

export type PoRetireIntent = 'close' | 'cancel'

export class PoLiveAsnRefusedError extends Error {
  override readonly name = 'PoLiveAsnRefusedError'
  constructor(message: string, readonly blocks: LiveAsnBlock[]) {
    super(message)
  }
}

export function liveAsnRetireRefusalMessage(poReference: string, intent: PoRetireIntent, blocks: readonly LiveAsnBlock[]): string {
  const bySku = new Map<string, LiveAsnBlock[]>()
  for (const block of blocks) bySku.set(block.sku, [...(bySku.get(block.sku) ?? []), block])
  const parts = [...bySku.entries()].map(([sku, list]) => `${sku} (ASN ${list.map((b) => `${b.externalAsnId}, ${b.status}`).join('; ')})`)
  const verb = intent === 'cancel' ? 'cancel' : 'close'
  return `Cannot ${verb} ${poReference}: ${parts.join(', ')} ${parts.length === 1 ? 'has' : 'have'} an open warehouse ASN. `
    + `Book the goods in through the ASN (use Recheck booked-in once the warehouse has booked them) or retire the ASN first, then ${verb} the order. `
    + 'Closing now would leave the warehouse expecting goods this order no longer expects.'
}

export async function assertNoLiveAsnForRetirement(
  client: Pick<Prisma.TransactionClient, 'wmsAsnLineMap'>,
  poReference: string,
  intent: PoRetireIntent,
  poLineIds: readonly string[],
): Promise<void> {
  const blocks = await findLiveAsnBlocks(client, poLineIds)
  if (blocks.length > 0) throw new PoLiveAsnRefusedError(liveAsnRetireRefusalMessage(poReference, intent, blocks), blocks)
}

export type BilledAheadLine = {
  poLineId: string
  sku: string | null
  billedQty: number
  landedQty: number
  excessQty: number
  excessValueBase: number
}

/**
 * Bills for more than has landed (a prepaid supplier billed on the ordered quantity). Closing does not hide it: Transit keeps a
 * debit for goods that will not arrive until the supplier credits it. Returns the per-line excess so the caller can say so.
 * Value = excess x the line's average billed base price. Pure.
 */
export function computeBilledAheadOfReceipt(input: {
  lines: ReadonlyArray<{ id: string; sku: string | null; landedQty: number }>
  invoiceLines: ReadonlyArray<{ poLineId: string | null; qtyBilled: unknown; totalBase: unknown }>
}): BilledAheadLine[] {
  const billed = new Map<string, { qty: number; base: number }>()
  for (const il of input.invoiceLines) {
    if (!il.poLineId) continue
    const cur = billed.get(il.poLineId) ?? { qty: 0, base: 0 }
    cur.qty += Number(il.qtyBilled)
    cur.base += Number(il.totalBase)
    billed.set(il.poLineId, cur)
  }
  const out: BilledAheadLine[] = []
  for (const line of input.lines) {
    const b = billed.get(line.id)
    if (!b || b.qty <= 0) continue
    const excess = b.qty - line.landedQty
    if (excess <= PO_LANDED_QTY_EPSILON) continue
    out.push({
      poLineId: line.id,
      sku: line.sku,
      billedQty: roundQuantity(b.qty, 4).toNumber(),
      landedQty: roundQuantity(line.landedQty, 4).toNumber(),
      excessQty: roundQuantity(excess, 4).toNumber(),
      excessValueBase: roundQuantity(toDecimal(excess).mul(b.base).div(b.qty), 2).toNumber(),
    })
  }
  return out
}

export type RetireOutcome = {
  reference: string
  previousStatus: PurchaseOrderStatus
  newStatus: 'CLOSED' | 'CANCELLED'
  /** True when anything had landed: the order closed short and the received stock stayed. */
  keptReceivedStock: boolean
  landedQty: number
  /** Ordered quantity that will now never be received (sum over lines of max(0, qty - landed)). */
  droppedQty: number
  billedAhead: BilledAheadLine[]
  /**
   * Set when the unreceived share of freight was reallocated onto the received units (the order carries contributing costs and
   * quantity was dropped). The caller posts its journals after commit with `settleCloseShortRevaluation`.
   */
  landedCostRecalc: LandedCostRecalcResult | null
}

/**
 * Close (or cancel a part-received) order. The caller already holds the `purchase_orders` row lock. Throws on a refused
 * transition or a live ASN; writes only the status. `beforeWrite` runs after the facts are read and before the status
 * write (the cancel service hangs its supplier-bill gate there: it applies only when nothing landed).
 */
export async function retirePurchaseOrderLocked(
  tx: Prisma.TransactionClient,
  id: string,
  intent: PoRetireIntent,
  beforeWrite?: (facts: { keptReceivedStock: boolean }) => void,
): Promise<RetireOutcome> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id },
    select: {
      status: true,
      reference: true,
      lines: { select: { id: true, qty: true, qtyReceived: true, product: { select: { sku: true } } } },
      freightCostLines: { select: { amountBase: true } },
      landedCostLinks: {
        where: { ...CONTRIBUTING_LANDED_COST_LINK_WHERE },
        select: { freightPO: { select: { freightCostLines: { select: { amountBase: true } } } } },
      },
      invoices: { select: { lines: { select: { poLineId: true, qtyBilled: true, totalBase: true } } } },
    },
  })
  if (!po) throw new Error('PO not found')

  await assertNoLiveAsnForRetirement(tx, po.reference, intent, po.lines.map((l) => l.id))

  const landedByLine = await loadPurchaseOrderLineLandedQty(tx, po.lines.map((l) => ({ id: l.id, qtyReceived: l.qtyReceived })))
  // Landed units the warehouse alignment brought into stock but that have not been folded into the line's received quantity
  // (`qtyReceived`) are real stock that the supplier-return flow cannot yet return: it validates `qtyReceived` only, and a closed
  // order refuses returns. Closing now would strand them (and would spread freight over units no return can reach), so the close
  // waits until the warehouse receipt has been reconciled into the order.
  const unreconciled = po.lines.filter((l) => (landedByLine.get(l.id)?.fromUnabsorbedWmsSnapshot.toNumber() ?? 0) > PO_LANDED_QTY_EPSILON)
  if (unreconciled.length > 0) {
    const names = unreconciled.map((l) => `${l.product?.sku ?? l.id} (${landedByLine.get(l.id)!.fromUnabsorbedWmsSnapshot.toNumber()})`).join(', ')
    throw new Error(
      `Cannot ${intent === 'cancel' ? 'cancel' : 'close'} ${po.reference}: ${names} ${unreconciled.length === 1 ? 'has' : 'have'} stock the warehouse sync brought in that is not yet booked into this order, `
      + 'so it cannot be returned to the supplier from here. Reconcile the warehouse receipt first (use Recheck booked-in on the order once the warehouse has booked the goods in), then close the order.',
    )
  }

  let landedQty = 0
  let droppedQty = 0
  const lineLanded = po.lines.map((line) => {
    const landed = landedByLine.get(line.id)?.qtyNumber ?? 0
    landedQty += landed
    droppedQty += Math.max(0, Number(line.qty) - landed)
    return { id: line.id, sku: line.product?.sku ?? null, landedQty: landed }
  })
  const keptReceivedStock = landedQty > PO_LANDED_QTY_EPSILON

  // Nothing landed: Close -> CLOSED, Cancel -> CANCELLED. Something landed: both end CLOSED (close-short).
  const newStatus: 'CLOSED' | 'CANCELLED' = keptReceivedStock || intent === 'close' ? 'CLOSED' : 'CANCELLED'
  const transition = validatePurchaseOrderStatusTransition(po.status, newStatus)
  if (!transition.success) throw new Error(transition.error)
  beforeWrite?.({ keptReceivedStock })

  // THE FREIGHT. The unreceived share of the order's freight (its own cost lines and its linked freight orders') is spread over the
  // units that landed: remaining layers revalued, sold units' share to COGS, in-transit residue capitalised, journals returned for
  // the caller to post. BEFORE the status write: the revaluation refuses a CLOSED order. The caller holds the revaluation scope
  // lock (lockLandedCostRevaluationScope), which this call requires.
  let landedCostRecalc: LandedCostRecalcResult | null = null
  const hasContributingCosts = po.freightCostLines.some((c) => !toDecimal(c.amountBase).isZero())
    || po.landedCostLinks.some((link) => link.freightPO.freightCostLines.some((c) => !toDecimal(c.amountBase).isZero()))
  if (keptReceivedStock && droppedQty > PO_LANDED_QTY_EPSILON && hasContributingCosts) {
    landedCostRecalc = await recalculateDirectLandedCosts(tx, id, undefined, {
      triggeredById: null,
      reason: 'purchase_order_closed_short',
      scheduleAdjustmentJournals: true, // durable backstop, as for every journaling revaluation
      landedQtyBasis: new Map(lineLanded.map((l) => [l.id, l.landedQty])),
    })
    // The links' cost now sits on the units that landed.
    await tx.landedCostLink.updateMany({ where: { primaryPoId: id, ...CONTRIBUTING_LANDED_COST_LINK_WHERE }, data: { allocated: true } })
  }

  await tx.purchaseOrder.update({ where: { id }, data: { status: newStatus } })

  const billedAhead = computeBilledAheadOfReceipt({
    lines: lineLanded,
    invoiceLines: po.invoices.flatMap((inv) => inv.lines),
  })
  return {
    reference: po.reference,
    previousStatus: po.status,
    newStatus,
    keptReceivedStock,
    landedQty: roundQuantity(landedQty, 4).toNumber(),
    droppedQty: roundQuantity(droppedQty, 4).toNumber(),
    billedAhead,
    landedCostRecalc,
  }
}

export type SettleCloseShortDeps = {
  logActivity: typeof logActivity
  queueLandedCostAdjustmentJournals: typeof queueLandedCostAdjustmentJournals
}

const defaultSettleDeps: SettleCloseShortDeps = { logActivity, queueLandedCostAdjustmentJournals }

/**
 * After the close-short transaction committed: post the freight reallocation's journals (DR Inventory / CR Transit for retained
 * units, DR COGS / CR Transit for sold units; the existing queue, behind the existing holds, keyed by the adjustment's event key so
 * the in-transaction outbox row and this call are one posting), write the credit-floor WARNING, and log each COGS correction.
 * Returns operator-facing warnings. Never throws: the close already committed.
 */
export async function settleCloseShortRevaluation(
  recalc: LandedCostRecalcResult | null,
  outcome: Pick<RetireOutcome, 'reference'>,
  poId: string,
  deps: SettleCloseShortDeps = defaultSettleDeps,
): Promise<string[]> {
  if (!recalc) return []
  const warnings: string[] = []
  try {
    await logLandedCostCreditFloorActivities(recalc)
  } catch (error) {
    console.error('Failed to log close-short credit-floor activity:', error)
  }
  for (const w of recalc.warnings) warnings.push(w.message)
  try {
    await deps.queueLandedCostAdjustmentJournals(recalc)
  } catch (error) {
    console.error('Failed to queue close-short freight reallocation journals:', error)
    warnings.push('The freight reallocation is saved, but its accounting journals could not be queued now; they are held in the retry outbox.')
  }
  for (const adj of recalc.cogsAdjustments) {
    try {
      await deps.logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: poId,
        action: 'cogs_adjusted',
        tag: 'purchase',
        level: 'INFO',
        description: `Retrospective COGS correction of ${adj.totalDelta.toFixed(2)} for ${outcome.reference} after closing it short (freight reallocated onto the units received)`,
        metadata: { totalDelta: adj.totalDelta, reason: 'purchase_order_closed_short' },
      })
    } catch (error) {
      console.error('Failed to log close-short COGS adjustment:', error)
    }
  }
  return warnings
}

export function describeRetireOutcome(outcome: RetireOutcome, intent: PoRetireIntent): string {
  const verb = intent === 'cancel' ? 'Cancelled' : 'Closed'
  if (outcome.keptReceivedStock) {
    return `${verb} ${outcome.reference} as closed short: ${outcome.droppedQty} unit(s) still due were dropped; the ${outcome.landedQty} unit(s) received stay in stock at their cost.`
  }
  return `${verb} ${outcome.reference}. Nothing had been received, so stock and accounts are unchanged.`
}

export function describeBilledAhead(lines: readonly BilledAheadLine[]): string | null {
  if (lines.length === 0) return null
  const parts = lines.map((l) => `${l.sku ?? l.poLineId}: billed ${l.billedQty}, received ${l.landedQty} (${l.excessQty} over, about ${l.excessValueBase.toFixed(2)} base)`)
  return `Billed ahead of receipt: ${parts.join('; ')}. Goods-in-transit keeps a debit for these until the supplier issues a credit note.`
}
