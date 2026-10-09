/**
 * THE FIRST-LOAD TRANSFORM: canonical rows in, importer-ready CSV files and a validation report out.
 *
 * PURE. No database, no network, no clock, no filesystem: it takes parsed datasets and a config and returns strings.
 * DETERMINISTIC. Every dataset is sorted by content before it is processed and every output is sorted by key, so the same
 * data in a different row order gives byte-identical files. The only run-specific text is the explicit `runId`.
 *
 * Every input record gets exactly one disposition: EMITTED (it is in an output file, or, for datasets that only feed
 * checks, it was used), EXCLUDED (deliberately not loaded, with a reason) or REJECTED (an error, with a reason). The
 * accounting identity `read = emitted + excluded + rejected` is checked for every dataset.
 *
 * ANY rejected record or ERROR finding blocks the whole run: no import file is produced. A half-load that someone uploads
 * because "the report said 3 rows were bad" is exactly the failure this tool exists to prevent.
 */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { parseCsv } from '@/lib/csv'
import { parseCsvStrict, serializeCsv } from './csv'
import { PART_LINE_STRIDE, type CanonRow, type IngestedDataset } from './ingest'
import { D, fmt, fmtFixed, parseDecimal, roundTo, sum, type Dec } from './money'
import {
  APPLY_TIME_CHECKS,
  AVERAGE_COST_DP,
  DATASETS,
  IMPORT_TARGETS,
  LIFECYCLE_STATUSES,
  NUMERIC_LIMITS,
  PRODUCT_TYPES,
  RECIPE_TYPES,
  STOCK_BEARING_TYPES,
  STRANDED_TRANSFER_DAYS,
  type DatasetName,
  type ImporterTarget,
  type InTransitConvention,
  type ProductType,
} from './spec'
import { joinVariantParents, type CatalogueView } from './variant-parents'
import {
  accountRows,
  assertWithinImporterLimits,
  chunkUnits,
  dispositionAnomalies,
  findRecipeCycles,
  hasInvisibleKeyChars,
  idToken,
  parseSku,
  skuKey,
  type AccountingRow,
  type ChunkLimits,
  type Outcome,
  type RowDisposition,
  DEFAULT_CHUNK_LIMITS,
} from './validate'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export interface PrepareConfig {
  /** Explicit, caller-supplied label. The only run-specific text that may appear in an output. */
  runId: string | null
  baseCurrency: string
  /** YYYY-MM-DD. Only used to date-check transfers; never read from a clock. */
  asOf: string | null
  inTransitConvention: InTransitConvention | null
  purchaseOrderKeyPrefix: string | null
  transferKeyPrefix: string | null
  /**
   * Worst-case purchase tax rate as a fraction ("0.25"), declared by the operator. The importer applies an IMS tax rate it
   * resolves by NAME (or the supplier's default), which this DB-free tool cannot read, so every order is bounded with this rate.
   */
  maxPurchaseTaxRate: string | null
  chunkLimits?: ChunkLimits
}

export interface PrepareInput {
  config: PrepareConfig
  datasets: Partial<Record<DatasetName, IngestedDataset>>
}

export type Severity = 'ERROR' | 'WARNING' | 'INFO'
const SEVERITY_RANK: Record<Severity, number> = { ERROR: 0, WARNING: 1, INFO: 2 }

export interface Finding {
  severity: Severity
  code: string
  message: string
  dataset?: DatasetName
  keys?: string[]
}

export interface OutputFile {
  name: string
  target: ImporterTarget
  chunk: number
  chunks: number
  rows: number
  bytes: number
  sha256: string
  content: string
}

export interface StockGroupReport {
  sku: string
  warehouseCode: string
  lots: number
  lotQty: string
  lotTotalBase: string
  averageUnitCostBase: string
  collapsedTotalBase: string
  roundingResidualBase: string
  inTransitQty: string
  openingQty: string
}

export interface PrepareReport {
  tool: 'first-load-prepare'
  formatVersion: 1
  runId: string | null
  verdict: 'PASS' | 'BLOCKED'
  config: {
    baseCurrency: string
    asOf: string | null
    inTransitConvention: InTransitConvention | null
    purchaseOrderKeyPrefix: string | null
    transferKeyPrefix: string | null
    maxPurchaseTaxRate: string | null
    maxRowsPerFile: number
    maxBytesPerFile: number
  }
  inputs: Array<{
    dataset: DatasetName
    file: string
    sha256: string
    bytes: number
    hadBom: boolean
    blankRows: number
    recordsRead: number
    rowsSkipped: number
    parts: Array<{ file: string; sha256: string; bytes: number }>
    unmappedHeaders: string[]
  }>
  notSupplied: DatasetName[]
  checks: Array<{ check: string; status: 'RAN' | 'NOT RUN'; note: string }>
  accounting: AccountingRow[]
  accountingByCode: Array<{ dataset: string; outcome: Outcome; code: string; count: number }>
  accountingBalanced: boolean
  outputs: Array<Omit<OutputFile, 'content'>>
  plannedOutputRows: Record<ImporterTarget, number>
  findings: Finding[]
  /** Every EXCLUDED and REJECTED record. EMITTED records are counted in `accounting`, not listed. */
  dispositions: RowDisposition[]
  stock: {
    groups: StockGroupReport[]
    totals: { lotQty: string; lotTotalBase: string; collapsedTotalBase: string; roundingResidualBase: string; openingQty: string; openingValueBase: string }
    zeroOnHand: string[]
    missingFromExtract: Array<{ sku: string; holdsStockElsewhere: boolean | null; wmsQty: string | null }>
  }
  coverage: {
    patterns: Array<{ pattern: string; count: number; skus: string[] }>
    notLoadedAndNotExcluded: string[]
    excludedAccepted: string[]
  }
  recipes: { cycles: string[][] }
  /** The join of Qoblex variants to WooCommerce variation parents (dataset `variant-parents`); `supplied` is false when it was not given. */
  variantParents: { supplied: boolean; rowsRead: number; variantsJoined: number; parentsEmitted: number; parentsWithoutQoblexVariant: number }
  purchaseOrders: { orders: number; ordersNothingOutstanding: number; linesEmitted: number }
  transfers: { transfers: number; linesEmitted: number }
  /** Every warehouse code the import files use. The importers refuse a code that does not exist in IMS; the tool cannot check that. */
  warehouseCodesUsed: string[]
  /** Importer rejection rules this tool cannot prove; the apply step must verify them (see APPLY_TIME_CHECKS). */
  applyTimeChecks: Array<{ id: string; area: string; check: string }>
  selfCheckFailures: string[]
}

