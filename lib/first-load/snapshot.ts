/**
 * THE WOOCOMMERCE CATALOGUE SNAPSHOT: its canonical form, its checksum, its consistency rules, and the `variant-parents` and `woo-product-status` rows derived from it.
 *
 * PURE. This file holds no request, no clock and no file access: `lib/first-load/woo-snapshot/` reads the store and calls these functions, and
 * `--verify` re-runs them offline on a file that was written earlier.
 *
 * WHAT A SNAPSHOT IS. Every WooCommerce PRODUCT of any type and status (id, SKU, title, type, own status, stock quantity), the VARIABLE ones again as parents
 * with the ids of their variations, and every variation of those (id, SKU, status, the attribute values that make it a variation), exactly as the store
 * returned them, sorted by id. It is the evidence the variant-parent join and the Woo-gospel lifecycle stand on, so it is checksummed: the file carries the
 * SHA-256 of its own canonical payload and a reader recomputes it.
 *
 * FAIL CLOSED. `snapshotProblems` lists everything that makes a snapshot unusable as a catalogue (a repeated variation SKU, a parent without a SKU,
 * a variation whose parent is not in the snapshot, a parent whose list of variation ids is not the variations that were read). A snapshot with a
 * problem is never written.
 */
import { createHash } from 'node:crypto'
import { serializeCsv } from './csv'
import { DATASETS } from './spec'
import { FORMULA_LEADING, skuKey } from './validate'

/** 2: `products` (every product, any type) was added. A version-1 snapshot holds variable products only and is refused with a message that says so. */
export const SNAPSHOT_FORMAT_VERSION = 2

export interface SnapshotAttribute {
  name: string
  option: string
}

/** One WooCommerce product as the store lists it (a variation is not a product here). `stockQuantity` is `null` when the store does not manage stock or reports none. */
export interface SnapshotProduct {
  id: number
  sku: string
  name: string
  type: string
  status: string
  manageStock: boolean
  stockQuantity: number | null
}

export interface SnapshotParent {
  id: number
  sku: string
  name: string
  status: string
  /** The ids WooCommerce lists on the parent. The variations that were read must be exactly these. */
  variationIds: number[]
}

export interface SnapshotVariation {
  id: number
  parentId: number
  sku: string
  status: string
  attributes: SnapshotAttribute[]
}

export interface SnapshotPayload {
  source: 'woocommerce'
  /** EVERY product, any type and status (the VARIABLE ones included). */
  products: SnapshotProduct[]
  /** The VARIABLE products again, with the ids of their variations. */
  parents: SnapshotParent[]
  variations: SnapshotVariation[]
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** JSON with every object's keys sorted and no insignificant whitespace: the same value is always the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort((a, b) => cmp(a[0], b[0]))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function sha256Hex(content: string | Uint8Array): string {
  return typeof content === 'string' ? createHash('sha256').update(content, 'utf8').digest('hex') : createHash('sha256').update(content).digest('hex')
}

/** Sorted copy: parents and variations by id, variation ids ascending, attributes by name then option. Nothing in a snapshot depends on the order the store answered in. */
export function normalizePayload(payload: SnapshotPayload): SnapshotPayload {
  return {
    source: 'woocommerce',
    products: [...payload.products]
      .map((p) => ({ id: p.id, sku: p.sku, name: p.name, type: p.type, status: p.status, manageStock: p.manageStock, stockQuantity: p.stockQuantity }))
      .sort((a, b) => a.id - b.id),
    parents: [...payload.parents]
      .map((p) => ({ id: p.id, sku: p.sku, name: p.name, status: p.status, variationIds: [...p.variationIds].sort((a, b) => a - b) }))
      .sort((a, b) => a.id - b.id),
    variations: [...payload.variations]
      .map((v) => ({
        id: v.id, parentId: v.parentId, sku: v.sku, status: v.status,
        attributes: [...v.attributes].map((a) => ({ name: a.name, option: a.option })).sort((a, b) => cmp(a.name, b.name) || cmp(a.option, b.option)),
      }))
      .sort((a, b) => a.id - b.id),
  }
}

export function payloadSha256(payload: SnapshotPayload): string {
  return sha256Hex(canonicalJson(normalizePayload(payload)))
}

/**
 * The checksum the TWO WALKS are compared by: the payload WITHOUT the stock figures (manageStock, stockQuantity). Stock moves with every order and every stock push, and the
 * verifying walk runs minutes after the first, so comparing it would refuse a live store that is merely trading. Status, SKU, type, title, ids and variations still must agree.
 * The stock figures kept in the file are walk A's: a point-in-time read, for information only (the file's own checksum still covers them).
 */
