/**
 * Pure validators shared by the transforms: SKU normalisation, recipe-cycle detection, chunking, and the row-accounting identity.
 */
import { Buffer } from 'node:buffer'
import { detectBomItemCycleInEdges } from '@/lib/products/bom-recipe'
import { serializeCsvLine } from './csv'
import { IMPORTER_MAX_BYTES, IMPORTER_MAX_ROWS, MAX_BYTES_PER_FILE, MAX_ROWS_PER_FILE } from './spec'

// ---------------------------------------------------------------------------
// SKUs
// ---------------------------------------------------------------------------

/** Control characters, NBSP and zero-width characters inside a SKU make two visually identical SKUs differ. */
const FORBIDDEN_SKU_CHARS = /[\u0000-\u001f\u007f\u00a0\u200b-\u200d\u2060\ufeff]/

export type SkuParse = { ok: true; sku: string; key: string; trimmed: boolean } | { ok: false; reason: string }

/**
 * Canonical SKU = Unicode NFC, outer whitespace removed. Nothing inside is altered.
 * The match KEY is the upper-cased SKU, which is exactly how the opening-stock, transfers and purchase-order importers look
 * a SKU up (`toUpperCase()`), so two SKUs that share a key would be indistinguishable to them: those are collisions.
 */
export function parseSku(raw: string, label = 'sku'): SkuParse {
  const normalised = raw.normalize('NFC')
  const sku = normalised.trim()
  if (sku === '') return { ok: false, reason: `${label} is empty` }
  if (FORBIDDEN_SKU_CHARS.test(sku)) {
    return { ok: false, reason: `${label} ${JSON.stringify(sku)} contains a control, non-breaking-space or zero-width character` }
  }
  if (sku.startsWith('#')) {
    return { ok: false, reason: `${label} ${JSON.stringify(sku)} starts with "#": the importers' CSV reader silently skips such a row as a comment` }
  }
  return { ok: true, sku, key: skuKey(sku), trimmed: sku !== raw }
}

/**
 * The comparable form of an optional IDENTITY value (lot reference, line number): every space, zero-width and other format
 * character removed, upper-cased. Empty means "not given". A blank, a space, a zero-width space or a non-breaking space can
 * therefore never make a row look distinct from another, and `l1` / `L 1` are the same reference.
 */
export function idToken(value: string): string {
  return value.normalize('NFKC').replace(/[\p{Z}\p{C}\s]/gu, '').toUpperCase()
}

/** True when a KEY (order key, transfer key) contains a control, space-like or zero-width character, which makes visually equal keys differ. */
export function hasInvisibleKeyChars(value: string): boolean {
  return /[\p{C}\p{Zl}\p{Zp}]/u.test(value) || /(?! )\p{Zs}/u.test(value)
}

export function skuKey(sku: string): string {
  return sku.toUpperCase()
}

// ---------------------------------------------------------------------------
// Recipe graph
// ---------------------------------------------------------------------------

export interface RecipeEdge {
  parent: string
  component: string
}

/**
 * Finds every cycle that must be cut, using the SAME function the importer's component pass uses
 * (`detectBomItemCycleInEdges`, lib/products/bom-recipe.ts), so "acyclic here" and "acyclic there" cannot drift apart.
 *
 * That function returns only the FIRST cycle it meets. To account for every cyclic parent, the loop removes all edges of the
 * parents on the cycle found and asks again until the graph is acyclic. Edges are sorted first, so the answer does not
 * depend on the order of the input file.
 */
