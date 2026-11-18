import type { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings, queueAccountingSyncTxWithOutcome } from '@/lib/accounting'
import { withSavepoint } from '@/lib/db/savepoint'
import { postingIsOwed, reportPostingNotQueued, type EnqueueOutcomeLike } from '@/lib/domain/accounting/enqueue-outcome'
import type { PostingRefusalClient } from '@/lib/domain/accounting/posting-refusal-inbox'
import { buildInventoryAdjustmentJournal } from '@/lib/domain/inventory/stock-adjustment-apply'
import { getAverageUnitCost, getHistoricalAverageUnitCost } from '@/lib/cost-layers'
import type { RefundReturnRow } from '@/lib/domain/sales/refund-service'

/**
 * Layers whose cost an operator or a receipt stated: a purchase receipt line, a manual adjustment, opening stock, or a
 * production order. A zero-cost transfer BALANCING layer (written when a dispatch snapshot could not cost the units)
 * carries none of these links, and a layer with nothing received is no evidence of a cost either: neither makes a
 * zero cost "genuinely free". The test only matters when every average is 0, so every layer it sees is at 0.
 */
const EXPLICIT_COST_LAYER_FILTER: Prisma.CostLayerWhereInput = {
  receivedQty: { gt: 0 },
  OR: [
    { poLineId: { not: null } },
    { adjustmentMovementId: { not: null } },
    { isOpeningStock: true },
    { productionOrderId: { not: null } },
  ],
}

/**
 * Takes the units of an UNPRICED returns-inbox row that a refund already restocked (or whose expectation covers them)
 * out of the restock, so the same returned unit is never valued and journalled twice.
 *
 * A refund that restocks at once books RETURN_INBOUND (referenceType SalesOrderRefund) with its own COGS reversal, and a
 * refund routed in transit keeps an expectation whose arrival is priced at the refund's cost. The parcel's inbox row then
 * arrives with nothing to price it by, and pricing it at the average would credit the same unit a second time. Cover =
 * units restocked by this order's refunds + units its expectations hold (net of write-offs), minus what earlier inbox
 * restocks and this arrival's own expectation match already used. Only the uncovered remainder is returned for valuing.
 * `coveredQty` > 0 means some units were refused: the operator marks that item Refunded only.
 */
export async function netUnpricedReturnRowsAgainstRefunds(
  tx: Prisma.TransactionClient,
  params: { inboxId: string; orderId: string; rows: readonly RefundReturnRow[] },
): Promise<{ rows: RefundReturnRow[]; coveredQty: number }> {
  const out: RefundReturnRow[] = []
  let coveredQty = 0
  const refunds = await tx.salesOrderRefund.findMany({ where: { orderId: params.orderId, deletedAt: null }, select: { id: true } })
  const refundIds = refunds.map((r) => r.id)
  for (const row of params.rows) {
    if (row.unitCostBase != null || !(row.qty > 0)) {
      out.push(row)
      continue
    }
    const productId = row.productId
    const restockedByRefunds = refundIds.length === 0 ? 0 : Number((await tx.stockMovement.aggregate({
      where: { type: 'RETURN_INBOUND', referenceType: 'SalesOrderRefund', referenceId: { in: refundIds }, productId },
      _sum: { qty: true },
    }))._sum.qty ?? 0)
    const expectationLines = await tx.returnExpectationLine.findMany({
      where: { productId, expectation: { orderId: params.orderId } },
      select: { qty: true, qtyWrittenOff: true },
    })
    const expected = expectationLines.reduce((sum, l) => sum + Number(l.qty) - Number(l.qtyWrittenOff), 0)
    const inboxes = await tx.wmsReturnsInbox.findMany({
      where: { orderId: params.orderId, productId, id: { not: params.inboxId } },
      select: { id: true },
    })
    const priorInbox = inboxes.length === 0 ? 0 : Number((await tx.stockMovement.aggregate({
      where: { type: 'RETURN_INBOUND', referenceType: 'WmsReturnsInbox', referenceId: { in: inboxes.map((i) => i.id) }, productId },
      _sum: { qty: true },
    }))._sum.qty ?? 0)
    // This arrival's own expectation-matched rows (already priced) used up part of the expectation cover.
    const matchedNow = params.rows.filter((r) => r.productId === productId && r.unitCostBase != null).reduce((sum, r) => sum + r.qty, 0)
    const available = Math.max(0, restockedByRefunds + expected - priorInbox - matchedNow)
    const covered = Math.min(available, row.qty)
    coveredQty += covered
    const remainder = Math.round((row.qty - covered) * 1e6) / 1e6
    if (remainder > 0) out.push({ ...row, qty: remainder })
  }
  return { rows: out, coveredQty }
}

