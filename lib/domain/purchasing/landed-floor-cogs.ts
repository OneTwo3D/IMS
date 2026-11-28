import { Prisma } from '@/app/generated/prisma/client'
import { accountingPayloadKey } from '@/lib/accounting/payload-key'
import { businessDateYmd } from '@/lib/business-date'
import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'
import { isShadowedOutcome, postingIsOwed, type EnqueueOutcomeLike } from '@/lib/domain/accounting/enqueue-outcome'
import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'
import { roundQuantity, toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import {
  allocateLandedCost,
  grossUnitCostForGoods,
  headerDiscountFactorForPo,
  unabsorbedBaseForQty,
} from '@/lib/domain/purchasing/landed-cost-allocation'

/**
 * A SUPPLIER CREDIT THE STOCK CANNOT CARRY GOES TO COST OF SALES (FRS 102 s13.6). Switch `landed_cost_floor_cogs_enabled`, ADMIN, off by default.
 *
 * WHERE THE AMOUNT SITS TODAY. A negative landed cost line (a supplier credit or rebate on the order or on a linked freight order) lowers the landed
 * unit cost, floored at 0.00 per PO line (landed-cost-allocation.ts, rule 4). The order's bills debit Stock in Transit with the goods and every cost
 * line, the credit line included (so the credit is a CREDIT on transit), and each receipt credits transit with the value it lays into Inventory,
 * which is the FLOORED value. So the part of the credit the floor did not absorb is left as a credit balance on Stock in Transit, with nothing to
 * clear it: the transit account under-states what is owed by exactly that amount, for ever.
 *
 * WHAT THIS DOES. It clears that credit to cost of sales: DR Stock in Transit / CR COGS (a COGS_JOURNAL), at the point the floor applies (a receipt
 * of the order, a recalculation of its landed cost). It is TARGET-STATE and idempotent, like the per-event FX variance journals: the target is
 * what the floor leaves unabsorbed on the order's receipt layers now; what was already journalled is the sum of this writer's own transit rows;
 * only the difference is queued. A later freight change moves the target and the next event posts the adjustment; a cancelled freight order
 * takes its credit out of the allocation, the target falls to zero and the journal is reversed (DR COGS / CR Stock in Transit).
 *
 * THE SUB-LEDGERS. The journal moves both COGS and transit, so it records a COGS row (LANDED_COST_ADJUSTMENT, the landed-cost COGS_JOURNAL's own
 * source) and a transit row (LANDED_COST_CONSUMED_OFFSET, its transit leg), both keyed by the journal's own key (prefix `landed-floor-cogs:`), so
 * the COGS cross-check and the transit reconciliation (R11) tie by construction. The landed-cost revaluation journals of the ABSORBED part are
 * untouched (they carry only the floored delta), and the per-event FX variance journals ignore non-positive cost lines, so nothing is counted twice.
 *
 * SCOPE. Only an order whose receipts were journalled (a STOCK_RECEIPT transit row exists) leaves the credit in transit, so only such an order has a
 * target; the layers counted are the order's own receipt layers (not refund returns, adjustments or production outputs). A supplier return of
 * floored units is not netted (the credit was earned on the purchase). With the switch off and nothing journalled for the order, nothing is read
 * beyond the switch: behaviour is exactly as before. Once this writer has journalled an order, the order keeps being reconciled even if the switch
 * is turned off later, so a cancellation still reverses what was posted.
 */

export const LANDED_FLOOR_COGS_SWITCH_KEY = 'landed_cost_floor_cogs_enabled'
export const LANDED_FLOOR_COGS_KEY_PREFIX = 'landed-floor-cogs:'

/** Same predicate as landed-cost-service.ts CONTRIBUTING_LANDED_COST_LINK_WHERE (a literal here to keep this module out of that one's import graph). */
const CONTRIBUTING_LINK_WHERE = { freightPO: { status: { not: 'CANCELLED' as const } } }

export class LandedFloorCogsRefusal extends Error {}

type Client = Prisma.TransactionClient

export async function readLandedFloorCogsEnabled(client: Pick<Client, 'setting'>): Promise<boolean> {
  // A narrow test double without settings reads the switch as off.
  if (typeof (client as Partial<Pick<Client, 'setting'>>).setting?.findUnique !== 'function') return false
  const row = await client.setting.findUnique({ where: { key: LANDED_FLOOR_COGS_SWITCH_KEY }, select: { value: true } })
  return row?.value === 'true'
}

/** What the zero floor leaves unabsorbed on the order's own receipt layers NOW, exact Decimal (never negative). */
export async function computeLandedFloorUnabsorbedTx(tx: Client, poId: string): Promise<Decimal> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      subtotalBase: true,
      freightCostLines: { select: { id: true, amountBase: true, distributionMethod: true } },
      lines: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          qty: true,
          unitCostBase: true,
          totalBase: true,
          product: { select: { weight: true } },
          costLayers: {
            where: { returnMovementId: null, adjustmentMovementId: null, productionOrderId: null, isOpeningStock: false },
            select: { goodsUnitCostBase: true, receivedQty: true },
          },
        },
      },
    },
  })
  const zero = new Prisma.Decimal(0)
  if (!po) return zero
  const links = await tx.landedCostLink.findMany({
    where: { primaryPoId: poId, ...CONTRIBUTING_LINK_WHERE },
    select: { freightPO: { select: { freightCostLines: { select: { id: true, amountBase: true, distributionMethod: true } } } } },
  })
  const headerDiscountFactor = headerDiscountFactorForPo(po)
  const allocation = allocateLandedCost(
    po.lines.map((line) => ({
      id: line.id,
      qty: line.qty,
      unitCostBase: line.unitCostBase,
      totalBase: line.totalBase,
      weight: line.product?.weight ?? null,
      headerDiscountFactor,
    })),
    [
      ...po.freightCostLines.map((costLine) => ({ ...costLine, sourceRank: 0 as const })),
      ...links.flatMap((link) => link.freightPO.freightCostLines.map((costLine) => ({ ...costLine, sourceRank: 1 as const }))),
    ],
  )
  const floorByLine = new Map(allocation.floors.map((floor) => [floor.lineId, floor]))
  let total = zero
  for (const line of po.lines) {
    const qty = toDecimal(line.qty)
    if (qty.lte(0)) continue
    const lineFloor = floorByLine.get(line.id)
    const landed = toDecimal(allocation.landedAmountByLine.get(line.id) ?? 0)
    for (const layer of line.costLayers) {
      // The same per-layer rule the recalculation applies (landed-cost-service.ts layerUnitCostAfterRecalc): a legacy layer takes the line's
      // floor, a layer laid at its own goods cost (per-event FX) takes the line's landed share on its own goods cost.
      const unfloored = layer.goodsUnitCostBase == null
        ? lineFloor?.unflooredGrossUnitCostBase
        : grossUnitCostForGoods(layer.goodsUnitCostBase, landed, qty).unfloored
      if (unfloored && unfloored.lt(0)) total = total.add(unabsorbedBaseForQty(unfloored, layer.receivedQty))
    }
  }
  return total
}

