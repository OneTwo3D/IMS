/**
 * ITEMS R7 AND R8: THE OPEN PURCHASE ORDERS, IMS AGAINST THE QOBLEX INCOMING REPORT (qoblex-source.ts, the `purchaseOrders` part).
 *
 * Both apply at phase P2 only (the catalogue): before the purchase-order load there is nothing in IMS to compare, so at P0 and P1 the item
 * is not-applicable and NOTHING is read (no file, no database). Without --qoblex-export the run reports QOBLEX_EXPORT_OFF before either is
 * called (run.ts). Each stands on one Qoblex read and one IMS read (one READ ONLY REPEATABLE READ transaction).
 *
 * THE IDENTITY IS A RECORDED ONE. The first load put the Qoblex order number into IMS as the purchase-order REFERENCE, behind a prefix
 * (the first-load manifest's purchaseOrderKeyPrefix, lib/first-load/transform.ts): the IMS reference IS prefix + Qoblex number. The export
 * manifest declares that prefix; an IMS order is matched to a Qoblex one only when its reference is exactly that prefix followed by a plain
 * order number. No other formatting is ever tried (no case folding, trimming or digit extraction). An IMS order whose reference does not
 * carry the prefix is an IMS-only identity, keyed by its own id (an order IMS made itself, or one the prefix does not explain) and so a
 * finding, never skipped.
 *
 * THE POPULATION IS IMS'S, NOT THE FILE'S (the R2 and R5 lesson). The IMS set is EVERY goods purchase order in a committed-incoming status
 * (PO_SENT, SHIPPED, PARTIALLY_RECEIVED: lib/domain/inventory/po-status-sets.ts, the one definition the product page's Incoming figure uses),
 * read whole, and a first load that is not recorded VERIFIED is NO_POPULATION_RECORD. The Qoblex set is every order in the report with a
 * quantity still outstanding. Neither the manifest, the prefix nor the file can take an IMS order out of the comparison: an order the file
 * omits is onlyIms, one it adds is onlyVendor, one the prefix fails to explain is onlyIms and onlyVendor. A DRAFT or quote order is not
 * incoming supply on either side by definition, so one that Qoblex lists as open is onlyVendor. An order with a header discount, a freight
 * order and a non-goods order are not in the figure (stated limit: the figure is the lines' outstanding value).
 *
 *   R7  The identity is the Qoblex order number. The set is exact. The value is the order's OUTSTANDING value in GBP: IMS = the sum over its
 *       lines of (qty - qtyReceived) x the stored unitCostBase (the rate fixed when the order was created, so IMS's foreign exchange source is
 *       its own stored rate); Qoblex = the sum over its lines of (ordered - received) x (price / rate), the unit rounded half-up to six
 *       decimals, the rate being the one the pinned native map gives the supplier's currency (qoblex-native-map.ts: a fixed table in the
 *       repository, not a market rate). The catalogue's rule: an order in GBP on both sides must agree EXACTLY, any other order within GBP 1,
 *       inclusive. The GBP rule is carried as a second identity per such order (`<order>|value-exact-gbp`) whose two values are 0 and the
 *       difference in millionths of a pound, so the catalogue's GBP 1 tolerance can only be met by an exact match to the stored precision.
 *       An order whose currency differs between the two sides is CURRENCY_UNKNOWN (no foreign exchange statement is made across a currency
 *       disagreement). An order with nothing outstanding is in the set only if IMS holds it in an incoming status (an incoming status with
 *       nothing outstanding is a finding: Qoblex lists no such order).
 *   R8  The identity is (Qoblex order number, SKU), the line identity the first load recorded (the report has no line number, so a
 *       repeated (order, SKU) on either side is DUPLICATE_KEY, never summed). The value is the outstanding quantity (ordered - received),
 *       EXACT (0.0001). Every open line is compared, which includes every part-received line; a line with nothing outstanding is no line on
 *       either side (as a zero position is none in R2). An outstanding quantity below zero (received above ordered) is BAD_VALUE.
 *
 * Both: an empty comparison (no outstanding order on either side) passes only on the named proof qoblex-incoming-report-empty, which needs
 * the report to have been read and IMS to have been read to the end in the same snapshot. Every malformed, missing, duplicate or unstable
 * input is inconclusive with a closed reason; nothing is converted or guessed. The module never throws.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { compareItem, decimalText, outcomeOfComparison, parseDecimalStrict, type CompareResult, type SideRow } from '@/lib/reconciliation-pack/compare'
import { QOBLEX_BASE_CURRENCY, QOBLEX_PO_NUMBER_RE, itemApplicability, type PackReasonCode, type PackSourceCode } from '@/lib/reconciliation-pack/constants'
import type { KeyPart } from '@/lib/reconciliation-pack/identity'
import type { ImsRead, ImsReadOptions, PoRow } from '@/lib/reconciliation-pack/ims-readers'
import type { QoblexPoLine, QoblexSource } from '@/lib/reconciliation-pack/qoblex-source'
import type { ItemInput } from '@/lib/reconciliation-pack/report'
import type { ReadinessPhase } from '@/lib/ops/readiness-gate-constants'

export const PO_ITEM_IDS = ['R7', 'R8'] as const
export type PoItemId = (typeof PO_ITEM_IDS)[number]
export function isPoItem(id: string): id is PoItemId {
  return (PO_ITEM_IDS as readonly string[]).includes(id)
}

export type PoItemContext = {
  phase?: ReadinessPhase
  ims?: (options: ImsReadOptions) => Promise<ImsRead>
  /** Absent = the run named no export: the item reads nothing. */
  qoblex?: QoblexSource
}

