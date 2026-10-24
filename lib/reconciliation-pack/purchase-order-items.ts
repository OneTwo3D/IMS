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
 *       lines of (qty - qtyReceived) x the stored unitCostBase (the rate fixed when the order was created); Qoblex = the sum over its lines of
 *       (ordered - received) x (price / rate), the unit rounded half-up to six decimals. THE EXCHANGE RATE HAS ONE SOURCE, the central fx_rates
 *       table (1 GBP = rate units of the currency): the latest row on or before the instant the IMS order was created (rateAt: why that instant,
 *       and why not the rate stored on the order, is stated there), read in the same snapshot. The currency is the one IMS recorded on the matched
 *       order (the report has none), so it cannot disagree with it; no row, a rate that is not positive, or two disagreeing rows at the latest
 *       instant is CURRENCY_UNKNOWN. The catalogue's rule: an order in GBP must agree EXACTLY (any nonzero difference at the stored precision, one
 *       millionth of a pound, is a finding), any other order within GBP 1 inclusive. The GBP rule is carried as a second identity per such order
 *       (`<order>|value-exact-gbp`) whose two values are 0 and twice the difference in millionths of a pound, so the catalogue's GBP 1 limit is
 *       exceeded by any nonzero difference. An order no IMS order explains has no recorded currency: it is already onlyVendor and carries its
 *       unconverted price sum. An IMS incoming order with nothing outstanding is a finding (Qoblex lists no such order).
 *   R8  The identity is (Qoblex order number, SKU), the line identity the first load recorded (the report has no line number, so a
 *       repeated (order, SKU) on either side is DUPLICATE_KEY, never summed). The value is the outstanding quantity (ordered - received),
 *       EXACT (0.0001). Every open line is compared, which includes every part-received line; a line with nothing outstanding is no line on
 *       either side (as a zero position is none in R2). An outstanding quantity below zero (received above ordered) is BAD_VALUE. Every ORDER
 *       on either side also has an order-level identity (`<order>|order-lines-outstanding`, the number of its open lines, possibly 0), so an IMS
 *       incoming order whose lines are all received and which the export omits is onlyIms and R8 cannot pass.
 *
 * Both: an empty comparison (no outstanding order on either side) passes only on the named proof qoblex-incoming-report-empty, which needs
 * the report to have been read and IMS to have been read to the end in the same snapshot. Every malformed, missing, duplicate or unstable
 * input is inconclusive with a closed reason; nothing is converted or guessed. The module never throws.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { compareItem, decimalText, outcomeOfComparison, parseDecimalStrict, type CompareResult, type SideRow } from '@/lib/reconciliation-pack/compare'
import { QOBLEX_BASE_CURRENCY, QOBLEX_PO_NUMBER_RE, itemApplicability, type PackReasonCode, type PackSourceCode } from '@/lib/reconciliation-pack/constants'
import type { KeyPart } from '@/lib/reconciliation-pack/identity'
import type { FxRateRow, ImsRead, ImsReadOptions, PoRow } from '@/lib/reconciliation-pack/ims-readers'
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
/** One stored-precision step (a millionth of a pound) is TWO of these units, so the catalogue's GBP 1 limit (1 unit) is exceeded by any nonzero difference. */
const HALF_MICRO_UNITS = new Dec(2_000_000)

const inconclusive = (id: PoItemId, sources: readonly PackSourceCode[], ...reasons: PackReasonCode[]): ItemInput => ({ id, outcome: 'inconclusive', reasons: [...new Set(reasons)], sources: [...sources] })

function fromComparison(id: PoItemId, result: CompareResult): ItemInput {
  const verdict = outcomeOfComparison(result)
  const proof = verdict.outcome === 'pass' && result.status === 'compared' ? result.proof : null
  return { id, outcome: verdict.outcome, reasons: verdict.reasons, proof, sources: [...SOURCES], entries: result.status === 'compared' ? result.buckets : undefined }
}

// ---------------------------------------------------------------------------------------------
// One side each, as { identity -> figures }. Built before anything is compared; a malformed input ends here.
// ---------------------------------------------------------------------------------------------

export type Order = { key: KeyPart[]; token: string; currency: string; createdAt: string; value: Dec; lines: Map<string, { sku: string; outstanding: Dec }>; native: boolean }
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
    out.set(token, { key, token, currency: po.currency, createdAt: po.createdAt, value: round6(value), lines, native: !explained })
  }
  return { ok: true, orders: out }
}

/**
 * THE EXCHANGE RATE (one central source). For an order in the base currency the rate is 1. For any other currency it is the LATEST fx_rates row
 * (1 GBP = rate units of the currency) with fetchedAt ON OR BEFORE the instant the IMS purchase order was created, and nothing else: no
 * rate stored on the order is trusted (the first-load importer accepts a supplied rate within 2% of the table's, so the stored one is not provably
 * a table row), no fixed table is carried by the pack. No row on or before that instant, a rate that is not a positive plain decimal, or two rows
 * at the latest instant that disagree, is null: the caller makes the item CURRENCY_UNKNOWN. The instant is the order's creation because that is
 * when IMS booked its own figures; the same table row is then what both sides would have used.
 */