export function comparisonSha256(payload: SnapshotPayload): string {
  const n = normalizePayload(payload)
  return sha256Hex(canonicalJson({ ...n, products: n.products.map(({ manageStock: _m, stockQuantity: _q, ...rest }) => rest) }))
}

/** The snapshot file: pretty, key-sorted JSON carrying the payload and the checksum of its canonical form. */
export function renderSnapshotFile(payload: SnapshotPayload): string {
  const normalised = normalizePayload(payload)
  const body = { formatVersion: SNAPSHOT_FORMAT_VERSION, kind: 'woocommerce-catalogue-snapshot', payloadSha256: payloadSha256(normalised), payload: normalised }
  return `${JSON.stringify(JSON.parse(canonicalJson(body)), null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Reading what the store returned (untrusted) into the snapshot shapes
// ---------------------------------------------------------------------------

/** An upstream value, bounded, for an error message: a store's own text must not be able to flood or smuggle anything into an output. */
export function short(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined'
  return text.length > 60 ? `${text.slice(0, 60)}...` : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wholeId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** A product object from `GET /products` (any type). Stock is read as the store states it: `manage_stock` true with a numeric `stock_quantity`, otherwise no quantity. */
export function reduceProduct(raw: unknown): { ok: true; product: SnapshotProduct } | { ok: false; problem: string } {
  if (!isRecord(raw)) return { ok: false, problem: 'a product in the response is not an object' }
  const id = wholeId(raw.id)
  if (id === null) return { ok: false, problem: `a product has no usable id (${short(raw.id)})` }
  if (typeof raw.type !== 'string' || raw.type === '') return { ok: false, problem: `product ${id} has no type field` }
  if (typeof raw.sku !== 'string') return { ok: false, problem: `product ${id} has no sku field` }
  if (typeof raw.name !== 'string') return { ok: false, problem: `product ${id} has no name field` }
  if (typeof raw.status !== 'string' || raw.status === '') return { ok: false, problem: `product ${id} has no status field` }
  // WooCommerce sends manage_stock as a boolean for a product; an absent field (an old store) is "not managed".
  const manageStock = raw.manage_stock === undefined || raw.manage_stock === null ? raw.stock_quantity !== undefined && raw.stock_quantity !== null : raw.manage_stock
  if (typeof manageStock !== 'boolean') return { ok: false, problem: `product ${id} has a manage_stock that is not true or false (${short(raw.manage_stock)})` }
  const q = raw.stock_quantity
  if (q !== undefined && q !== null && (typeof q !== 'number' || !Number.isFinite(q))) return { ok: false, problem: `product ${id} has a stock_quantity that is not a number (${short(q)})` }
  return { ok: true, product: { id, sku: raw.sku.trim(), name: raw.name, type: raw.type, status: raw.status, manageStock, stockQuantity: manageStock && typeof q === 'number' ? q : null } }
}

/** A product object from `GET /products?type=variable`. Anything that is not exactly a variable product with the expected fields is a problem. */
export function reduceParent(raw: unknown): { ok: true; parent: SnapshotParent } | { ok: false; problem: string } {
  if (!isRecord(raw)) return { ok: false, problem: 'a product in the response is not an object' }
  const id = wholeId(raw.id)
  if (id === null) return { ok: false, problem: `a product has no usable id (${short(raw.id)})` }
  if (raw.type !== 'variable') return { ok: false, problem: `product ${id} has type ${short(raw.type)}, not "variable"` }
  if (typeof raw.sku !== 'string') return { ok: false, problem: `product ${id} has no sku field` }
  if (typeof raw.name !== 'string') return { ok: false, problem: `product ${id} has no name field` }
  if (typeof raw.status !== 'string' || raw.status === '') return { ok: false, problem: `product ${id} has no status field` }
  if (!Array.isArray(raw.variations)) return { ok: false, problem: `product ${id} has no variations list` }
  const variationIds: number[] = []
  for (const entry of raw.variations) {
    const variationId = wholeId(entry)
    if (variationId === null) return { ok: false, problem: `product ${id} lists a variation id that is not a whole number (${short(entry)})` }
    variationIds.push(variationId)
  }
  return { ok: true, parent: { id, sku: raw.sku.trim(), name: raw.name, status: raw.status, variationIds: variationIds.sort((a, b) => a - b) } }
}

/** A variation object from `GET /products/{id}/variations`. `parent_id` is not in every WooCommerce version's response; when present it must match. */
export function reduceVariation(raw: unknown, parentId: number): { ok: true; variation: SnapshotVariation } | { ok: false; problem: string } {
  if (!isRecord(raw)) return { ok: false, problem: `a variation of product ${parentId} is not an object` }
  const id = wholeId(raw.id)
  if (id === null) return { ok: false, problem: `a variation of product ${parentId} has no usable id (${short(raw.id)})` }
  if (raw.parent_id !== undefined && raw.parent_id !== parentId) {
    return { ok: false, problem: `variation ${id} says its parent is ${short(raw.parent_id)} but it was listed under product ${parentId}` }
  }
  if (typeof raw.sku !== 'string') return { ok: false, problem: `variation ${id} has no sku field` }
  if (typeof raw.status !== 'string' || raw.status === '') return { ok: false, problem: `variation ${id} has no status field` }
  const attributes: SnapshotAttribute[] = []
  if (raw.attributes !== undefined) {
    if (!Array.isArray(raw.attributes)) return { ok: false, problem: `variation ${id} has an attributes field that is not a list` }
    for (const a of raw.attributes) {
      if (!isRecord(a) || typeof a.name !== 'string' || typeof a.option !== 'string') return { ok: false, problem: `variation ${id} has an attribute without a text name and option` }
      attributes.push({ name: a.name, option: a.option })
    }
  }
  return { ok: true, variation: { id, parentId, sku: raw.sku.trim(), status: raw.status, attributes } }
}

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

/** Everything that makes the snapshot unusable. Empty means usable. Sorted, so the text is stable. */
export function snapshotProblems(payload: SnapshotPayload): string[] {
  const problems: string[] = []
  const parentIds = new Set<number>()
  const parentSkus = new Map<string, number[]>()
  for (const p of payload.parents) {
    if (parentIds.has(p.id)) problems.push(`parent id ${p.id} appears more than once`)
    parentIds.add(p.id)
    if (p.sku === '') problems.push(`parent ${p.id} has a blank SKU: its variants cannot be given a parent SKU`)
    else parentSkus.set(skuKey(p.sku), [...(parentSkus.get(skuKey(p.sku)) ?? []), p.id])
  }
  for (const [key, ids] of parentSkus) if (ids.length > 1) problems.push(`parent SKU ${key} is used by products ${ids.join(', ')} (letter case ignored)`)

  const productIds = new Map<number, SnapshotProduct>()
  const productSkus = new Map<string, number[]>()
  for (const p of payload.products) {
    if (productIds.has(p.id)) problems.push(`product id ${p.id} appears more than once`)
    productIds.set(p.id, p)
    if (p.sku !== '') productSkus.set(skuKey(p.sku), [...(productSkus.get(skuKey(p.sku)) ?? []), p.id])
  }
  for (const [key, ids] of productSkus) if (ids.length > 1) problems.push(`product SKU ${key} is used by products ${ids.join(', ')} (letter case ignored)`)
  for (const p of payload.parents) {
    const own = productIds.get(p.id)
    if (!own || own.type !== 'variable' || own.sku !== p.sku || own.name !== p.name || own.status !== p.status) problems.push(`variable parent ${p.id} does not match the product of the same id in the product list`)
  }
  const variableProducts = payload.products.filter((p) => p.type === 'variable').map((p) => p.id).sort((a, b) => a - b)
  const parentList = payload.parents.map((p) => p.id).sort((a, b) => a - b)
  if (variableProducts.length !== parentList.length || variableProducts.some((id, i) => id !== parentList[i])) problems.push(`the variable products in the product list [${variableProducts.join(', ')}] are not the parents [${parentList.join(', ')}]`)

  const variationIds = new Set<number>()
  const variationSkus = new Map<string, number[]>()
  const byParent = new Map<number, number[]>()
  for (const v of payload.variations) {
    if (variationIds.has(v.id)) problems.push(`variation id ${v.id} appears more than once`)
    variationIds.add(v.id)
    if (!parentIds.has(v.parentId)) problems.push(`variation ${v.id} belongs to product ${v.parentId}, which is not a parent in the snapshot`)
    byParent.set(v.parentId, [...(byParent.get(v.parentId) ?? []), v.id])
    if (v.sku !== '') variationSkus.set(skuKey(v.sku), [...(variationSkus.get(skuKey(v.sku)) ?? []), v.id])
  }
  for (const [key, ids] of variationSkus) if (ids.length > 1) problems.push(`variation SKU ${key} is used by variations ${ids.join(', ')} (letter case ignored)`)
  for (const [key, ids] of productSkus) if (variationSkus.has(key)) problems.push(`SKU ${key} is both a product (${ids.join(', ')}) and a variation (${variationSkus.get(key)!.join(', ')})`)

  for (const p of payload.parents) {
    const read = (byParent.get(p.id) ?? []).sort((a, b) => a - b)
    if (read.length !== p.variationIds.length || read.some((id, i) => id !== p.variationIds[i])) {
      problems.push(`parent ${p.id} lists variations [${p.variationIds.join(', ')}] but [${read.join(', ')}] were read`)
    }
  }
  return problems.sort(cmp)
}

export type ParsedSnapshot = { ok: true; payload: SnapshotPayload; payloadSha256: string } | { ok: false; problems: string[] }

/** Reads a snapshot file back: the shape, the format version, the checksum (recomputed, never trusted) and the consistency rules. */
export function parseSnapshotFile(text: string): ParsedSnapshot {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, problems: [`the snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isRecord(raw)) return { ok: false, problems: ['the snapshot must be a JSON object'] }
  const allowed = new Set(['formatVersion', 'kind', 'payloadSha256', 'payload'])
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k))
  if (unknown.length > 0) return { ok: false, problems: [`unknown key(s) in the snapshot: ${unknown.join(', ')}`] }
  if (raw.formatVersion === 1) return { ok: false, problems: [`the snapshot is format 1: it was taken before every product's own status and stock were read (it holds variable products and their variations only), so it cannot give the lifecycle of a simple, KIT or BOM product. Re-run first-load:woo-snapshot to take a new snapshot (format ${SNAPSHOT_FORMAT_VERSION}) and regenerate the files derived from it`] }
  if (raw.formatVersion !== SNAPSHOT_FORMAT_VERSION) return { ok: false, problems: [`snapshot formatVersion must be ${SNAPSHOT_FORMAT_VERSION}`] }
  if (raw.kind !== 'woocommerce-catalogue-snapshot') return { ok: false, problems: ['the file is not a WooCommerce catalogue snapshot'] }
  const payload = raw.payload
  if (!isRecord(payload) || payload.source !== 'woocommerce' || !Array.isArray(payload.products) || !Array.isArray(payload.parents) || !Array.isArray(payload.variations)) {
    return { ok: false, problems: ['the snapshot payload is malformed'] }
  }
  const products: SnapshotProduct[] = []
  for (const entry of payload.products) {
    // The stored form names the stock fields in camel case; the reducer reads the store's own (snake case) names.
    const reduced = reduceProduct(isRecord(entry) ? { ...entry, manage_stock: entry.manageStock, stock_quantity: entry.stockQuantity } : entry)
    if (!reduced.ok) return { ok: false, problems: [reduced.problem] }
    products.push(reduced.product)
  }
  const parents: SnapshotParent[] = []
  for (const entry of payload.parents) {
    const reduced = reduceParent({ ...(isRecord(entry) ? entry : {}), type: 'variable', variations: isRecord(entry) ? entry.variationIds : undefined })
    if (!reduced.ok) return { ok: false, problems: [reduced.problem] }
    parents.push(reduced.parent)
  }
  const variations: SnapshotVariation[] = []
  for (const entry of payload.variations) {
    const parentId = isRecord(entry) ? wholeId(entry.parentId) : null
    if (parentId === null) return { ok: false, problems: ['a snapshot variation has no usable parentId'] }
    const reduced = reduceVariation(entry, parentId)
    if (!reduced.ok) return { ok: false, problems: [reduced.problem] }
    variations.push(reduced.variation)
  }
  const parsed: SnapshotPayload = { source: 'woocommerce', products, parents, variations }
  const actual = payloadSha256(parsed)
  if (raw.payloadSha256 !== actual) {
    return { ok: false, problems: [`the checksum does not match: the file says ${JSON.stringify(raw.payloadSha256)} but its content hashes to ${actual} (the file was changed after it was written)`] }
  }
  const problems = snapshotProblems(parsed)
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, payload: normalizePayload(parsed), payloadSha256: actual }
}