const IMS: PackSourceCode = 'ims-database'
const QOBLEX: PackSourceCode = 'qoblex-file'
const SOURCES: readonly PackSourceCode[] = [IMS, QOBLEX]

/** The second identity of an order in GBP on both sides (see the header): a fixed word, not data. */
export const VALUE_EXACT_GBP_TOKEN = 'value-exact-gbp'

const Dec = Prisma.Decimal
type Dec = Prisma.Decimal
const MICRO = new Dec(1_000_000)

const inconclusive = (id: PoItemId, sources: readonly PackSourceCode[], ...reasons: PackReasonCode[]): ItemInput => ({ id, outcome: 'inconclusive', reasons: [...new Set(reasons)], sources: [...sources] })

function fromComparison(id: PoItemId, result: CompareResult): ItemInput {
  const verdict = outcomeOfComparison(result)
  const proof = verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null
  return { id, outcome: verdict.outcome, reasons: verdict.reasons, proof, sources: [...SOURCES], entries: result.status === 'compared' ? result.buckets : undefined }
}

// ---------------------------------------------------------------------------------------------
// One side each, as { identity -> figures }. Built before anything is compared; a malformed input ends here.
// ---------------------------------------------------------------------------------------------

type Order = { key: KeyPart[]; token: string; currency: string; value: Dec; lines: Map<string, { sku: string; outstanding: Dec }>; native: boolean }
type Side = { ok: true; orders: Map<string, Order> } | { ok: false; reason: PackReasonCode }

const dec = (text: string): Dec | null => parseDecimalStrict(text)
const round6 = (value: Dec): Dec => value.toDecimalPlaces(6, Dec.ROUND_HALF_UP)

