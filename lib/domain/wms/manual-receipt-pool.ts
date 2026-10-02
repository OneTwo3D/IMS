/**
 * LOADING THE MANUAL-RECEIPT POOL A BOOK-IN RECONCILES AGAINST, AND THE BASELINE AN ASN ROW IS BORN WITH
 * (o3d-papk 6a follow-up, o3d-67kw3). The arithmetic and the brand live in `asn-reconciliation.ts`; this is
 * the one place that reads the columns, for purchase-order lines AND transfer lines alike, so the two cannot
 * drift (the defect was present in both by construction).
 *
 * Every function takes the TRANSACTION client of a caller that already holds the parent order's row lock
 * (`purchase_orders` / `stock_transfers`): every writer of `qtyReceived` and `lastProcessedReceivedQty` holds
 * that row first, so a read under it cannot interleave with one and no further lock is needed.
 */

import type { DecimalInput } from '@/lib/domain/math/decimal'
import { toDecimal } from '@/lib/domain/math/decimal'
import { resolveManualReceiptPool, type ManualReceiptPool } from '@/lib/domain/wms/asn-reconciliation'

export type ManualPoolSourceType = 'PURCHASE_ORDER_LINE' | 'STOCK_TRANSFER_LINE'

/** The minimum a client must expose: one query over the ASN rows of a set of source lines. */
export type ManualReceiptPoolClient = {
  wmsAsnLineMap: {
    findMany: (args: {
      where: { sourceType: ManualPoolSourceType; sourceLineId: { in: string[] } }
      select: { sourceLineId: true; lastProcessedReceivedQty: true }
    }) => Promise<Array<{ sourceLineId: string; lastProcessedReceivedQty: DecimalInput }>>
  }
}

/** Σ `lastProcessedReceivedQty` over EVERY ASN row (closed and retired included) of each source line, one query. */
async function loadReconciledAcrossAsns(
  client: ManualReceiptPoolClient,
  sourceType: ManualPoolSourceType,
  lineIds: string[],
): Promise<Map<string, number>> {
  const totals = new Map<string, number>()
  if (lineIds.length === 0) return totals
  const rows = await client.wmsAsnLineMap.findMany({
    where: { sourceType, sourceLineId: { in: lineIds } },
    select: { sourceLineId: true, lastProcessedReceivedQty: true },
  })
  for (const row of rows) {
    totals.set(row.sourceLineId, (totals.get(row.sourceLineId) ?? 0) + toDecimal(row.lastProcessedReceivedQty).toNumber())
  }
  return totals
}

/**
 * The manual receipts on each line that no ASN has reconciled yet: `max(0, qtyReceived - Σ lastProcessed)`.
 * This is what a creator stores as the new row's `manualQtyBaseline`. Every requested line has an entry.
 */
export async function loadUnreconciledManualReceiptQty(
  client: ManualReceiptPoolClient,
  sourceType: ManualPoolSourceType,
  lines: ReadonlyArray<{ id: string; qtyReceived: DecimalInput }>,
): Promise<Map<string, number>> {
  const reconciled = await loadReconciledAcrossAsns(client, sourceType, lines.map((line) => line.id))
  return new Map(lines.map((line) => [
    line.id,
    Math.max(0, toDecimal(line.qtyReceived).toNumber() - (reconciled.get(line.id) ?? 0)),
  ]))
}

/** One branded pool per ASN row, keyed by the ASN LINE MAP id: the line's unreconciled receipts less that row's baseline. */
export async function loadManualReceiptPools(
  client: ManualReceiptPoolClient,
  sourceType: ManualPoolSourceType,
  lines: ReadonlyArray<{ id: string; qtyReceived: DecimalInput }>,
  rows: ReadonlyArray<{ asnLineMapId: string; sourceLineId: string; manualQtyBaseline: DecimalInput }>,
): Promise<Map<string, ManualReceiptPool>> {
  const reconciled = await loadReconciledAcrossAsns(client, sourceType, lines.map((line) => line.id))
  const qtyReceivedByLine = new Map(lines.map((line) => [line.id, toDecimal(line.qtyReceived).toNumber()]))
  const pools = new Map<string, ManualReceiptPool>()
  for (const row of rows) {
    if (!qtyReceivedByLine.has(row.sourceLineId)) {
      throw new Error(
        `loadManualReceiptPools: no line was loaded for ${sourceType} ${row.sourceLineId}. `
        + 'Load the lines of the SAME rows being reconciled (o3d-papk).',
      )
    }
    pools.set(row.asnLineMapId, resolveManualReceiptPool({
      lineQtyReceived: qtyReceivedByLine.get(row.sourceLineId)!,
      lineReconciledAcrossAsns: reconciled.get(row.sourceLineId) ?? 0,
      rowManualQtyBaseline: toDecimal(row.manualQtyBaseline).toNumber(),
    }))
  }
  return pools
}

/** One row's pool out of the map, throwing rather than defaulting to "no manual receipts". */
export function requireManualReceiptPool(
  pools: ReadonlyMap<string, ManualReceiptPool>,
  asnLineMapId: string,
): ManualReceiptPool {
  const pool = pools.get(asnLineMapId)
  if (!pool) {
    throw new Error(
      `requireManualReceiptPool: no manual-receipt pool was loaded for ASN line ${asnLineMapId}. `
      + 'Load it with loadManualReceiptPools over the SAME rows being reconciled (o3d-papk).',
    )
  }
  return pool
}
