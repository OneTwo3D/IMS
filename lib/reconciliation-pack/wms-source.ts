/**
 * THE WAREHOUSE-SYSTEM SOURCE: proven reads of the per-warehouse stock lists and of the product list (the product census).
 *
 * Everything here stands on ONE port, `WmsReadPort`, which can only ask for the stock list of one warehouse and for one page of the
 * product list (the real one is the connector's reconciliation reader: GET only, the stored fixed key only, through the connector fetch
 * seam). The port already parsed each response strictly and failed closed (a malformed row, a duplicate SKU, a row of another warehouse
 * or client is a closed reason, never a dropped row). This module decides what a READ PROVES. A result is returned only when ALL of the
 * following hold; any other state is a closed reason and NO list at all (a partial list is never handed to a comparison):
 *
 *   STOCK, a DOUBLE SWEEP. The stock list of every warehouse is read once (sweep A), and then every warehouse is read again (sweep B),
 *   starting only after A finished. The stock list carries no paging and no total (the vendor ignores both), so one request per warehouse
 *   is the whole list and its completeness is claimed by agreement, not by a count: the COMBINED populations of the two sweeps (warehouse,
 *   SKU, product id, on-hand, bundle flag, for every row) must be identical, and any difference is VENDOR_READ_UNSTABLE. A SKU or a
 *   product id that repeats in one list is DUPLICATE_KEY; one SKU with two product ids (or one product id with two SKUs) across warehouses
 *   is IDENTITY_CONFLICT.
 *
 *   PRODUCT CENSUS, a PROVEN SCAN read twice. The product list pages at a limit of at most WMS_PRODUCT_LIST_LIMIT rows (the vendor answers
 *   400 above it, so the limit is CLAMPED here, never configured) and numbers its pages from 1. It gives no total and no ordering, so
 *   completeness is proven the only way this client can, in four independent steps:
 *     (1) every page before the last holds exactly the limit, and none holds more;
 *     (2) the last page is SHORT (including empty) and the page AFTER it is then requested and must be empty: a short page is a claim, and
 *         a truncation that is the same every time looks exactly like an end until the next page is asked for;
 *     (3) no product id and no SKU appears twice in a scan;
 *     (4) the scan is read a SECOND time and must hold exactly the same (id, SKU, bundle flag) triples, compared as a set (no ordering is assumed);
 *   and then, independently of how the vendor pages, (5) CONTAINMENT: every row of every stock list must be a product of the census with
 *   the same SKU and bundle flag (a product the stock list shows and the census lacks means the census is not the whole list: READ_INCOMPLETE; the same id
 *   under another SKU is IDENTITY_CONFLICT).
 *   NOT PROVEN, stated: that the vendor's pages are a window over one stable permutation of the whole set and not a keyset walk that
 *   skips the same row every time. Step (5) is the independent check against that for every product that has a stock row; a product with
 *   no stock row in any warehouse that is also skipped by the paging is the residual.
 *
 * The run has a request budget (WMS_REQUEST_BUDGET; exhausting it is CAP_EXCEEDED, never a shorter list) and a pause between requests
 * (WMS_MIN_REQUEST_INTERVAL_MS). The order is sweep A, sweep B, scan 1, scan 2: the two stock reads are close together because stock
 * moves, and a stock list that changes between them is unstable, never averaged. No response body, URL, header or message is kept.
 */

import {
  WMS_MAX_WAREHOUSES,
  WMS_MIN_REQUEST_INTERVAL_MS,
  WMS_PRODUCT_LIST_LIMIT,
  WMS_PRODUCT_LIST_MAX_PAGES,
  WMS_REQUEST_BUDGET,
  isPackReasonCode,
  type PackReasonCode,
} from '@/lib/reconciliation-pack/constants'

/** One row of a stock list, already strictly read. `onHand` is a non-negative whole number. */
export type WmsStockRow = { sku: string; productId: string; onHand: number; bundle: boolean }
/** One row of the product list, already strictly read. */
export type WmsProductRow = { id: string; sku: string; bundle: boolean }
export type WmsPortResult<T> = { ok: true; value: T } | { ok: false; reason: PackReasonCode }

export interface WmsReadPort {
  /** The whole stock list of one warehouse (the vendor's own warehouse id). */
  stockLevels(externalWarehouseId: string): Promise<WmsPortResult<WmsStockRow[]>>
  /** One page of the product list, pages from 1, at a limit the port clamps to WMS_PRODUCT_LIST_LIMIT. */
  productPage(pageNo: number, limit: number): Promise<WmsPortResult<WmsProductRow[]>>
}