// ---------------------------------------------------------------------------
// The variant-parents dataset
// ---------------------------------------------------------------------------

/** One row per variation that has a SKU, sorted by variation SKU. A variation without a SKU cannot be joined to anything and is counted in the provenance instead. */
export function variantParentRows(payload: SnapshotPayload): string[][] {
  const parents = new Map(payload.parents.map((p) => [p.id, p]))
  const rows: string[][] = []
  for (const v of payload.variations) {
    if (v.sku === '') continue
    const p = parents.get(v.parentId)
    if (!p) continue
    rows.push([v.sku, String(v.id), p.sku, p.name, p.status, String(p.id), v.status])
  }
  return rows.sort((a, b) => cmp(skuKey(a[0]), skuKey(b[0])) || cmp(a[0], b[0]))
}

export function renderVariantParentsCsv(payload: SnapshotPayload): string {
  return serializeCsv(DATASETS['variant-parents'].columns, variantParentRows(payload))
}

/** The cells of variant-parents.csv that a spreadsheet would read as a formula (WooCommerce text is untrusted). */
export function formulaLeadingCells(payload: SnapshotPayload): number {
  return variantParentRows(payload).reduce((n, row) => n + row.filter((cell) => FORMULA_LEADING.test(cell)).length, 0)
}

/**
 * An INSPECTION copy for a person to open in a spreadsheet: the same rows, with a leading apostrophe on every cell a spreadsheet would read as a
 * formula. It is NOT an input: variant-parents.csv is the data file and is never altered, because the join must see the text as WooCommerce has it.
 */
