import { createHash } from 'node:crypto'

/**
 * MIXED-WAREHOUSE SCOPE: WHAT THE WAREHOUSE (WMS) PART OF AN ORDER IS, AS A PURE FUNCTION OF THE ORDER'S ALLOCATIONS.
 *
 * An order IMS allocates across several warehouses has one warehouse (the WMS one, `wmsWarehouseId`) whose goods the WMS despatches and
 * others IMS ships by hand. The push must send the WMS only its own part, and the despatch must apply only that part. This module decides
 * the part; it touches no database, no clock and no network, so every rule here is pinned by a table test.
 *
 * THE RULES (owner answers 2026-11-18):
 *  - Single warehouse (no allocation or shipment outside the WMS warehouse): mode FULL. The caller sends the order exactly as it always
 *    has; nothing here changes a byte of that payload.
 *  - Q1 UNALLOCATED UNITS: while any unit of a mixed order is not yet allocated, the push HOLDS (nothing is sent or amended).
 *  - Q4 KITS ARE WHOLE UNITS: a kit unit is sent whole or not at all. A kit whose components are allocated across warehouses inside one
 *    unit is REFUSED (an operator reallocates); it is never split into components.
 *  - Q2 SHIPPING goes with whichever part ships FIRST: the WMS part carries all of the shipping (and the VAT that is not on a goods line)
 *    unless a shipment in another warehouse has already SHIPPED, in which case the WMS part carries none.
 *  - Q3 DISCOUNT is pro-rated by the net value each part sends.
 *  - Money is apportioned in minor units (pence) with the LARGEST-REMAINDER method, so the parts always add up to the order exactly.
 */

export type ScopeRequirement = { productId: string; perUnit: string }

export type ScopeLineInput = {
  lineId: string
  sku: string | null
  description: string
  orderedQty: number
  /** Units refunded on this line (already removed from demand). */
  refundedQty: number
  /** The line's net (ex-VAT) total and its VAT, in MINOR units of the order currency. */
  netMinor: number
  vatMinor: number
  /** One unit's leaf requirements (the fulfilment-requirement seam). Empty = a line IMS holds no stock for (it stays with the WMS part). */
  requirements: ScopeRequirement[]
  /** A mirrored fee line: never goods, never pushed. */
  isFee: boolean
}

export type ScopeAllocationInput = { lineId: string; productId: string; warehouseId: string; qty: string | number }
export type ScopeShipmentInput = { id: string; warehouseId: string; status: string }

export type ScopeOrderMoney = {
  /** Order-level amounts in minor units. */
  discountMinor: number
  shippingMinor: number
  totalVatMinor: number
}

export type ScopedLine = {
  lineId: string
  sku: string
  description: string | null
  quantity: number
  /** Per ORIGINAL unit, in major units, computed exactly as the full push computes them. */
  unitPriceExVat: number
  unitPriceVat: number
}

export type MixedScope =
  | { mode: 'FULL' }
  | { mode: 'HOLD'; reason: string; unallocated: Array<{ lineId: string; missingUnits: number }> }
  | { mode: 'REFUSED'; reason: string; code: 'SPLIT_KIT' | 'FRACTIONAL_KIT'; lineIds: string[] }
  | { mode: 'EMPTY'; reason: string }
  | {
      mode: 'MIXED'
      lines: ScopedLine[]
      discountMinor: number
      shippingMinor: number
      vatMinor: number
      /** True when this part carries the order's shipping (no other warehouse has shipped yet). */
      shippingCarried: boolean
      hash: string
    }

/** Whole-number tolerance for decimal allocation quantities (the columns are Decimal(12,4)). */
const EPS = 1e-6

function toNumber(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Split `total` minor units across `weights` so the parts sum to `total` exactly: each gets its floor share, and the units left over go one
 * each to the largest fractional remainders (ties: the lower index, so the answer is deterministic). Negative totals apportion their
 * magnitude and negate. All-zero weights give the whole amount to index 0.
 */
export function apportionMinor(total: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  if (!Number.isInteger(total)) throw new Error(`apportionMinor needs whole minor units, got ${total}`)
  if (total < 0) return apportionMinor(-total, weights).map((part) => (part === 0 ? 0 : -part))
  const clean = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0))
  const sum = clean.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weights.map((_, index) => (index === 0 ? total : 0))
  const raw = clean.map((weight) => (total * weight) / sum)
  const floors = raw.map((value) => Math.floor(value))
  let left = total - floors.reduce((a, b) => a + b, 0)
  const order = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  const out = [...floors]
  for (const { index } of order) {
    if (left <= 0) break
    if (clean[index] <= 0) continue
    out[index] += 1
    left -= 1
  }
  // Only reachable if every positive-weight slot was already topped up once, which cannot happen (left < number of positive slots).
  if (left > 0) out[0] += left
  return out
}