/**
 * Gives every unpriced row of a returns-inbox restock a unit cost, so the units enter stock with a cost layer.
 *
 * A row the refund's return expectation covered arrives priced (its own dispatch cost). Whatever no expectation
 * covers (an over-return, a legacy refund that already restocked, no refund at all) used to go in with no unit
 * cost: on-hand stock with no cost layer and a zero-value movement, which later sells at zero COGS. Such a row is
 * valued the way a manual stock addition is: the warehouse's current average layer cost, else the product's
 * historical average. With no cost basis anywhere the restock is refused, never booked at zero. A product whose
 * cost is legitimately zero (every layer at 0, or a NON_INVENTORY product) is restocked at 0; only a product with
 * no cost layers at all is refused.
 *
 * Whatever this prices adds inventory value, so the caller must journal it: see `queueReturnRestockValueJournal`.
 */
export async function priceUnpricedReturnRows(
  tx: Prisma.TransactionClient,
  warehouseId: string,
  rows: readonly RefundReturnRow[],
): Promise<RefundReturnRow[]> {
  const priced: RefundReturnRow[] = []
  for (const row of rows) {
    if (row.unitCostBase != null) {
      priced.push(row)
      continue
    }
    const warehouseAverage = await getAverageUnitCost(tx, row.productId, warehouseId)
    const unitCostBase = warehouseAverage > 0 ? warehouseAverage : await getHistoricalAverageUnitCost(tx, row.productId)
    if (!(unitCostBase > 0)) {
      // Averages of 0 mean either "layers exist and are all at 0" (genuinely zero-cost: samples, free gifts) or
      // "no layers at all" (no cost basis). Only the second is refused.
      const product = await tx.product.findUnique({ where: { id: row.productId }, select: { type: true } })
      const layerCount = product?.type === 'NON_INVENTORY'
        ? 1
        : await tx.costLayer.count({ where: { productId: row.productId, ...EXPLICIT_COST_LAYER_FILTER } })
      if (layerCount === 0) {
        throw new Error(
          'This returned item cannot be restocked because no unit cost could be derived for the product (it has no cost layer from a receipt or an operator-entered cost). Receive stock for it with a unit cost first (use 0 only for genuinely zero-cost stock), then restock the return.',
        )
      }
    }
    priced.push({ ...row, unitCostBase })
  }
  return priced
}

/**
 * Journals the inventory value `priceUnpricedReturnRows` added, in the restock's own transaction, so the Inventory GL
 * ties to the cost layers. Same posting as a manual stock addition (`applyStockAdjustment`): Dr Inventory / Cr the
 * adjustment reason's account (the stock-gain / inventory-adjustment account), NOT COGS: the units priced here are ones
 * no refund reversal covers (an over-return, or a unit whose sale booked no COGS), so no COGS was ever debited for them.
 * Built by `buildInventoryAdjustmentJournal`, with the same owed-posting handling; an unmapped reason account is owed. `originalRows` are the rows BEFORE pricing; only those that arrived unpriced are valued.
 * Nothing is queued when the value is zero or no COGS / Inventory account is mapped (as a manual adjustment).
 */
