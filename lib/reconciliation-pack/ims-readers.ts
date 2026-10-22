/**
 * THE IMS-SIDE READERS: everything the pack needs from the IMS database, read in ONE `REPEATABLE READ, READ ONLY`
 * transaction.
 *
 * What the guards are, and the review that asked for each:
 *
 *   - ONE SNAPSHOT. Every section is read inside the same transaction, so a stock pair, an order and a sync row are all
 *     from the same instant. The transaction proves it, it does not assume it: `transaction_read_only` and
 *     `transaction_isolation` are read back (a pass needs positive proof of the mode, not a request for it), and the
 *     snapshot is read at the start and at the end and must be EQUAL. Nothing is written (the transaction cannot write,
 *     and the only statements the wrapper will send are SELECTs and two SET LOCAL timeouts); it is always rolled back.
 *   - FULL POPULATION. No section has a window, an oldest-first page or a "recent N". A section is read to the end or it
 *     is not read: more rows than the cap is CAP_EXCEEDED, a statement timeout is READ_INCOMPLETE, and neither ever
 *     becomes a shorter list.
 *   - NO ROW IS DROPPED OR GUESSED. A row that cannot be read exactly (a missing id, a value that is not a plain decimal,
 *     an enum this module does not know, a duplicate identity) makes its WHOLE SECTION unreadable with a closed code.
 *   - POPULATION BOUNDARIES COME FROM RECORDED IDENTITIES: the first-load run record (VERIFIED only), the storefront
 *     initial-import completion setting and the sales-order retention setting. `classifyPopulation` puts an identity
 *     created before a recorded boundary in `out` with a closed reason: listed, never silently dropped, never a finding.
 *     A missing or unreadable record is `unknown`, never "in". A recorded instant bounds a population here and nowhere
 *     else; two runs are never ordered by a timestamp.
 *   - NOT STOCK-TRACKED PRODUCTS ARE EXCLUDED AND LISTED: stock rows of a product type that does not carry stock are
 *     returned under `untracked`, so nothing is hidden and nothing is compared.
 *
 * Nothing read here reaches text except through lib/reconciliation-pack/identity.ts. The module has no clock and no
 * environment: the caller passes the connection, the date and the limits.
 */

import { parseDecimalStrict } from '@/lib/reconciliation-pack/compare'
import {
  FIRST_LOAD_RUN_STATUSES,
  IMS_OPEN_ORDER_STATUSES,
  IMS_READER_MAX_TIMEOUT_MS,
  IMS_READER_ROW_CAP,
  IMS_READER_STATEMENT_TIMEOUT_MS,
  SYSTEM_IDENTIFIER_RE,
  type PackPopulationReason,
  type PackReasonCode,
} from '@/lib/reconciliation-pack/constants'
import { STOCK_TRACKED_PRODUCT_TYPES } from '@/lib/domain/inventory/backorder-policy'
import { AccountingSyncStatus, AccountingSyncType } from '@/app/generated/prisma/enums'

/** The slice of a `pg` client this module needs. A test double implements it; `pg.Client` satisfies it. */
export interface ImsQueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

export const IMS_SECTIONS = ['identity', 'boundaries', 'stock', 'products', 'orders', 'taxes', 'xeroSyncLogs', 'snapshots', 'wmsBindings', 'xeroPostings'] as const
export type ImsSectionId = (typeof IMS_SECTIONS)[number]

// ---------------------------------------------------------------------------------------------
// Section shapes
// ---------------------------------------------------------------------------------------------

export type ImsIdentity = { systemIdentifier: string; database: string }

export type FirstLoadRecord = { state: 'absent' } | { state: 'unverified' } | { state: 'verified'; cutAt: string }
export type StorefrontImportRecord = { state: 'not-completed' } | { state: 'completed'; cutAt: string }
export type PopulationBoundaries = { firstLoad: FirstLoadRecord; storefrontImport: StorefrontImportRecord; retentionMonths: number }

