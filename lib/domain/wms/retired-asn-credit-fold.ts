/**
 * FOLDING THE WAREHOUSE-SNAPSHOT CREDIT OF A RETIRED ASN INTO THE PURCHASE ORDER'S RECEIVED QUANTITY.
 *
 * A stock-sync alignment brings units into stock and credits `wms_asn_line_maps.qtyAccountedViaSnapshot` without writing
 * `purchase_order_lines.qtyReceived`. A booked-in callback later folds that credit into `qtyReceived`; while an ASN is open the
 * operator's "Recheck booked-in" drives that. Once the ASN is RETIRED (`closedAt` set, its expectation shrunk to the credit)
 * nothing re-drives it, so the credit stays unabsorbed for ever and the PO can neither be closed nor have those units returned.
 *
 * This is the operator-side reconcile. It does exactly what the booked-in service does for units a snapshot already covers
 * (`coveredBySnapshotQty`): `qtyReceived`, `qtyAccountedViaReceipt` and `lastProcessedReceivedQty` rise together, a receipt row
 * records it, and a zero-quantity audit movement marks it. It adds NO stock and NO cost layer and posts NO journal: the
 * alignment already did all three. The line's landed quantity (`qtyReceived + unabsorbed snapshot`) is therefore unchanged.
 *
 * It only touches RETIRED rows (`closedAt` not null). The caller holds the `purchase_orders` row lock and has checked that no
 * live ASN exists for the order, because a live ASN's manual-receipt pool is derived from `qtyReceived`.
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { addMoney, roundQuantity, subtractMoney, toDecimal } from '@/lib/domain/math/decimal'
import { buildStockMovementValueFields } from '@/lib/domain/inventory/stock-movement-value'
import { PO_LANDED_QTY_EPSILON } from '@/lib/domain/inventory/po-line-landed-quantity'

export type RetiredAsnCreditFoldLine = {
  asnLineMapId: string
  poLineId: string
  sku: string | null
  foldedQty: number
}

export async function foldRetiredAsnCreditIntoPurchaseOrder(
  tx: Prisma.TransactionClient,
  input: { poId: string; reference: string; poLineIds: readonly string[] },
): Promise<{ lines: RetiredAsnCreditFoldLine[]; foldedQty: number }> {
  if (input.poLineIds.length === 0) return { lines: [], foldedQty: 0 }
  const rows = await tx.wmsAsnLineMap.findMany({
    where: {
      sourceType: 'PURCHASE_ORDER_LINE',
      sourceLineId: { in: [...input.poLineIds] },
      asn: { closedAt: { not: null } },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      sourceLineId: true,
      sku: true,
      productId: true,
      expectedQty: true,
      lastProcessedReceivedQty: true,
      qtyAccountedViaSnapshot: true,
      qtyAccountedViaReceipt: true,
      asn: { select: { warehouseId: true } },
    },
  })

  const folds: Array<{ row: (typeof rows)[number]; delta: number }> = []
  for (const row of rows) {
    const delta = roundQuantity(
      subtractMoney(toDecimal(row.qtyAccountedViaSnapshot), toDecimal(row.qtyAccountedViaReceipt)),
      4,
    ).toNumber()
    if (delta > PO_LANDED_QTY_EPSILON) folds.push({ row, delta })
  }
  if (folds.length === 0) return { lines: [], foldedQty: 0 }

  const receiptKey = `wms-snapshot-fold:${input.poId}:${folds.map((f) => `${f.row.id}=${f.delta}`).join(',')}`
  await tx.purchaseReceipt.create({
    data: {
      poId: input.poId,
      reference: `${input.reference}-WMS-FOLD`,
      externalKey: receiptKey.length > 250 ? receiptKey.slice(0, 250) : receiptKey,
      notes: 'Warehouse stock credit on a retired ASN folded into the received quantity (no stock added)',
      lines: {
        create: folds.map(({ row, delta }) => ({
          poLineId: row.sourceLineId,
          qtyReceived: delta,
          coveredBySnapshotQty: delta,
          warehouseId: row.asn.warehouseId,
        })),
      },
    },
  })

  let total = toDecimal(0)
  for (const { row, delta } of folds) {
    await tx.purchaseOrderLine.update({ where: { id: row.sourceLineId }, data: { qtyReceived: { increment: delta } } })
    const headroom = Math.max(0, Number(row.expectedQty) - Number(row.lastProcessedReceivedQty))
    await tx.wmsAsnLineMap.update({
      where: { id: row.id },
      data: {
        qtyAccountedViaReceipt: { increment: delta },
        lastProcessedReceivedQty: { increment: Math.min(delta, headroom) },
      },
    })
    await tx.stockMovement.create({
      data: {
        type: 'WMS_RECEIPT_RECONCILIATION',
        productId: row.productId,
        toWarehouseId: row.asn.warehouseId,
        qty: 0,
        ...buildStockMovementValueFields({ qty: 0, unitCostBase: 0 }),
        note: `Retired ASN credit of ${delta} folded into ${input.reference}`,
        referenceType: 'WmsAsnLineMap',
        referenceId: row.id,
      },
    })
    total = addMoney(total, toDecimal(delta))
  }
  return {
    lines: folds.map(({ row, delta }) => ({ asnLineMapId: row.id, poLineId: row.sourceLineId, sku: row.sku, foldedQty: delta })),
    foldedQty: total.toNumber(),
  }
}
