/**
 * THE WOOCOMMERCE SOURCE: full, proven walks of the storefront's orders (one status at a time), products and tax rates.
 *
 * Everything here stands on ONE port, `WooGetPort.get(collection, params)`, which can only ask for a page of a read-only collection
 * (the real one is lib/reconciliation-pack/woo-transport.ts: GET only, through the connector fetch seam). This module decides what
 * a read PROVES. A list is returned only when ALL of the following hold; any other state is a closed reason and NO list at all (a
 * partial list is never handed to a comparison):
 *
 *   - every response is HTTP 200 with a JSON array body, and carries both X-WP-Total and X-WP-TotalPages as plain whole numbers
 *     (a missing, empty, signed or padded header is SOURCE_UNREADABLE: the store "saying nothing" is never "one page");
 *   - the total is not above the walk cap (CAP_EXCEEDED) and the page count is exactly ceil(total / per_page);
 *   - every page reports the same total and page count as the first (a store that changes under the walk is VENDOR_READ_UNSTABLE),
 *     every page but the last holds exactly per_page rows, the last holds exactly the remainder, and the rows were asked for in
 *     ascending id order and arrive strictly ascending (an ignored `orderby` lets pages shift under the walk);
 *   - the number of rows read equals the total the store reported, and no row repeats (a store that ignores `page` repeats ids);
 *   - the whole walk is then read AGAIN and the two reads are equal row for row (a proven double scan);
 *   - every field of every row is validated (type, shape, enum, currency, decimal) and a row that is not exactly what was asked for
 *     (an order in another status than the one requested) is SOURCE_UNREADABLE; no row is dropped or repaired.
 *
 * The run as a whole has a request budget (WOO_REQUEST_BUDGET: exhausting it is CAP_EXCEEDED, never a shorter list) and a pause
 * between requests (WOO_MIN_REQUEST_INTERVAL_MS). No response body, URL, header or message is kept or returned: what comes out is
 * the validated rows, or a closed reason.
 *
 * LIMIT, stated: "ceil(total / per_page) pages" is how WordPress counts; a store that reports one page for a zero total is accepted
 * for zero only. A store that does not honour X-WP-Total (U4 in the plan: not yet compared with wp-admin's own counts) is
 * unreadable, never trusted.
 */

import { Prisma } from '@/app/generated/prisma/client'
import { parseDecimalStrict } from '@/lib/reconciliation-pack/compare'
import {
  WOO_MIN_REQUEST_INTERVAL_MS,
  WOO_PER_PAGE,
  WOO_REQUEST_BUDGET,
  WOO_WALK_MAX_ROWS,
  isKnownCurrency,
  type PackReasonCode,
  type WooCollection,
} from '@/lib/reconciliation-pack/constants'
import { normaliseWcOrderStatus } from '@/lib/connectors/woocommerce/order-status-filter'

/** One page as the transport reports it. `body` is the parsed JSON, nothing else of the response. */
export type WooPage =
  | { ok: true; status: number; total: string | null; totalPages: string | null; body: unknown }
  | { ok: false }

export interface WooGetPort {
  get(collection: WooCollection, params: Readonly<Record<string, string>>): Promise<WooPage>
}

export type WooOrderRow = { id: string; status: string; currency: string; total: string; createdAt: string | null }
export type WooProductRow = { id: string; sku: string; status: string; type: string }
export type WooTaxRateRow = { id: string }

export type WalkOutcome<T> = { ok: true; rows: T[]; total: number } | { ok: false; reason: PackReasonCode }

/** What the pacing and the budget of one run need. Injectable so a test neither sleeps nor spends real time. */
export type WooSourceOptions = {
  sleep?: (ms: number) => Promise<void>
  budget?: number
  perPage?: number
  maxRows?: number
}

class Stop extends Error {
  constructor(readonly reason: PackReasonCode) { super(reason) }
}