export interface PrepareResult {
  outputs: OutputFile[]
  report: PrepareReport
  /** True when any record was rejected or any ERROR finding exists. Then `outputs` is empty. */
  blocking: boolean
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Rows in FILE order. Nothing downstream depends on that order: every group is keyed, every conflict rejects ALL of its members,
 * and every output and report list is sorted explicitly where it is built. (A pre-sort here would be a second mechanism
 * producing the same determinism and would hide a missing sort at the real site from the shuffle test.)
 */
function fileOrderRows(dataset: IngestedDataset | undefined): CanonRow[] {
  return dataset ? dataset.rows : []
}

function parseBool(raw: string): 'TRUE' | 'FALSE' | '' | null {
  const v = raw.trim().toLowerCase()
  if (v === '') return ''
  if (['true', '1', 'yes', 'y'].includes(v)) return 'TRUE'
  if (['false', '0', 'no', 'n'].includes(v)) return 'FALSE'
  return null
}

function parseIsoDate(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const back = new Date(ms)
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null
  return ms
}

function parseCurrency(raw: string): string | null {
  const v = raw.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(v) ? v : null
}

function parseWarehouse(raw: string, label: string): { ok: true; code: string } | { ok: false; reason: string } {
  const code = raw.normalize('NFC').trim().toUpperCase()
  if (code === '') return { ok: false, reason: `${label} is empty` }
  if (/[\u0000-\u001f\u007f\u00a0\u200b-\u200d\u2060\ufeff,"]/.test(code)) return { ok: false, reason: `${label} ${JSON.stringify(code)} contains a forbidden character` }
  return { ok: true, code }
}

function resolveFx(
  currency: string,
  baseCurrency: string,
  rawFx: string,
): { ok: true; fx: Dec; text: string } | { ok: false; reason: string } {
  if (currency === baseCurrency) {
    if (rawFx.trim() === '') return { ok: true, fx: new D(1), text: '1' }
    const parsed = parseDecimal(rawFx, 'fxRateToBase', NUMERIC_LIMITS.fx)
    if (!parsed.ok) return parsed
    if (!parsed.value.eq(1)) return { ok: false, reason: `fxRateToBase ${rawFx.trim()} is given for the base currency ${baseCurrency}; it must be 1 or blank` }
    return { ok: true, fx: new D(1), text: '1' }
  }
  if (rawFx.trim() === '') return { ok: false, reason: `fxRateToBase is required for non-base currency ${currency} (base is ${baseCurrency})` }
  const parsed = parseDecimal(rawFx, 'fxRateToBase', NUMERIC_LIMITS.fx)
  if (!parsed.ok) return parsed
  if (parsed.value.lte(0)) return { ok: false, reason: `fxRateToBase ${rawFx.trim()} must be greater than zero` }
  return { ok: true, fx: parsed.value, text: fmt(parsed.value) }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type CatStatus = 'ok' | 'rejected' | 'excluded'

interface CatEntry {
  sku: string
  key: string
  name: string
  type: ProductType
  parentSku: string
  cells: Record<string, string>
  /** The lifecycle status the importer will give this product. */
  lifecycle: string
}

interface StockGroup {
  sku: string
  key: string
  warehouseCode: string
  lots: number
  lotQty: Dec
  lotTotal: Dec
  average: Dec
  collapsedTotal: Dec
  residual: Dec
  inTransit: Dec
  openingQty: Dec
}

interface TransferLine {
  line: number
  transferKey: string
  from: string
  to: string
  status: string
  notes: string
  sku: string
  key: string
  outstanding: Dec
}

class Run {
  disp: RowDisposition[] = []
  findings: Finding[] = []
  selfCheck: string[] = []
  cat = new Map<string, CatEntry>()
  catStatus = new Map<string, CatStatus>()
  catAnyParsed = new Map<string, string>()
  ims = new Map<string, { sku: string; type: string | null }>()
  exclusions = new Map<string, { sku: string; reason: string }>()
  recipeComponents = new Map<string, Array<{ componentSku: string; componentKey: string; qty: Dec; sortOrder: number | null }>>()
  recipeCycles: string[][] = []
  imsSuppliers = new Map<string, string>()
  imsSuppliersLower = new Map<string, string>()
  imsSupplierCollidedKeys = new Set<string>()
  suppliers = new Map<string, { name: string; cells: Record<string, string> }>()
  supplierStatus = new Map<string, 'ok' | 'rejected'>()
  stockGroups = new Map<string, StockGroup>()
  stockStated = new Set<string>()
  zeroStated = new Set<string>()
  stockRejected = new Set<string>()
  skuTrimmed = new Map<string, number>()
  skuRespelled = new Map<string, number>()
  warehouses = new Set<string>()
  transferLines: TransferLine[] = []
  transferOutputs: Array<{ key: string; rows: string[][] }> = []
  poOutputs: Array<{ key: string; rows: string[][] }> = []
  poOrdersNothingOutstanding = 0
  wmsQty = new Map<string, Dec>()
  wmsSkus = new Map<string, string>()
  wooSkus = new Map<string, string>()
  /** VARIABLE parents created from the variant-parents dataset (they are output rows without a products-dataset record). */
  syntheticParents = new Set<string>()
  variantParentKeys = new Set<string>()
  variantParentSummary = { supplied: false, rowsRead: 0, variantsJoined: 0, parentsEmitted: 0, parentsWithoutQoblexVariant: 0 }

  constructor(readonly input: PrepareInput) {}

  get config(): PrepareConfig {
    return this.input.config
  }

  add(dataset: DatasetName, line: number, key: string, outcome: Outcome, code: string, reason: string): void {
    this.disp.push({ dataset, line, key, outcome, code, reason })
  }

  find(severity: Severity, code: string, message: string, dataset?: DatasetName, keys?: string[]): void {
    this.findings.push({ severity, code, message, dataset, keys: keys ? [...new Set(keys)].sort(cmp) : undefined })
  }

  has(name: DatasetName): boolean {
    return this.input.datasets[name] !== undefined
  }

  rows(name: DatasetName): CanonRow[] {
    return fileOrderRows(this.input.datasets[name])
  }
}

type Resolved =
  | { kind: 'ok'; sku: string; key: string; type: string | null; source: 'catalogue' | 'ims'; lifecycle: string | null }
  | { kind: 'excluded'; reason: string }
  | { kind: 'rejected' }
  | { kind: 'absent' }

function resolveProduct(run: Run, key: string): Resolved {
  const excluded = run.exclusions.get(key)
  if (excluded) return { kind: 'excluded', reason: excluded.reason }
  const status = run.catStatus.get(key)
  if (status === 'rejected') return { kind: 'rejected' }
  if (status === 'ok') {
    const entry = run.cat.get(key)!
    return { kind: 'ok', sku: entry.sku, key, type: entry.type, source: 'catalogue', lifecycle: entry.lifecycle }
  }
  const ims = run.ims.get(key)
  if (ims) return { kind: 'ok', sku: ims.sku, key, type: ims.type, source: 'ims', lifecycle: null }
  return { kind: 'absent' }
}

function skuProblem(res: Resolved, what: string): { code: string; reason: string } | null {
  if (res.kind === 'rejected') return { code: 'PRODUCT_ROW_REJECTED', reason: `${what}'s catalogue row was rejected, so the SKU will not exist in IMS` }
  if (res.kind === 'absent') return { code: 'SKU_NOT_IN_CATALOGUE', reason: `${what} is not in the products dataset or the IMS SKU list` }
  return null
}

/** Counts SKU cells that were trimmed, and cells matched to the catalogue under a different letter case, per dataset. */
function trackSku(run: Run, dataset: DatasetName, parsed: { sku: string; trimmed: boolean }, canonical: string): void {
  if (parsed.trimmed) run.skuTrimmed.set(dataset, (run.skuTrimmed.get(dataset) ?? 0) + 1)
  if (parsed.sku !== canonical) run.skuRespelled.set(dataset, (run.skuRespelled.get(dataset) ?? 0) + 1)
}

function reportNormalisation(run: Run): void {
  const datasets = [...new Set([...run.skuTrimmed.keys(), ...run.skuRespelled.keys()])].sort(cmp) as DatasetName[]
  for (const dataset of datasets) {
    const trimmed = run.skuTrimmed.get(dataset) ?? 0
    const respelled = run.skuRespelled.get(dataset) ?? 0
    run.find('INFO', 'SKU_NORMALISED', `${dataset}: ${trimmed} SKU cell(s) had outer whitespace trimmed and ${respelled} were matched to the catalogue under a different letter case (the catalogue spelling is what is written)`, dataset)
  }
}

// ---------------------------------------------------------------------------
// Exclusions and existing IMS SKUs
// ---------------------------------------------------------------------------

function loadExclusions(run: Run): void {
  const groups = new Map<string, Array<{ row: CanonRow; sku: string; reason: string }>>()
  for (const row of run.rows('sku-exclusions')) {
    const sku = parseSku(row.values.sku)
    if (!sku.ok) {
      run.add('sku-exclusions', row.line, row.values.sku, 'REJECTED', 'BAD_SKU', sku.reason)
      continue
    }
    if (row.values.reason === '') {
      run.add('sku-exclusions', row.line, sku.sku, 'REJECTED', 'MISSING_REASON', 'an exclusion needs a written reason: it is the owner-accepted record of why this SKU is not loaded')
      continue
    }
    groups.set(sku.key, [...(groups.get(sku.key) ?? []), { row, sku: sku.sku, reason: row.values.reason }])
  }
  for (const [key, list] of [...groups.entries()]) {
    if (new Set(list.map((entry) => entry.reason)).size > 1 || new Set(list.map((entry) => entry.sku)).size > 1) {
      for (const entry of list) run.add('sku-exclusions', entry.row.line, entry.sku, 'REJECTED', 'CONFLICTING_EXCLUSION', 'the same SKU is listed with different reasons or different letter case')
      continue
    }
    run.exclusions.set(key, { sku: list[0].sku, reason: list[0].reason })
    run.add('sku-exclusions', list[0].row.line, list[0].sku, 'EMITTED', 'EXCLUSION_REGISTERED', 'registered on the accepted exclusion list')
    for (const extra of list.slice(1)) run.add('sku-exclusions', extra.row.line, extra.sku, 'EXCLUDED', 'DUPLICATE_EXCLUSION', 'exact duplicate of another exclusion row')
  }
}

function loadImsSkus(run: Run): void {
  const groups = new Map<string, Array<{ row: CanonRow; sku: string; type: string | null }>>()
  for (const row of run.rows('ims-skus')) {
    const sku = parseSku(row.values.sku)
    if (!sku.ok) {
      run.add('ims-skus', row.line, row.values.sku, 'REJECTED', 'BAD_SKU', sku.reason)
      continue
    }
    const type = row.values.type === '' ? null : row.values.type.toUpperCase()
    if (type !== null && !(PRODUCT_TYPES as readonly string[]).includes(type)) {
      run.add('ims-skus', row.line, sku.sku, 'REJECTED', 'BAD_TYPE', `type ${JSON.stringify(row.values.type)} is not one of ${PRODUCT_TYPES.join(', ')}`)
      continue
    }
    groups.set(sku.key, [...(groups.get(sku.key) ?? []), { row, sku: sku.sku, type }])
  }
  for (const [key, list] of [...groups.entries()]) {
    if (new Set(list.map((e) => `${e.sku}|${e.type}`)).size > 1) {
      for (const entry of list) run.add('ims-skus', entry.row.line, entry.sku, 'REJECTED', 'CONFLICTING_IMS_SKU', 'the same SKU appears with different type or letter case')
      continue
    }
    run.ims.set(key, { sku: list[0].sku, type: list[0].type })
    run.add('ims-skus', list[0].row.line, list[0].sku, 'EMITTED', 'IMS_SKU_REGISTERED', 'used by the coverage and lookup checks')
    for (const extra of list.slice(1)) run.add('ims-skus', extra.row.line, extra.sku, 'EXCLUDED', 'DUPLICATE_IMS_SKU', 'exact duplicate of another row')
  }
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

const CATEGORY_MAX = 100 // PRODUCT_CATEGORY_NAME_MAX_LENGTH in lib/products/categories.ts

function validateProductRow(row: CanonRow): { ok: true; entry: CatEntry } | { ok: false; code: string; reason: string; key: string } {
  const v = row.values
  const sku = parseSku(v.sku)
  if (!sku.ok) return { ok: false, code: 'BAD_SKU', reason: sku.reason, key: v.sku }
  const fail = (code: string, reason: string) => ({ ok: false as const, code, reason, key: sku.sku })
  if (v.name === '') return fail('MISSING_NAME', 'name is empty')
  const type = v.type.toUpperCase()
  if (!(PRODUCT_TYPES as readonly string[]).includes(type)) {
    return fail('BAD_TYPE', `type ${JSON.stringify(v.type)} is not one of ${PRODUCT_TYPES.join(', ')} (map the source's own type names in the column map's valueMaps.type)`)
  }
  let parentSku = ''
  if (v.parentSku !== '') {
    const parent = parseSku(v.parentSku, 'parentSku')
    if (!parent.ok) return fail('BAD_PARENT_SKU', parent.reason)
    parentSku = parent.sku
  }
  const cells: Record<string, string> = {}
  for (const column of ['weight', 'widthCm', 'heightCm', 'depthCm'] as const) {
    if (v[column] === '') continue
    const parsed = parseDecimal(v[column], column, column === 'weight' ? NUMERIC_LIMITS.weight : NUMERIC_LIMITS.dimension)
    if (!parsed.ok) return fail('BAD_NUMBER', parsed.reason)
    cells[column] = fmt(parsed.value)
  }
  for (const column of ['salesPriceBase', 'salePriceBase'] as const) {
    if (v[column] === '') continue
    const parsed = parseDecimal(v[column], column, NUMERIC_LIMITS.price)
    if (!parsed.ok) return fail('BAD_NUMBER', parsed.reason)
    cells[column] = fmt(parsed.value)
  }
  for (const column of ['salesPriceTaxInclusive', 'active'] as const) {
    const parsed = parseBool(v[column])
    if (parsed === null) return fail('BAD_BOOLEAN', `${column} ${JSON.stringify(v[column])} is not TRUE/FALSE (the importer would silently read anything else as FALSE)`)
    if (parsed !== '') cells[column] = parsed
  }
  if (v.lifecycleStatus !== '') {
    const status = v.lifecycleStatus.toUpperCase()
    if (!(LIFECYCLE_STATUSES as readonly string[]).includes(status)) return fail('BAD_LIFECYCLE', `lifecycleStatus ${JSON.stringify(v.lifecycleStatus)} is not one of ${LIFECYCLE_STATUSES.join(', ')}`)
    cells.lifecycleStatus = status
  }
  // The importer cleans the name (HTML entities, NFKC, control characters, whitespace runs) BEFORE its length check; this
  // mirrors the part that can be done without lib/products/categories (which imports the database).
  const categoryCleaned = v.category.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (categoryCleaned.length > CATEGORY_MAX) return fail('CATEGORY_TOO_LONG', `category is longer than ${CATEGORY_MAX} characters once cleaned`)
  for (const column of ['description', 'barcode', 'mpn', 'countryOfOrigin', 'stockUnit', 'imageUrl', 'category'] as const) {
    if (v[column] !== '') cells[column] = v[column]
  }
  // The importer's own derivation: a valid lifecycleStatus wins, otherwise active FALSE means EOL, otherwise ACTIVE.
  const lifecycle = cells.lifecycleStatus ?? (cells.active === 'FALSE' ? 'EOL' : 'ACTIVE')
  return { ok: true, entry: { sku: sku.sku, key: sku.key, name: v.name, type: type as ProductType, parentSku, cells, lifecycle } }
}

function loadCatalogue(run: Run): void {
  type Candidate = { row: CanonRow; entry: CatEntry }
  const groups = new Map<string, Candidate[]>()
  for (const row of run.rows('products')) {
    const parsedSku = parseSku(row.values.sku)
    if (parsedSku.ok) run.catAnyParsed.set(parsedSku.key, parsedSku.sku)
    const result = validateProductRow(row)
    if (!result.ok) {
      run.add('products', row.line, result.key, 'REJECTED', result.code, result.reason)
      if (parsedSku.ok) run.catStatus.set(parsedSku.key, 'rejected')
      continue
    }
    groups.set(result.entry.key, [...(groups.get(result.entry.key) ?? []), { row, entry: result.entry }])
  }

  const survivors: Candidate[] = []
  for (const [key, list] of [...groups.entries()]) {
    const signatures = new Set(list.map((c) => JSON.stringify([c.entry.sku, c.entry.name, c.entry.type, c.entry.parentSku, c.entry.cells])))
    const distinctSkus = new Set(list.map((c) => c.entry.sku))
    if (distinctSkus.size > 1) {
      for (const c of list) run.add('products', c.row.line, c.entry.sku, 'REJECTED', 'SKU_CASE_COLLISION', `SKUs ${[...distinctSkus].sort(cmp).map((s) => JSON.stringify(s)).join(' and ')} differ only by letter case; the opening-stock, transfer and purchase-order importers cannot tell them apart`)
      run.catStatus.set(key, 'rejected')
      continue
    }
    if (signatures.size > 1) {
      for (const c of list) run.add('products', c.row.line, c.entry.sku, 'REJECTED', 'DUPLICATE_SKU_CONFLICT', `the SKU appears ${list.length} times with different data; which row is right cannot be decided`)
      run.catStatus.set(key, 'rejected')
      continue
    }
    if (list.length > 1) for (const extra of list.slice(1)) run.add('products', extra.row.line, extra.entry.sku, 'EXCLUDED', 'DUPLICATE_ROW', 'exact duplicate of another product row (same data)')
    survivors.push(list[0])
  }

  const afterIms: Candidate[] = []
  for (const c of survivors) {
    const existing = run.ims.get(c.entry.key)
    if (existing && existing.sku !== c.entry.sku) {
      run.add('products', c.row.line, c.entry.sku, 'REJECTED', 'SKU_CASE_DIFFERS_FROM_IMS', `IMS already has ${JSON.stringify(existing.sku)}, which differs only by letter case: the products importer matches exactly and would create a second product, and the opening-stock, transfer and purchase-order importers could not tell them apart`)
      run.catStatus.set(c.entry.key, 'rejected')
    } else afterIms.push(c)
  }
  const afterExclusion: Candidate[] = []
  for (const c of afterIms) {
    const excluded = run.exclusions.get(c.entry.key)
    if (excluded) {
      run.add('products', c.row.line, c.entry.sku, 'EXCLUDED', 'EXCLUDED_BY_LIST', `on the accepted exclusion list: ${excluded.reason}`)
      run.catStatus.set(c.entry.key, 'excluded')
    } else afterExclusion.push(c)
  }

  const byBarcode = new Map<string, Candidate[]>()
  for (const c of afterExclusion) {
    const barcode = c.entry.cells.barcode
    if (barcode) byBarcode.set(barcode, [...(byBarcode.get(barcode) ?? []), c])
  }
  const barcodeLoser = new Set<string>()
  for (const [barcode, list] of [...byBarcode.entries()]) {
    if (list.length < 2) continue
    for (const c of list) {
      barcodeLoser.add(c.entry.key)
      run.add('products', c.row.line, c.entry.sku, 'REJECTED', 'DUPLICATE_BARCODE', `barcode ${JSON.stringify(barcode)} is shared by ${list.map((x) => x.entry.sku).sort(cmp).join(', ')}; the importer refuses a barcode already in use`)
      run.catStatus.set(c.entry.key, 'rejected')
    }
  }
  const remaining = afterExclusion.filter((c) => !barcodeLoser.has(c.entry.key))

  const categorySpellings = new Map<string, Set<string>>()
  const entityCategories: string[] = []
  for (const c of remaining) {
    const raw = c.entry.cells.category
    if (!raw) continue
    const spelling = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
    const key = spelling.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    categorySpellings.set(key, (categorySpellings.get(key) ?? new Set<string>()).add(spelling))
    if (/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(raw)) entityCategories.push(spelling)
  }
  const merged = [...categorySpellings.values()].filter((set) => set.size > 1).map((set) => [...set].sort(cmp).join(' / '))
  if (merged.length > 0) run.find('WARNING', 'CATEGORY_SPELLINGS_MERGED', 'category spellings that differ only by case, accents or whitespace are ONE category to the importer: they will be merged into whichever it creates first', 'products', merged)
  if (entityCategories.length > 0) run.find('WARNING', 'CATEGORY_HTML_ENTITY', 'the importer decodes HTML entities in a category name, so the stored name will differ from this text', 'products', entityCategories)

  joinVariantParentsInto(run, remaining.map((c) => c.entry))

  const typeOf = new Map<string, ProductType>([...remaining.map((c) => [c.entry.key, c.entry.type] as const), ...[...run.syntheticParents].map((key) => [key, 'VARIABLE' as const] as const)])
  const unjoined: string[] = []
  for (const c of remaining) {
    const { entry } = c
    if (entry.type === 'VARIANT') {
      if (entry.parentSku === '') {
        run.add('products', c.row.line, entry.sku, 'REJECTED', 'VARIANT_WITHOUT_PARENT', run.variantParentSummary.supplied
          ? 'a VARIANT needs a parentSku, and no WooCommerce variation has this SKU (the join is by exact SKU; it is never guessed from the SKU\'s shape, and the variant is never loaded as a simple product)'
          : 'a VARIANT needs a parentSku (the variant-parents dataset, read from WooCommerce, supplies it)')
        run.catStatus.set(entry.key, 'rejected')
        unjoined.push(entry.sku)
        continue
      }
      const parentKey = skuKey(entry.parentSku)
      if (typeOf.get(parentKey) !== 'VARIABLE') {
        const why = run.exclusions.has(parentKey) ? 'is on the exclusion list' : typeOf.has(parentKey) ? `is type ${typeOf.get(parentKey)}, not VARIABLE` : 'is not a valid product in the file'
        run.add('products', c.row.line, entry.sku, 'REJECTED', 'VARIANT_PARENT_INVALID', `parent SKU ${JSON.stringify(entry.parentSku)} ${why}`)
        run.catStatus.set(entry.key, 'rejected')
        continue
      }
    } else if (entry.parentSku !== '') {
      run.add('products', c.row.line, entry.sku, 'REJECTED', 'PARENT_ON_NON_VARIANT', `parentSku is only valid on a VARIANT; this product is ${entry.type}`)
      run.catStatus.set(entry.key, 'rejected')
      continue
    }
    run.cat.set(entry.key, entry)
    run.catStatus.set(entry.key, 'ok')
    run.add('products', c.row.line, entry.sku, 'EMITTED', 'PRODUCT', 'in the products import file')
  }
  if (unjoined.length > 0) {
    run.find('ERROR', 'VARIANT_WITHOUT_PARENT', `${unjoined.length} VARIANT product(s) have no parent: ${run.variantParentSummary.supplied ? 'no WooCommerce variation has their SKU' : 'no variant-parents dataset was supplied'}. Fix the SKU in Qoblex or WooCommerce, or put each on the exclusion list with a reason. They are never loaded as simple products.`, 'products', unjoined)
  }
}

/**
 * Joins the Qoblex VARIANT rows that have no parent to the WooCommerce variation with the same SKU (exact), assigns the variation's parent SKU
 * to the variant, and adds each parent reached to the catalogue ONCE as a VARIABLE product named by WooCommerce.
 */
function joinVariantParentsInto(run: Run, candidates: CatEntry[]): void {
  if (!run.has('variant-parents')) return
  if (!run.has('products')) {
    for (const row of run.rows('variant-parents')) run.add('variant-parents', row.line, row.values.variantSku, 'EXCLUDED', 'NO_CATALOGUE_TO_JOIN', 'the Qoblex products dataset was not supplied, so there is nothing to join')
    run.find('ERROR', 'VARIANT_PARENTS_NEED_CATALOGUE', 'the variant-parents dataset was supplied but the Qoblex products dataset was not: variants cannot be joined to their parents', 'variant-parents')
    run.variantParentSummary = { supplied: true, rowsRead: run.rows('variant-parents').length, variantsJoined: 0, parentsEmitted: 0, parentsWithoutQoblexVariant: 0 }
    return
  }
  const byKey = new Map(candidates.map((entry) => [entry.key, entry]))
  const catalogue = (key: string): CatalogueView => {
    const entry = byKey.get(key)
    if (entry) return { state: 'candidate', sku: entry.sku, type: entry.type, parentSku: entry.parentSku }
    const status = run.catStatus.get(key)
    if (status === 'rejected') return { state: 'rejected' }
    if (status === 'excluded') return { state: 'excluded' }
    return { state: 'absent' }
  }
  const result = joinVariantParents({
    rows: run.rows('variant-parents'),
    catalogue,
    imsKeys: new Set(run.ims.keys()),
    exclusions: new Map([...run.exclusions.entries()].map(([key, value]) => [key, value.reason])),
  })
  for (const d of result.dispositions) run.add('variant-parents', d.line, d.key, d.outcome, d.code, d.reason)
  for (const f of result.findings) run.find(f.severity, f.code, f.message, 'variant-parents', f.keys)
  for (const [variantKey, parentSku] of result.assignments) {
    const entry = byKey.get(variantKey)
    if (entry) entry.parentSku = parentSku
  }
  for (const parent of result.parents) {
    const entry: CatEntry = {
      sku: parent.sku, key: parent.key, name: parent.name, type: 'VARIABLE', parentSku: '',
      cells: { lifecycleStatus: parent.lifecycle }, lifecycle: parent.lifecycle,
    }
    run.cat.set(entry.key, entry)
    run.catStatus.set(entry.key, 'ok')
    run.syntheticParents.add(entry.key)
  }
  for (const key of result.namedKeys) run.variantParentKeys.add(key)
  run.variantParentSummary = { supplied: true, ...result.summary }
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

function loadRecipes(run: Run): void {
  type Line = { row: CanonRow; parent: string; parentKey: string; component: string; componentKey: string; qty: Dec; sortOrder: number | null }
  const candidates: Line[] = []
  for (const row of run.rows('recipe-lines')) {
    const v = row.values
    const parent = parseSku(v.parentSku, 'parentSku')
    const component = parseSku(v.componentSku, 'componentSku')
    const label = parent.ok ? parent.sku : v.parentSku
    const reject = (code: string, reason: string) => run.add('recipe-lines', row.line, label, 'REJECTED', code, reason)
    if (!parent.ok) { reject('BAD_SKU', parent.reason); continue }
    if (!component.ok) { reject('BAD_SKU', component.reason); continue }
    if (/[;:]/.test(component.sku)) { reject('COMPONENT_SKU_HAS_DELIMITER', `component SKU ${JSON.stringify(component.sku)} contains ":" or ";", which the importer's components cell uses as separators`); continue }
    const qty = parseDecimal(v.qty, 'qty', NUMERIC_LIMITS.lineQty)
    if (!qty.ok) { reject('BAD_QTY', qty.reason); continue }
    if (qty.value.lte(0)) { reject('BAD_QTY', `qty ${v.qty} must be greater than zero`); continue }
    let sortOrder: number | null = null
    if (v.sortOrder !== '') {
      if (!/^\d{1,6}$/.test(v.sortOrder)) { reject('BAD_SORT_ORDER', `sortOrder ${JSON.stringify(v.sortOrder)} is not a whole number`); continue }
      sortOrder = Number(v.sortOrder)
    }

    const parentRes = resolveProduct(run, parent.key)
    if (parentRes.kind === 'excluded') {
      run.add('recipe-lines', row.line, parent.sku, 'EXCLUDED', 'PARENT_EXCLUDED_BY_LIST', `parent is on the accepted exclusion list: ${parentRes.reason}`)
      continue
    }
    const parentProblem = skuProblem(parentRes, `parent ${parent.sku}`)
    if (parentProblem) { reject(parentProblem.code, parentProblem.reason); continue }
    if (parentRes.kind === 'ok' && parentRes.source === 'ims') { reject('PARENT_ONLY_IN_IMS', `parent ${parent.sku} exists only in IMS; its recipe cannot be loaded from this file`); continue }
    if (parentRes.kind === 'ok' && !RECIPE_TYPES.has(parentRes.type ?? '')) { reject('PARENT_NOT_RECIPE_TYPE', `parent ${parent.sku} is ${parentRes.type}; only KIT and BOM carry a recipe`); continue }
    const componentRes = resolveProduct(run, component.key)
    if (componentRes.kind === 'excluded') { reject('COMPONENT_EXCLUDED_BY_LIST', `component ${component.sku} is on the exclusion list (${componentRes.reason}) but its parent ${parent.sku} is loaded: the recipe would be incomplete`); continue }
    const componentProblem = skuProblem(componentRes, `component ${component.sku}`)
    if (componentProblem) { reject(componentProblem.code, componentProblem.reason); continue }
    if (parentRes.kind === 'ok') trackSku(run, 'recipe-lines', parent, parentRes.sku)
    if (componentRes.kind === 'ok') trackSku(run, 'recipe-lines', component, componentRes.sku)
    candidates.push({ row, parent: parent.sku, parentKey: parent.key, component: component.sku, componentKey: component.key, qty: qty.value, sortOrder })
  }

  const byPair = new Map<string, Line[]>()
  for (const line of candidates) byPair.set(`${line.parentKey}\u0000${line.componentKey}`, [...(byPair.get(`${line.parentKey}\u0000${line.componentKey}`) ?? []), line])
  const valid: Line[] = []
  for (const [, list] of [...byPair.entries()]) {
    if (list.length > 1) {
      for (const line of list) run.add('recipe-lines', line.row.line, line.parent, 'REJECTED', 'DUPLICATE_RECIPE_LINE', `component ${line.component} is listed ${list.length} times for ${line.parent}; whether to add the quantities cannot be decided`)
    } else valid.push(list[0])
  }

  const { cycles, cyclicParents } = findRecipeCycles(valid.map((line) => ({ parent: line.parentKey, component: line.componentKey })))
  const skuOf = (key: string) => run.cat.get(key)?.sku ?? run.ims.get(key)?.sku ?? key
  run.recipeCycles = cycles.map((cycle) => cycle.map(skuOf))
  for (const cycle of run.recipeCycles) {
    run.find('ERROR', 'RECIPE_CYCLE', `recipe cycle: ${cycle.join(' -> ')}. The importer would refuse the whole catalogue because of it; fix it in Qoblex.`, 'recipe-lines', cycle)
  }
  for (const line of valid) {
    if (cyclicParents.has(line.parentKey)) {
      const path = run.recipeCycles.find((cycle) => cycle.some((sku) => skuKey(sku) === line.parentKey))
      run.add('recipe-lines', line.row.line, line.parent, 'REJECTED', 'RECIPE_CYCLE', `${line.parent} is on a recipe cycle (${path ? path.join(' -> ') : 'see findings'})`)
      continue
    }
    run.add('recipe-lines', line.row.line, line.parent, 'EMITTED', 'RECIPE_LINE', 'in the components cell of its parent')
    run.recipeComponents.set(line.parentKey, [
      ...(run.recipeComponents.get(line.parentKey) ?? []),
      { componentSku: line.component, componentKey: line.componentKey, qty: line.qty, sortOrder: line.sortOrder },
    ])
  }
  for (const list of run.recipeComponents.values()) {
    list.sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER) || cmp(a.componentKey, b.componentKey))
  }
}

function checkRecipesPresent(run: Run): void {
  const parents = [...run.cat.values()].filter((entry) => RECIPE_TYPES.has(entry.type))
  if (parents.length === 0) return
  if (!run.has('recipe-lines')) {
    run.find('ERROR', 'RECIPES_NOT_SUPPLIED', `the products dataset has ${parents.length} KIT/BOM product(s) but no recipe-lines dataset was supplied: they would load without components`, 'recipe-lines', parents.map((p) => p.sku))
    return
  }
  const missing = parents.filter((p) => !run.recipeComponents.has(p.key)).map((p) => p.sku)
  if (missing.length > 0) {
    run.find('ERROR', 'NO_RECIPE_LINES', `${missing.length} KIT/BOM product(s) have no loadable recipe line: a bundle or manufactured product without components is silently broken`, 'recipe-lines', missing)
  }
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

function loadImsSuppliers(run: Run): void {
  const entries: Array<{ row: CanonRow; name: string }> = []
  for (const row of run.rows('ims-suppliers')) {
    const name = row.values.name.normalize('NFC').trim()
    if (name === '') { run.add('ims-suppliers', row.line, '(blank)', 'REJECTED', 'MISSING_NAME', 'name is empty'); continue }
    entries.push({ row, name })
  }
  const byUpper = new Map<string, Set<string>>()
  const byLower = new Map<string, Set<string>>()
  for (const e of entries) {
    byUpper.set(e.name.toUpperCase(), (byUpper.get(e.name.toUpperCase()) ?? new Set<string>()).add(e.name))
    byLower.set(e.name.toLowerCase(), (byLower.get(e.name.toLowerCase()) ?? new Set<string>()).add(e.name))
  }
  const seen = new Set<string>()
  for (const e of entries) {
    if ((byUpper.get(e.name.toUpperCase())?.size ?? 0) > 1 || (byLower.get(e.name.toLowerCase())?.size ?? 0) > 1) {
      run.add('ims-suppliers', e.row.line, e.name, 'REJECTED', 'IMS_SUPPLIER_NAME_COLLISION', 'two suppliers already in IMS collide under the importers\' name matching: the importers cannot tell them apart and keep the last; fix it in IMS first')
      run.imsSupplierCollidedKeys.add(e.name.toUpperCase())
      run.imsSupplierCollidedKeys.add(e.name.toLowerCase())
    } else if (seen.has(e.name)) run.add('ims-suppliers', e.row.line, e.name, 'EXCLUDED', 'DUPLICATE_IMS_SUPPLIER', 'exact duplicate of another row')
    else {
      seen.add(e.name)
      run.imsSuppliers.set(e.name.toUpperCase(), e.name)
      run.imsSuppliersLower.set(e.name.toLowerCase(), e.name)
      run.add('ims-suppliers', e.row.line, e.name, 'EMITTED', 'IMS_SUPPLIER_REGISTERED', 'used by the supplier collision and purchase-order lookup checks')
    }
  }
}

/** The IMS supplier names a candidate name would be confused with (a different spelling under either importer rule, or a colliding pair). */
function imsSupplierRivals(run: Run, name: string): string[] {
  const rivals = new Set<string>()
  const upper = run.imsSuppliers.get(name.toUpperCase())
  const lower = run.imsSuppliersLower.get(name.toLowerCase())
  if (upper !== undefined && upper !== name) rivals.add(upper)
  if (lower !== undefined && lower !== name) rivals.add(lower)
  if (run.imsSupplierCollidedKeys.has(name.toUpperCase()) || run.imsSupplierCollidedKeys.has(name.toLowerCase())) rivals.add('(two colliding suppliers already in IMS)')
  return [...rivals].sort(cmp)
}

function loadSuppliers(run: Run): void {
  type Candidate = { row: CanonRow; name: string; cells: Record<string, string> }
  const groups = new Map<string, Candidate[]>()
  for (const row of run.rows('suppliers')) {
    const v = row.values
    const name = v.name.normalize('NFC').trim()
    const reject = (code: string, reason: string) => run.add('suppliers', row.line, name || '(blank)', 'REJECTED', code, reason)
    if (name === '') { reject('MISSING_NAME', 'name is empty'); continue }
    if (name.startsWith('#')) { reject('NAME_STARTS_WITH_HASH', 'the importers\' CSV reader silently skips a row whose first value starts with "#"'); continue }
    const cells: Record<string, string> = { name }
    if (v.currency !== '') {
      const currency = parseCurrency(v.currency)
      if (!currency) { reject('BAD_CURRENCY', `currency ${JSON.stringify(v.currency)} is not a 3-letter code`); continue }
      cells.currency = currency
    }
    if (v.paymentTermsDays !== '') {
      if (!/^\d{1,4}$/.test(v.paymentTermsDays)) { reject('BAD_PAYMENT_TERMS', `paymentTermsDays ${JSON.stringify(v.paymentTermsDays)} is not a whole number of days (the importer would truncate a fraction)`); continue }
      cells.paymentTermsDays = String(Number(v.paymentTermsDays))
    }
    for (const column of ['contactName', 'email', 'phone', 'vatNumber', 'accountNumber', 'addressLine1', 'addressLine2', 'city', 'county', 'postcode', 'country', 'notes'] as const) {
      if (v[column] !== '') cells[column] = v[column]
    }
    const key = name.toUpperCase()
    groups.set(key, [...(groups.get(key) ?? []), { row, name, cells }])
  }
  // The importers look a supplier up by NAME with two different rules: the purchase-order importer by `toUpperCase()`, the
  // supplier importer by trimmed `toLowerCase()`. Two spellings that collide under EITHER rule are one supplier to one importer
  // and two to the other, and a Map keeps the last, silently. Every row of every colliding spelling is rejected.
  const spellingsByLower = new Map<string, Set<string>>()
  for (const list of groups.values()) for (const c of list) spellingsByLower.set(c.name.toLowerCase(), (spellingsByLower.get(c.name.toLowerCase()) ?? new Set<string>()).add(c.name))
  const collided = new Set<string>()
  for (const [key, list] of groups) {
    const spellings = new Set(list.map((c) => c.name))
    for (const name of spellings) if (spellings.size > 1 || (spellingsByLower.get(name.toLowerCase())?.size ?? 0) > 1) collided.add(name)
    void key
  }
  for (const [key, list] of [...groups.entries()]) {
    const imsRivals = [...new Set(list.flatMap((c) => imsSupplierRivals(run, c.name)))]
    if (imsRivals.length > 0) {
      for (const c of list) run.add('suppliers', c.row.line, c.name, 'REJECTED', 'SUPPLIER_COLLIDES_WITH_IMS', `supplier name ${JSON.stringify(c.name)} collides with ${imsRivals.map((n) => JSON.stringify(n)).join(', ')} already in IMS under the importers' name matching: the supplier importer would update the wrong supplier or the purchase-order importer would resolve to it`)
      run.supplierStatus.set(key, 'rejected')
      continue
    }
    if (list.some((c) => collided.has(c.name))) {
      for (const c of list) {
        const rivals = [...new Set([...list.map((x) => x.name), ...(spellingsByLower.get(c.name.toLowerCase()) ?? [])])].filter((n) => n !== c.name).sort(cmp)
        run.add('suppliers', c.row.line, c.name, 'REJECTED', 'SUPPLIER_NAME_COLLISION', `supplier name ${JSON.stringify(c.name)} collides with ${rivals.map((n) => JSON.stringify(n)).join(', ') || 'another spelling'} under the importers' name matching (upper-case in the purchase-order importer, lower-case in the supplier importer); it would resolve to the wrong supplier`)
      }
      run.supplierStatus.set(key, 'rejected')
      for (const c of list) run.supplierStatus.set(c.name.toUpperCase(), 'rejected')
      continue
    }
    const signatures = new Set(list.map((c) => JSON.stringify(c.cells)))
    if (signatures.size > 1) {
      for (const c of list) run.add('suppliers', c.row.line, c.name, 'REJECTED', 'DUPLICATE_SUPPLIER_CONFLICT', `the supplier name appears ${list.length} times with different data`)
      run.supplierStatus.set(key, 'rejected')
      continue
    }
    run.suppliers.set(key, { name: list[0].name, cells: list[0].cells })
    run.supplierStatus.set(key, 'ok')
    run.add('suppliers', list[0].row.line, list[0].name, 'EMITTED', 'SUPPLIER', 'in the suppliers import file')
    for (const extra of list.slice(1)) run.add('suppliers', extra.row.line, extra.name, 'EXCLUDED', 'DUPLICATE_ROW', 'exact duplicate of another supplier row')
  }
}

// ---------------------------------------------------------------------------
// Stock lots -> one weighted-average opening-stock row per SKU x warehouse
// ---------------------------------------------------------------------------

/** True when |value| needs more than `digits` integer digits. */
function exceedsIntDigits(value: Dec, digits: number): boolean {
  return value.abs().gte(new D(10).pow(digits))
}

/** The opening row after an in-transit addition: its quantity and its value (quantity x average cost) must both be storable. */
function openingOutOfRange(group: StockGroup, need: Dec): boolean {
  const qty = group.lotQty.add(need)
  return exceedsIntDigits(qty, NUMERIC_LIMITS.stockQty.maxIntDigits) || exceedsIntDigits(group.average.mul(qty), NUMERIC_LIMITS.stockValue.maxIntDigits)
}

function stockGroupKey(key: string, warehouse: string): string {
  return `${key}\u0000${warehouse}`
}

/** Exact weighted average of a group, rounded ONCE to 6 dp (half up). Exported for the tests. */
export function collapseLots(lots: Array<{ qty: Dec; unitCostBase: Dec }>): { qty: Dec; lotTotal: Dec; average: Dec; collapsedTotal: Dec; residual: Dec } {
  const qty = sum(lots.map((l) => l.qty))
  const lotTotal = sum(lots.map((l) => l.qty.mul(l.unitCostBase)))
  const average = roundTo(lotTotal.div(qty), AVERAGE_COST_DP)
  const collapsedTotal = average.mul(qty)
  return { qty, lotTotal, average, collapsedTotal, residual: collapsedTotal.sub(lotTotal) }
}

function loadStock(run: Run): void {
  type Lot = { row: CanonRow; sku: string; key: string; warehouse: string; qty: Dec; unitCostBase: Dec; lotRef: string; date: string }
  const lots: Lot[] = []
  const excludedHolding = new Map<string, Dec>()
  for (const row of run.rows('stock-lots')) {
    const v = row.values
    const sku = parseSku(v.sku)
    const label = sku.ok ? sku.sku : v.sku
    const reject = (code: string, reason: string) => {
      run.add('stock-lots', row.line, label, 'REJECTED', code, reason)
      if (sku.ok) run.stockRejected.add(sku.key)
    }
    if (!sku.ok) { reject('BAD_SKU', sku.reason); continue }
    run.stockStated.add(sku.key)
    const warehouse = parseWarehouse(v.warehouseCode, 'warehouseCode')
    if (!warehouse.ok) { reject('BAD_WAREHOUSE', warehouse.reason); continue }
    const qty = parseDecimal(v.qty, 'qty', NUMERIC_LIMITS.stockQty, { allowNegative: true })
    if (!qty.ok) { reject('BAD_QTY', qty.reason); continue }
    if (qty.value.lt(0)) { reject('NEGATIVE_ON_HAND', `qty ${v.qty} is negative; a negative balance has no opening layer and must be resolved in the source`); continue }

    const res = resolveProduct(run, sku.key)
    if (res.kind === 'excluded') {
      run.add('stock-lots', row.line, sku.sku, 'EXCLUDED', 'EXCLUDED_BY_LIST', `SKU is on the accepted exclusion list: ${res.reason}`)
      if (qty.value.gt(0)) excludedHolding.set(sku.sku, (excludedHolding.get(sku.sku) ?? new D(0)).add(qty.value))
      continue
    }
    const problem = skuProblem(res, `SKU ${sku.sku}`)
    if (problem) { reject(problem.code, problem.reason); continue }
    if (res.kind !== 'ok') continue
    trackSku(run, 'stock-lots', sku, res.sku)
    if (res.type === null) { reject('TYPE_UNKNOWN', `SKU ${sku.sku} exists only in IMS and its type is not known; give the type in the ims-skus file`); continue }
    if (!STOCK_BEARING_TYPES.has(res.type)) {
      run.add('stock-lots', row.line, sku.sku, 'EXCLUDED', 'EXCLUDED_TYPE', `${res.type} products cannot receive opening stock (only SIMPLE, VARIANT and BOM hold stock and cost layers)`)
      if (qty.value.gt(0)) run.find('ERROR', 'EXCLUDED_TYPE_HOLDS_STOCK', `${res.type} SKU ${sku.sku} has quantity ${fmt(qty.value)} in the stock extract but ${res.type} products cannot hold opening stock, so those units would be absent from every import file. Resolve it in the source (correct the type, or remove the stock row once the quantity is written off).`, 'stock-lots', [`${sku.sku} (${fmt(qty.value)})`])
      continue
    }
    if (qty.value.isZero()) {
      run.zeroStated.add(sku.key)
      run.add('stock-lots', row.line, sku.sku, 'EXCLUDED', 'ZERO_ON_HAND', 'the extract states zero on hand: no opening layer is created (qty must be above zero)')
      continue
    }
    const currency = parseCurrency(v.currency)
    if (!currency) { reject('BAD_CURRENCY', `currency ${JSON.stringify(v.currency)} is not a 3-letter code`); continue }
    const fx = resolveFx(currency, run.config.baseCurrency, v.fxRateToBase)
    if (!fx.ok) { reject('BAD_FX', fx.reason); continue }
    if (v.unitCost === '') { reject('MISSING_UNIT_COST', 'a lot with stock on hand has no unit cost'); continue }
    const cost = parseDecimal(v.unitCost, 'unitCost', NUMERIC_LIMITS.lotUnitCost)
    if (!cost.ok) { reject('BAD_UNIT_COST', cost.reason); continue }
    const converted = cost.value.div(fx.fx)
    if (exceedsIntDigits(converted, NUMERIC_LIMITS.unitCost.maxIntDigits)) {
      reject('BAD_UNIT_COST', `unit cost ${v.unitCost} ${currency} / rate ${fx.text} = ${fmt(converted)} in the base currency, which has more than ${NUMERIC_LIMITS.unitCost.maxIntDigits} integer digits (the cost column or the importer's number type cannot hold it exactly)`)
      continue
    }
    lots.push({ row, sku: res.sku, key: sku.key, warehouse: warehouse.code, qty: qty.value, unitCostBase: converted, lotRef: v.lotRef, date: v.receivedDate })
  }

  // The same lot twice (same reference) is a duplicated export row, not two lots: refuse it.
  const byRef = new Map<string, Lot[]>()
  for (const lot of lots) {
    const token = idToken(lot.lotRef)
    if (token !== '') byRef.set(`${stockGroupKey(lot.key, lot.warehouse)}\u0000${token}`, [...(byRef.get(`${stockGroupKey(lot.key, lot.warehouse)}\u0000${token}`) ?? []), lot])
  }
  const refused = new Set<Lot>()
  for (const [, list] of byRef) {
    if (list.length < 2) continue
    for (const lot of list) {
      refused.add(lot)
      run.add('stock-lots', lot.row.line, lot.sku, 'REJECTED', 'DUPLICATE_LOT_REF', `lot reference ${JSON.stringify(lot.lotRef)} appears ${list.length} times for this SKU and warehouse`)
    }
  }
  // Rows of one SKU and warehouse with the same quantity and cost are told apart ONLY by distinct, non-blank lot references. A blank
  // (or whitespace, or zero-width) reference on any of them cannot make it distinct: it could be a referenced lot exported twice, and
  // summing them silently doubles stock. The date is deliberately not part of the signature: a missing date is no evidence either.
  const bySignature = new Map<string, Lot[]>()
  for (const lot of lots) {
    if (refused.has(lot)) continue
    const signature = [stockGroupKey(lot.key, lot.warehouse), fmt(lot.qty), lot.unitCostBase.toFixed()].join('\u0000')
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), lot])
  }
  for (const list of bySignature.values()) {
    if (list.length < 2 || list.every((lot) => idToken(lot.lotRef) !== '')) continue
    for (const lot of list) {
      refused.add(lot)
      run.add('stock-lots', lot.row.line, lot.sku, 'REJECTED', 'DUPLICATE_LOT_ROW', `${list.length} lot rows with the same SKU, warehouse, quantity and cost, and at least one has no lot reference to tell it apart; they could be one lot exported twice (stock would be doubled) or genuinely separate lots. Add a lot reference column to the export`)
    }
  }
  // Rows of one SKU and warehouse that arrive from MORE THAN ONE input file are never added together unless every one of them carries its own
  // non-blank lot reference: without that, the same stock could be in both files (a re-export, a second layout) and would be counted twice.
  // (An input file's part number is the multiple of 1,000,000 in its line numbers: see PART_LINE_STRIDE.)
  const byGroup = new Map<string, Lot[]>()
  for (const lot of lots) if (!refused.has(lot)) byGroup.set(stockGroupKey(lot.key, lot.warehouse), [...(byGroup.get(stockGroupKey(lot.key, lot.warehouse)) ?? []), lot])
  for (const list of byGroup.values()) {
    if (list.length < 2) continue
    const partsSeen = new Set(list.map((lot) => Math.floor(lot.row.line / PART_LINE_STRIDE)))
    // A row of a wide report has a fractional line number (L.0B): such a report states ONE balance per SKU and warehouse, so a second row for
    // the same SKU and warehouse (two source spellings of one SKU, the loader's own normalisation catching what the reader's did not) is a repeat.
    const wideRows = list.some((lot) => !Number.isInteger(lot.row.line))
    if (partsSeen.size < 2 && !wideRows) continue
    const tokens = list.map((lot) => idToken(lot.lotRef))
    if (tokens.every((token) => token !== '') && new Set(tokens).size === tokens.length) continue
    for (const lot of list) {
      refused.add(lot)
      if (partsSeen.size >= 2) run.add('stock-lots', lot.row.line, lot.sku, 'REJECTED', 'STOCK_FROM_SEVERAL_FILES', `${lot.sku} in ${lot.warehouse} is stocked by rows from ${partsSeen.size} different input files and they do not all carry their own lot reference; they could be the same stock exported twice, so they are not added together. Give each lot a reference or supply the stock in one file`)
      else run.add('stock-lots', lot.row.line, lot.sku, 'REJECTED', 'REPEATED_WIDE_STOCK_ROW', `${list.length} rows of a one-row-per-SKU report state ${lot.sku} in ${lot.warehouse} (two spellings of one SKU?) and they have no lot references to tell them apart; they are not added together. Fix the source`)
    }
  }
  const groups = new Map<string, Lot[]>()
  for (const lot of lots) if (!refused.has(lot)) groups.set(stockGroupKey(lot.key, lot.warehouse), [...(groups.get(stockGroupKey(lot.key, lot.warehouse)) ?? []), lot])
  for (const [gk, list] of [...groups.entries()]) {
    const collapsed = collapseLots(list.map((l) => ({ qty: l.qty, unitCostBase: l.unitCostBase })))
    if (exceedsIntDigits(collapsed.qty, NUMERIC_LIMITS.stockQty.maxIntDigits) || exceedsIntDigits(collapsed.average, NUMERIC_LIMITS.unitCost.maxIntDigits) || exceedsIntDigits(collapsed.average.mul(collapsed.qty), NUMERIC_LIMITS.stockValue.maxIntDigits)) {
      for (const lot of list) {
        run.add('stock-lots', lot.row.line, lot.sku, 'REJECTED', 'COLLAPSED_OUT_OF_RANGE', `the ${list.length} lot(s) of ${lot.sku} in ${lot.warehouse} collapse to quantity ${fmt(collapsed.qty)} at ${fmtFixed(collapsed.average, AVERAGE_COST_DP)}, beyond what the stock quantity (8 integer digits), cost (9) or movement value (quantity x cost, 12) can hold`)
      }
      continue
    }
    for (const lot of list) run.add('stock-lots', lot.row.line, lot.sku, 'EMITTED', 'LOT_COLLAPSED', `collapsed into one weighted-average opening row for ${lot.sku} in ${lot.warehouse}`)
    run.warehouses.add(list[0].warehouse)
    run.stockGroups.set(gk, {
      sku: list[0].sku,
      key: list[0].key,
      warehouseCode: list[0].warehouse,
      lots: list.length,
      lotQty: collapsed.qty,
      lotTotal: collapsed.lotTotal,
      average: collapsed.average,
      collapsedTotal: collapsed.collapsedTotal,
      residual: collapsed.residual,
      inTransit: new D(0),
      openingQty: collapsed.qty,
    })
  }
  const zeroCost = [...run.stockGroups.values()].filter((g) => g.average.isZero()).map((g) => `${g.sku} in ${g.warehouseCode}`)
  if (zeroCost.length > 0) {
    run.find('WARNING', 'ZERO_COST_OPENING_STOCK', 'opening stock with a weighted-average cost of zero is accepted by the importer but would sell at zero cost of goods: confirm the cost in Qoblex', 'stock-lots', zeroCost)
  }
  if (excludedHolding.size > 0) {
    run.find('ERROR', 'EXCLUDED_SKU_HOLDS_STOCK', 'SKU(s) on the exclusion list hold stock in the stock extract: that stock would silently not be loaded. Remove the exclusion or confirm the stock is written off.', 'stock-lots', [...excludedHolding.entries()].map(([sku, qty]) => `${sku} (${fmt(qty)})`))
  }
}

// ---------------------------------------------------------------------------
// Transfers (in-transit remainder) and the single-count rule
// ---------------------------------------------------------------------------

const TRANSFER_STATUSES = ['DRAFT', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'COMPLETED', 'CANCELLED']

function loadTransfers(run: Run): void {
  const { config } = run
  const convention = config.inTransitConvention
  const prefix = config.transferKeyPrefix
  type Line = TransferLine & { row: CanonRow }
  const candidates: Line[] = []
  for (const row of run.rows('transfers')) {
    const v = row.values
    const sku = parseSku(v.sku)
    const label = `${v.transferKey}/${sku.ok ? sku.sku : v.sku}`
    const reject = (code: string, reason: string) => run.add('transfers', row.line, label, 'REJECTED', code, reason)
    if (v.transferKey === '') { reject('MISSING_KEY', 'transferKey is empty'); continue }
    if (hasInvisibleKeyChars(v.transferKey)) { reject('KEY_HAS_INVISIBLE_CHARS', 'transferKey contains a control, space-like or zero-width character, which makes visually equal references differ'); continue }
    if (v.transferKey.startsWith('#')) { reject('KEY_STARTS_WITH_HASH', 'the importers\' CSV reader silently skips a row whose first value starts with "#"'); continue }
    if (!sku.ok) { reject('BAD_SKU', sku.reason); continue }
    const status = v.status.toUpperCase()
    if (!TRANSFER_STATUSES.includes(status)) { reject('BAD_STATUS', `status ${JSON.stringify(v.status)} is not one of ${TRANSFER_STATUSES.join(', ')} (map the source's names in the column map's valueMaps.status)`); continue }
    const from = parseWarehouse(v.fromWarehouseCode, 'fromWarehouseCode')
    const to = parseWarehouse(v.toWarehouseCode, 'toWarehouseCode')
    if (!from.ok) { reject('BAD_WAREHOUSE', from.reason); continue }
    if (!to.ok) { reject('BAD_WAREHOUSE', to.reason); continue }
    if (from.code === to.code) { reject('SAME_WAREHOUSE', 'source and destination warehouse are the same'); continue }
    const shipped = parseDecimal(v.qtyShipped, 'qtyShipped', NUMERIC_LIMITS.lineQty)
    if (!shipped.ok) { reject('BAD_QTY', shipped.reason); continue }
    const received = parseDecimal(v.qtyReceived, 'qtyReceived', NUMERIC_LIMITS.lineQty)
    if (!received.ok) { reject('BAD_QTY', received.reason); continue }
    if (v.dispatchDate !== '' && parseIsoDate(v.dispatchDate) === null) { reject('BAD_DATE', `dispatchDate ${JSON.stringify(v.dispatchDate)} is not YYYY-MM-DD`); continue }

    if (status === 'DRAFT' || status === 'CANCELLED') {
      run.add('transfers', row.line, label, 'EXCLUDED', 'NOT_IN_TRANSIT', `status ${status}: nothing is in transit`)
      continue
    }
    const outstanding = shipped.value.sub(received.value)
    if (status === 'RECEIVED' || status === 'COMPLETED') {
      if (outstanding.gt(0)) { reject('STATUS_CONTRADICTS_QUANTITY', `status ${status} but only ${fmt(received.value)} of ${fmt(shipped.value)} was received`); continue }
      run.add('transfers', row.line, label, 'EXCLUDED', 'FULLY_RECEIVED', `status ${status}: nothing is in transit`)
      continue
    }
    if (outstanding.lt(0)) {
      run.find('WARNING', 'TRANSFER_OVER_RECEIVED', `transfer ${v.transferKey} line ${sku.sku}: received ${fmt(received.value)} exceeds shipped ${fmt(shipped.value)}; treated as nothing outstanding`, 'transfers', [`${v.transferKey}/${sku.sku}`])
      run.add('transfers', row.line, label, 'EXCLUDED', 'OVER_RECEIVED', 'received exceeds shipped: the outstanding quantity is never negative, so nothing is in transit')
      continue
    }
    if (outstanding.isZero()) {
      run.add('transfers', row.line, label, 'EXCLUDED', 'FULLY_RECEIVED', 'shipped and received quantities are equal: nothing is in transit')
      continue
    }
    const res = resolveProduct(run, sku.key)
    if (res.kind === 'excluded') { run.add('transfers', row.line, label, 'EXCLUDED', 'EXCLUDED_BY_LIST', `SKU is on the accepted exclusion list: ${res.reason}`); continue }
    const problem = skuProblem(res, `SKU ${sku.sku}`)
    if (problem) { reject(problem.code, problem.reason); continue }
    if (res.kind !== 'ok') continue
    trackSku(run, 'transfers', sku, res.sku)
    if (res.lifecycle === 'ARCHIVED') { reject('PRODUCT_ARCHIVED', `SKU ${sku.sku} will be created as ARCHIVED; createTransfer refuses archived products`); continue }
    if (res.type === null || !STOCK_BEARING_TYPES.has(res.type)) { reject('TYPE_CANNOT_BE_TRANSFERRED', `SKU ${sku.sku} is ${res.type ?? 'of unknown type'}; only SIMPLE, VARIANT and BOM hold stock to transfer`); continue }
    if (v.dispatchDate !== '' && config.asOf) {
      const days = Math.floor(((parseIsoDate(config.asOf) ?? 0) - (parseIsoDate(v.dispatchDate) ?? 0)) / 86_400_000)
      if (days > STRANDED_TRANSFER_DAYS) {
        run.find('WARNING', 'TRANSFER_DISPATCH_DATE_OLD', `transfer ${v.transferKey} was dispatched ${days} days before ${config.asOf}. The importer stamps the dispatch at IMPORT time, not at the source date, so IMS will count it as dispatched on the import day.`, 'transfers', [v.transferKey])
      }
    }
    candidates.push({ row, line: row.line, transferKey: v.transferKey, from: from.code, to: to.code, status, notes: v.notes, sku: res.sku, key: sku.key, outstanding })
  }
  if (candidates.length > 0 && convention === null) throw new ConfigError('transfers were supplied but no in-transit convention was declared')

  // Group consistency: the importer groups lines by transferKey and refuses a group whose from/to/status/notes differ.
  const byTransfer = new Map<string, Line[]>()
  for (const c of candidates) byTransfer.set(c.transferKey, [...(byTransfer.get(c.transferKey) ?? []), c])
  const live: Line[] = []
  for (const [key, list] of [...byTransfer.entries()]) {
    const shape = new Set(list.map((l) => JSON.stringify([l.from, l.to, l.notes])))
    const skus = list.map((l) => l.key)
    if (shape.size > 1) {
      for (const l of list) run.add('transfers', l.line, `${key}/${l.sku}`, 'REJECTED', 'INCONSISTENT_TRANSFER', 'lines of one transferKey differ in source, destination or notes')
    } else if (new Set(skus).size !== skus.length) {
      for (const l of list) run.add('transfers', l.line, `${key}/${l.sku}`, 'REJECTED', 'DUPLICATE_TRANSFER_LINE', 'the same SKU appears more than once in one transfer')
    } else live.push(...list)
  }

  // In-transit quantity is counted ONCE. See docs/first-load-input-spec.md "In-transit stock".
  const needBySource = new Map<string, Dec>()
  for (const l of live) needBySource.set(stockGroupKey(l.key, l.from), (needBySource.get(stockGroupKey(l.key, l.from)) ?? new D(0)).add(l.outstanding))
  const failedSources = new Set<string>()
  for (const [gk, need] of [...needBySource.entries()]) {
    const group = run.stockGroups.get(gk)
    if (convention === 'counted-in-source') {
      if (!group || group.lotQty.lt(need)) failedSources.add(gk)
    } else if (!group || openingOutOfRange(group, need)) failedSources.add(gk)
  }
  const transferGroups = new Map<string, Line[]>()
  for (const l of live) {
    const gk = stockGroupKey(l.key, l.from)
    if (failedSources.has(gk)) {
      const group = run.stockGroups.get(gk)
      const need = needBySource.get(gk)!
      const overflow = convention === 'excluded-from-source' && !!group && openingOutOfRange(group, need)
      const reason = overflow
        ? `adding the ${fmt(need)} in transit to the ${fmt(group!.lotQty)} on hand for ${l.sku} in ${l.from} gives an opening quantity or value (quantity x average cost) beyond what the stock quantity (8 integer digits) or movement value (12) columns can hold`
        : convention === 'counted-in-source'
        ? `source stock for ${l.sku} in ${l.from} is ${group ? fmt(group.lotQty) : 'absent from the stock extract'} but ${fmt(need)} is in transit from it; with the "counted-in-source" convention the source quantity must cover the in-transit quantity or the importer cannot dispatch it`
        : `no stock row with cost for ${l.sku} in ${l.from}: under the "excluded-from-source" convention the in-transit units are added to the source opening balance at its weighted-average cost, and there is none to use`
      run.add('transfers', l.line, `${l.transferKey}/${l.sku}`, 'REJECTED', overflow ? 'OPENING_QTY_OUT_OF_RANGE' : convention === 'counted-in-source' ? 'IN_TRANSIT_EXCEEDS_SOURCE_STOCK' : 'NO_COST_BASIS_AT_SOURCE', reason)
      continue
    }
    run.add('transfers', l.line, `${l.transferKey}/${l.sku}`, 'EMITTED', 'IN_TRANSIT', 'the outstanding quantity is in the transfers import file')
    run.warehouses.add(l.from)
    run.warehouses.add(l.to)
    transferGroups.set(l.transferKey, [...(transferGroups.get(l.transferKey) ?? []), l])
  }
  for (const [gk, need] of needBySource) {
    if (failedSources.has(gk)) continue
    const group = run.stockGroups.get(gk)!
    group.inTransit = need
    // counted-in-source: the reported quantity already holds the goods, the importer's dispatch will remove them.
    // excluded-from-source: the reported quantity does not, so they are added before the dispatch removes them again.
    group.openingQty = convention === 'excluded-from-source' ? group.lotQty.add(need) : group.lotQty
  }
  for (const [key, list] of [...transferGroups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const ordered = [...list].sort((a, b) => cmp(a.key, b.key))
    run.transferOutputs.push({
      key,
      rows: ordered.map((l) => [`${prefix}${key}`, l.from, l.to, 'IN_TRANSIT', l.sku, fmt(l.outstanding), l.notes]),
    })
  }
}

// ---------------------------------------------------------------------------
// Purchase orders (outstanding quantity only)
// ---------------------------------------------------------------------------

function loadPurchaseOrders(run: Run): void {
  const { config } = run
  const prefix = config.purchaseOrderKeyPrefix
  type Line = {
    row: CanonRow
    orderKey: string
    sku: string
    key: string
    supplierName: string
    currency: string
    fxText: string
    warehouse: string
    pricesIncludeVat: string
    supplierRef: string
    expectedDelivery: string
    notes: string
    taxRateName: string
    taxRateValue: string
    qty: Dec
    unitCost: Dec
    ordered: Dec
  }
  // The same purchase order line twice would DOUBLE the outstanding quantity. A line is identified by order, SKU and (when the export
  // has one) line number; two rows with the same identity are either an exported-twice row or a conflict, and either way all are rejected.
  const dupInfo = new Map<CanonRow, { exact: boolean; count: number }>()
  const byIdentity = new Map<string, CanonRow[]>()
  for (const row of run.rows('purchase-order-lines')) {
    const parsed = parseSku(row.values.sku)
    if (row.values.orderKey === '' || !parsed.ok) continue
    const identity = [row.values.orderKey, parsed.key].join('\u0000')
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), row])
  }
  // An order that repeats a SKU is only unambiguous when EVERY such row carries a non-blank line number and no two share one. A blank
  // (or whitespace, or zero-width) line number on any of them cannot make it distinct from the others.
  for (const list of byIdentity.values()) {
    if (list.length < 2) continue
    const tokens = list.map((r) => idToken(r.values.lineNo))
    const anyBlank = tokens.some((tok) => tok === '')
    const tokenCount = new Map<string, number>()
    for (const tok of tokens) tokenCount.set(tok, (tokenCount.get(tok) ?? 0) + 1)
    const bad = list.filter((_, i) => anyBlank || (tokenCount.get(tokens[i]) ?? 0) > 1)
    const exact = new Set(bad.map((r) => JSON.stringify({ ...r.values, lineNo: '' }))).size === 1
    for (const row of bad) dupInfo.set(row, { exact, count: list.length })
  }
  const candidates: Line[] = []
  const fullyReceivedOrders = new Map<string, { open: number; closed: number }>()
  for (const row of run.rows('purchase-order-lines')) {
    const v = row.values
    const sku = parseSku(v.sku)
    const label = `${v.orderKey}/${sku.ok ? sku.sku : v.sku}`
    const reject = (code: string, reason: string) => run.add('purchase-order-lines', row.line, label, 'REJECTED', code, reason)
    const tally = fullyReceivedOrders.get(v.orderKey) ?? { open: 0, closed: 0 }
    fullyReceivedOrders.set(v.orderKey, tally)
    if (v.orderKey === '') { reject('MISSING_KEY', 'orderKey is empty (an empty key would load every line as its own purchase order)'); continue }
    if (hasInvisibleKeyChars(v.orderKey)) { reject('KEY_HAS_INVISIBLE_CHARS', 'orderKey contains a control, space-like or zero-width character, which makes visually equal references differ'); continue }
    if (v.orderKey.startsWith('#')) { reject('KEY_STARTS_WITH_HASH', 'the importers\' CSV reader silently skips a row whose first value starts with "#"'); continue }
    if (v.supplierName === '') { reject('MISSING_SUPPLIER', 'supplierName is empty'); continue }
    if (!sku.ok) { reject('BAD_SKU', sku.reason); continue }
    const dup = dupInfo.get(row)
    if (dup) {
      reject(dup.exact ? 'DUPLICATE_PO_LINE' : 'DUPLICATE_PO_LINE_CONFLICT', dup.exact
        ? `this order repeats SKU ${sku.sku} ${dup.count} times with identical data (ignoring the line number) and no distinct, non-blank line number on every one; it could be one line exported twice (the outstanding quantity would be doubled) or genuinely repeated. Map a line-number column to lineNo and fill it on every line`
        : `order ${v.orderKey} has ${dup.count} rows for SKU ${sku.sku} with different data and no distinct, non-blank line number on every one; which is right cannot be decided. Map a line-number column to lineNo and fill it on every line`)
      continue
    }
    const status = v.status === '' ? 'OPEN' : v.status.toUpperCase()
    if (!['OPEN', 'CLOSED', 'CANCELLED'].includes(status)) { reject('BAD_STATUS', `status ${JSON.stringify(v.status)} is not OPEN, CLOSED or CANCELLED (map the source's names in valueMaps.status)`); continue }
    const ordered = parseDecimal(v.qtyOrdered, 'qtyOrdered', NUMERIC_LIMITS.lineQty)
    if (!ordered.ok) { reject('BAD_QTY', ordered.reason); continue }
    const received = parseDecimal(v.qtyReceived, 'qtyReceived', NUMERIC_LIMITS.lineQty)
    if (!received.ok) { reject('BAD_QTY', received.reason); continue }
    const cost = parseDecimal(v.unitCostForeign, 'unitCostForeign', NUMERIC_LIMITS.unitCost)
    if (!cost.ok) { reject('BAD_UNIT_COST', cost.reason); continue }
    const currency = parseCurrency(v.currency)
    if (!currency) { reject('BAD_CURRENCY', `currency ${JSON.stringify(v.currency)} is not a 3-letter code`); continue }
    const fx = resolveFx(currency, config.baseCurrency, v.fxRateToBase)
    if (!fx.ok) { reject('BAD_FX', fx.reason); continue }
    let warehouse = ''
    if (v.destinationWarehouseCode !== '') {
      const w = parseWarehouse(v.destinationWarehouseCode, 'destinationWarehouseCode')
      if (!w.ok) { reject('BAD_WAREHOUSE', w.reason); continue }
      warehouse = w.code
    }
    const vat = parseBool(v.pricesIncludeVat)
    if (vat === null) { reject('BAD_BOOLEAN', `pricesIncludeVat ${JSON.stringify(v.pricesIncludeVat)} is not TRUE/FALSE`); continue }
    if (v.expectedDelivery !== '' && parseIsoDate(v.expectedDelivery) === null) { reject('BAD_DATE', `expectedDelivery ${JSON.stringify(v.expectedDelivery)} is not YYYY-MM-DD`); continue }
    if (v.taxRateName !== '' && v.taxRateValue !== '') {
      reject('TAX_NAME_AND_VALUE', `the line gives both a tax rate name (${JSON.stringify(v.taxRateName)}) and a value (${v.taxRateValue}); the importer resolves the NAME first and falls back to the value, and this tool cannot read IMS's named rates to show they agree. Give one or the other`)
      continue
    }
    let taxRateValue = ''
    if (v.taxRateValue !== '') {
      const t = parseDecimal(v.taxRateValue, 'taxRateValue', { maxIntDigits: 3, maxDp: 6 })
      if (!t.ok) { reject('BAD_TAX_RATE', t.reason); continue }
      taxRateValue = fmt(t.value)
      const asFraction = t.value.gt(1) ? t.value.div(100) : t.value
      if (asFraction.decimalPlaces() > NUMERIC_LIMITS.taxFraction.maxDp) {
        reject('TAX_RATE_PRECISION', `taxRateValue ${v.taxRateValue} is ${fmt(asFraction)} as a fraction, which has more than ${NUMERIC_LIMITS.taxFraction.maxDp} decimal places; the order stores the rate at 4 (Decimal(5,4)) while computing tax from the unrounded value`)
        continue
      }
      if (config.maxPurchaseTaxRate !== null && asFraction.gt(new D(config.maxPurchaseTaxRate))) {
        reject('TAX_RATE_ABOVE_DECLARED_MAX', `taxRateValue ${v.taxRateValue} is ${fmt(asFraction)} as a fraction, above the declared maxPurchaseTaxRate ${config.maxPurchaseTaxRate}`)
        continue
      }
    }

    if (status !== 'OPEN') {
      tally.closed++
      run.add('purchase-order-lines', row.line, label, 'EXCLUDED', 'NOT_OPEN', `status ${status}: not an open purchase order`)
      continue
    }
    const outstanding = ordered.value.sub(received.value)
    if (outstanding.lt(0)) {
      run.find('WARNING', 'PO_OVER_RECEIVED', `order ${v.orderKey} line ${sku.sku}: received ${fmt(received.value)} exceeds ordered ${fmt(ordered.value)}; treated as nothing outstanding`, 'purchase-order-lines', [`${v.orderKey}/${sku.sku}`])
      run.add('purchase-order-lines', row.line, label, 'EXCLUDED', 'OVER_RECEIVED', 'received exceeds ordered: the outstanding quantity is never negative, so nothing is loaded')
      tally.closed++
      continue
    }
    if (outstanding.isZero()) {
      run.add('purchase-order-lines', row.line, label, 'EXCLUDED', 'FULLY_RECEIVED', 'ordered and received quantities are equal: nothing is outstanding (the received portion stays with the incumbent)')
      tally.closed++
      continue
    }

    const res = resolveProduct(run, sku.key)
    if (res.kind === 'excluded') { run.add('purchase-order-lines', row.line, label, 'EXCLUDED', 'EXCLUDED_BY_LIST', `SKU is on the accepted exclusion list: ${res.reason}`); continue }
    const problem = skuProblem(res, `SKU ${sku.sku}`)
    if (problem) { reject(problem.code, problem.reason); continue }
    if (res.kind !== 'ok') continue
    trackSku(run, 'purchase-order-lines', sku, res.sku)
    if (res.lifecycle !== null && res.lifecycle !== 'ACTIVE' && res.lifecycle !== 'DRAFT') { reject('PRODUCT_NOT_PURCHASABLE', `SKU ${sku.sku} will be created as ${res.lifecycle}; createPurchaseOrder only accepts ACTIVE or DRAFT products`); continue }
    if (res.type === 'KIT' || res.type === 'VARIABLE') { reject('TYPE_CANNOT_BE_PURCHASED', `SKU ${sku.sku} is ${res.type}; it can never be received into stock`); continue }

    let supplierName = v.supplierName.normalize('NFC').trim()
    const supplierKey = supplierName.toUpperCase()
    const inFile = run.has('suppliers') ? run.suppliers.get(supplierKey) : undefined
    if (run.has('suppliers') && run.supplierStatus.get(supplierKey) === 'rejected') { reject('SUPPLIER_ROW_REJECTED', `supplier ${JSON.stringify(supplierName)}'s row in the suppliers dataset was rejected`); continue }
    if (inFile) supplierName = inFile.name
    else if (run.has('ims-suppliers')) {
      // The importer matches by upper-case, so a different case of the one IMS spelling IS the supplier; only a colliding pair in IMS is ambiguous.
      const known = run.imsSuppliers.get(supplierKey)
      const ambiguous = run.imsSupplierCollidedKeys.has(supplierKey) || run.imsSupplierCollidedKeys.has(supplierName.toLowerCase())
      if (known !== undefined && !ambiguous) supplierName = known
      else { reject(ambiguous ? 'SUPPLIER_AMBIGUOUS_IN_IMS' : 'SUPPLIER_NOT_IN_FILE', ambiguous ? `supplier ${JSON.stringify(supplierName)} matches two suppliers already in IMS that the importers cannot tell apart` : `supplier ${JSON.stringify(supplierName)} is in neither the suppliers dataset nor the IMS supplier list`); continue }
    } else if (run.has('suppliers')) { reject('SUPPLIER_NOT_IN_FILE', `supplier ${JSON.stringify(supplierName)} is not in the suppliers dataset`); continue }
    tally.open++
    candidates.push({
      row, orderKey: v.orderKey, sku: res.sku, key: sku.key, supplierName, currency, fxText: fx.text, warehouse,
      pricesIncludeVat: vat, supplierRef: v.supplierRef, expectedDelivery: v.expectedDelivery, notes: v.notes,
      taxRateName: v.taxRateName, taxRateValue, qty: outstanding, unitCost: cost.value, ordered: ordered.value,
    })
  }
  if (!run.has('suppliers') && !run.has('ims-suppliers') && candidates.length > 0) {
    run.find('WARNING', 'SUPPLIER_NAMES_UNCHECKED', 'neither a suppliers dataset nor an IMS supplier list was supplied, so purchase-order supplier names were NOT checked. The importer refuses a name that does not exist in IMS.', 'purchase-order-lines', [...new Set(candidates.map((c) => c.supplierName))])
  }
  run.poOrdersNothingOutstanding = [...fullyReceivedOrders.values()].filter((t) => t.open === 0 && t.closed > 0).length

