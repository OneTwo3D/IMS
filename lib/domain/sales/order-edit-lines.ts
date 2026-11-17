/**
 * Which saved order line each edited line continues: the saved line's id, or null for a line added by the edit. Pure.
 * A line naming its saved line (`orderLineId`) continues it only when that line belongs to the order, is not claimed by another edited line and carries the same product (a different product is a different line). A line that names none
 * continues the first saved line of the same product nothing else claimed; a line that names one that does not fit is new. A saved line no edited line continues is removed by the edit.
 */
export function matchContinuedOrderLines(existing: readonly { id: string; productId: string | null }[], edited: readonly { productId: string; orderLineId?: string }[]): (string | null)[] {
  const byId = new Map(existing.map((line) => [line.id, line]))
  const claimed = new Set<string>()
  const result: (string | null)[] = edited.map(() => null)
  edited.forEach((line, index) => {
    if (!line.orderLineId) return
    const saved = byId.get(line.orderLineId)
    if (saved && !claimed.has(saved.id) && saved.productId === line.productId) { claimed.add(saved.id); result[index] = saved.id }
  })
  edited.forEach((line, index) => {
    if (line.orderLineId || result[index] !== null) return
    const saved = existing.find((candidate) => !claimed.has(candidate.id) && candidate.productId === line.productId)
    if (saved) { claimed.add(saved.id); result[index] = saved.id }
  })
  return result
}

