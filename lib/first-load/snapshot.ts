/**
 * THE WOOCOMMERCE CATALOGUE SNAPSHOT: its canonical form, its checksum, its consistency rules, and the `variant-parents` rows derived from it.
 *
 * PURE. This file holds no request, no clock and no file access: `lib/first-load/woo-snapshot/` reads the store and calls these functions, and
 * `--verify` re-runs them offline on a file that was written earlier.
 *
 * WHAT A SNAPSHOT IS. Every WooCommerce VARIABLE product (id, SKU, title, status) and every variation of it (id, SKU, status, the attribute values
 * that make it a variation), exactly as the store returned them, sorted by id. It is the evidence the variant-parent join stands on, so it is
 * checksummed: the file carries the SHA-256 of its own canonical payload and a reader recomputes it.
 *
 * FAIL CLOSED. `snapshotProblems` lists everything that makes a snapshot unusable as a catalogue (a repeated variation SKU, a parent without a SKU,
 * a variation whose parent is not in the snapshot, a parent whose list of variation ids is not the variations that were read). A snapshot with a
 * problem is never written.
 */
import { createHash } from 'node:crypto'
import { serializeCsv } from './csv'
import { DATASETS } from './spec'
import { FORMULA_LEADING, skuKey } from './validate'

export const SNAPSHOT_FORMAT_VERSION = 1

export interface SnapshotAttribute {
  name: string
  option: string
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

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Sorted copy: parents and variations by id, variation ids ascending, attributes by name then option. Nothing in a snapshot depends on the order the store answered in. */
export function normalizePayload(payload: SnapshotPayload): SnapshotPayload {
  return {
    source: 'woocommerce',
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
  for (const [key, ids] of parentSkus) if (variationSkus.has(key)) problems.push(`SKU ${key} is both a parent (product ${ids.join(', ')}) and a variation (${variationSkus.get(key)!.join(', ')})`)

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
  if (raw.formatVersion !== SNAPSHOT_FORMAT_VERSION) return { ok: false, problems: [`snapshot formatVersion must be ${SNAPSHOT_FORMAT_VERSION}`] }
  if (raw.kind !== 'woocommerce-catalogue-snapshot') return { ok: false, problems: ['the file is not a WooCommerce catalogue snapshot'] }
  const payload = raw.payload
  if (!isRecord(payload) || payload.source !== 'woocommerce' || !Array.isArray(payload.parents) || !Array.isArray(payload.variations)) {
    return { ok: false, problems: ['the snapshot payload is malformed'] }
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
  const parsed: SnapshotPayload = { source: 'woocommerce', parents, variations }
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
    rows.push([v.sku, String(v.id), p.sku, p.name, p.status, String(p.id)])
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
