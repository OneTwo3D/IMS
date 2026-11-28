import { Prisma } from '@/app/generated/prisma/client'
import type { AccountingSettings } from '@/lib/accounting'
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
 * WHICH LAYERS COUNT (the coverage rule). The journal is the missing half of the RECEIPT's own transit drain: the receipt credits transit with the
 * floored value, and the floor stopped it crediting the unabsorbed part as well. It is therefore owed exactly where the receipt journal is, by the
 * same accrual (independently of when the bills post, as the receipt is), and a receipt of floored units only is worth 0.00 and writes no
 * receipt row but still owes it. So a layer counts when the transit sub-ledger covers its receipt day (`transit_ledger_coverage_start_date`, the
 * watermark from which IMS records every transit posting; unset = nothing counts) and IMS posts stock receipts now (accounting sync on). The layers
 * counted are the order's own receipt layers (not refund returns, adjustments or production outputs).
 *
 * THE QUANTITY BASIS. Normally the allocation divides the cost lines over the ordered quantities. An order CLOSED SHORT spreads its freight over the
 * units that landed (po-close-short.ts, recalculateDirectLandedCosts with `landedQtyBasis`), so the close-short passes that basis in, and for an
 * order already CLOSED it is derived the same way (loadPurchaseOrderLineLandedQty), so later events agree with the layers.
 *
 * COST. With the switch off: one read of the switch and one indexed lookup of this order's own rows (source_ref, source_type); nothing else. Once
 * this writer has journalled an order, the order keeps being reconciled even if the switch is turned off later, so a cancellation still reverses
 * what was posted. A supplier return of floored units is not netted (the credit was earned on the purchase).
 */

export const LANDED_FLOOR_COGS_SWITCH_KEY = 'landed_cost_floor_cogs_enabled'
export const LANDED_FLOOR_COGS_KEY_PREFIX = 'landed-floor-cogs:'

/** Same predicate as landed-cost-service.ts CONTRIBUTING_LANDED_COST_LINK_WHERE (a literal here to keep this module out of that one's import graph). */
const CONTRIBUTING_LINK_WHERE = { freightPO: { status: { not: 'CANCELLED' as const } } }

const TRANSIT_COVERAGE_KEY = 'transit_ledger_coverage_start_date'

export class LandedFloorCogsRefusal extends Error {}

type Client = Prisma.TransactionClient

export async function readLandedFloorCogsEnabled(client: Pick<Client, 'setting'>): Promise<boolean> {
  // A narrow test double without settings reads the switch as off.
  if (typeof (client as Partial<Pick<Client, 'setting'>>).setting?.findUnique !== 'function') return false
  const row = await client.setting.findUnique({ where: { key: LANDED_FLOOR_COGS_SWITCH_KEY }, select: { value: true } })
  return row?.value === 'true'
}

/** The landed quantity per PO line, for a close-short basis (quantity divided over, value pro rata). */
export type LandedQtyBasis = ReadonlyMap<string, Prisma.Decimal | number | string>

/**
 * What the zero floor leaves unabsorbed on the order's own receipt layers NOW, exact Decimal (never negative). `coveredFrom` is the transit coverage
 * watermark (YYYY-MM-DD): a layer received before it is not counted. `landedQtyBasis` is the close-short basis (see the header).
 */
