import type { Prisma } from '@/app/generated/prisma/client'
import { getAccountingSettings, queueAccountingSyncTxWithOutcome } from '@/lib/accounting'
import { withSavepoint } from '@/lib/db/savepoint'
import { postingIsOwed, reportPostingNotQueued } from '@/lib/domain/accounting/enqueue-outcome'
import type { PostingRefusalClient } from '@/lib/domain/accounting/posting-refusal-inbox'
import { buildInventoryAdjustmentJournal } from '@/lib/domain/inventory/stock-adjustment-apply'
import { getAverageUnitCost, getHistoricalAverageUnitCost } from '@/lib/cost-layers'
import type { RefundReturnRow } from '@/lib/domain/sales/refund-service'

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
      const layerCount = product?.type === 'NON_INVENTORY' ? 1 : await tx.costLayer.count({ where: { productId: row.productId } })
      if (layerCount === 0) {
        throw new Error(
          'This returned item cannot be restocked because no unit cost could be derived for the product (it has no cost layers). Receive stock for it with a unit cost first (use 0 only for genuinely zero-cost stock), then restock the return.',
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
 * COGS account (the return reverses the cost the sale booked), through `buildInventoryAdjustmentJournal`, with the
 * same owed-posting handling. `originalRows` are the rows BEFORE pricing; only those that arrived unpriced are valued.
 * Nothing is queued when the value is zero or no COGS / Inventory account is mapped (as a manual adjustment).
 */
export async function queueReturnRestockValueJournal(
  tx: Prisma.TransactionClient,
  params: {
    inboxId: string
    warehouse: { id: string; code: string; name: string }
    originalRows: readonly RefundReturnRow[]
    pricedRows: readonly RefundReturnRow[]
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
  for (const [productId, { qty, value }] of byProduct) {
    if (!(value > 0)) continue
    const product = await tx.product.findUnique({ where: { id: productId }, select: { sku: true, name: true } })
    const journal = buildInventoryAdjustmentJournal({
      reasonAccountCode: settings.cogsAccount,
      inventoryAccountCode: settings.inventoryAccount,
      productSku: product?.sku ?? productId,
      productName: product?.name ?? '',
      warehouseCode: params.warehouse.code,
      warehouseName: params.warehouse.name,
      qty,
      totalValueBase: value,
      note: 'Returns-inbox restock',
    })
    if (!journal) continue
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