export type WmsSourceOptions = {
  sleep?: (ms: number) => Promise<void>
  budget?: number
  /** Asked page size; clamped to WMS_PRODUCT_LIST_LIMIT, never above. */
  limit?: number
  maxPages?: number
}

export type WmsRead = {
  /** The stock rows of each requested warehouse (the vendor's own id), as proven by the two sweeps. */
  stock: Map<string, WmsStockRow[]>
  /** The product census: every (id, SKU) pair, as proven by the two scans. */
  census: WmsProductRow[]
  /** True only when every stock list and the census are empty (in every read). */
  allEmpty: boolean
}

class Stop extends Error {
  constructor(readonly reason: PackReasonCode) { super(reason) }
}

const WAREHOUSE_ID_RE = /^[1-9][0-9]{0,8}$/

type Reader = {
  port: WmsReadPort
  left: number
  requests: number
  limit: number
  maxPages: number
  sleep: (ms: number) => Promise<void>
}

/** The page size actually asked for: a whole number from 1 to WMS_PRODUCT_LIST_LIMIT. Anything else (NaN, 0, 101, 500) is clamped, never passed through. */
export function clampedWmsLimit(asked: unknown): number {
  const n = typeof asked === 'number' && Number.isFinite(asked) ? Math.floor(asked) : WMS_PRODUCT_LIST_LIMIT
  return Math.min(WMS_PRODUCT_LIST_LIMIT, Math.max(1, n))
}

async function spend(r: Reader): Promise<void> {
  if (r.left <= 0) throw new Stop('CAP_EXCEEDED')
  r.left -= 1
  if (r.requests > 0) await r.sleep(WMS_MIN_REQUEST_INTERVAL_MS)
  r.requests += 1
}

async function ask<T>(r: Reader, call: () => Promise<WmsPortResult<T>>): Promise<T> {
  await spend(r)
  let result: WmsPortResult<T>
  try {
    result = await call()
  } catch {
    throw new Stop('SOURCE_UNREADABLE')
  }
  if (typeof result !== 'object' || result === null || (result as { ok?: unknown }).ok !== true) {
    const reason = (result as { reason?: unknown } | null)?.reason
    throw new Stop(isPackReasonCode(reason) ? reason : 'SOURCE_UNREADABLE')
  }
  return (result as { ok: true; value: T }).value
}

function checkStockRows(rows: unknown): WmsStockRow[] {
  if (!Array.isArray(rows)) throw new Stop('SOURCE_UNREADABLE')
  const skus = new Set<string>()
  const ids = new Set<string>()
  for (const row of rows as unknown[]) {
    if (typeof row !== 'object' || row === null) throw new Stop('SOURCE_UNREADABLE')
    const r = row as Partial<WmsStockRow>
    if (typeof r.sku !== 'string' || r.sku.length === 0 || typeof r.productId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(r.productId)) throw new Stop('SOURCE_UNREADABLE')
    if (typeof r.onHand !== 'number' || !Number.isSafeInteger(r.onHand) || r.onHand < 0 || typeof r.bundle !== 'boolean') throw new Stop('SOURCE_UNREADABLE')
    if (skus.has(r.sku) || ids.has(r.productId)) throw new Stop('DUPLICATE_KEY')
    skus.add(r.sku)
    ids.add(r.productId)
  }
  return rows as WmsStockRow[]
}

const rowText = (row: WmsStockRow): string => JSON.stringify([row.sku, row.productId, row.onHand, row.bundle])

async function sweepStock(r: Reader, warehouses: readonly string[]): Promise<Map<string, WmsStockRow[]>> {
  const out = new Map<string, WmsStockRow[]>()
  for (const id of warehouses) out.set(id, checkStockRows(await ask(r, () => r.port.stockLevels(id))))
  return out
}

/** The COMBINED populations of the two sweeps must be identical: the same warehouses, the same rows, the same figures. */
function requireSameSweeps(a: Map<string, WmsStockRow[]>, b: Map<string, WmsStockRow[]>): void {
  if (a.size !== b.size) throw new Stop('VENDOR_READ_UNSTABLE')
  for (const [id, rowsA] of a) {
    const rowsB = b.get(id)
    if (rowsB === undefined || rowsA.length !== rowsB.length) throw new Stop('VENDOR_READ_UNSTABLE')
    const bySku = new Map(rowsB.map((row) => [row.sku, rowText(row)] as const))
    for (const row of rowsA) if (bySku.get(row.sku) !== rowText(row)) throw new Stop('VENDOR_READ_UNSTABLE')
  }
}

