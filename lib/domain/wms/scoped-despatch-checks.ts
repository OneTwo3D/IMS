/**
 * The two checks a SCOPED despatch makes before it ships anything: the part the warehouse was sent is still the part IMS holds for it, and the warehouse's
 * shipments in IMS are exactly that part. Either failing is `wms_scope_mismatch`: nothing is shipped, a person is told, and it is retried (the dispatch is
 * not lost; once the shipments or the scope are put right the same despatch applies).
 *
 * Pure: the callers read the rows.
 */

const EPS = 1e-6

export type ScopeQtyLine = { lineId: string; quantity: number | string }
export type KeyedQty = { lineId: string; productId: string; qty: number | string }

function num(value: number | string): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** The scope IMS would send now carries exactly the units the recorded (sent) scope carried, line by line. */
export function sameScopeLines(sent: ScopeQtyLine[], current: ScopeQtyLine[]): boolean {
  const byLine = (lines: ScopeQtyLine[]): Map<string, number> => {
    const map = new Map<string, number>()
    for (const line of lines) map.set(line.lineId, (map.get(line.lineId) ?? 0) + num(line.quantity))
    return map
  }
  const a = byLine(sent)
  const b = byLine(current)
  if (a.size !== b.size) return false
  for (const [lineId, qty] of a) {
    const other = b.get(lineId)
    if (other === undefined || Math.abs(other - qty) > EPS) return false
  }
  return true
}

/**
 * The warehouse's shipments (every status: a shipment already shipped is part of what was sent) hold exactly the leaf quantities the allocations in the
 * warehouse hold, per (order line, product). Returns a sentence naming the first difference, or null when they agree.
 */
export function warehouseShipmentsMatchAllocations(shipmentLines: KeyedQty[], allocations: KeyedQty[]): string | null {
  const total = (rows: KeyedQty[]): Map<string, number> => {
    const map = new Map<string, number>()
    for (const row of rows) map.set(`${row.lineId}|${row.productId}`, (map.get(`${row.lineId}|${row.productId}`) ?? 0) + num(row.qty))
    return map
  }
  const shipped = total(shipmentLines)
  const allocated = total(allocations)
  for (const key of new Set([...shipped.keys(), ...allocated.keys()])) {
    const have = shipped.get(key) ?? 0
    const want = allocated.get(key) ?? 0
    if (Math.abs(have - want) > EPS) {
      return `the warehouse's shipments hold ${have} of an item (order line ${key.split('|')[0]}) where ${want} is allocated to the warehouse`
    }
  }
  return null
}