export type StockPair = { stockLevelId: string; productId: string; sku: string; productType: string; warehouseId: string; warehouseCode: string; quantity: string; reservedQty: string }
export type ImsStock = { tracked: StockPair[]; untracked: StockPair[] }
export type ProductRow = { id: string; sku: string; type: string; active: boolean; lifecycleStatus: string }
export type OrderLink = { connector: string; externalOrderId: string }
export type OrderRow = { id: string; status: string; currency: string; totalForeign: string; externalCreatedAt: string | null; externalUpdatedAt: string | null; links: OrderLink[] }
export type TaxRateRow = { id: string; active: boolean; accountingTaxType: string | null; countryCode: string | null; reportingCategory: string | null }
export type TaxMappingRow = { connector: string; externalTaxRateId: string; taxRateId: string }
export type ImsTaxes = { rates: TaxRateRow[]; mappings: TaxMappingRow[] }
export type XeroSyncLogRow = { id: string; type: string; referenceType: string; referenceId: string; externalTransactionId: string }
export type SnapshotValueRow = { productId: string; warehouseId: string; qty: string; valueBase: string; valueReplayReliable: boolean }
export type BalanceSnapshotRow = { externalAccountId: string; accountCode: string | null; currency: string; amountBase: string }
export type ImsSnapshots = { asOf: string; run: { stockLevelCount: number; snapshotCount: number } | null; values: SnapshotValueRow[]; balances: BalanceSnapshotRow[] }
/**
 * R10, the zero-IMS-originated-posting leg. `p0` is the first-load run record: only a VERIFIED run is a recorded P0, and the instant
 * is when that run STARTED (created_at), so a posting made at any time since the first load began is inside. `rows` is every sync
 * log row of the Xero connector that could be a write to Xero (of ANY type: a posting, an attachment, an e-mail, a tax-rate push):
 * SYNCED, PROCESSING (the write may have happened), or carrying an external document id. `at` is when it happened: the sync time,
 * else the time processing started, else the time the row was created. The row's own status is kept so a reader can see why it is in.
 */
export type XeroPostingRow = { id: string; type: string; status: string; at: string }
export type XeroPostings = { p0: { state: 'absent' } | { state: 'unverified' } | { state: 'verified'; startedAt: string }; rows: XeroPostingRow[] }
export type WmsBindingRow = { connector: string; warehouseId: string; warehouseCode: string; externalWarehouseId: string; active: boolean; stockSyncMode: 'DISABLED' | 'NOTIFICATION_ONLY' | 'ALIGN_TO_WMS'; alignmentConfirmed: boolean }

export type ImsSectionValues = {
  identity: ImsIdentity
  boundaries: PopulationBoundaries
  stock: ImsStock
  products: ProductRow[]
  orders: OrderRow[]
  taxes: ImsTaxes
  xeroSyncLogs: XeroSyncLogRow[]
  snapshots: ImsSnapshots
  wmsBindings: WmsBindingRow[]
  xeroPostings: XeroPostings
}
export type SectionResult<T> = { ok: true; value: T } | { ok: false; reason: PackReasonCode }
export type ImsSections = { [K in ImsSectionId]?: SectionResult<ImsSectionValues[K]> }

export type ImsRead =
  | { ok: true; snapshotId: string; sections: ImsSections }
  | { ok: false; reason: PackReasonCode }

export type ImsReadOptions = {
  sections: readonly ImsSectionId[]
  /** The cycle date (YYYY-MM-DD); required by the `snapshots` section and by nothing else. */
  asOf?: string
  rowCap?: number
  statementTimeoutMs?: number
}

// ---------------------------------------------------------------------------------------------
// Row parsing. Every parser throws a closed code; nothing is dropped, defaulted or coerced.
// ---------------------------------------------------------------------------------------------

class Unreadable extends Error {
  constructor(readonly reason: PackReasonCode) { super(reason) }
}

const ISO_UTC_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/
const ASOF_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

function text(value: unknown, reason: PackReasonCode = 'BAD_KEY'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Unreadable(reason)
  return value
}
function textOrNull(value: unknown, reason: PackReasonCode = 'SOURCE_UNREADABLE'): string | null {
  return value === null ? null : text(value, reason)
}
function decimal(value: unknown): string {
  if (typeof value !== 'string' || parseDecimalStrict(value) === null) throw new Unreadable('BAD_VALUE')
  return value
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Unreadable('SOURCE_UNREADABLE')
  return value
}
function instantOrNull(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value) || Number.isNaN(Date.parse(value))) throw new Unreadable('SOURCE_UNREADABLE')
  return value
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Unreadable('SOURCE_UNREADABLE')
  return value as T
}
function count(value: unknown): number {
  const n = typeof value === 'string' && /^[0-9]{1,9}$/.test(value) ? Number(value) : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  if (n === null) throw new Unreadable('BAD_VALUE')
  return n
}
function unique<T>(rows: readonly T[], identity: (row: T) => string): void {
  const seen = new Set<string>()
  for (const row of rows) {
    const id = identity(row)
    if (seen.has(id)) throw new Unreadable('DUPLICATE_KEY')
    seen.add(id)
  }
}