export function renderVariantParentsInspectionCsv(payload: SnapshotPayload): string {
  return serializeCsv(DATASETS['variant-parents'].columns, variantParentRows(payload).map((row) => row.map((cell) => (FORMULA_LEADING.test(cell) ? `'${cell}` : cell))))
}

// ---------------------------------------------------------------------------
// The woo-product-status dataset
// ---------------------------------------------------------------------------

/** One row per product (any type) that has a SKU, sorted by SKU. A product without a SKU cannot be matched to anything and is counted in the provenance instead. */
export function productStatusRows(payload: SnapshotPayload): string[][] {
  const rows = payload.products
    .filter((p) => p.sku !== '')
    .map((p) => [p.sku, String(p.id), p.type, p.status, p.stockQuantity === null ? '' : String(p.stockQuantity), p.name])
  return rows.sort((a, b) => cmp(skuKey(a[0]), skuKey(b[0])) || cmp(a[0], b[0]))
}

export function renderProductStatusCsv(payload: SnapshotPayload): string {
  return serializeCsv(DATASETS['woo-product-status'].columns, productStatusRows(payload))
}

/** The cells of woo-product-status.csv that a spreadsheet would read as a formula (a title is untrusted text; the file is data, never altered). */
export function productStatusFormulaLeadingCells(payload: SnapshotPayload): number {
  return productStatusRows(payload).reduce((n, row) => n + row.filter((cell) => FORMULA_LEADING.test(cell)).length, 0)
}