const COUNT_RE = /^(?:0|[1-9][0-9]{0,8})$/
const ID_RE = /^[1-9][0-9]{0,17}$/
const STATUS_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const GMT_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})$/
const FIELDS = {
  orders: 'id,status,currency,total,date_created_gmt',
  products: 'id,sku,status,type',
  taxes: 'id',
} as const

type Walker = {
  port: WooGetPort
  perPage: number
  maxRows: number
  left: number
  requests: number
  sleep: (ms: number) => Promise<void>
}

function makeWalker(port: WooGetPort, options: WooSourceOptions): Walker {
  return {
    port,
    perPage: options.perPage ?? WOO_PER_PAGE,
    maxRows: options.maxRows ?? WOO_WALK_MAX_ROWS,
    left: options.budget ?? WOO_REQUEST_BUDGET,
    requests: 0,
    sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })),
  }
}

function header(value: unknown): number {
  if (typeof value !== 'string' || !COUNT_RE.test(value)) throw new Stop('SOURCE_UNREADABLE')
  return Number(value)
}

function rowId(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Stop('SOURCE_UNREADABLE')
  const text = String(value)
  if (!ID_RE.test(text)) throw new Stop('SOURCE_UNREADABLE')
  return text
}

function plainText(value: unknown, max = 512): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Stop('SOURCE_UNREADABLE')
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Stop('SOURCE_UNREADABLE')
  return value as Record<string, unknown>
}