/** The IMS side: every incoming goods order, keyed by the Qoblex number its reference explains with the declared prefix, else by its own reference. */
export function imsSide(orders: readonly PoRow[], prefix: string): Side {
  const out = new Map<string, Order>()
  for (const po of orders) {
    const explained = po.reference.startsWith(prefix) && QOBLEX_PO_NUMBER_RE.test(po.reference.slice(prefix.length))
    const key: KeyPart[] = explained ? [{ kind: 'order-ref', raw: po.reference.slice(prefix.length) }] : [{ kind: 'ims-id', raw: po.id }]
    const token = `${key[0]!.kind}\u0001${String(key[0]!.raw)}`
    if (out.has(token)) return { ok: false, reason: 'DUPLICATE_KEY' }
    let value = new Dec(0)
    const lines = new Map<string, { sku: string; outstanding: Dec }>()
    for (const line of po.lines) {
      const qty = dec(line.qty)
      const received = dec(line.qtyReceived)
      const cost = dec(line.unitCostBase)
      if (qty === null || received === null || cost === null) return { ok: false, reason: 'BAD_VALUE' }
      const outstanding = qty.minus(received)
      if (outstanding.isNegative()) return { ok: false, reason: 'BAD_VALUE' }
      if (lines.has(line.sku)) return { ok: false, reason: 'DUPLICATE_KEY' }
      lines.set(line.sku, { sku: line.sku, outstanding })
      value = value.plus(outstanding.mul(cost))
    }
    out.set(token, { key, token, currency: po.currency, value: round6(value), lines, native: !explained })
  }
  return { ok: true, orders: out }
}

/** The Qoblex side: the orders of the report that still have a quantity outstanding, keyed by their number. */
export function qoblexSide(lines: readonly QoblexPoLine[]): Side {
  const out = new Map<string, Order>()
  for (const line of lines) {
    const ordered = dec(line.qtyOrdered)
    const received = dec(line.qtyReceived)
    const price = dec(line.unitCostForeign)
    if (ordered === null || received === null || price === null) return { ok: false, reason: 'BAD_VALUE' }
    const outstanding = ordered.minus(received)
    if (outstanding.isNegative()) return { ok: false, reason: 'BAD_VALUE' }
    if (outstanding.isZero()) continue
    // Foreign = base x rate: the base cost of a unit is the price divided by the rate (blank = the base currency itself).
    let unit = price
    if (line.currency !== QOBLEX_BASE_CURRENCY || line.fxRateToBase !== '') {
      const rate = dec(line.fxRateToBase === '' ? '1' : line.fxRateToBase)
      if (rate === null || !rate.gt(0)) return { ok: false, reason: 'CURRENCY_UNKNOWN' }
      unit = round6(price.div(rate))
    }
    const token = `order-ref\u0001${line.orderKey}`
    const have = out.get(token) ?? { key: [{ kind: 'order-ref', raw: line.orderKey }] as KeyPart[], token, currency: line.currency, value: new Dec(0), lines: new Map<string, { sku: string; outstanding: Dec }>(), native: false }
    if (have.lines.has(line.sku)) return { ok: false, reason: 'DUPLICATE_KEY' }
    have.lines.set(line.sku, { sku: line.sku, outstanding })
    have.value = round6(have.value.plus(outstanding.mul(unit)))
    out.set(token, have)
  }
  return { ok: true, orders: out }
}

// ---------------------------------------------------------------------------------------------
// The comparisons
// ---------------------------------------------------------------------------------------------

function r7Rows(mine: ReadonlyMap<string, Order>, theirs: ReadonlyMap<string, Order>): { ims: SideRow[]; vendor: SideRow[] } | PackReasonCode {
  const ims: SideRow[] = []
  const vendor: SideRow[] = []
  for (const order of mine.values()) ims.push({ key: order.key, value: decimalText(order.value), currency: QOBLEX_BASE_CURRENCY })
  for (const order of theirs.values()) vendor.push({ key: order.key, value: decimalText(order.value), currency: QOBLEX_BASE_CURRENCY })
  for (const [token, a] of mine) {
    const b = theirs.get(token)
    if (b === undefined) continue
    // The two sides must agree on what the order IS before its value means anything.
    if (a.currency !== b.currency) return 'CURRENCY_UNKNOWN'
    if (a.currency === QOBLEX_BASE_CURRENCY) {
      const exactKey: KeyPart[] = [...a.key, { kind: 'sku', raw: VALUE_EXACT_GBP_TOKEN }]
      ims.push({ key: exactKey, value: '0', currency: QOBLEX_BASE_CURRENCY })
      vendor.push({ key: exactKey, value: decimalText(a.value.minus(b.value).abs().mul(MICRO)), currency: QOBLEX_BASE_CURRENCY })
    }
  }
  return { ims, vendor }
}