export function rateAt(currency: string, createdAt: string, rows: readonly FxRateRow[]): Dec | null {
  if (currency === QOBLEX_BASE_CURRENCY) return new Dec(1)
  const at = Date.parse(createdAt)
  if (!Number.isFinite(at)) return null
  const eligible = rows.filter((row) => row.currency === currency && Date.parse(row.fetchedAt) <= at)
  if (eligible.length === 0) return null
  const latest = Math.max(...eligible.map((row) => Date.parse(row.fetchedAt)))
  const atLatest = eligible.filter((row) => Date.parse(row.fetchedAt) === latest)
  const rates = new Set<string>()
  for (const row of atLatest) {
    const rate = dec(row.rate)
    if (rate === null || !rate.gt(0)) return null
    rates.add(rate.toFixed())
  }
  if (rates.size !== 1) return null
  return new Dec([...rates][0]!)
}

/**
 * The Qoblex side: the orders of the report that still have a quantity outstanding, keyed by their number. The report has no currency, so an
 * order that an IMS order explains is converted in THAT order's recorded currency at the central rate (rateAt); one that no IMS order explains
 * has no recorded currency, is already a finding (onlyVendor), and carries its unconverted price sum (stated: its value is not a GBP figure).
 */
export function qoblexSide(lines: readonly QoblexPoLine[], context: { mine: ReadonlyMap<string, Order>; fxRates: readonly FxRateRow[] | null }): Side {
  const out = new Map<string, Order>()
  const rates = new Map<string, Dec>()
  for (const line of lines) {
    const ordered = dec(line.qtyOrdered)
    const received = dec(line.qtyReceived)
    const price = dec(line.unitCostForeign)
    if (ordered === null || received === null || price === null) return { ok: false, reason: 'BAD_VALUE' }
    const outstanding = ordered.minus(received)
    if (outstanding.isNegative()) return { ok: false, reason: 'BAD_VALUE' }
    if (outstanding.isZero()) continue
    const token = `order-ref\u0001${line.orderKey}`
    const booked = context.mine.get(token)
    let unit = price
    let currency = ''
    if (booked !== undefined) {
      currency = booked.currency
    }
    // R8 compares quantities and reads no rates (fxRates null): no value is converted.
    if (booked !== undefined && context.fxRates !== null) {
      let rate = rates.get(token)
      if (rate === undefined) {
        const found = rateAt(booked.currency, booked.createdAt, context.fxRates)
        if (found === null) return { ok: false, reason: 'CURRENCY_UNKNOWN' }
        rate = found
        rates.set(token, rate)
      }
      if (booked.currency !== QOBLEX_BASE_CURRENCY) unit = round6(price.div(rate))
    }
    const have = out.get(token) ?? { key: [{ kind: 'order-ref', raw: line.orderKey }] as KeyPart[], token, currency, createdAt: booked?.createdAt ?? '', value: new Dec(0), lines: new Map<string, { sku: string; outstanding: Dec }>(), native: false }
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
    if (a.currency === QOBLEX_BASE_CURRENCY) {
      const exactKey: KeyPart[] = [...a.key, { kind: 'sku', raw: VALUE_EXACT_GBP_TOKEN }]
      ims.push({ key: exactKey, value: '0', currency: QOBLEX_BASE_CURRENCY })
      vendor.push({ key: exactKey, value: decimalText(a.value.minus(b.value).abs().mul(HALF_MICRO_UNITS)), currency: QOBLEX_BASE_CURRENCY })
    }
  }
  return { ims, vendor }
}

/** The word of the order-level identity R8 adds for EVERY order on either side: a fixed word, not data. */
export const ORDER_LINES_TOKEN = 'order-lines-outstanding'

/**
 * R8's rows: one per open line (its outstanding quantity) AND one per ORDER on either side (the number of its lines still outstanding, which can
 * be 0). The order-level row is what makes an IMS incoming order whose lines are all received, and which the export omits, an onlyIms finding
 * instead of a population that never appears; a matched order is also judged on its count of open lines.
 */
function r8Rows(mine: ReadonlyMap<string, Order>, theirs: ReadonlyMap<string, Order>): { ims: SideRow[]; vendor: SideRow[] } {
  const rows = (orders: ReadonlyMap<string, Order>): SideRow[] => {
    const out: SideRow[] = []
    for (const order of orders.values()) {
      let open = 0
      for (const line of order.lines.values()) {
        if (line.outstanding.isZero()) continue
        open += 1
        out.push({ key: [...order.key, { kind: 'sku', raw: line.sku }], value: decimalText(line.outstanding) })
      }
      out.push({ key: [...order.key, { kind: 'sku', raw: ORDER_LINES_TOKEN }], value: String(open) })
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

    const ims = await context.ims({ sections: id === 'R7' ? ['purchaseOrders', 'boundaries', 'fxRates'] : ['purchaseOrders', 'boundaries'] })
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
    let fxRates: readonly FxRateRow[] | null = null
    if (id === 'R7') {
      const fx = ims.sections.fxRates
      if (fx === undefined) return inconclusive(id, SOURCES, 'SOURCE_UNREADABLE')
      if (!fx.ok) return inconclusive(id, SOURCES, fx.reason)
      fxRates = fx.value
    }
    const theirs = qoblexSide(lines, { mine: mine.orders, fxRates })
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
    // The empty proof is granted only when no order is on either side (R8 also has an order-level row for every order, so an order with no open line is never "empty").
    const result = compareItem(id, { ims: rows.ims, vendor: rows.vendor, imsComplete: true, vendorComplete: true, ...(empty ? { emptyProof: 'qoblex-incoming-report-empty' as const } : {}) })
    return fromComparison(id, result)
  } catch {
    return inconclusive(id, [], 'INTERNAL_ERROR')
  }
}
