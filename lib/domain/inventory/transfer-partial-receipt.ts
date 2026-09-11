/**
 * Pure planning for manual partial transfer receipts. Lives in a plain module
 * (NOT a `'use server'` file) so it can be exported and unit-tested — a
 * `'use server'` action file may only export async functions.
 */

import { transferLineOutstandingQty, type TransferLineLandedQty } from '@/lib/domain/inventory/transfer-landed-quantity'

export type TransferReceiptPlanLine = { lineId: string; receiveQty: number }

/**
 * Cap each requested per-line delta to what has NOT yet landed.
 *
 * Takes `landed` rather than `qtyReceived` (6oyu.19, Codex round-6 HIGH-1): a line
 * the WMS stock-sync alignment has already brought into stock has a `qtyReceived` of
 * zero, so capping on that column offered its units up to be received — and layered
 * — a second time. `TransferLineLandedQty` can only be built by
 * lib/domain/inventory/transfer-landed-quantity, so this planner and the paths that
 * act on its output cannot answer the question differently.
 */
export function planTransferPartialReceipt(
  lines: ReadonlyArray<{ id: string; qty: number; landed: TransferLineLandedQty }>,
  requested: ReadonlyArray<{ lineId: string; qty: number }>,
): { plan: TransferReceiptPlanLine[]; fullyReceivedAfter: boolean } {
  const lineById = new Map(lines.map((line) => [line.id, line]))
  const requestedById = new Map<string, number>()
  for (const item of requested) {
    if (!lineById.has(item.lineId)) continue
    if (!Number.isFinite(item.qty) || item.qty <= 0) continue
    requestedById.set(item.lineId, (requestedById.get(item.lineId) ?? 0) + item.qty)
  }

  const plan: TransferReceiptPlanLine[] = []
  for (const [lineId, requestedQty] of requestedById) {
    const line = lineById.get(lineId)!
    const remaining = transferLineOutstandingQty(line.qty, line.landed).toNumber()
    const receiveQty = Math.min(requestedQty, remaining)
    if (receiveQty > 0) plan.push({ lineId, receiveQty })
  }

  const receivedById = new Map(plan.map((p) => [p.lineId, p.receiveQty]))
  const fullyReceivedAfter = lines.every(
    (line) => line.landed.qtyNumber + (receivedById.get(line.id) ?? 0) >= line.qty,
  )
  return { plan, fullyReceivedAfter }
}