/** Instants as text the parsers above accept: millisecond precision, a trailing Z. Prisma's DateTime columns are timestamp(3) without a zone and hold UTC; the session zone is pinned to UTC anyway. */
const UTC = (column: string) => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

// ---------------------------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------------------------

const ALLOWED_STATEMENT = /^\s*(?:SELECT\b|SET LOCAL (?:statement_timeout|idle_in_transaction_session_timeout) = [0-9]{1,7}\s*$|SET LOCAL TIME ZONE 'UTC'\s*$)/i

/** Only a SELECT or one of three fixed SET LOCALs is ever sent, and never two statements in one text. */
export function statementAllowed(sql: string): boolean {
  return typeof sql === 'string' && ALLOWED_STATEMENT.test(sql) && !sql.includes(';')
}

function closedReason(error: unknown): PackReasonCode {
  if (error instanceof Unreadable) return error.reason
  const code = (error as { code?: unknown } | null)?.code
  // 57014 query_canceled (the statement timeout): the read did not finish, so it is not a shorter read.
  return code === '57014' ? 'READ_INCOMPLETE' : 'SOURCE_UNREADABLE'
}

type Tx = { query: (sql: string, values?: unknown[]) => Promise<Array<Record<string, unknown>>>; cap: number; asOf: string | undefined }