function parseOrder(raw: unknown): WooOrderRow {
  const r = record(raw)
  const status = normaliseWcOrderStatus(plainText(r.status, 64))
  if (!STATUS_RE.test(status)) throw new Stop('SOURCE_UNREADABLE')
  if (!isKnownCurrency(r.currency)) throw new Stop('CURRENCY_UNKNOWN')
  const total = r.total
  if (typeof total !== 'string' || parseDecimalStrict(total) === null || new Prisma.Decimal(total).isNegative()) throw new Stop('BAD_VALUE')
  let createdAt: string | null = null
  const created = r.date_created_gmt
  if (created !== undefined && created !== null) {
    const m = typeof created === 'string' ? GMT_RE.exec(created) : null
    if (!m) throw new Stop('SOURCE_UNREADABLE')
    const iso = `${created}.000Z`
    if (Number.isNaN(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw new Stop('SOURCE_UNREADABLE')
    createdAt = iso
  }
  return { id: rowId(r.id), status, currency: r.currency as string, total, createdAt }
}

function parseProduct(raw: unknown): WooProductRow {
  const r = record(raw)
  // An empty SKU is a real value on WooCommerce (a product with none); it is carried as the empty string, never guessed.
  return { id: rowId(r.id), sku: plainText(r.sku), status: plainText(r.status, 64), type: plainText(r.type, 64) }
}

function parseTaxRate(raw: unknown): WooTaxRateRow {
  return { id: rowId(record(raw).id) }
}

const idNumber = (id: string): bigint => BigInt(id)

async function walkOnce<T extends { id: string }>(w: Walker, collection: WooCollection, extra: Readonly<Record<string, string>>, parse: (raw: unknown) => T): Promise<{ rows: T[]; total: number }> {
  const rows: T[] = []
  const seen = new Set<string>()
  let total = -1
  let pages = -1
  let page = 1
  for (;;) {
    if (w.left <= 0) throw new Stop('CAP_EXCEEDED')
    w.left -= 1
    if (w.requests > 0) await w.sleep(WOO_MIN_REQUEST_INTERVAL_MS)
    w.requests += 1
    let response: WooPage
    try {
      response = await w.port.get(collection, { ...extra, page: String(page), per_page: String(w.perPage), orderby: 'id', order: 'asc', _fields: extra._fields ?? FIELDS[collection] })
    } catch {
      throw new Stop('SOURCE_UNREADABLE')
    }
    if (typeof response !== 'object' || response === null || response.ok !== true || response.status !== 200) throw new Stop('SOURCE_UNREADABLE')
    const pageTotal = header(response.total)
    const pageCount = header(response.totalPages)
    if (!Array.isArray(response.body)) throw new Stop('SOURCE_UNREADABLE')
    if (page === 1) {
      if (pageTotal > w.maxRows) throw new Stop('CAP_EXCEEDED')
      const expected = Math.ceil(pageTotal / w.perPage)
      if (pageCount !== expected && !(pageTotal === 0 && pageCount === 1)) throw new Stop('VENDOR_READ_UNSTABLE')
      total = pageTotal
      pages = pageCount
    } else if (pageTotal !== total || pageCount !== pages) {
      throw new Stop('VENDOR_READ_UNSTABLE')
    }
    const expectedLength = total === 0 ? 0 : page < pages ? w.perPage : total - w.perPage * (pages - 1)
    if (response.body.length !== expectedLength) throw new Stop('VENDOR_READ_UNSTABLE')
    for (const raw of response.body) {
      const row = parse(raw)
      if (seen.has(row.id)) throw new Stop('VENDOR_READ_UNSTABLE')
      const last = rows.at(-1)
      if (last && idNumber(row.id) <= idNumber(last.id)) throw new Stop('VENDOR_READ_UNSTABLE')
      seen.add(row.id)
      rows.push(row)
    }
    if (total === 0 || page >= pages) break
    page += 1
  }
  if (rows.length !== total) throw new Stop('VENDOR_READ_UNSTABLE')
  return { rows, total }
}

/** A walk read TWICE; the two reads must be equal row for row. */
async function walkTwice<T extends { id: string }>(w: Walker, collection: WooCollection, extra: Readonly<Record<string, string>>, parse: (raw: unknown) => T, check?: (row: T) => void): Promise<{ rows: T[]; total: number }> {
  const first = await walkOnce(w, collection, extra, parse)
  const second = await walkOnce(w, collection, extra, parse)
  if (first.total !== second.total || first.rows.length !== second.rows.length) throw new Stop('VENDOR_READ_UNSTABLE')
  for (const [index, row] of first.rows.entries()) {
    if (JSON.stringify(row) !== JSON.stringify(second.rows[index])) throw new Stop('VENDOR_READ_UNSTABLE')
    check?.(row)
  }
  return first
}

function reasonOf(error: unknown): PackReasonCode {
  return error instanceof Stop ? error.reason : 'SOURCE_UNREADABLE'
}

export type WooOrdersRead = {
  /** Every order of every requested status, ascending by id within a status. */
  orders: WooOrderRow[]
  /** The total each status reported (the same in both sweeps). */
  totals: Array<{ status: string; total: number }>
  /** True only when at least one status was enumerated and every one reported a total of zero in both sweeps. */
  allZero: boolean
}

type Sweep<T> = { orders: T[]; totals: Array<{ status: string; total: number }> }

/** ONE full proven walk of every status, in order. Each walk proves its own headers and pages; the sweep proves no order is in two statuses. */
async function sweepOrders<T extends { id: string; status: string }>(w: Walker, statuses: readonly string[], extra: Readonly<Record<string, string>>, parse: (raw: unknown) => T): Promise<Sweep<T>> {
  const orders: T[] = []
  const totals: Array<{ status: string; total: number }> = []
  const seen = new Set<string>()
  for (const status of statuses) {
    const walk = await walkOnce(w, 'orders', { ...extra, status }, parse)
    for (const row of walk.rows) {
      // The store was asked for one status; an order in another is a response that is not what was asked for.
      if (row.status !== status) throw new Stop('SOURCE_UNREADABLE')
      if (seen.has(row.id)) throw new Stop('VENDOR_READ_UNSTABLE')
      seen.add(row.id)
      orders.push(row)
    }
    totals.push({ status, total: walk.total })
  }
  return { orders, totals }
}

/** Two sweeps, the second starting only after the first finished; their combined populations and per-status totals must be identical. */
async function doubleSweep<T extends { id: string; status: string }>(w: Walker, statuses: readonly string[], extra: Readonly<Record<string, string>>, parse: (raw: unknown) => T): Promise<Sweep<T>> {
  const a = await sweepOrders(w, statuses, extra, parse)
  const b = await sweepOrders(w, statuses, extra, parse)
  if (a.orders.length !== b.orders.length || JSON.stringify(a.totals) !== JSON.stringify(b.totals)) throw new Stop('VENDOR_READ_UNSTABLE')
  const byId = new Map(b.orders.map((row) => [row.id, JSON.stringify(row)] as const))
  for (const row of a.orders) if (byId.get(row.id) !== JSON.stringify(row)) throw new Stop('VENDOR_READ_UNSTABLE')
  return a
}

/**
 * The orders in each of `statuses`: a DOUBLE SWEEP. Sweep A walks every status one at a time; sweep B starts only after A finished and
 * walks them all again. A per-status double read would not do: an order that moves from a later status to an earlier one between two
 * status walks is in neither read of the earlier status and not yet in the later one's, so every walk is consistent and the order is
 * missing. Here the COMBINED populations of A and B (id, status, currency, total, date: every field R9 uses) must be identical, the
 * totals per status must be identical, and any difference is VENDOR_READ_UNSTABLE and no list. The empty proof needs zero in BOTH sweeps.
 *
 * One request per status on purpose: a multi-status request (status array or comma list) is unverified on the live store (U4), so it is not used.
 * REMAINING LIMIT: an order that moves between open statuses TWICE within one run (out and back) can be missed by both sweeps.
 */
export async function readWooOrders(port: WooGetPort, statuses: readonly string[], options: WooSourceOptions = {}): Promise<{ ok: true; value: WooOrdersRead } | { ok: false; reason: PackReasonCode }> {
  try {
    if (!Array.isArray(statuses) || new Set(statuses).size !== statuses.length || !statuses.every((s) => typeof s === 'string' && STATUS_RE.test(s))) return { ok: false, reason: 'UNKNOWN_STATUS' }
    const swept = await doubleSweep(makeWalker(port, options), statuses, {}, parseOrder)
    const totals = swept.totals
    return { ok: true, value: { orders: swept.orders, totals, allZero: totals.length > 0 && totals.every((entry) => entry.total === 0) } }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

/**
 * R12: the tax lines of the orders created in a date window, in each of `statuses`, as the same proven DOUBLE SWEEP (every status walked
 * twice, the combined populations identical). The store is asked for the window (`after`, `before`, plain dates) and for the order's id,
 * status, currency, GMT creation date and tax lines only; the caller widens the window and cuts by the GMT date, because the zone the
 * store's date filter uses is unverified. Each tax line is the rate id and the LINE tax total (shipping tax is not read).
 */
/** `feeTaxLines` counts the order's fee lines whose own tax is not zero (R12 cannot prove fee tax is counted alike in the three systems, so one makes it inconclusive). */
export type WooOrderTaxRow = { id: string; status: string; currency: string; createdAt: string; taxes: Array<{ rateId: string; tax: string }>; feeTaxLines: number }

function parseOrderTax(raw: unknown): WooOrderTaxRow {
  const r = record(raw)
  const status = normaliseWcOrderStatus(plainText(r.status, 64))
  if (!STATUS_RE.test(status)) throw new Stop('SOURCE_UNREADABLE')
  if (!isKnownCurrency(r.currency)) throw new Stop('CURRENCY_UNKNOWN')
  const created = r.date_created_gmt
  const m = typeof created === 'string' ? GMT_RE.exec(created) : null
  if (!m) throw new Stop('SOURCE_UNREADABLE')
  const iso = `${created as string}.000Z`
  if (Number.isNaN(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw new Stop('SOURCE_UNREADABLE')
  if (!Array.isArray(r.tax_lines) || r.tax_lines.length > 200) throw new Stop('SOURCE_UNREADABLE')
  // EVERY tax line stays a line (in the order the store gave them): lines of one rate that cancel are not merged here, because the caller
  // judges each non-zero line's mapping before anything is summed.
  const taxes: Array<{ rateId: string; tax: string }> = []
  let partsTotal = new Prisma.Decimal(0)
  for (const entry of r.tax_lines) {
    const line = record(entry)
    const rateId = rowId(line.rate_id)
    const tax = line.tax_total
    if (typeof tax !== 'string' || parseDecimalStrict(tax) === null) throw new Stop('BAD_VALUE')
    // The shipping share of the line is not carried (R12 leaves shipping out) but it is part of the order's total_tax, so it is read to reconcile.
    const shipping = line.shipping_tax_total
    if (typeof shipping !== 'string' || parseDecimalStrict(shipping) === null) throw new Stop('BAD_VALUE')
    partsTotal = partsTotal.add(tax).add(shipping)
    taxes.push({ rateId, tax: new Prisma.Decimal(tax).isZero() ? '0' : new Prisma.Decimal(tax).toFixed() })
  }
  // THE PARTS MUST ADD UP TO THE ORDER'S OWN FIGURE: total_tax is the sum of every tax line's tax_total and shipping_tax_total. An order whose
  // lines were dropped, truncated or not reported (tax missing from tax_lines) does not reconcile and is unreadable, never a partial figure.
  if (typeof r.total_tax !== 'string' || parseDecimalStrict(r.total_tax) === null) throw new Stop('SOURCE_UNREADABLE')
  if (!partsTotal.eq(r.total_tax)) throw new Stop('SOURCE_UNREADABLE')
  if (!Array.isArray(r.fee_lines) || r.fee_lines.length > 200) throw new Stop('SOURCE_UNREADABLE')
  let feeTaxLines = 0
  for (const entry of r.fee_lines) {
    const fee = record(entry).total_tax
    if (typeof fee !== 'string' || parseDecimalStrict(fee) === null) throw new Stop('BAD_VALUE')
    if (!new Prisma.Decimal(fee).isZero()) feeTaxLines += 1
  }
  return { id: rowId(r.id), status, currency: r.currency as string, createdAt: iso, taxes, feeTaxLines }
}

const PLAIN_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

export async function readWooOrderTaxes(
  port: WooGetPort,
  statuses: readonly string[],
  window: { after: string; before: string },
  options: WooSourceOptions = {},
): Promise<{ ok: true; value: { orders: WooOrderTaxRow[]; totals: Array<{ status: string; total: number }> } } | { ok: false; reason: PackReasonCode }> {
  try {
    if (!Array.isArray(statuses) || statuses.length === 0 || new Set(statuses).size !== statuses.length || !statuses.every((s) => typeof s === 'string' && STATUS_RE.test(s))) return { ok: false, reason: 'UNKNOWN_STATUS' }
    if (!PLAIN_DATE_RE.test(window.after) || !PLAIN_DATE_RE.test(window.before) || window.after >= window.before) return { ok: false, reason: 'BAD_MODE' }
    const swept = await doubleSweep(makeWalker(port, options), statuses, { after: window.after, before: window.before, _fields: 'id,status,currency,date_created_gmt,total_tax,tax_lines,fee_lines' }, parseOrderTax)
    return { ok: true, value: { orders: swept.orders, totals: swept.totals } }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

/** Every product (status `any`), walked twice. Variations are separate collections and are NOT walked here (stated limit; the SKU-coverage item must). */
export async function readWooProducts(port: WooGetPort, options: WooSourceOptions = {}): Promise<{ ok: true; value: { products: WooProductRow[]; total: number } } | { ok: false; reason: PackReasonCode }> {
  try {
    const walk = await walkTwice(makeWalker(port, options), 'products', { status: 'any' }, parseProduct)
    return { ok: true, value: { products: walk.rows, total: walk.total } }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

/** Every tax rate, walked twice. */
export async function readWooTaxRates(port: WooGetPort, options: WooSourceOptions = {}): Promise<{ ok: true; value: { rates: WooTaxRateRow[]; total: number } } | { ok: false; reason: PackReasonCode }> {
  try {
    const walk = await walkTwice(makeWalker(port, options), 'taxes', {}, parseTaxRate)
    return { ok: true, value: { rates: walk.rows, total: walk.total } }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}