  const byOrder = new Map<string, Line[]>()
  for (const c of candidates) byOrder.set(c.orderKey, [...(byOrder.get(c.orderKey) ?? []), c])
  for (const [orderKey, list] of [...byOrder.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const shapes = new Set(list.map((l) => JSON.stringify([l.supplierName.toUpperCase(), l.currency, l.fxText, l.warehouse, l.pricesIncludeVat, l.supplierRef, l.expectedDelivery, l.notes, l.taxRateName, l.taxRateValue])))
    if (shapes.size > 1) {
      for (const l of list) run.add('purchase-order-lines', l.row.line, `${orderKey}/${l.sku}`, 'REJECTED', 'INCONSISTENT_ORDER_FIELDS', 'open lines of one orderKey differ in supplier, currency, fx rate, warehouse, VAT flag, supplier reference, delivery date, notes or tax rate; the importer refuses such an order')
      continue
    }
    const fx = new D(list[0].fxText)
    const taxRate = new D(config.maxPurchaseTaxRate ?? '0')
    const subtotalForeign = sum(list.map((l) => l.qty.mul(l.unitCost)))
    const grossForeign = subtotalForeign.mul(new D(1).add(taxRate))
    const grossBase = grossForeign.div(fx)
    if (
      exceedsIntDigits(grossForeign, NUMERIC_LIMITS.orderValue.maxIntDigits)
      || exceedsIntDigits(grossBase, NUMERIC_LIMITS.orderValue.maxIntDigits)
      || list.some((l) => exceedsIntDigits(l.unitCost.div(fx), NUMERIC_LIMITS.unitCostBaseColumn.maxIntDigits))
    ) {
      for (const l of list) run.add('purchase-order-lines', l.row.line, `${orderKey}/${l.sku}`, 'REJECTED', 'ORDER_VALUE_OUT_OF_RANGE', `the order's value (${fmt(grossForeign)} foreign, ${fmt(grossBase)} base, at the declared worst-case tax rate ${config.maxPurchaseTaxRate}) or a base unit cost is beyond what the purchase order columns can hold (14 integer digits for totals, 12 for a unit cost)`)
      continue
    }
    for (const l of list) run.add('purchase-order-lines', l.row.line, `${orderKey}/${l.sku}`, 'EMITTED', 'PO_LINE', 'outstanding quantity is in the purchase-orders import file')
    for (const l of list) if (l.warehouse) run.warehouses.add(l.warehouse)
    const ordered = [...list].sort((a, b) => cmp(a.key, b.key) || cmp(fmt(a.qty), fmt(b.qty)) || cmp(a.unitCost.toFixed(), b.unitCost.toFixed()))
    run.poOutputs.push({
      key: orderKey,
      rows: ordered.map((l) => {
        const cells: Record<string, string> = {
          orderKey: `${prefix}${orderKey}`, supplierName: l.supplierName, currency: l.currency, fxRateToBase: l.fxText,
          destinationWarehouseCode: l.warehouse, sku: l.sku, qty: fmt(l.qty), unitCostForeign: fmt(l.unitCost),
          taxRateName: l.taxRateName, taxRateValue: l.taxRateValue, pricesIncludeVat: l.pricesIncludeVat,
          supplierRef: l.supplierRef, expectedDelivery: l.expectedDelivery, notes: l.notes,
        }
        return IMPORT_TARGETS['purchase-orders'].headers.map((h) => cells[h] ?? '')
      }),
    })
  }
}

// ---------------------------------------------------------------------------
// Coverage-only datasets, R14 and the zero / missing split
// ---------------------------------------------------------------------------

function loadCoverageDatasets(run: Run): void {
  const rowsOf = (name: DatasetName, target: Map<string, string>, withQty: boolean) => {
    let withoutSku = 0
    const variants = new Map<string, Set<string>>()
    for (const row of run.rows(name)) {
      const v = row.values
      if (v.sku === '') {
        run.add(name, row.line, '(no sku)', 'EXCLUDED', 'NO_SKU', 'the row has no SKU, so it cannot be matched to an IMS product')
        withoutSku++
        continue
      }
      const sku = parseSku(v.sku)
      if (!sku.ok) { run.add(name, row.line, v.sku, 'REJECTED', 'BAD_SKU', sku.reason); continue }
      if (withQty) {
        const qty = parseDecimal(v.qty, 'qty', NUMERIC_LIMITS.stockQty)
        if (!qty.ok) { run.add(name, row.line, sku.sku, 'REJECTED', 'BAD_QTY', qty.reason); continue }
        run.wmsQty.set(sku.key, (run.wmsQty.get(sku.key) ?? new D(0)).add(qty.value))
      }
      if (!target.has(sku.key)) target.set(sku.key, sku.sku)
      variants.set(sku.key, (variants.get(sku.key) ?? new Set<string>()).add(sku.sku))
      run.add(name, row.line, sku.sku, 'EMITTED', 'COVERAGE_ROW', 'used by the coverage check')
    }
    const clashing = [...variants.values()].filter((set) => set.size > 1).map((set) => [...set].sort(cmp).join(' / '))
    if (clashing.length > 0) run.find('WARNING', 'SKU_CASE_VARIANTS_IN_SOURCE', `${name} spells ${clashing.length} SKU(s) in more than one letter case; they are treated as one SKU for coverage`, name, clashing)
    if (withoutSku > 0) run.find('WARNING', 'COVERAGE_ROW_WITHOUT_SKU', `${name} has ${withoutSku} row(s) without a SKU; they cannot take part in the coverage check`, name)
  }
  rowsOf('wms-products', run.wmsSkus, false)
  rowsOf('wms-stock', run.wmsSkus, true)
  rowsOf('woo-products', run.wooSkus, false)
}

interface CoverageResult {
  patterns: Array<{ pattern: string; count: number; skus: string[] }>
  notLoaded: string[]
  excludedAccepted: string[]
}

function computeCoverage(run: Run): CoverageResult {
  const q = new Map<string, string>()
  for (const [key, sku] of run.catAnyParsed) q.set(key, sku)
  const sources: Array<[string, Map<string, string>]> = [
    ['Q', q],
    ['L', run.wmsSkus],
    ['W', run.wooSkus],
    ['I', new Map([...run.ims.entries()].map(([k, v]) => [k, v.sku]))],
  ]
  const display = new Map<string, string>()
  for (const [, map] of sources) for (const [key, sku] of map) if (!display.has(key)) display.set(key, sku)
  const patterns = new Map<string, string[]>()
  for (const key of [...display.keys()].sort(cmp)) {
    const pattern = sources.filter(([, map]) => map.has(key)).map(([label]) => label).join('+')
    patterns.set(pattern, [...(patterns.get(pattern) ?? []), display.get(key)!])
  }
  const loaded = new Set<string>([...run.cat.keys(), ...run.ims.keys()])
  const notLoaded: string[] = []
  const excludedAccepted: string[] = []
  const subjects = new Set<string>([...q.keys(), ...run.wmsSkus.keys(), ...run.wooSkus.keys()])
  for (const key of [...subjects].sort(cmp)) {
    if (loaded.has(key)) continue
    if (run.exclusions.has(key)) {
      excludedAccepted.push(display.get(key)!)
      continue
    }
    const where = sources.filter(([label, map]) => label !== 'I' && map.has(key)).map(([label]) => label).join('+')
    notLoaded.push(`${display.get(key)!} (${where})`)
  }
  return {
    patterns: [...patterns.entries()].sort((a, b) => cmp(a[0], b[0])).map(([pattern, skus]) => ({ pattern, count: skus.length, skus })),
    notLoaded,
    excludedAccepted,
  }
}

function checkCoverage(run: Run): CoverageResult | null {
  const anyCoverage = run.has('products') || run.has('wms-products') || run.has('wms-stock') || run.has('woo-products')
  if (!anyCoverage) return null
  if (!run.has('products') && (run.has('wms-products') || run.has('wms-stock') || run.has('woo-products'))) {
    run.find('ERROR', 'R14_NEEDS_CATALOGUE', '3PL (WMS) or WooCommerce SKUs were supplied but the Qoblex products dataset was not: four-way SKU coverage cannot be established', 'products')
    return null
  }
  const result = computeCoverage(run)
  if (result.notLoaded.length > 0) {
    run.find('ERROR', 'R14_SKU_NOT_LOADED', `${result.notLoaded.length} SKU(s) exist in Qoblex, the 3PL (WMS) or WooCommerce but will not exist in IMS and are not on the exclusion list (R14 must have zero one-sided SKUs). Fix the data or add a reasoned exclusion.`, undefined, result.notLoaded)
  }
  const everything = new Set<string>([...run.catAnyParsed.keys(), ...run.wmsSkus.keys(), ...run.wooSkus.keys(), ...run.ims.keys(), ...run.variantParentKeys])
  const stale = [...run.exclusions.entries()].filter(([key]) => !everything.has(key)).map(([, v]) => v.sku)
  if (stale.length > 0) run.find('WARNING', 'STALE_EXCLUSION', 'SKU(s) on the exclusion list appear in no input: the exclusion does nothing', 'sku-exclusions', stale)
  const sourceKeys = new Set<string>([...run.catAnyParsed.keys(), ...run.wmsSkus.keys(), ...run.wooSkus.keys()])
  const imsOnly = [...run.ims.entries()].filter(([key]) => !sourceKeys.has(key)).map(([, v]) => v.sku)
  if (imsOnly.length > 0) run.find('WARNING', 'IMS_ONLY_SKU', 'SKU(s) already in IMS are in none of Qoblex, the 3PL (WMS) or WooCommerce', 'ims-skus', imsOnly)
  return result
}

interface StockSplit {
  zero: string[]
  missing: Array<{ sku: string; holdsStockElsewhere: boolean | null; wmsQty: string | null }>
}

/**
 * The extract can fail a SKU in two different ways and they must never be merged:
 *   ZERO    the extract has a row for it and it says zero (OD-2: nothing to load, expected);
 *   MISSING the extract has no row for it at all (the extract is incomplete, and if the SKU holds stock elsewhere that is a defect).
 */
function splitZeroAndMissing(run: Run): StockSplit | null {
  if (!run.has('stock-lots') || !run.has('products')) return null
  const expected = [...run.cat.values()].filter((entry) => STOCK_BEARING_TYPES.has(entry.type))
  const positive = new Set([...run.stockGroups.values()].map((g) => g.key))
  const zero: string[] = []
  const missing: StockSplit['missing'] = []
  const haveWms = run.has('wms-stock')
  for (const entry of expected.sort((a, b) => cmp(a.key, b.key))) {
    const stated = run.stockStated.has(entry.key)
    if (run.zeroStated.has(entry.key) && !positive.has(entry.key) && !run.stockRejected.has(entry.key)) zero.push(entry.sku)
    if (!stated) {
      const qty = run.wmsQty.get(entry.key) ?? new D(0)
      missing.push({
        sku: entry.sku,
        holdsStockElsewhere: haveWms ? qty.gt(0) : null,
        wmsQty: haveWms ? fmt(qty) : null,
      })
    }
  }
  const dangerous = missing.filter((m) => m.holdsStockElsewhere === true)
  if (dangerous.length > 0) {
    run.find('ERROR', 'MISSING_SKU_HOLDS_STOCK', `${dangerous.length} SKU(s) are missing from the Qoblex stock extract but hold stock in the 3PL (WMS): the extract is incomplete and those balances would not be loaded`, 'stock-lots', dangerous.map((m) => `${m.sku} (3PL ${m.wmsQty})`))
  }
  const quiet = missing.filter((m) => m.holdsStockElsewhere !== true)
  if (quiet.length > 0) {
    run.find('WARNING', 'MISSING_FROM_STOCK_EXTRACT', `${quiet.length} stock-bearing SKU(s) have no row in the Qoblex stock extract${haveWms ? ' (and no stock in the 3PL)' : ' (3PL stock was not supplied, so whether they hold stock elsewhere is UNKNOWN)'}. This is different from a stated zero.`, 'stock-lots', quiet.map((m) => m.sku))
  }
  if (haveWms) {
    const zeroButHeld = zero.filter((sku) => (run.wmsQty.get(skuKey(sku)) ?? new D(0)).gt(0))
    if (zeroButHeld.length > 0) run.find('WARNING', 'ZERO_IN_QOBLEX_STOCK_IN_WMS', 'SKU(s) show zero on hand in the Qoblex extract but hold stock in the 3PL (reconciliation R1/R2 will not pass for them)', 'stock-lots', zeroButHeld)
  }
  return { zero, missing }
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function productSortGroup(entry: CatEntry, depthOf: (key: string) => number): number {
  if (entry.type === 'VARIANT') return 1
  if (RECIPE_TYPES.has(entry.type)) return 2 + depthOf(entry.key)
  return 0
}

function emitProducts(run: Run): string[][] {
  const depthCache = new Map<string, number>()
  const depthOf = (key: string): number => {
    const cached = depthCache.get(key)
    if (cached !== undefined) return cached
    depthCache.set(key, 0)
    const parts = run.recipeComponents.get(key) ?? []
    const depth = parts.length === 0 ? 0 : 1 + Math.max(...parts.map((p) => (run.recipeComponents.has(p.componentKey) ? depthOf(p.componentKey) : 0)))
    depthCache.set(key, depth)
    return depth
  }
  const entries = [...run.cat.values()].sort((a, b) => productSortGroup(a, depthOf) - productSortGroup(b, depthOf) || cmp(a.key, b.key))
  const rows = entries.map((entry) => {
    const cells: Record<string, string> = { ...entry.cells, sku: entry.sku, name: entry.name, type: entry.type }
    if (entry.parentSku) cells.parentSku = run.cat.get(skuKey(entry.parentSku))?.sku ?? entry.parentSku
    const parts = run.recipeComponents.get(entry.key)
    if (parts) cells.components = parts.map((p) => `${run.cat.get(p.componentKey)?.sku ?? run.ims.get(p.componentKey)?.sku ?? p.componentSku}:${fmt(p.qty)}`).join(';')
    return IMPORT_TARGETS.products.headers.map((h) => cells[h] ?? '')
  })
  // Load order proof: a parent and every component must be in the same file or an earlier one, i.e. never LATER in the order.
  const position = new Map(entries.map((entry, index) => [entry.key, index]))
  for (const entry of entries) {
    const needed = [skuKey(entry.parentSku), ...(run.recipeComponents.get(entry.key) ?? []).map((p) => p.componentKey)].filter((k) => k !== skuKey(''))
    for (const dependency of needed) {
      const at = position.get(dependency)
      if (at !== undefined && at > position.get(entry.key)!) run.selfCheck.push(`products load order: ${entry.sku} comes before ${dependency}, which it depends on`)
    }
  }
  return rows
}

function emitOpeningStock(run: Run): string[][] {
  const groups = [...run.stockGroups.values()].sort((a, b) => cmp(a.key, b.key) || cmp(a.warehouseCode, b.warehouseCode))
  return groups.map((g) => {
    const entry = run.cat.get(g.key)
    const value = g.average.mul(g.openingQty)
    const cells: Record<string, string> = {
      sku: g.sku, warehouseCode: g.warehouseCode, qty: fmt(g.openingQty), unitCostBase: fmtFixed(g.average, AVERAGE_COST_DP),
      productName: entry?.name ?? '', type: entry?.type ?? run.ims.get(g.key)?.type ?? '', stockUnit: entry?.cells.stockUnit ?? '',
      warehouseName: '', reserved: '0', available: fmt(g.openingQty), inventoryValueBase: fmt(value),
    }
    return IMPORT_TARGETS['opening-stock'].headers.map((h) => cells[h] ?? '')
  })
}

function emitUnits(target: ImporterTarget, units: ReadonlyArray<ReadonlyArray<readonly string[]>>, limits: ChunkLimits, run: Run): OutputFile[] {
  const header = IMPORT_TARGETS[target].headers
  const { chunks, oversizedUnits } = chunkUnits(header, units, limits)
  if (oversizedUnits.length > 0) {
    run.find('ERROR', 'GROUP_TOO_LARGE', `${oversizedUnits.length} ${target} group(s) cannot fit in one importer file (their lines must stay together)`, undefined, oversizedUnits.map(String))
  }
  const loadOrder = String(IMPORT_TARGETS[target].loadOrder).padStart(2, '0')
  return chunks.map((rows, index) => {
    assertWithinImporterLimits(header, rows, `${target} chunk ${index + 1}`)
    const content = serializeCsv(header, rows)
    return {
      name: `${loadOrder}-${target}-${String(index + 1).padStart(3, '0')}-of-${String(chunks.length).padStart(3, '0')}.csv`,
      target,
      chunk: index + 1,
      chunks: chunks.length,
      rows: rows.length,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      content,
    }
  })
}

/**
 * Round-trips every output through the importers' own CSV reader (`parseCsv`, lib/csv.ts) and compares it with this tool's
 * strict reader: the importers must see exactly the rows and values we meant (no row swallowed as a comment, none split, no
 * value trimmed differently).
 */
function verifyRoundTrip(files: OutputFile[], run: Run): void {
  for (const file of files) {
    const importerView = parseCsv(file.content)
    const strict = parseCsvStrict(file.content)
    const headers = IMPORT_TARGETS[file.target].headers
    if (strict.header.join(',') !== headers.join(',')) run.selfCheck.push(`${file.name}: header line is not the importer template header`)
    if (importerView.length !== file.rows || strict.rows.length !== file.rows) {
      run.selfCheck.push(`${file.name}: the importers' CSV reader sees ${importerView.length} rows, expected ${file.rows} (a row was swallowed or split)`)
      continue
    }
    strict.rows.forEach((record, index) => {
      strict.header.forEach((name, column) => {
        if (importerView[index][name] !== record.cells[column].trim()) run.selfCheck.push(`${file.name} row ${index + 1}: the importers would read column ${name} differently from what was written`)
      })
    })
  }
}

function verifyUniqueness(files: OutputFile[], run: Run): void {
  const keysOf = (target: ImporterTarget, columns: string[]): string[] => {
    const keys: string[] = []
    for (const file of files.filter((f) => f.target === target)) {
      for (const row of parseCsv(file.content)) keys.push(columns.map((c) => (row[c] ?? '').toUpperCase()).join('|'))
    }
    return keys
  }
  const report = (label: string, keys: string[]) => {
    const seen = new Set<string>()
    const dup = new Set<string>()
    for (const key of keys) (seen.has(key) ? dup : seen).add(key)
    if (dup.size > 0) run.selfCheck.push(`${label}: duplicate keys in the output: ${[...dup].sort(cmp).join(', ')}`)
  }
  report('products (sku)', keysOf('products', ['sku']))
  report('opening-stock (sku, warehouse)', keysOf('opening-stock', ['sku', 'warehouseCode']))
  report('suppliers (name)', keysOf('suppliers', ['name']))
}

function verifySingleCount(run: Run): void {
  const convention = run.config.inTransitConvention
  for (const g of run.stockGroups.values()) {
    const expected = convention === 'excluded-from-source' ? g.lotQty.add(g.inTransit) : g.lotQty
    if (!g.openingQty.eq(expected)) run.selfCheck.push(`in-transit single count: ${g.sku} in ${g.warehouseCode} opening ${fmt(g.openingQty)} != ${fmt(expected)}`)
    if (g.openingQty.sub(g.inTransit).lt(0)) run.selfCheck.push(`in-transit single count: ${g.sku} in ${g.warehouseCode} would go negative after dispatch`)
  }
}

// ---------------------------------------------------------------------------
// prepare()
// ---------------------------------------------------------------------------

export function prepare(input: PrepareInput): PrepareResult {
  const { config } = input
  if (!/^[A-Z]{3}$/.test(config.baseCurrency)) throw new ConfigError(`baseCurrency ${JSON.stringify(config.baseCurrency)} is not a 3-letter upper-case code`)
  const needsPrefix = (name: DatasetName, value: string | null, label: string) => {
    if (input.datasets[name] && (value === null || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value))) {
      throw new ConfigError(`${label} must be set (letters, digits, "-", "_" or "."; it is prefixed to every key so it cannot collide with IMS-generated references)`)
    }
  }
  needsPrefix('purchase-order-lines', config.purchaseOrderKeyPrefix, 'purchaseOrderKeyPrefix')
  needsPrefix('transfers', config.transferKeyPrefix, 'transferKeyPrefix')
  if (input.datasets['purchase-order-lines']) {
    const declared = config.maxPurchaseTaxRate
    if (declared === null || !/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/.test(declared)) {
      throw new ConfigError('maxPurchaseTaxRate must be set to the highest purchase tax rate any IMS tax rate or supplier default could apply, as a fraction between 0 and 1 (for example "0.25"): the importer resolves tax rates by name inside IMS, which this tool cannot read, so it bounds every order with this rate')
    }
  }
  if (input.datasets.transfers && config.inTransitConvention === null) {
    throw new ConfigError('inTransitConvention must be "counted-in-source" or "excluded-from-source" when transfers are supplied (see docs/first-load-input-spec.md, "In-transit stock")')
  }
  if (config.asOf !== null && parseIsoDate(config.asOf) === null) throw new ConfigError(`asOf ${JSON.stringify(config.asOf)} is not YYYY-MM-DD`)
  const limits = config.chunkLimits ?? DEFAULT_CHUNK_LIMITS

  const run = new Run(input)
  const recordsRead: Record<string, number> = {}
  for (const [name, dataset] of Object.entries(input.datasets) as Array<[DatasetName, IngestedDataset]>) {
    recordsRead[name] = dataset.recordsRead
    for (const rejection of dataset.rejected) {
      run.add(name, rejection.line, `line ${rejection.line}`, 'REJECTED', rejection.code, rejection.reason)
    }
    for (const replaced of dataset.superseded) run.add(name, replaced.line, replaced.key, 'EXCLUDED', 'SUPERSEDED_BY_LATER_FILE', replaced.reason)
  }

  loadExclusions(run)
  loadImsSkus(run)
  loadCatalogue(run)
  loadRecipes(run)
  if (run.has('products')) checkRecipesPresent(run)
  loadImsSuppliers(run)
  loadSuppliers(run)
  loadStock(run)
  loadTransfers(run)
  loadPurchaseOrders(run)
  reportNormalisation(run)
  loadCoverageDatasets(run)
  const coverage = checkCoverage(run)
  const split = splitZeroAndMissing(run)

  // ----- build output files (kept only when nothing blocks) -----
  const outputs: OutputFile[] = []
  if (run.has('suppliers')) {
    const rows = [...run.suppliers.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, s]) => IMPORT_TARGETS.suppliers.headers.map((h) => s.cells[h] ?? ''))
    outputs.push(...emitUnits('suppliers', rows.map((r) => [r]), limits, run))
  }
  if (run.has('products')) outputs.push(...emitUnits('products', emitProducts(run).map((r) => [r]), limits, run))
  if (run.has('stock-lots')) outputs.push(...emitUnits('opening-stock', emitOpeningStock(run).map((r) => [r]), limits, run))
  if (run.has('transfers')) outputs.push(...emitUnits('transfers', run.transferOutputs.map((t) => t.rows), limits, run))
  if (run.has('purchase-order-lines')) outputs.push(...emitUnits('purchase-orders', run.poOutputs.map((o) => o.rows), limits, run))

  verifyRoundTrip(outputs, run)
  verifyUniqueness(outputs, run)
  verifySingleCount(run)

  const accounting = accountRows(recordsRead, run.disp)
  const anomalies = dispositionAnomalies(run.disp)
  for (const line of anomalies) run.selfCheck.push(`row accounting: ${line}`)
  for (const row of accounting) if (row.unaccounted !== 0) run.selfCheck.push(`row accounting: ${row.dataset} has ${row.unaccounted} unaccounted record(s)`)

  const emittedByTarget: Record<ImporterTarget, number> = { suppliers: 0, products: 0, 'opening-stock': 0, transfers: 0, 'purchase-orders': 0 }
  for (const file of outputs) emittedByTarget[file.target] += file.rows
  const expectOut = (target: ImporterTarget, expected: number, label: string) => {
    if (emittedByTarget[target] !== expected) run.selfCheck.push(`${label}: ${emittedByTarget[target]} output rows but ${expected} emitted dispositions`)
  }
  if (run.has('products')) expectOut('products', run.disp.filter((d) => d.dataset === 'products' && d.outcome === 'EMITTED').length + run.syntheticParents.size, 'products (emitted records plus VARIABLE parents created from the variant-parents dataset)')
  if (run.has('suppliers')) expectOut('suppliers', run.disp.filter((d) => d.dataset === 'suppliers' && d.outcome === 'EMITTED').length, 'suppliers')
  if (run.has('stock-lots')) expectOut('opening-stock', run.stockGroups.size, 'opening-stock')
  if (run.has('transfers')) expectOut('transfers', run.disp.filter((d) => d.dataset === 'transfers' && d.outcome === 'EMITTED').length, 'transfers')
  if (run.has('purchase-order-lines')) expectOut('purchase-orders', run.disp.filter((d) => d.dataset === 'purchase-order-lines' && d.outcome === 'EMITTED').length, 'purchase-orders')

  const blocking = run.disp.some((d) => d.outcome === 'REJECTED') || run.findings.some((f) => f.severity === 'ERROR')
  const stockGroups = [...run.stockGroups.values()].sort((a, b) => cmp(a.key, b.key) || cmp(a.warehouseCode, b.warehouseCode))
  const totals = {
    lotQty: sum(stockGroups.map((g) => g.lotQty)),
    lotTotal: sum(stockGroups.map((g) => g.lotTotal)),
    collapsed: sum(stockGroups.map((g) => g.collapsedTotal)),
    residual: sum(stockGroups.map((g) => g.residual)),
    openingQty: sum(stockGroups.map((g) => g.openingQty)),
    openingValue: sum(stockGroups.map((g) => g.average.mul(g.openingQty))),
  }
  const byCode = new Map<string, number>()
  for (const d of run.disp) byCode.set(`${d.dataset}\u0000${d.outcome}\u0000${d.code}`, (byCode.get(`${d.dataset}\u0000${d.outcome}\u0000${d.code}`) ?? 0) + 1)
  const notSupplied = (Object.keys(DATASETS) as DatasetName[]).filter((name) => !input.datasets[name])

  const checks: PrepareReport['checks'] = [
    { check: 'row accounting identity', status: 'RAN', note: 'every record read has exactly one disposition' },
    split ? { check: 'zero on-hand versus missing from extract', status: 'RAN', note: 'stock-lots and products supplied' } : { check: 'zero on-hand versus missing from extract', status: 'NOT RUN', note: 'needs the products and stock-lots datasets' },
    coverage ? { check: 'R14 four-way SKU coverage', status: 'RAN', note: `sides supplied: ${['products', 'wms', 'woo', 'ims'].filter((s) => (s === 'products' ? run.has('products') : s === 'wms' ? run.has('wms-products') || run.has('wms-stock') : s === 'woo' ? run.has('woo-products') : run.has('ims-skus'))).join(', ')}` } : { check: 'R14 four-way SKU coverage', status: 'NOT RUN', note: 'needs the products dataset' },
    run.has('ims-suppliers') ? { check: 'new supplier names versus suppliers already in IMS', status: 'RAN', note: 'under both importer matching rules' } : { check: 'new supplier names versus suppliers already in IMS', status: 'NOT RUN', note: 'no ims-suppliers list supplied: a collision with an existing IMS supplier is NOT checked (apply-time check lookup-keys-unique-in-ims)' },
    run.has('variant-parents') ? { check: 'variants joined to WooCommerce parents by exact SKU', status: 'RAN', note: 'the parent is the one WooCommerce gives the variation; a SKU stem is only compared, never used' } : { check: 'variants joined to WooCommerce parents by exact SKU', status: 'NOT RUN', note: 'variant-parents not supplied: every Qoblex variant is rejected as VARIANT_WITHOUT_PARENT' },
    run.has('recipe-lines') ? { check: 'recipe graph is acyclic', status: 'RAN', note: 'detectBomItemCycleInEdges over every valid recipe line' } : { check: 'recipe graph is acyclic', status: 'NOT RUN', note: 'recipe-lines not supplied' },
    run.has('stock-lots') ? { check: 'multi-lot collapse to one weighted average', status: 'RAN', note: 'exact decimal arithmetic, rounded once to 6 dp' } : { check: 'multi-lot collapse to one weighted average', status: 'NOT RUN', note: 'stock-lots not supplied' },
    run.has('transfers') ? { check: 'in-transit quantity counted once', status: 'RAN', note: `convention ${config.inTransitConvention}` } : { check: 'in-transit quantity counted once', status: 'NOT RUN', note: 'transfers not supplied' },
    run.has('purchase-order-lines') ? { check: 'open purchase orders reduced to outstanding quantity', status: 'RAN', note: 'ordered minus received, never negative' } : { check: 'open purchase orders reduced to outstanding quantity', status: 'NOT RUN', note: 'purchase-order-lines not supplied' },
  ]

  const finalOutputs = blocking || run.selfCheck.length > 0 ? [] : outputs
  const report: PrepareReport = {
    tool: 'first-load-prepare',
    formatVersion: 1,
    runId: config.runId,
    verdict: blocking || run.selfCheck.length > 0 ? 'BLOCKED' : 'PASS',
    config: {
      baseCurrency: config.baseCurrency,
      asOf: config.asOf,
      inTransitConvention: config.inTransitConvention,
      purchaseOrderKeyPrefix: config.purchaseOrderKeyPrefix,
      transferKeyPrefix: config.transferKeyPrefix,
      maxPurchaseTaxRate: config.maxPurchaseTaxRate,
      maxRowsPerFile: limits.maxRows,
      maxBytesPerFile: limits.maxBytes,
    },
    inputs: (Object.keys(DATASETS) as DatasetName[])
      .filter((name) => input.datasets[name])
      .map((name) => {
        const d = input.datasets[name]!
        return { dataset: name, file: d.file, sha256: d.sha256, bytes: d.bytes, hadBom: d.hadBom, blankRows: d.blankRows, recordsRead: d.recordsRead, rowsSkipped: Object.values(d.rowsSkipped).reduce((a, b) => a + b, 0), parts: d.parts, unmappedHeaders: d.unmappedHeaders }
      }),
    notSupplied,
    checks,
    accounting,
    accountingByCode: [...byCode.entries()]
      .map(([k, count]) => {
        const [dataset, outcome, code] = k.split('\u0000')
        return { dataset, outcome: outcome as Outcome, code, count }
      })
      .sort((a, b) => cmp(a.dataset, b.dataset) || cmp(a.outcome, b.outcome) || cmp(a.code, b.code)),
    accountingBalanced: accounting.every((row) => row.unaccounted === 0) && anomalies.length === 0,
    outputs: finalOutputs.map((file) => ({ name: file.name, target: file.target, chunk: file.chunk, chunks: file.chunks, rows: file.rows, bytes: file.bytes, sha256: file.sha256 })),
    plannedOutputRows: emittedByTarget,
    findings: [...run.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || cmp(a.code, b.code) || cmp(a.message, b.message)),
    dispositions: run.disp
      .filter((d) => d.outcome !== 'EMITTED')
      .sort((a, b) => cmp(a.dataset, b.dataset) || cmp(a.outcome, b.outcome) || cmp(a.code, b.code) || cmp(a.key, b.key) || cmp(a.reason, b.reason) || a.line - b.line),
    stock: {
      groups: stockGroups.map((g) => ({
        sku: g.sku,
        warehouseCode: g.warehouseCode,
        lots: g.lots,
        lotQty: fmt(g.lotQty),
        lotTotalBase: fmt(g.lotTotal),
        averageUnitCostBase: fmtFixed(g.average, AVERAGE_COST_DP),
        collapsedTotalBase: fmt(g.collapsedTotal),
        roundingResidualBase: fmt(g.residual),
        inTransitQty: fmt(g.inTransit),
        openingQty: fmt(g.openingQty),
      })),
      totals: {
        lotQty: fmt(totals.lotQty),
        lotTotalBase: fmt(totals.lotTotal),
        collapsedTotalBase: fmt(totals.collapsed),
        roundingResidualBase: fmt(totals.residual),
        openingQty: fmt(totals.openingQty),
        openingValueBase: fmt(totals.openingValue),
      },
      zeroOnHand: split?.zero ?? [],
      missingFromExtract: split?.missing ?? [],
    },
    coverage: {
      patterns: coverage?.patterns ?? [],
      notLoadedAndNotExcluded: coverage?.notLoaded ?? [],
      excludedAccepted: coverage?.excludedAccepted ?? [],
    },
    recipes: { cycles: run.recipeCycles },
    variantParents: run.variantParentSummary,
    purchaseOrders: { orders: run.poOutputs.length, ordersNothingOutstanding: run.poOrdersNothingOutstanding, linesEmitted: emittedByTarget['purchase-orders'] },
    transfers: { transfers: run.transferOutputs.length, linesEmitted: emittedByTarget.transfers },
    warehouseCodesUsed: [...run.warehouses].sort(cmp),
    applyTimeChecks: APPLY_TIME_CHECKS.map((c) => ({ ...c })),
    selfCheckFailures: run.selfCheck,
  }
  return { outputs: finalOutputs, report, blocking: blocking || run.selfCheck.length > 0 }
}