// ---------------------------------------------------------------------------
// The binding between the verified snapshot and the files derived from it
// ---------------------------------------------------------------------------

/**
 * What `first-load:prepare` needs to know before it lets variant-parents.csv assign a parent. `verified: true` is only ever produced by
 * `verifyWooSnapshotBundle` (through `bindingFromVerification`); `csvSha256` is the hash of the exact CSV bytes that were compared, so a later
 * step can check it is looking at those bytes.
 */
export type VariantParentsBinding =
  | { verified: true; csvSha256: string; snapshotPayloadSha256: string }
  | { verified: false; problems: string[] }

/** The same proof for woo-product-status.csv: `first-load:prepare` takes a Woo status for a product only from a file that was verified against the snapshot. */
export type ProductStatusBinding = VariantParentsBinding

/** `csvSha256` / `productStatusSha256` are the hashes of the bytes compared, or null when that file was not part of the verification. */
export type SnapshotBundleVerdict =
  | { ok: true; payload: SnapshotPayload; payloadSha256: string; snapshotSha256: string; csvSha256: string | null; productStatusSha256: string | null }
  | { ok: false; problems: string[] }

const MAX_BUNDLE_PROBLEMS = 8
const MAX_PROBLEM_CHARS = 300

/** Messages stay short and never echo file content (a CSV cell is untrusted text). */
export function boundProblems(problems: string[]): string[] {
  const clipped = problems.slice(0, MAX_BUNDLE_PROBLEMS).map((p) => (p.length > MAX_PROBLEM_CHARS ? `${p.slice(0, MAX_PROBLEM_CHARS)}...` : p))
  if (problems.length > MAX_BUNDLE_PROBLEMS) clipped.push(`... and ${problems.length - MAX_BUNDLE_PROBLEMS} more problem(s)`)
  return clipped
}