async function readCapped(tx: Tx, sql: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> {
  const rows = await tx.query(`${sql} LIMIT ${tx.cap + 1}`, values)
  if (rows.length > tx.cap) throw new Unreadable('CAP_EXCEEDED')
  return rows
}

type Reader<K extends ImsSectionId> = (tx: Tx) => Promise<ImsSectionValues[K]>

const READERS: { [K in ImsSectionId]: Reader<K> } = {
  async identity(tx) {
    const rows = await tx.query('SELECT system_identifier::text AS sid, current_database() AS db FROM pg_control_system()')
    if (rows.length !== 1) throw new Unreadable('SOURCE_UNREADABLE')
    const sid = rows[0]!.sid
    if (typeof sid !== 'string' || !SYSTEM_IDENTIFIER_RE.test(sid)) throw new Unreadable('SOURCE_UNREADABLE')
    return { systemIdentifier: sid, database: text(rows[0]!.db, 'SOURCE_UNREADABLE') }
  },

  async boundaries(tx) {
    const runs = await tx.query(`SELECT status, ${UTC('updated_at')} AS cut FROM first_load_apply_runs`)
    if (runs.length > 1) throw new Unreadable('DUPLICATE_KEY')
    let firstLoad: FirstLoadRecord = { state: 'absent' }
    if (runs.length === 1) {
      const status = oneOf(runs[0]!.status, FIRST_LOAD_RUN_STATUSES)
      const cut = instantOrNull(runs[0]!.cut)
      if (status !== 'VERIFIED') firstLoad = { state: 'unverified' }
      else if (cut === null) throw new Unreadable('SOURCE_UNREADABLE')
      else firstLoad = { state: 'verified', cutAt: cut }
    }
    const settings = await tx.query(`SELECT key, value, ${UTC('"updatedAt"')} AS at FROM settings WHERE key IN ('wc_initial_import_completed', 'retention_sales_orders_months')`)
    unique(settings, (row) => text(row.key))
    const byKey = new Map(settings.map((row) => [text(row.key), row]))
    let storefrontImport: StorefrontImportRecord = { state: 'not-completed' }
    const completed = byKey.get('wc_initial_import_completed')
    if (completed) {
      // The stamp is written as the text "true" and nothing else. Any other value is not "not completed": it is unreadable.
      if (completed.value !== 'true') throw new Unreadable('SOURCE_UNREADABLE')
      const cut = instantOrNull(completed.at)
      if (cut === null) throw new Unreadable('SOURCE_UNREADABLE')
      storefrontImport = { state: 'completed', cutAt: cut }
    }
    // Absent = the documented default of 0 (keep everything): fewer identities leave the population, never more.
    const retention = byKey.get('retention_sales_orders_months')
    let retentionMonths = 0
    if (retention) {
      if (typeof retention.value !== 'string' || !/^[0-9]{1,4}$/.test(retention.value)) throw new Unreadable('SOURCE_UNREADABLE')
      retentionMonths = Number(retention.value)
    }
    return { firstLoad, storefrontImport, retentionMonths }
  },

  async stock(tx) {
    const rows = await readCapped(tx, `SELECT sl.id, sl."productId" AS product_id, p.sku, p.type::text AS product_type, sl."warehouseId" AS warehouse_id, w.code AS warehouse_code, sl.quantity::text AS quantity, sl."reservedQty"::text AS reserved FROM stock_levels sl JOIN products p ON p.id = sl."productId" JOIN warehouses w ON w.id = sl."warehouseId" ORDER BY sl.id`)
    const pairs = rows.map((row): StockPair => ({ stockLevelId: text(row.id), productId: text(row.product_id), sku: text(row.sku), productType: text(row.product_type, 'SOURCE_UNREADABLE'), warehouseId: text(row.warehouse_id), warehouseCode: text(row.warehouse_code), quantity: decimal(row.quantity), reservedQty: decimal(row.reserved) }))
    unique(pairs, (pair) => pair.stockLevelId)
    unique(pairs, (pair) => `${pair.productId}\u0001${pair.warehouseId}`)
    const tracked = (type: string) => (STOCK_TRACKED_PRODUCT_TYPES as ReadonlySet<string>).has(type)
    return { tracked: pairs.filter((pair) => tracked(pair.productType)), untracked: pairs.filter((pair) => !tracked(pair.productType)) }
  },

  async products(tx) {
    const rows = await readCapped(tx, 'SELECT id, sku, type::text AS type, active, "lifecycleStatus"::text AS lifecycle FROM products ORDER BY id')
    const products = rows.map((row): ProductRow => ({ id: text(row.id), sku: text(row.sku), type: text(row.type, 'SOURCE_UNREADABLE'), active: bool(row.active), lifecycleStatus: text(row.lifecycle, 'SOURCE_UNREADABLE') }))
    unique(products, (product) => product.id)
    unique(products, (product) => product.sku)
    return products
  },

  async orders(tx) {
    const statuses = [...IMS_OPEN_ORDER_STATUSES]
    const rows = await readCapped(tx, `SELECT so.id, so.status::text AS status, so.currency, so."totalForeign"::text AS total, ${UTC('so."externalCreatedAt"')} AS created, ${UTC('so."externalUpdatedAt"')} AS updated FROM sales_orders so WHERE so.status::text = ANY($1::text[]) ORDER BY so.id`, [statuses])
    const orders = rows.map((row): OrderRow => ({ id: text(row.id), status: oneOf(row.status, IMS_OPEN_ORDER_STATUSES), currency: text(row.currency, 'CURRENCY_UNKNOWN'), totalForeign: decimal(row.total), externalCreatedAt: instantOrNull(row.created), externalUpdatedAt: instantOrNull(row.updated), links: [] }))
    unique(orders, (order) => order.id)
    const byId = new Map(orders.map((order) => [order.id, order]))
    const links = await readCapped(tx, 'SELECT l."orderId" AS order_id, l.connector, l."externalOrderId" AS external_id FROM shopping_order_links l JOIN sales_orders so ON so.id = l."orderId" WHERE so.status::text = ANY($1::text[]) ORDER BY l.id', [statuses])
    const seen = new Set<string>()
    for (const row of links) {
      const order = byId.get(text(row.order_id))
      if (!order) throw new Unreadable('SOURCE_UNREADABLE')
      const link = { connector: text(row.connector), externalOrderId: text(row.external_id) }
      const key = `${link.connector}\u0001${link.externalOrderId}`
      if (seen.has(key) || order.links.some((existing) => existing.connector === link.connector)) throw new Unreadable('DUPLICATE_KEY')
      seen.add(key)
      order.links.push(link)
    }
    return orders
  },

  async taxes(tx) {
    const rates = (await readCapped(tx, 'SELECT id, active, accounting_tax_type AS tax_type, "countryCode" AS country, reporting_category AS category FROM tax_rates ORDER BY id')).map((row): TaxRateRow => ({ id: text(row.id), active: bool(row.active), accountingTaxType: textOrNull(row.tax_type), countryCode: textOrNull(row.country), reportingCategory: textOrNull(row.category) }))
    unique(rates, (rate) => rate.id)
    const mappings = (await readCapped(tx, 'SELECT connector, "externalTaxRateId" AS external_id, "taxRateId" AS rate_id FROM shopping_tax_rate_mappings ORDER BY id')).map((row): TaxMappingRow => ({ connector: text(row.connector), externalTaxRateId: text(row.external_id), taxRateId: text(row.rate_id) }))
    unique(mappings, (mapping) => `${mapping.connector}\u0001${mapping.externalTaxRateId}`)
    const known = new Set(rates.map((rate) => rate.id))
    if (mappings.some((mapping) => !known.has(mapping.taxRateId))) throw new Unreadable('SOURCE_UNREADABLE')
    return { rates, mappings }
  },

  async xeroSyncLogs(tx) {
    // Connector-confirmed rows only: SYNCED, a document id, and no operator assertion standing in for the connector.
    const rows = await readCapped(tx, `SELECT id, type::text AS type, "referenceType" AS ref_type, "referenceId" AS ref_id, "externalTransactionId" AS external_id FROM accounting_sync_logs WHERE connector = 'xero' AND status::text = 'SYNCED' AND settlement_basis IS NULL AND "externalTransactionId" IS NOT NULL ORDER BY id`)
    const logs = rows.map((row): XeroSyncLogRow => ({ id: text(row.id), type: text(row.type, 'SOURCE_UNREADABLE'), referenceType: text(row.ref_type), referenceId: text(row.ref_id), externalTransactionId: text(row.external_id) }))
    unique(logs, (log) => log.id)
    return logs
  },

  async xeroPostings(tx) {
    const runs = await tx.query(`SELECT status, ${UTC('created_at')} AS started FROM first_load_apply_runs`)
    if (runs.length > 1) throw new Unreadable('DUPLICATE_KEY')
    let p0: XeroPostings['p0'] = { state: 'absent' }
    if (runs.length === 1) {
      const status = oneOf(runs[0]!.status, FIRST_LOAD_RUN_STATUSES)
      const started = instantOrNull(runs[0]!.started)
      if (status !== 'VERIFIED') p0 = { state: 'unverified' }
      else if (started === null) throw new Unreadable('SOURCE_UNREADABLE')
      else p0 = { state: 'verified', startedAt: started }
    }
    // Whatever could be a write to Xero, of any type. Not "connector-confirmed rows only": a row that is still PROCESSING may
    // have posted, and a row with a document id has been sent whatever its status says now. The instant is COALESCEd to the row's
    // creation time, which is not null, so no row falls out of the population for want of an instant.
    const rows = await readCapped(tx, `SELECT id, type::text AS type, status::text AS status, ${UTC('COALESCE("syncedAt", "processingStartedAt", "createdAt")')} AS at FROM accounting_sync_logs WHERE connector = 'xero' AND (status::text IN ('SYNCED', 'PROCESSING') OR "externalTransactionId" IS NOT NULL) ORDER BY id`)
    const postings = rows.map((row): XeroPostingRow => {
      const at = instantOrNull(row.at)
      if (at === null) throw new Unreadable('SOURCE_UNREADABLE')
      return { id: text(row.id), type: oneOf(row.type, Object.values(AccountingSyncType)), status: oneOf(row.status, Object.values(AccountingSyncStatus)), at }
    })
    unique(postings, (posting) => posting.id)
    return { p0, rows: postings }
  },

  async snapshots(tx) {
    const asOf = tx.asOf
    if (asOf === undefined || !ASOF_RE.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) throw new Unreadable('STALE_BASIS')
    const runs = await tx.query('SELECT "stockLevelCount" AS stock_count, "snapshotCount" AS snapshot_count FROM inventory_snapshot_runs WHERE "snapshotDate" = $1::date', [asOf])
    if (runs.length > 1) throw new Unreadable('DUPLICATE_KEY')
    const run = runs.length === 1 ? { stockLevelCount: count(runs[0]!.stock_count), snapshotCount: count(runs[0]!.snapshot_count) } : null
    const values = (await readCapped(tx, 'SELECT "productId" AS product_id, "warehouseId" AS warehouse_id, qty::text AS qty, "valueBase"::text AS value, "valueReplayReliable" AS reliable FROM inventory_snapshots WHERE "snapshotDate" = $1::date ORDER BY id', [asOf])).map((row): SnapshotValueRow => ({ productId: text(row.product_id), warehouseId: text(row.warehouse_id), qty: decimal(row.qty), valueBase: decimal(row.value), valueReplayReliable: bool(row.reliable) }))
    unique(values, (value) => `${value.productId}\u0001${value.warehouseId}`)
    // Completeness is proven against the run row, never assumed: rows without a run row are missing evidence, and a run row
    // that counts a different number of rows than were read means the read is not the day's snapshot.
    if (run !== null && run.snapshotCount !== values.length) throw new Unreadable('READ_INCOMPLETE')
    if (run === null && values.length > 0) throw new Unreadable('READ_INCOMPLETE')
    const balances = (await readCapped(tx, `SELECT "externalAccountId" AS account_id, "accountCode" AS code, currency, "amountBase"::text AS amount FROM accounting_account_balance_snapshots WHERE connector = 'xero' AND "balanceDate" = $1::date ORDER BY id`, [asOf])).map((row): BalanceSnapshotRow => ({ externalAccountId: text(row.account_id), accountCode: textOrNull(row.code), currency: text(row.currency, 'CURRENCY_UNKNOWN'), amountBase: decimal(row.amount) }))
    unique(balances, (balance) => `${balance.externalAccountId}\u0001${balance.currency}`)
    return { asOf, run, values, balances }
  },

  async wmsBindings(tx) {
    const rows = await readCapped(tx, 'SELECT b.connector, b."warehouseId" AS warehouse_id, w.code AS warehouse_code, b."externalWarehouseId" AS external_id, b.active, b."stockSyncMode"::text AS mode, b."alignmentConfirmedAt" IS NOT NULL AS confirmed FROM external_wms_bindings b JOIN warehouses w ON w.id = b."warehouseId" ORDER BY b.id')
    const bindings = rows.map((row): WmsBindingRow => ({ connector: text(row.connector), warehouseId: text(row.warehouse_id), warehouseCode: text(row.warehouse_code), externalWarehouseId: text(row.external_id), active: bool(row.active), stockSyncMode: oneOf(row.mode, ['DISABLED', 'NOTIFICATION_ONLY', 'ALIGN_TO_WMS'] as const), alignmentConfirmed: bool(row.confirmed) }))
    unique(bindings, (binding) => `${binding.connector}\u0001${binding.warehouseId}`)
    return bindings
  },
}

/**
 * Read the requested sections in one REPEATABLE READ, READ ONLY transaction. A section that cannot be read exactly is
 * reported with a closed code and the others are still returned; a failure of the transaction itself (it could not be
 * opened, its mode could not be proven, the snapshot moved, the database refused a statement) fails the whole read.
 */
export async function readImsSnapshot(client: ImsQueryClient, options: ImsReadOptions): Promise<ImsRead> {
  const cap = options.rowCap ?? IMS_READER_ROW_CAP
  const timeout = options.statementTimeoutMs ?? IMS_READER_STATEMENT_TIMEOUT_MS
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > IMS_READER_ROW_CAP) return { ok: false, reason: 'BAD_MODE' }
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > IMS_READER_MAX_TIMEOUT_MS) return { ok: false, reason: 'BAD_MODE' }
  if (new Set(options.sections).size !== options.sections.length || !options.sections.every((id) => (IMS_SECTIONS as readonly string[]).includes(id))) return { ok: false, reason: 'BAD_MODE' }

  let open = false
  const run = async (sql: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> => {
    if (!statementAllowed(sql)) throw new Unreadable('SOURCE_UNREADABLE')
    return (await client.query(sql, values)).rows
  }
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    open = true
    await run(`SET LOCAL statement_timeout = ${timeout}`)
    await run(`SET LOCAL idle_in_transaction_session_timeout = ${IMS_READER_MAX_TIMEOUT_MS}`)
    await run(`SET LOCAL TIME ZONE 'UTC'`)
    const start = await run(`SELECT pg_current_snapshot()::text AS snapshot, current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation`)
    const first = start[0]
    if (start.length !== 1 || first!.read_only !== 'on' || first!.isolation !== 'repeatable read' || typeof first!.snapshot !== 'string' || first!.snapshot === '') return { ok: false, reason: 'SOURCE_UNREADABLE' }
    const tx: Tx = { query: run, cap, asOf: options.asOf }
    const sections: ImsSections = {}
    for (const id of options.sections) {
      try {
        const value = await READERS[id](tx)
        ;(sections as Record<string, unknown>)[id] = { ok: true, value }
      } catch (error) {
        // A database error (including a timeout) leaves the transaction unusable: it fails the whole read. Only a row this module
        // refused to read is a section-level result.
        if (!(error instanceof Unreadable)) throw error
        ;(sections as Record<string, unknown>)[id] = { ok: false, reason: error.reason }
      }
    }
    const end = await run(`SELECT pg_current_snapshot()::text AS snapshot`)
    if (end.length !== 1 || end[0]!.snapshot !== first!.snapshot) return { ok: false, reason: 'BASIS_MOVED' }
    return { ok: true, snapshotId: first!.snapshot, sections }
  } catch (error) {
    return { ok: false, reason: closedReason(error) }
  } finally {
    if (open) { try { await client.query('ROLLBACK') } catch { /* the caller closes the connection; a failed rollback cannot have written anything */ } }
  }
}