export async function computeLandedFloorUnabsorbedTx(
  tx: Client,
  poId: string,
  options: { coveredFrom: string; landedQtyBasis?: LandedQtyBasis } = { coveredFrom: '0000-00-00' },
): Promise<Decimal> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      status: true,
      subtotalBase: true,
      freightCostLines: { select: { id: true, amountBase: true, distributionMethod: true } },
      lines: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          qty: true,
          qtyReceived: true,
          unitCostBase: true,
          totalBase: true,
          product: { select: { weight: true } },
          costLayers: {
            where: { returnMovementId: null, adjustmentMovementId: null, productionOrderId: null, isOpeningStock: false },
            select: { goodsUnitCostBase: true, receivedQty: true, receivedAt: true },
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
  // The close-short basis: passed by the close-short itself (before the status write), derived for an order already CLOSED.
  let basis: LandedQtyBasis | undefined = options.landedQtyBasis
  if (!basis && po.status === 'CLOSED') {
    const { loadPurchaseOrderLineLandedQty } = await import('@/lib/domain/inventory/po-line-landed-quantity')
    const landed = await loadPurchaseOrderLineLandedQty(tx, po.lines.map((line) => ({ id: line.id, qtyReceived: line.qtyReceived })))
    basis = new Map(po.lines.map((line) => [line.id, landed.get(line.id)?.qtyNumber ?? 0]))
  }
  const allocQty = (line: { id: string; qty: Prisma.Decimal }): Decimal => (basis ? toDecimal(basis.get(line.id) ?? 0) : toDecimal(line.qty))
  const headerDiscountFactor = headerDiscountFactorForPo(po)
  const allocation = allocateLandedCost(
    po.lines.map((line) => {
      const ordered = toDecimal(line.qty)
      const qty = allocQty(line)
      return {
        id: line.id,
        qty,
        unitCostBase: line.unitCostBase,
        // The value basis follows the quantity basis, exactly as recalculateDirectLandedCosts builds it for a close-short.
        totalBase: basis ? (ordered.gt(0) ? toDecimal(line.totalBase).mul(qty).div(ordered) : zero) : line.totalBase,
        weight: line.product?.weight ?? null,
        headerDiscountFactor,
      }
    }),
    [
      ...po.freightCostLines.map((costLine) => ({ ...costLine, sourceRank: 0 as const })),
      ...links.flatMap((link) => link.freightPO.freightCostLines.map((costLine) => ({ ...costLine, sourceRank: 1 as const }))),
    ],
  )
  const floorByLine = new Map(allocation.floors.map((floor) => [floor.lineId, floor]))
  let total = zero
  for (const line of po.lines) {
    const qty = allocQty(line)
    if (qty.lte(0)) continue
    const lineFloor = floorByLine.get(line.id)
    const landed = toDecimal(allocation.landedAmountByLine.get(line.id) ?? 0)
    for (const layer of line.costLayers) {
      if (businessDateYmd(layer.receivedAt) < options.coveredFrom) continue
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
  poId: string
  poReference: string
  /** The signed transit movement queued now (+ = DR Stock in Transit / CR COGS), as text, or null when nothing was queued. */
  transitDelta: string | null
  /** The queue declined a journal that is owed (the next receipt or recalculation of the order queues what is still owed). */
  notQueued?: EnqueueOutcomeLike
  /** The producer-side hold recorded the journal as a shadow; nothing was sent. */
  shadowed?: { transitDelta: string }
  /** A WMS path that must not refuse its book-in: the refusal it would have raised, reported after the commit. */
  refused?: string
}

/** The accounting chart the caller read BEFORE its transaction (`getAccountingSettings()`); undefined = read here, lazily, over the pool. */
type Chart = Pick<AccountingSettings, 'connector' | 'syncEnabled' | 'cogsAccount'> | null | undefined

/**
 * Reconcile the floored-credit journal of one order to its target. Runs inside the caller's transaction (a receipt, a landed-cost recalculation),
 * after the layers are written. Pass `chart` read before the transaction (a pooled read inside it is the nested-pool shape); `null` = it could not
 * be read, and a journal owed then refuses. Throws LandedFloorCogsRefusal when a journal is owed and an account is not mapped (the caller's whole
 * event is refused and rolled back, with nothing written).
 */
export async function reconcileLandedFloorCogsTx(
  tx: Client,
  params: { poId: string; poReference: string; at: Date; chart?: Chart; landedQtyBasis?: LandedQtyBasis },
): Promise<LandedFloorCogsResult> {
  const none: LandedFloorCogsResult = { poId: params.poId, poReference: params.poReference, transitDelta: null }
  const enabled = await readLandedFloorCogsEnabled(tx)
  // A narrow test double without the transit sub-ledger has no history either.
  if (!enabled && typeof (tx as Partial<Client>).transitSubledgerMovement?.findMany !== 'function') return none
  // Equality on (source_ref, source_type): the indexed lookup; the key prefix only filters the order's own few rows.
  const rows = await tx.transitSubledgerMovement.findMany({
    where: { sourceRef: params.poId, sourceType: 'LANDED_COST_CONSUMED_OFFSET', idempotencyKey: { startsWith: LANDED_FLOOR_COGS_KEY_PREFIX } },
    select: { baseDelta: true },
  })
  if (!enabled && rows.length === 0) return none

  let chart: Chart = params.chart
  if (chart === undefined) {
    const { getAccountingSettings } = await import('@/lib/accounting')
    chart = await getAccountingSettings()
  }
  if (chart && (!chart.syncEnabled || !chart.connector)) return none

  const coverage = (await tx.setting.findUnique({ where: { key: TRANSIT_COVERAGE_KEY }, select: { value: true } }))?.value?.trim() ?? ''
  const target = /^\d{4}-\d{2}-\d{2}$/.test(coverage)
    ? roundQuantity(await computeLandedFloorUnabsorbedTx(tx, params.poId, { coveredFrom: coverage, landedQtyBasis: params.landedQtyBasis }), 2)
    : new Prisma.Decimal(0)
  const posted = rows.reduce((sum, row) => sum.add(toDecimal(row.baseDelta)), new Prisma.Decimal(0))
  const delta = roundQuantity(target.sub(posted), 2)
  if (delta.isZero()) return none
  if (!chart || !chart.connector) {
    throw new LandedFloorCogsRefusal(
      `The accounting settings could not be read, so the supplier credit on ${params.poReference} that the stock cannot carry (${delta.abs().toFixed(2)}) `
      + 'was not posted and nothing was changed. Try again; if it persists check the database connection.',
    )
  }
  const connector = chart.connector

  const { queueAccountingSyncTx, readStockReceiptAccountsTx } = await import('@/lib/accounting')
  const { lockAccountingMappingSelection } = await import('@/lib/integration-plugin-selection-lock')
  await lockAccountingMappingSelection(tx, connector)
  const transitAccount = (await readStockReceiptAccountsTx(tx, connector)).transitAccount
  const cogsAccount = chart.cogsAccount?.trim() ?? ''
  if (!transitAccount || !cogsAccount) {
    throw new LandedFloorCogsRefusal(
      `The supplier credit on ${params.poReference} that the stock cannot carry (${delta.abs().toFixed(2)}) cannot be posted to cost of sales: `
      + `${!cogsAccount ? 'the COGS account' : 'the Stock in Transit account'} is not mapped. Nothing was changed. Map it under Sync > Accounting settings, then retry. `
      + '(Switching landed_cost_floor_cogs_enabled off does not stop this for an order that already has such a journal: it keeps being reconciled.)',
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
    chartConnector: connector,
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
    return { ...none, transitDelta: delta.toFixed(2) }
  }
  // A shadow leaves no row: the next event of the order computes the same difference again and, once the hold has lifted, queues it (the shadow's
  // own row is CANCELLED, so it does not dedupe a live one); while the hold stays, the credit remains in transit as a residue.
  if (answered.outcome && isShadowedOutcome(answered.outcome)) return { ...none, shadowed: { transitDelta: delta.toFixed(2) } }
  if (answered.outcome && postingIsOwed(answered.outcome)) return { ...none, notQueued: answered.outcome }
  return none
}

/** For a WMS path that must not refuse its book-in: the refusal becomes a result, reported after the commit (never swallowed). */
export async function reconcileLandedFloorCogsForWmsTx(
  tx: Client,
  params: Parameters<typeof reconcileLandedFloorCogsTx>[1],
): Promise<LandedFloorCogsResult> {
  try {
    return await reconcileLandedFloorCogsTx(tx, params)
  } catch (error) {
    if (!(error instanceof LandedFloorCogsRefusal)) throw error
    return { poId: params.poId, poReference: params.poReference, transitDelta: null, refused: error.message }
  }
}

/** AFTER the commit: report a declined, shadowed or refused floored-credit journal (an activity write uses its own connection). */
export async function reportLandedFloorCogsResults(results: ReadonlyArray<LandedFloorCogsResult | null | undefined>): Promise<void> {
  const { logActivity } = await import('@/lib/activity-log')
  const { reportPostingNotQueued } = await import('@/lib/domain/accounting/enqueue-outcome')
  for (const result of results) {
    if (!result) continue
    if (result.notQueued) {
      await reportPostingNotQueued({
        entityType: 'PURCHASE_ORDER',
        entityId: result.poId,
        action: 'landed_floor_cogs_not_queued',
        kind: 'landed_cost_cogs_journal',
        posting: `the journal posting the supplier credit on ${result.poReference} that the stock cannot carry to cost of sales`,
        committed: 'the receipt or landed-cost change is recorded in IMS',
        remedy: 'Stock in Transit still holds that credit. Leave the ledger as it is (a copy keyed in by hand would be booked twice): the next receipt or '
          + 'landed-cost recalculation of the order queues only what is still owed, then mark this row handled.',
        outcome: result.notQueued,
        metadata: { reference: result.poReference },
      })
    }
    if (result.shadowed) {
      await logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: result.poId,
        action: 'landed_floor_cogs_shadowed',
        tag: 'accounting',
        level: 'WARNING',
        description: `The journal posting ${result.shadowed.transitDelta} of the supplier credit on ${result.poReference} that the stock cannot carry to cost of sales was held by the outbound write hold: recorded, nothing sent. The next receipt or recalculation of the order queues it once the hold has lifted.`,
        metadata: { reference: result.poReference, transitDelta: result.shadowed.transitDelta },
        resolveUser: false,
      })
    }
    if (result.refused) {
      await logActivity({
        entityType: 'PURCHASE_ORDER',
        entityId: result.poId,
        action: 'landed_floor_cogs_refused',
        tag: 'accounting',
        level: 'WARNING',
        description: `${result.refused} The warehouse receipt itself was recorded.`,
        metadata: { reference: result.poReference },
        resolveUser: false,
      })
    }
  }
}