type PerWarehouseUnits = Map<string, number>

/** Units of one line held per warehouse, plus the diagnostics the HOLD / REFUSED answers need. */
function lineUnitsByWarehouse(
  line: ScopeLineInput,
  allocations: ScopeAllocationInput[],
): { byWarehouse: PerWarehouseUnits; componentTotalUnits: number; splitKit: boolean; fractionalKit: boolean } {
  const byWarehouse: PerWarehouseUnits = new Map()
  const isKit = line.requirements.length > 1 || line.requirements.some((r) => Math.abs(toNumber(r.perUnit) - 1) > EPS)
  const mine = allocations.filter((alloc) => alloc.lineId === line.lineId)
  const warehouses = [...new Set(mine.map((alloc) => alloc.warehouseId))]
  let splitKit = false
  let fractionalKit = false
  let componentTotalUnits = Number.POSITIVE_INFINITY

  // Per component: units covered in all warehouses.
  for (const requirement of line.requirements) {
    const perUnit = toNumber(requirement.perUnit)
    if (perUnit <= 0) continue
    const total = mine.filter((alloc) => alloc.productId === requirement.productId).reduce((sum, alloc) => sum + toNumber(alloc.qty), 0)
    componentTotalUnits = Math.min(componentTotalUnits, total / perUnit)
  }
  if (!Number.isFinite(componentTotalUnits)) componentTotalUnits = 0

  for (const warehouseId of warehouses) {
    const counts = line.requirements
      .filter((requirement) => toNumber(requirement.perUnit) > 0)
      .map((requirement) => {
        const qty = mine
          .filter((alloc) => alloc.warehouseId === warehouseId && alloc.productId === requirement.productId)
          .reduce((sum, alloc) => sum + toNumber(alloc.qty), 0)
        return qty / toNumber(requirement.perUnit)
      })
    if (counts.length === 0) continue
    const first = counts[0]
    const same = counts.every((count) => Math.abs(count - first) < EPS)
    if (isKit) {
      if (!same) splitKit = true
      else if (Math.abs(first - Math.round(first)) > EPS) fractionalKit = true
    }
    byWarehouse.set(warehouseId, same ? first : Math.min(...counts))
  }
  return { byWarehouse, componentTotalUnits, splitKit, fractionalKit }
}

export type ComputeMixedScopeInput = {
  wmsWarehouseId: string
  lines: ScopeLineInput[]
  allocations: ScopeAllocationInput[]
  shipments: ScopeShipmentInput[]
  money: ScopeOrderMoney
  /** 10^minorUnits of the order currency, to turn the minor figures back into major units exactly as the full push does. */
  minorFactor: number
}

function roundHalfUp(value: number): number {
  return Math.round(value + Math.sign(value) * 1e-9)
}

