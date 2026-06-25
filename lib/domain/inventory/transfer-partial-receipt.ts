/**
 * Pure planning for manual partial transfer receipts. Lives in a plain module
 * (NOT a `'use server'` file) so it can be exported and unit-tested — a
 * `'use server'` action file may only export async functions.
 */

export type TransferReceiptPlanLine = { lineId: string; receiveQty: number }

/** Cap each requested per-line delta to its remaining (qty − qtyReceived). */
export function planTransferPartialReceipt(
  lines: ReadonlyArray<{ id: string; qty: number; qtyReceived: number }>,
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
    const remaining = Math.max(0, line.qty - line.qtyReceived)
    const receiveQty = Math.min(requestedQty, remaining)
    if (receiveQty > 0) plan.push({ lineId, receiveQty })
  }

  const receivedById = new Map(plan.map((p) => [p.lineId, p.receiveQty]))
  const fullyReceivedAfter = lines.every(
    (line) => line.qtyReceived + (receivedById.get(line.id) ?? 0) >= line.qty,
  )
  return { plan, fullyReceivedAfter }
}