function r8Rows(mine: ReadonlyMap<string, Order>, theirs: ReadonlyMap<string, Order>): { ims: SideRow[]; vendor: SideRow[] } {
  const rows = (orders: ReadonlyMap<string, Order>): SideRow[] => {
    const out: SideRow[] = []
    for (const order of orders.values()) {
      for (const line of order.lines.values()) {
        if (line.outstanding.isZero()) continue
        out.push({ key: [...order.key, { kind: 'sku', raw: line.sku }], value: decimalText(line.outstanding) })
      }
    }
    return out
  }
  return { ims: rows(mine), vendor: rows(theirs) }
}

/** Run R7 or R8. Never throws; whatever cannot be proven is inconclusive with a closed reason; at P0 and P1 nothing is read. */
export async function runPoItem(id: PoItemId, context: PoItemContext): Promise<ItemInput> {
  try {
    // PHASES: the catalogue is the authority. A phase the item does not apply in reads nothing at all.
    if (context.phase === undefined || itemApplicability(id, context.phase) === 'not-applicable') {
      return context.phase === undefined ? inconclusive(id, [], 'INTERNAL_ERROR') : { id, outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE'] }
    }
    if (context.qoblex === undefined) return { id, outcome: 'inconclusive', reasons: ['QOBLEX_EXPORT_OFF'] }
    if (context.ims === undefined) return inconclusive(id, [], 'SOURCE_UNREADABLE')
    const read = await context.qoblex.read()
    if (!read.ok) return inconclusive(id, [QOBLEX], read.reason)
    const part = read.value.purchaseOrders
    if (!part.ok) return inconclusive(id, [QOBLEX], part.reason)
    const { keyPrefix, lines } = part.value

    const ims = await context.ims({ sections: ['purchaseOrders', 'boundaries'] })
    if (!ims.ok) return inconclusive(id, SOURCES, ims.reason)
    const orders = ims.sections.purchaseOrders
    const boundaries = ims.sections.boundaries
    if (orders === undefined || boundaries === undefined) return inconclusive(id, SOURCES, 'SOURCE_UNREADABLE')
    if (!orders.ok) return inconclusive(id, SOURCES, orders.reason)
    if (!boundaries.ok) return inconclusive(id, SOURCES, boundaries.reason)
    // The load that put the Qoblex numbers into IMS must be a recorded, verified one: without it the reference carries no recorded meaning.
    if (boundaries.value.firstLoad.state !== 'verified') return inconclusive(id, SOURCES, 'NO_POPULATION_RECORD')

    const mine = imsSide(orders.value, keyPrefix)
    if (!mine.ok) return inconclusive(id, SOURCES, mine.reason)
    const theirs = qoblexSide(lines)
    if (!theirs.ok) return inconclusive(id, SOURCES, theirs.reason)

    const empty = mine.orders.size === 0 && theirs.orders.size === 0
    let rows: { ims: SideRow[]; vendor: SideRow[] }
    if (id === 'R7') {
      const built = r7Rows(mine.orders, theirs.orders)
      if (typeof built === 'string') return inconclusive(id, SOURCES, built)
      rows = built
    } else {
      rows = r8Rows(mine.orders, theirs.orders)
    }
    // R8 may be empty of LINES while orders exist (an incoming order with nothing outstanding, in IMS only): that is a finding in R7 and, in
    // R8, nothing to compare; the empty proof is granted only when no order is on either side.
    const result = compareItem(id, { ims: rows.ims, vendor: rows.vendor, imsComplete: true, vendorComplete: true, ...(empty ? { emptyProof: 'qoblex-incoming-report-empty' as const } : {}) })
    return fromComparison(id, result)
  } catch {
    return inconclusive(id, [], 'INTERNAL_ERROR')
  }
}