export async function queueReturnRestockValueJournal(
  tx: Prisma.TransactionClient,
  params: {
    inboxId: string
    warehouse: { id: string; code: string; name: string }
    originalRows: readonly RefundReturnRow[]
    pricedRows: readonly RefundReturnRow[]
    /** The adjustment reason chosen for the restock, whose accountCode is the Cr side; null when none was chosen. */
    adjustmentReasonId?: string | null
  },
): Promise<void> {
  const byProduct = new Map<string, { qty: number; value: number }>()
  params.pricedRows.forEach((row, index) => {
    if (params.originalRows[index]?.unitCostBase != null) return
    const entry = byProduct.get(row.productId) ?? { qty: 0, value: 0 }
    entry.qty += row.qty
    entry.value += row.qty * Number(row.unitCostBase ?? 0)
    byProduct.set(row.productId, entry)
  })
  if (byProduct.size === 0) return
  const settings = await getAccountingSettings()
  const reason = params.adjustmentReasonId
    ? await tx.adjustmentReason.findUnique({ where: { id: params.adjustmentReasonId }, select: { name: true, accountCode: true } })
    : null
  const reasonAccountCode = reason?.accountCode ?? ''
  for (const [productId, { qty, value }] of byProduct) {
    if (!(value > 0)) continue
    const product = await tx.product.findUnique({ where: { id: productId }, select: { sku: true, name: true } })
    const journal = buildInventoryAdjustmentJournal({
      reasonAccountCode,
      inventoryAccountCode: settings.inventoryAccount,
      productSku: product?.sku ?? productId,
      productName: product?.name ?? '',
      warehouseCode: params.warehouse.code,
      warehouseName: params.warehouse.name,
      qty,
      totalValueBase: value,
      note: reason?.name ? `Returns-inbox restock: ${reason.name}` : 'Returns-inbox restock',
    })
    if (!journal) {
      // No reason account (none chosen, or it has no GL code) or no Inventory account: the value entered stock but the
      // ledger was told nothing. Owed, like any unqueued posting; a missing connector account is `not-configured`.
      if (!reasonAccountCode && settings.inventoryAccount) {
        // Nothing was enqueued: no reason account means no journal to enqueue. The owed outcome is held by name and
        // forwarded, as the manufacturing journal does for a retired chart, never built inline at the report.
        const unmappedAccountOutcome: EnqueueOutcomeLike = { queued: false, reason: 'refused', connector: settings.connector }
        await reportPostingNotQueued({
          entityType: 'STOCK_ADJUSTMENT',
          entityId: params.inboxId,
          action: 'inventory_adjustment_journal_not_queued',
          kind: 'returns_inbox_restock_journal',
          posting: `the inventory journal for the restocked return of ${product?.sku ?? productId} at ${params.warehouse.name}`,
          committed: 'the return stock movement and its cost layer are written in IMS',
          remedy: 'Choose an adjustment reason with a GL account when restocking. Inventory in the ledger no longer matches IMS by the value of this restock; post the journal by hand (Dr Inventory / Cr the stock-gain account).',
          outcome: unmappedAccountOutcome,
          metadata: { inboxId: params.inboxId, productId, warehouseId: params.warehouse.id, adjustmentReasonId: params.adjustmentReasonId ?? null, chartConnector: settings.connector },
          inTransaction: {
            client: tx as unknown as PostingRefusalClient,
            withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
          },
        })
      }
      continue
    }
    const enqueued = await queueAccountingSyncTxWithOutcome(tx, {
      type: 'INVENTORY_ADJUSTMENT',
      referenceType: 'WmsReturnsInbox',
      referenceId: params.inboxId,
      payload: journal as unknown as Record<string, unknown>,
      chartConnector: settings.connector,
      recordRefusalAsOutstanding: true,
    })
    if (postingIsOwed(enqueued)) {
      await reportPostingNotQueued({
        entityType: 'STOCK_ADJUSTMENT',
        entityId: params.inboxId,
        action: 'inventory_adjustment_journal_not_queued',
        kind: 'returns_inbox_restock_journal',
        posting: `the inventory journal for the restocked return of ${product?.sku ?? productId} at ${params.warehouse.name}`,
        committed: 'the return stock movement and its cost layer are written in IMS',
        remedy: 'Inventory in the ledger no longer matches IMS by the value of this restock. Post the journal by hand.',
        outcome: enqueued,
        metadata: { inboxId: params.inboxId, productId, warehouseId: params.warehouse.id, chartConnector: settings.connector },
        inTransaction: {
          client: tx as unknown as PostingRefusalClient,
          withSavepoint: <T,>(fn: () => Promise<T>) => withSavepoint(tx, fn),
        },
      })
    }
  }
}