export function findRecipeCycles(edges: RecipeEdge[]): { cycles: string[][]; cyclicParents: Set<string> } {
  let remaining = [...edges].sort((a, b) => (a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : a.component < b.component ? -1 : a.component > b.component ? 1 : 0))
  const cycles: string[][] = []
  const cyclicParents = new Set<string>()
  for (let guard = 0; guard <= edges.length + 1; guard++) {
    const cycle = detectBomItemCycleInEdges(remaining.map((edge) => ({ parentProductId: edge.parent, componentProductId: edge.component })))
    if (!cycle) return { cycles, cyclicParents }
    cycles.push(cycle)
    const members = new Set(cycle)
    for (const member of members) cyclicParents.add(member)
    remaining = remaining.filter((edge) => !members.has(edge.parent))
  }
  throw new Error('findRecipeCycles did not converge')
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface ChunkLimits {
  maxRows: number
  maxBytes: number
}

export const DEFAULT_CHUNK_LIMITS: ChunkLimits = { maxRows: MAX_ROWS_PER_FILE, maxBytes: MAX_BYTES_PER_FILE }

function lineBytes(cells: readonly string[]): number {
  return Buffer.byteLength(serializeCsvLine(cells), 'utf8') + 2
}

/**
 * Splits `units` into files. A unit is a group of rows that must stay in one file (all lines of one purchase order or transfer:
 * the importers group lines by key WITHIN a file, so a split order would load as two orders or be skipped as a duplicate).
 * Order is preserved; a file is closed before a unit that would push it over either limit.
 */
export function chunkUnits(
  header: readonly string[],
  units: ReadonlyArray<ReadonlyArray<readonly string[]>>,
  limits: ChunkLimits = DEFAULT_CHUNK_LIMITS,
): { chunks: string[][][]; oversizedUnits: number[] } {
  const chunks: string[][][] = []
  const oversizedUnits: number[] = []
  let current: string[][] = []
  const headerBytes = lineBytes(header)
  let bytes = headerBytes
  units.forEach((unit, index) => {
    const unitBytes = unit.reduce((total, row) => total + lineBytes(row), 0)
    if (unit.length > limits.maxRows || headerBytes + unitBytes > limits.maxBytes) {
      oversizedUnits.push(index)
      return
    }
    if (current.length > 0 && (current.length + unit.length > limits.maxRows || bytes + unitBytes > limits.maxBytes)) {
      chunks.push(current)
      current = []
      bytes = headerBytes
    }
    for (const row of unit) current.push([...row])
    bytes += unitBytes
  })
  if (current.length > 0) chunks.push(current)
  return { chunks, oversizedUnits }
}

/** Throws when a file we are about to write would break an importer limit. A defect of the tool, never of the data. */
export function assertWithinImporterLimits(header: readonly string[], rows: ReadonlyArray<readonly string[]>, label: string): void {
  const bytes = lineBytes(header) + rows.reduce((total, row) => total + lineBytes(row), 0)
  if (rows.length > IMPORTER_MAX_ROWS) throw new Error(`${label}: ${rows.length} rows exceeds the importer cap of ${IMPORTER_MAX_ROWS}`)
  if (rows.length > MAX_ROWS_PER_FILE) throw new Error(`${label}: ${rows.length} rows exceeds this tool's own cap of ${MAX_ROWS_PER_FILE}`)
  if (bytes > IMPORTER_MAX_BYTES) throw new Error(`${label}: ${bytes} bytes exceeds the importer cap of ${IMPORTER_MAX_BYTES}`)
  if (bytes > MAX_BYTES_PER_FILE) throw new Error(`${label}: ${bytes} bytes exceeds this tool's own cap of ${MAX_BYTES_PER_FILE}`)
}

// ---------------------------------------------------------------------------
// Row accounting
// ---------------------------------------------------------------------------

export type Outcome = 'EMITTED' | 'EXCLUDED' | 'REJECTED'

export interface RowDisposition {
  dataset: string
  line: number
  key: string
  outcome: Outcome
  code: string
  reason: string
}

export interface AccountingRow {
  dataset: string
  recordsRead: number
  emitted: number
  excluded: number
  rejected: number
  /** recordsRead - (emitted + excluded + rejected). Must be 0. */
  unaccounted: number
}

export function accountRows(recordsRead: Record<string, number>, dispositions: RowDisposition[]): AccountingRow[] {
  const datasets = [...new Set([...Object.keys(recordsRead), ...dispositions.map((d) => d.dataset)])].sort()
  return datasets.map((dataset) => {
    const own = dispositions.filter((d) => d.dataset === dataset)
    const emitted = own.filter((d) => d.outcome === 'EMITTED').length
    const excluded = own.filter((d) => d.outcome === 'EXCLUDED').length
    const rejected = own.filter((d) => d.outcome === 'REJECTED').length
    const read = recordsRead[dataset] ?? 0
    return { dataset, recordsRead: read, emitted, excluded, rejected, unaccounted: read - (emitted + excluded + rejected) }
  })
}

/** Each record must have exactly ONE disposition: returns every (dataset, line) that has none or several. */
export function dispositionAnomalies(dispositions: RowDisposition[]): string[] {
  const seen = new Map<string, number>()
  for (const d of dispositions) {
    const id = `${d.dataset}:${d.line}`
    seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, count]) => count !== 1).map(([id, count]) => `${id} has ${count} dispositions`)
}

/**
 * A spreadsheet treats a cell that starts with `=`, `@`, a tab or a carriage return, or with `+` / `-` followed by anything but a digit or a point,
 * as a formula. Data files are never altered for that reason; the risk is reported, and an escaped inspection copy is offered where a file is meant
 * to be looked at by a person.
 */
export const FORMULA_LEADING = /^(?:[=@\t\r]|[+-](?![0-9.]))/