/** One SKU is one product id and one product id is one SKU, across every warehouse. */
function requireOneIdentity(sweep: Map<string, WmsStockRow[]>): void {
  const idOfSku = new Map<string, string>()
  const skuOfId = new Map<string, string>()
  const bundleOfId = new Map<string, boolean>()
  for (const rows of sweep.values()) {
    for (const row of rows) {
      // The kind of a product (bundle or plain) is part of its identity: every warehouse must say the same.
      if ((bundleOfId.get(row.productId) ?? row.bundle) !== row.bundle) throw new Stop('IDENTITY_CONFLICT')
      bundleOfId.set(row.productId, row.bundle)
      if ((idOfSku.get(row.sku) ?? row.productId) !== row.productId || (skuOfId.get(row.productId) ?? row.sku) !== row.sku) throw new Stop('IDENTITY_CONFLICT')
      idOfSku.set(row.sku, row.productId)
      skuOfId.set(row.productId, row.sku)
    }
  }
}

function checkProductRows(rows: unknown, limit: number): WmsProductRow[] {
  if (!Array.isArray(rows)) throw new Stop('SOURCE_UNREADABLE')
  if (rows.length > limit) throw new Stop('VENDOR_READ_UNSTABLE')
  for (const row of rows as unknown[]) {
    if (typeof row !== 'object' || row === null) throw new Stop('SOURCE_UNREADABLE')
    const r = row as Partial<WmsProductRow>
    if (typeof r.id !== 'string' || !/^[1-9][0-9]{0,17}$/.test(r.id) || typeof r.sku !== 'string' || r.sku.length === 0 || typeof r.bundle !== 'boolean') throw new Stop('SOURCE_UNREADABLE')
  }
  return rows as WmsProductRow[]
}

/** ONE proven scan of the product list. */
async function scanProducts(r: Reader): Promise<WmsProductRow[]> {
  const rows: WmsProductRow[] = []
  const ids = new Set<string>()
  const skus = new Set<string>()
  for (let pageNo = 1; pageNo <= r.maxPages; pageNo += 1) {
    const page = checkProductRows(await ask(r, () => r.port.productPage(pageNo, r.limit)), r.limit)
    for (const row of page) {
      // Neither a repeated id (a vendor that ignores the page) nor a repeated SKU is summed or picked between.
      if (ids.has(row.id)) throw new Stop('VENDOR_READ_UNSTABLE')
      if (skus.has(row.sku)) throw new Stop('IDENTITY_CONFLICT')
      ids.add(row.id)
      skus.add(row.sku)
      rows.push(row)
    }
    if (page.length < r.limit) {
      // A short page is a claim that this was the end; the page after it is the proof.
      const after = checkProductRows(await ask(r, () => r.port.productPage(pageNo + 1, r.limit)), r.limit)
      if (after.length !== 0) throw new Stop('VENDOR_READ_UNSTABLE')
      return rows
    }
  }
  throw new Stop('CAP_EXCEEDED')
}

function requireSameScans(a: readonly WmsProductRow[], b: readonly WmsProductRow[]): void {
  if (a.length !== b.length) throw new Stop('VENDOR_READ_UNSTABLE')
  const kindOfId = new Map(b.map((row) => [row.id, `${row.sku}\u0001${row.bundle}`] as const))
  for (const row of a) if (kindOfId.get(row.id) !== `${row.sku}\u0001${row.bundle}`) throw new Stop('VENDOR_READ_UNSTABLE')
}

/** CONTAINMENT: every product a stock list shows is a product of the census, under the same SKU. */
function requireContainment(sweep: Map<string, WmsStockRow[]>, census: readonly WmsProductRow[]): void {
  const byId = new Map(census.map((row) => [row.id, row] as const))
  for (const rows of sweep.values()) {
    for (const row of rows) {
      const product = byId.get(row.productId)
      if (product === undefined) throw new Stop('READ_INCOMPLETE')
      // Same SKU AND same kind: the census says whether a product is a bundle, and so does every stock list; they must agree.
      if (product.sku !== row.sku || product.bundle !== row.bundle) throw new Stop('IDENTITY_CONFLICT')
    }
  }
}