export function computeMixedScope(input: ComputeMixedScopeInput): MixedScope {
  const { wmsWarehouseId } = input
  const otherWarehouses = new Set<string>()
  for (const alloc of input.allocations) if (alloc.warehouseId !== wmsWarehouseId) otherWarehouses.add(alloc.warehouseId)
  for (const shipment of input.shipments) if (shipment.warehouseId !== wmsWarehouseId) otherWarehouses.add(shipment.warehouseId)
  // A single-warehouse order is not this module's business.
  if (otherWarehouses.size === 0) return { mode: 'FULL' }

  const goods = input.lines.filter((line) => !line.isFee)
  const tracked = goods.filter((line) => line.requirements.length > 0)
  const perLine = new Map<string, ReturnType<typeof lineUnitsByWarehouse> & { demand: number }>()
  const unallocated: Array<{ lineId: string; missingUnits: number }> = []
  for (const line of tracked) {
    const demand = Math.max(0, line.orderedQty - line.refundedQty)
    if (demand <= 0) continue
    const units = lineUnitsByWarehouse(line, input.allocations)
    perLine.set(line.lineId, { ...units, demand })
    if (units.componentTotalUnits + EPS < demand) unallocated.push({ lineId: line.lineId, missingUnits: demand - units.componentTotalUnits })
  }
  // Q1: hold until every unit is allocated.
  if (unallocated.length > 0) {
    return {
      mode: 'HOLD',
      unallocated,
      reason: `${unallocated.length} line(s) still have unallocated units, so the warehouse order is held until every unit is allocated`,
    }
  }
  // Q4: a kit is whole units.
  const splitKitLines = [...perLine.entries()].filter(([, v]) => v.splitKit).map(([lineId]) => lineId)
  if (splitKitLines.length > 0) {
    return { mode: 'REFUSED', code: 'SPLIT_KIT', lineIds: splitKitLines, reason: 'A kit is allocated across warehouses inside one unit; reallocate it to a single warehouse' }
  }
  const fractionalKitLines = [...perLine.entries()].filter(([, v]) => v.fractionalKit).map(([lineId]) => lineId)
  if (fractionalKitLines.length > 0) {
    return { mode: 'REFUSED', code: 'FRACTIONAL_KIT', lineIds: fractionalKitLines, reason: 'A kit is allocated in part of a unit; reallocate it in whole units' }
  }

  // Units per line per part. Parts: the WMS warehouse (index 0) then the other warehouses in id order.
  const parts = [wmsWarehouseId, ...[...otherWarehouses].sort()]
  const unitsFor = (line: ScopeLineInput): number[] => {
    const info = perLine.get(line.lineId)
    if (!info) {
      // A line IMS holds no stock for (or fully refunded): the WMS part sends what the full push would (net of refunds) and no other part owns it.
      const demand = Math.max(0, line.orderedQty - line.refundedQty)
      return parts.map((_, index) => (index === 0 ? demand : 0))
    }
    return parts.map((warehouseId) => Math.min(info.byWarehouse.get(warehouseId) ?? 0, info.demand))
  }

  const partNet = parts.map(() => 0)
  const partVat = parts.map(() => 0)
  const sentLines: ScopedLine[] = []
  let goodsVatAll = 0
  const wmsLines: Array<{ line: ScopeLineInput; qty: number }> = []

  for (const line of goods) {
    const units = unitsFor(line)
    const ordered = line.orderedQty || 1
    goodsVatAll += line.vatMinor
    // Net per part, fractional minor units (only used as apportionment weight for the discount).
    units.forEach((qty, index) => { partNet[index] += (line.netMinor * qty) / ordered })
    // The line's VAT split across parts by units, exactly, in whole minor units.
    const vatShares = apportionMinor(line.vatMinor, units)
    vatShares.forEach((share, index) => { partVat[index] += share })
    if (units[0] > 0) wmsLines.push({ line, qty: units[0] })
  }

  if (wmsLines.length === 0) {
    return { mode: 'EMPTY', reason: 'No unit of this order is allocated to the warehouse this link serves' }
  }

  for (const { line, qty } of wmsLines) {
    if (!line.sku) throw new Error('Sales order has a line with no SKU; cannot push to WMS')
    const ordered = line.orderedQty || 1
    sentLines.push({
      lineId: line.lineId,
      sku: line.sku,
      description: line.description || null,
      quantity: qty,
      unitPriceExVat: line.netMinor / input.minorFactor / ordered,
      unitPriceVat: line.vatMinor / input.minorFactor / ordered,
    })
  }

  // Q3: the discount is pro-rated by the net each part sends.
  const discountShares = apportionMinor(input.money.discountMinor, partNet)
  // Q2: shipping, and the VAT that is not on a goods line, go with whichever part ships first.
  const otherShipped = input.shipments.some((shipment) => shipment.warehouseId !== wmsWarehouseId && shipment.status === 'SHIPPED')
  const shippingCarried = !otherShipped
  const residualVat = input.money.totalVatMinor - goodsVatAll
  const vatMinor = partVat[0] + (shippingCarried ? residualVat : 0)
  const shippingMinor = shippingCarried ? input.money.shippingMinor : 0
  const discountMinor = discountShares[0]

  const canonical = JSON.stringify({
    lines: sentLines.map((line) => [line.lineId, line.sku, line.quantity]),
    discountMinor,
    shippingMinor,
    vatMinor,
  })
  const hash = createHash('sha256').update(canonical).digest('hex')
  return { mode: 'MIXED', lines: sentLines, discountMinor, shippingMinor, vatMinor, shippingCarried, hash }
}

/** Minor units from a major-unit amount (a Decimal string/number), half-up. */
export function toMinorUnits(value: number, minorFactor: number): number {
  return roundHalfUp(value * minorFactor)
}