export type LandedFloorCogsResult = {
  /** The signed transit movement queued now (+ = DR Stock in Transit / CR COGS), as text, or null when nothing was owed. */
  transitDelta: string | null
  /** The queue declined a journal that is owed (retried by the next receipt or recalculation of the order). */
  notQueued?: EnqueueOutcomeLike
  shadowed?: boolean
}

/**
 * Reconcile the floored-credit journal of one order to its target. Runs inside the caller's transaction (a receipt, a landed-cost recalculation),
 * after the layers are written. Throws LandedFloorCogsRefusal when a journal is owed and the COGS or Stock in Transit account is not mapped (the
 * caller's whole event is refused and rolled back, with nothing written).
 */
export async function reconcileLandedFloorCogsTx(
  tx: Client,
  params: { poId: string; poReference: string; at: Date },
): Promise<LandedFloorCogsResult> {
  const none: LandedFloorCogsResult = { transitDelta: null }
  const enabled = await readLandedFloorCogsEnabled(tx)
  // A narrow test double without the transit sub-ledger has no history either.
  if (!enabled && typeof (tx as Partial<Client>).transitSubledgerMovement?.findMany !== 'function') return none
  const rows = await tx.transitSubledgerMovement.findMany({
    where: { sourceType: 'LANDED_COST_CONSUMED_OFFSET', sourceRef: params.poId, idempotencyKey: { startsWith: LANDED_FLOOR_COGS_KEY_PREFIX } },
    select: { baseDelta: true },
  })
  if (!enabled && rows.length === 0) return none

  const { getAccountingSettings, queueAccountingSyncTx, readStockReceiptAccountsTx } = await import('@/lib/accounting')
  const settings = await getAccountingSettings()
  if (!settings.syncEnabled || !settings.connector) return none

  const receiptJournalled = await tx.transitSubledgerMovement.findFirst({ where: { sourceType: 'STOCK_RECEIPT', sourceRef: params.poId }, select: { id: true } })
  const target = receiptJournalled ? roundQuantity(await computeLandedFloorUnabsorbedTx(tx, params.poId), 2) : new Prisma.Decimal(0)
  const posted = rows.reduce((sum, row) => sum.add(toDecimal(row.baseDelta)), new Prisma.Decimal(0))
  const delta = roundQuantity(target.sub(posted), 2)
  if (delta.isZero()) return none

  const { lockAccountingMappingSelection } = await import('@/lib/integration-plugin-selection-lock')
  await lockAccountingMappingSelection(tx, settings.connector)
  const transitAccount = (await readStockReceiptAccountsTx(tx, settings.connector)).transitAccount
  const cogsAccount = settings.cogsAccount?.trim() ?? ''
  if (!transitAccount || !cogsAccount) {
    throw new LandedFloorCogsRefusal(
      `The supplier credit on ${params.poReference} that the stock cannot carry (${delta.abs().toFixed(2)}) cannot be posted to cost of sales: `
      + `${!cogsAccount ? 'the COGS account' : 'the Stock in Transit account'} is not mapped. Nothing was changed. Map it under Sync > Accounting settings `
      + '(or ask an administrator to switch off landed_cost_floor_cogs_enabled), then retry.',
    )
  }
  const amount = delta.abs().toNumber()
  const description = `Supplier credit not absorbed by stock: ${params.poReference}`
  const transitLine = { accountCode: transitAccount, description, ...(delta.gt(0) ? { debit: amount } : { credit: amount }) }
  const cogsLine = { accountCode: cogsAccount, description, ...(delta.gt(0) ? { credit: amount } : { debit: amount }) }
  const payload = {
    date: businessDateYmd(params.at),
    reference: `Landed credit to COGS: ${params.poReference}`,
    narration: delta.gt(0)
      ? `Supplier credit on ${params.poReference} that the stock cannot carry (units floored at 0.00), cleared from Stock in Transit to cost of sales`
      : `Reversal of a supplier credit on ${params.poReference} previously cleared to cost of sales (the floored amount fell)`,
    lines: delta.gt(0) ? [transitLine, cogsLine] : [cogsLine, transitLine],
  }
  const idempotencyKey = accountingPayloadKey(`${LANDED_FLOOR_COGS_KEY_PREFIX}${params.poId}`, { ...payload, revision: rows.length })
  const answered: { outcome?: EnqueueOutcomeLike } = {}
  const queued = await queueAccountingSyncTx(tx, {
    type: 'COGS_JOURNAL',
    referenceType: 'PurchaseOrder',
    referenceId: params.poId,
    payload,
    idempotencyKey,
    chartConnector: settings.connector,
    reportOutcome: (outcome) => { answered.outcome = outcome },
  })
  if (queued) {
    // + = transit DEBITED; the COGS leg is the opposite sign (CR COGS on a positive delta).
    await recordTransitSubledgerMovement(tx, {
      sourceType: 'LANDED_COST_CONSUMED_OFFSET', sourceRef: params.poId, idempotencyKey, baseDelta: delta, journalDate: payload.date,
    })
    await recordCogsSubledgerMovement(tx, {
      sourceType: 'LANDED_COST_ADJUSTMENT', sourceRef: params.poId, idempotencyKey, baseDelta: delta.neg(), journalDate: payload.date,
    })
    return { transitDelta: delta.toFixed(2) }
  }
  if (answered.outcome && isShadowedOutcome(answered.outcome)) return { transitDelta: null, shadowed: true }
  if (answered.outcome && postingIsOwed(answered.outcome)) return { transitDelta: null, notQueued: answered.outcome }
  return none
}