/** The statuses a snapshot enumerates, for the variable products and for their variations. */
export const SNAPSHOT_STATUSES = ['publish', 'draft', 'private', 'pending'] as const
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number]
export type StatusCounts = Record<SnapshotStatus, number>
export interface VisibilityAttestation { allProducts: StatusCounts; products: StatusCounts; variations: StatusCounts }

/**
 * The operator's attestation of what the REAL key should see: the counts per status that WooCommerce's own admin shows for ALL products (every type), for the
 * VARIABLE products alone and for the variations of those. Shape: {"allProducts": {"publish": n, "draft": n, "private": n, "pending": n}, "products": {...}, "variations": {...}}
 * (`products` is the variable products, as before). Anything else is a problem.
 */
export function parseVisibilityAttestation(raw: unknown): { ok: true; value: VisibilityAttestation } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('the visibility attestation must be an object {"allProducts": {...}, "products": {...}, "variations": {...}}')
  const o = raw as Record<string, unknown>
  for (const key of Object.keys(o)) if (key !== 'allProducts' && key !== 'products' && key !== 'variations') return bad(`unknown key "${key.slice(0, 40)}" in the visibility attestation`)
  const counts = (name: string): StatusCounts | string => {
    const c = o[name]
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return `the visibility attestation needs "${name}" as an object with a count for each of ${SNAPSHOT_STATUSES.join(', ')}`
    const rec = c as Record<string, unknown>
    for (const key of Object.keys(rec)) if (!(SNAPSHOT_STATUSES as readonly string[]).includes(key)) return `unknown status "${key.slice(0, 40)}" in the attestation's ${name}`
    const out = {} as StatusCounts
    for (const status of SNAPSHOT_STATUSES) {
      const n = rec[status]
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return `the attestation's ${name}.${status} must be a whole number of rows, 0 or more`
      out[status] = n
    }
    return out
  }
  const allProducts = counts('allProducts')
  if (typeof allProducts === 'string') return bad(allProducts)
  const products = counts('products')
  if (typeof products === 'string') return bad(products)
  const variations = counts('variations')
  if (typeof variations === 'string') return bad(variations)
  return { ok: true, value: { allProducts, products, variations } }
}

const hex12 = (hex: string) => hex.slice(0, 12)

/** A store origin as the URL standard writes it (scheme://host[:port], lower-case host, default port dropped, no path), or null when it is not an http(s) origin. */
export function normaliseStoreOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * THE BINDING. A variant-parents.csv assigns a parent SKU to a Qoblex variant, so it is only as good as the snapshot it came from. This
 * regenerates the rows from the VERIFIED snapshot with the same pure builder that wrote them and requires:
 *   1. the snapshot's own checksum and consistency rules to hold;
 *   2. the provenance to record the SHA-256 of the snapshot file, of the CSV and (when `inspectionBytes` is given) of the inspection copy, and each to match
 *      the bytes on disk;
 *   3. the CSV on disk to be BYTE-IDENTICAL to the regenerated one (so an edited, stale or foreign CSV is refused even if every hash were forged).
 * It returns problems, never throws, and never echoes file content.
 */