function readerFor(port: WmsReadPort, options: WmsSourceOptions): Reader {
  return {
    port,
    left: options.budget ?? WMS_REQUEST_BUDGET,
    requests: 0,
    limit: clampedWmsLimit(options.limit),
    maxPages: Math.min(options.maxPages ?? WMS_PRODUCT_LIST_MAX_PAGES, WMS_PRODUCT_LIST_MAX_PAGES),
    sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })),
  }
}

/**
 * The product census ALONE, for a caller with no stock list to check it against (steps 1 to 4 above: full pages, the short last page and the
 * empty page after it, no repeated id or SKU, two scans equal as sets). Containment (step 5) needs a stock list and is NOT made here, so the
 * residual named above is wider: a product the paging skips every time is not caught. Used only by a run that did not read the stock lists.
 */
export async function readWmsCensus(port: WmsReadPort, options: WmsSourceOptions = {}): Promise<{ ok: true; value: WmsProductRow[] } | { ok: false; reason: PackReasonCode }> {
  try {
    const r = readerFor(port, options)
    const first = await scanProducts(r)
    const second = await scanProducts(r)
    requireSameScans(first, second)
    return { ok: true, value: first }
  } catch (error) {
    return { ok: false, reason: error instanceof Stop ? error.reason : 'SOURCE_UNREADABLE' }
  }
}

export type WmsReadResult = Awaited<ReturnType<typeof readWms>>
/**
 * ONE READ OF THE VENDOR PER RUN, shared by the items that need it (R1 and R14). The first caller makes the read; every later caller gets
 * the SAME result (a success or the same closed reason): no second request is ever made, so R14 adds none to what R1 makes. R14 asks for the
 * census of the very warehouses R1 read; a different warehouse list is BASIS_MOVED (the bindings changed under the run), never a second read.
 * With no stock read to share (R1 not run, or nothing to compare), the census alone is read once.
 */
export interface WmsReadSession {
  read(warehouses: readonly string[]): Promise<WmsReadResult>
  census(): Promise<{ ok: true; value: WmsProductRow[] } | { ok: false; reason: PackReasonCode }>
}

export function createWmsReadSession(port: WmsReadPort, options: WmsSourceOptions = {}): WmsReadSession {
  let full: { key: string; result: Promise<WmsReadResult> } | null = null
  let only: ReturnType<WmsReadSession['census']> | null = null
  return {
    read(warehouses) {
      const key = JSON.stringify(warehouses)
      if (full !== null) return key === full.key ? full.result : Promise.resolve({ ok: false, reason: 'BASIS_MOVED' })
      full = { key, result: readWms(port, warehouses, options) }
      return full.result
    },
    census() {
      if (full !== null) return full.result.then((result) => (result.ok ? { ok: true as const, value: result.value.census } : result))
      only ??= readWmsCensus(port, options)
      return only
    },
  }
}

/**
 * The stock lists of `warehouses` (the vendor's own ids) and the product census, proven as described above. Total: never throws; a
 * failure is a closed reason and no list.
 */
export async function readWms(port: WmsReadPort, warehouses: readonly string[], options: WmsSourceOptions = {}): Promise<{ ok: true; value: WmsRead } | { ok: false; reason: PackReasonCode }> {
  try {
    if (!Array.isArray(warehouses) || warehouses.length === 0 || warehouses.length > WMS_MAX_WAREHOUSES) return { ok: false, reason: 'CAP_EXCEEDED' }
    if (new Set(warehouses).size !== warehouses.length || !warehouses.every((id) => typeof id === 'string' && WAREHOUSE_ID_RE.test(id))) return { ok: false, reason: 'BAD_KEY' }
    const r = readerFor(port, options)
    const a = await sweepStock(r, warehouses)
    const b = await sweepStock(r, warehouses)
    requireSameSweeps(a, b)
    requireOneIdentity(a)
    const first = await scanProducts(r)
    const second = await scanProducts(r)
    requireSameScans(first, second)
    requireContainment(a, first)
    requireContainment(b, first)
    const allEmpty = first.length === 0 && [...a.values()].every((rows) => rows.length === 0)
    return { ok: true, value: { stock: a, census: first, allEmpty } }
  } catch (error) {
    return { ok: false, reason: error instanceof Stop ? error.reason : 'SOURCE_UNREADABLE' }
  }
}