// ---------------------------------------------------------------------------------------------
// Population boundaries
// ---------------------------------------------------------------------------------------------

export type PopulationScope = 'storefront-order' | 'first-load'
export type PopulationVerdict = { kind: 'in' } | { kind: 'out'; reason: PackPopulationReason } | { kind: 'unknown'; reason: 'NO_POPULATION_RECORD' }

function horizon(asOf: string, months: number): number | null {
  if (!ASOF_RE.test(asOf) || !Number.isSafeInteger(months) || months < 1) return null
  const [y, m, d] = asOf.split('-').map(Number) as [number, number, number]
  const index = y * 12 + (m - 1) - months
  const year = Math.floor(index / 12)
  const month = index - year * 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const value = Date.UTC(year, month, Math.min(d, lastDay))
  return Number.isNaN(value) ? null : value
}

/**
 * Whether an identity created at `createdAt` is inside the population the RECORDED boundaries define. An identity with no usable
 * creation instant, or whose scope has no usable record, is `unknown`: the caller makes the item inconclusive and never treats it
 * as in. An instant equal to a boundary is IN (judged, not set aside).
 */
export function classifyPopulation(boundaries: PopulationBoundaries, scope: PopulationScope, createdAt: string | null, asOf: string): PopulationVerdict {
  const unknown: PopulationVerdict = { kind: 'unknown', reason: 'NO_POPULATION_RECORD' }
  if (createdAt === null || !ISO_UTC_RE.test(createdAt)) return unknown
  const at = Date.parse(createdAt)
  if (Number.isNaN(at)) return unknown
  if (scope === 'first-load') {
    if (boundaries.firstLoad.state !== 'verified') return unknown
    const cut = Date.parse(boundaries.firstLoad.cutAt)
    if (Number.isNaN(cut)) return unknown
    return at < cut ? { kind: 'out', reason: 'BEFORE_FIRST_LOAD' } : { kind: 'in' }
  }
  if (boundaries.storefrontImport.state !== 'completed') return unknown
  const cut = Date.parse(boundaries.storefrontImport.cutAt)
  if (Number.isNaN(cut)) return unknown
  if (at < cut) return { kind: 'out', reason: 'BEFORE_STOREFRONT_IMPORT' }
  if (boundaries.retentionMonths > 0) {
    const limit = horizon(asOf, boundaries.retentionMonths)
    if (limit === null) return unknown
    if (at < limit) return { kind: 'out', reason: 'OLDER_THAN_RETENTION' }
  }
  return { kind: 'in' }
}

/** R1 is meaningful only while alignment is unconfirmed (F5). DISABLED bindings take no part. */
export function alignmentState(binding: Pick<WmsBindingRow, 'stockSyncMode' | 'alignmentConfirmed'>): 'disabled' | 'unconfirmed' | 'confirmed' {
  if (binding.stockSyncMode === 'DISABLED') return 'disabled'
  if (binding.stockSyncMode === 'NOTIFICATION_ONLY') return 'unconfirmed'
  return binding.alignmentConfirmed ? 'confirmed' : 'unconfirmed'
}