export function verifyWooSnapshotBundle(input: {
  snapshotBytes: Uint8Array | null
  provenanceBytes: Uint8Array | null
  /** variant-parents.csv; `undefined` when the run does not use it (then it is not checked), `null` when it could not be read. */
  csvBytes?: Uint8Array | null
  /** woo-product-status.csv; same convention as `csvBytes`. */
  productStatusBytes?: Uint8Array | null
  /** Offline `--verify` also checks the inspection copy; `first-load:prepare` does not read it. */
  inspectionBytes?: Uint8Array | null
  requireInspection?: boolean
  /**
   * The WooCommerce origin the OPERATOR declares this snapshot must come from (the manifest's wooSnapshot.origin, or --expect-origin offline).
   * It is an expectation checked against the origin the provenance recorded, not proof of where the bytes came from. `null` (not declared) is a refusal.
   */
  expectedOrigin: string | null
  /**
   * What the operator read off the shop's own admin for the real key's visibility (see `parseVisibilityAttestation`). The provenance's recorded per-status
   * counts must equal it, because a key that is silently shown less than the shop holds produces self-consistent counts that no check inside the walk can tell apart.
   * `null` (not given) is a refusal.
   */
  visibilityChecked: VisibilityAttestation | null
}): SnapshotBundleVerdict {
  const problems: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const text = (bytes: Uint8Array | null, label: string): string | null => {
    if (bytes === null) {
      problems.push(`${label} could not be read`)
      return null
    }
    try {
      return decoder.decode(bytes)
    } catch {
      problems.push(`${label} is not valid UTF-8`)
      return null
    }
  }
  const snapshotText = text(input.snapshotBytes, 'the snapshot file')
  const provenanceText = text(input.provenanceBytes, 'the provenance file')
  const parsed = snapshotText === null ? null : parseSnapshotFile(snapshotText)
  if (parsed !== null && !parsed.ok) problems.push(...parsed.problems.map((p) => `snapshot: ${p}`))

  let provenance: Record<string, unknown> | null = null
  if (provenanceText !== null) {
    try {
      const raw: unknown = JSON.parse(provenanceText)
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) provenance = raw as Record<string, unknown>
      else problems.push('the provenance file is not a JSON object')
    } catch {
      problems.push('the provenance file is not valid JSON')
    }
  }
  const recorded = (key: string, label: string): { sha256: string | null; payloadSha256?: string | null } => {
    const entry = provenance?.[key]
    if (provenance === null) return { sha256: null }
    if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).sha256 !== 'string' || !/^[0-9a-f]{64}$/.test((entry as Record<string, string>).sha256)) {
      problems.push(`the provenance does not record a SHA-256 for ${label}`)
      return { sha256: null }
    }
    const e = entry as Record<string, unknown>
    return { sha256: e.sha256 as string, payloadSha256: typeof e.payloadSha256 === 'string' ? e.payloadSha256 : null }
  }
  const expectedOrigin = input.expectedOrigin === null ? null : normaliseStoreOrigin(input.expectedOrigin)
  if (input.expectedOrigin === null) problems.push('no expected WooCommerce store origin was declared (the manifest wooSnapshot.origin, or --expect-origin): a snapshot is only accepted from the store the operator names')
  else if (expectedOrigin === null) problems.push('the declared expected store origin is not an http(s) origin')
  if (provenance !== null) {
    const recordedOrigin = typeof provenance.origin === 'string' ? normaliseStoreOrigin(provenance.origin) : null
    if (recordedOrigin === null) problems.push('the provenance does not record a usable store origin')
    else if (expectedOrigin !== null && recordedOrigin !== expectedOrigin) problems.push(`the snapshot was taken from ${recordedOrigin}, not from the declared store ${expectedOrigin}`)
  }
  if (input.visibilityChecked === null) problems.push('no visibility attestation was given (the manifest wooSnapshot.visibilityChecked, or --expect-visibility): the per-status counts the real key saw were not compared with the shop\'s own admin counts')
  else if (provenance !== null) {
    const proof = provenance.proof as { allProducts?: { statusTotals?: unknown }; parents?: { statusTotals?: unknown }; variations?: { statusTotals?: unknown } } | undefined
    for (const [name, attested, recordedCounts] of [
      ['products of every type', input.visibilityChecked.allProducts, proof?.allProducts?.statusTotals],
      ['variable products', input.visibilityChecked.products, proof?.parents?.statusTotals],
      ['variations', input.visibilityChecked.variations, proof?.variations?.statusTotals],
    ] as const) {
      const rec = typeof recordedCounts === 'object' && recordedCounts !== null ? (recordedCounts as Record<string, unknown>) : null
      if (rec === null) problems.push(`the provenance does not record per-status counts for the ${name}`)
      else {
        const diff = SNAPSHOT_STATUSES.filter((status) => rec[status] !== attested[status]).map((status) => `${status}: snapshot saw ${String(rec[status])}, attested ${attested[status]}`)
        if (diff.length > 0) problems.push(`the key saw different ${name} than the shop's admin counts attested (${diff.join('; ')}): the key sees less (or more) than the shop holds`)
      }
    }
  }
  const snapRec = recorded('snapshotFile', 'the snapshot file')
  if (provenance !== null && provenance.formatVersion !== SNAPSHOT_FORMAT_VERSION) problems.push(`the provenance is format ${JSON.stringify(provenance.formatVersion)}, not ${SNAPSHOT_FORMAT_VERSION}: it was written before every product's own status was read. Re-run first-load:woo-snapshot`)
  const csvRec = input.csvBytes === undefined ? { sha256: null } : recorded('variantParentsFile', 'variant-parents.csv')
  const statusRec = input.productStatusBytes === undefined ? { sha256: null } : recorded('productStatusFile', 'woo-product-status.csv')
  const inspectRec = input.requireInspection ? recorded('variantParentsInspectionFile', 'the inspection copy') : { sha256: null }

  let snapshotSha = ''
  if (input.snapshotBytes !== null) {
    snapshotSha = sha256Hex(input.snapshotBytes)
    if (snapRec.sha256 !== null && snapRec.sha256 !== snapshotSha) problems.push(`the snapshot file (SHA-256 ${hex12(snapshotSha)}...) is not the one the provenance recorded (${hex12(snapRec.sha256)}...): it is a different or edited snapshot`)
    if (parsed?.ok && snapRec.payloadSha256 != null && snapRec.payloadSha256 !== parsed.payloadSha256) problems.push('the snapshot payload checksum differs from the one the provenance recorded')
  }
  let csvSha: string | null = null
  if (input.csvBytes === null) problems.push('variant-parents.csv could not be read')
  else if (input.csvBytes !== undefined) {
    csvSha = sha256Hex(input.csvBytes)
    if (csvRec.sha256 !== null && csvRec.sha256 !== csvSha) problems.push(`variant-parents.csv (SHA-256 ${hex12(csvSha)}...) is not the file the provenance recorded (${hex12(csvRec.sha256)}...)`)
  }
  let statusSha: string | null = null
  if (input.productStatusBytes === null) problems.push('woo-product-status.csv could not be read')
  else if (input.productStatusBytes !== undefined) {
    statusSha = sha256Hex(input.productStatusBytes)
    if (statusRec.sha256 !== null && statusRec.sha256 !== statusSha) problems.push(`woo-product-status.csv (SHA-256 ${hex12(statusSha)}...) is not the file the provenance recorded (${hex12(statusRec.sha256)}...)`)
  }
  if (parsed?.ok) {
    if (input.productStatusBytes != null) {
      const expected = Buffer.from(renderProductStatusCsv(parsed.payload), 'utf8')
      if (!expected.equals(Buffer.from(input.productStatusBytes))) problems.push(`woo-product-status.csv is not the rows regenerated from the verified snapshot (${expected.length} byte(s) expected, ${input.productStatusBytes.length} found): it is stale, edited or from another snapshot`)
    }
    if (input.csvBytes != null) {
      const expected = Buffer.from(renderVariantParentsCsv(parsed.payload), 'utf8')
      const headerLine = Buffer.from(input.csvBytes).toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? ''
      if (!headerLine.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim()).includes('variationStatus')) problems.push('variant-parents.csv predates the variationStatus column (it is the old 6-column layout, written before the column was added). The lifecycle of a variation is taken from its own WooCommerce status, so re-run first-load:woo-snapshot to take a new snapshot and regenerate the CSV')
      else if (!expected.equals(Buffer.from(input.csvBytes))) problems.push(`variant-parents.csv is not the rows regenerated from the verified snapshot (${expected.length} byte(s) expected, ${input.csvBytes.length} found): it is stale, edited or from another snapshot`)
    }
    if (input.requireInspection) {
      if (input.inspectionBytes == null) problems.push('the inspection copy could not be read')
      else {
        const inspectSha = sha256Hex(input.inspectionBytes)
        if (inspectRec.sha256 !== null && inspectRec.sha256 !== inspectSha) problems.push(`the inspection copy (SHA-256 ${hex12(inspectSha)}...) is not the file the provenance recorded (${hex12(inspectRec.sha256)}...)`)
        if (!Buffer.from(renderVariantParentsInspectionCsv(parsed.payload), 'utf8').equals(Buffer.from(input.inspectionBytes))) problems.push('the inspection copy is not the rows regenerated from the verified snapshot')
      }
    }
  }
  if (problems.length > 0 || parsed === null || !parsed.ok) return { ok: false, problems: boundProblems(problems.length > 0 ? problems : ['the snapshot could not be verified']) }
  return { ok: true, payload: parsed.payload, payloadSha256: parsed.payloadSha256, snapshotSha256: snapshotSha, csvSha256: csvSha, productStatusSha256: statusSha }
}

export function bindingFromVerification(verdict: SnapshotBundleVerdict): VariantParentsBinding {
  return verdict.ok && verdict.csvSha256 !== null ? { verified: true, csvSha256: verdict.csvSha256, snapshotPayloadSha256: verdict.payloadSha256 } : { verified: false, problems: verdict.ok ? ['variant-parents.csv was not part of the verification'] : verdict.problems }
}

export function productStatusBindingFromVerification(verdict: SnapshotBundleVerdict): ProductStatusBinding {
  return verdict.ok && verdict.productStatusSha256 !== null ? { verified: true, csvSha256: verdict.productStatusSha256, snapshotPayloadSha256: verdict.payloadSha256 } : { verified: false, problems: verdict.ok ? ['woo-product-status.csv was not part of the verification'] : verdict.problems }
}
