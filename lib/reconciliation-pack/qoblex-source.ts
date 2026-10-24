/**
 * THE QOBLEX SOURCE: an operator-supplied EXPORT DIRECTORY, read once per run, for items R2, R5 and R14.
 *
 * Qoblex is the incumbent system and has no API the pack may call (plan F7): the owner supplies a weekly export as files (owner decision
 * D9). This module decides what a read of those files PROVES. A part of the export (the stock, the products) is returned only when every
 * condition below holds; any other state is a closed reason and NO rows at all (a partial list is never handed to a comparison):
 *
 *   - THE DIRECTORY AND EVERY FILE ARE TRUSTED: the directory and each ancestor are real directories only root or the running account can
 *     modify, and each file is a regular file (a symlink is never followed) owned by root or the running account and not writable by group
 *     or others (lib/ops/published-report.ts, the policy every other input of the pack is read under). A file name in the manifest is a
 *     plain name inside the directory: no path, no leading dot.
 *   - EVERY FILE IS READ ONCE, and its sha256 is taken on the same bytes that are parsed. The manifest DECLARES each file's sha256 and a
 *     file whose bytes hash to anything else (a copy still in progress, an edited file) is unreadable. The digests are held in the result
 *     (`files`); the pack's report format has no field for them, so they are not published (stated limit).
 *   - THE MANIFEST IS CLOSED: an unknown key anywhere, a missing key, a repeated file or location, a name that is not a plain token, or a
 *     version other than 1 is unreadable. It declares `exportedAt` (an instant, UTC), `asOf` (the cycle date the export shows), the base
 *     currency (GBP only) and every LOCATION the export may contain with its IMS warehouse code, its company and whether it is a 3PL's.
 *   - THE COLUMN MAP IS NOT THE OPERATOR'S. A manifest may name a column map only if its bytes are exactly the repository's native Qoblex map
 *     (qoblex-native-map.ts, which lists every transform in it); anything else is COLUMN_MAP_NOT_NATIVE. With no column map the file must
 *     be in the canonical layout, which has no transform at all.
 *   - EVERY DATA ROW IS ACCOUNTED FOR: a rejected row makes the part unreadable. The native map skips nothing. Only blank lines (no cell) are uncounted; zero-quantity rows are kept here and dropped by R2/R5 on both sides.
 *   - THE EXPORT IS PARSED BY THE FIRST-LOAD INGEST (lib/first-load/ingest.ts), not by a parser of its own: a malformed header, a rejected
 *     row, an unknown or repeated location, a SKU that is not a valid SKU, a non-decimal quantity (a negative one is data: an oversold position is compared as it is), a repeated (SKU, location)
 *     that is not told apart by distinct lot references, an empty file: each makes that part unreadable.
 *   - THE EXPORT IS FRESH: for the cycle date of the run (asOf equal to --as-of), exported after that day ended, not in the future, and
 *     no older than the weekly cadence (QOBLEX_EXPORT_STALE otherwise).
 *
 * UNVERIFIED (U10): nothing in a Qoblex file proves when it was exported, so `exportedAt` is the operator's declaration. The pack checks
 * that the declaration is consistent with the run, not that it is true.
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import { ingestDataset, parseColumnMap, type DatasetMapping, type IngestedDataset } from '@/lib/first-load/ingest'
import { parseCsvStrict } from '@/lib/first-load/csv'
import { PRODUCT_TYPES } from '@/lib/first-load/spec'
import { idToken, parseSku } from '@/lib/first-load/validate'
import { QOBLEX_NATIVE_COLUMN_MAP } from '@/lib/reconciliation-pack/qoblex-native-map'
import { checkAncestors, readTrustedRegularFileBytes } from '@/lib/ops/published-report'
import { parseDecimalStrict } from '@/lib/reconciliation-pack/compare'
import {
  PACK_CADENCE_MAX_AGE_MS,
  QOBLEX_BASE_CURRENCY,
  QOBLEX_FILE_NAME_RE,
  QOBLEX_MANIFEST_FILE,
  QOBLEX_MANIFEST_VERSION,
  QOBLEX_MAX_FILE_BYTES,
  QOBLEX_MAX_LOCATIONS,
  QOBLEX_NAME_RE,
  type PackReasonCode,
} from '@/lib/reconciliation-pack/constants'

export type QoblexLocation = { code: string; company: string; threePl: boolean }
/** One stock row of the export (a lot, or the one row of a SKU in a location). Quantities and costs are plain decimals as written. */
export type QoblexLot = { sku: string; location: string; qty: string; unitCost: string | null; currency: string; fxRateToBase: string; lotRef: string }
export type QoblexProduct = { sku: string; type: string }
export type QoblexPart<T> = { ok: true; value: T } | { ok: false; reason: PackReasonCode }
export type QoblexExport = {
  exportedAt: string
  asOf: string
  locations: QoblexLocation[]
  stock: QoblexPart<QoblexLot[]>
  products: QoblexPart<QoblexProduct[]>
  /** Every file read, once, with the sha256 of the bytes that were parsed. */
  files: Array<{ name: string; sha256: string }>
}
export type QoblexRead = { ok: true; value: QoblexExport } | { ok: false; reason: PackReasonCode }

/** What R2, R5 and R14 hold: one read per run, shared. */
export interface QoblexSource { read(): Promise<QoblexRead> }

class Unreadable extends Error {
  constructor(readonly reason: PackReasonCode) { super(reason) }
}
const bad = (reason: PackReasonCode = 'SOURCE_UNREADABLE'): never => { throw new Unreadable(reason) }

const SHA256_RE = /^[0-9a-f]{64}$/
const ISO_UTC_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const DAY_MS = 86_400_000

const NATIVE_MAP_SHA256 = createHash('sha256').update(QOBLEX_NATIVE_COLUMN_MAP).digest('hex')

type Reference = { file: string; sha256: string }
type PartSpec = { file: string; sha256: string; columnMap: Reference | null }
type Manifest = { exportedAt: string; asOf: string; locations: QoblexLocation[]; stock: PartSpec | null; products: PartSpec | null }

function record(value: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return bad()
  const r = value as Record<string, unknown>
  for (const key of Object.keys(r)) if (!keys.includes(key)) return bad()
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(r, key)) return bad()
  return r
}

function reference(value: unknown): Reference {
  const r = record(value, ['file', 'sha256'], ['file', 'sha256'])
  if (typeof r.file !== 'string' || !QOBLEX_FILE_NAME_RE.test(r.file) || r.file === QOBLEX_MANIFEST_FILE) return bad()
  if (typeof r.sha256 !== 'string' || !SHA256_RE.test(r.sha256)) return bad()
  return { file: r.file, sha256: r.sha256 }
}

function partSpec(value: unknown): PartSpec {
  const r = record(value, ['file', 'sha256', 'columnMap'], ['file', 'sha256'])
  const data = reference({ file: r.file, sha256: r.sha256 })
  return { ...data, columnMap: r.columnMap === undefined ? null : reference(r.columnMap) }
}

function calendarDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return bad()
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return bad()
  return value
}

/** The manifest, strictly. Total in the sense that anything wrong throws an Unreadable and nothing else. */
export function parseQoblexManifest(text: string): Manifest {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return bad() }
  const r = record(raw, ['formatVersion', 'exportedAt', 'asOf', 'baseCurrency', 'locations', 'stock', 'products'], ['formatVersion', 'exportedAt', 'asOf', 'baseCurrency', 'locations'])
  if (r.formatVersion !== QOBLEX_MANIFEST_VERSION) return bad()
  if (r.baseCurrency !== QOBLEX_BASE_CURRENCY) return bad('CURRENCY_UNKNOWN')
  if (typeof r.exportedAt !== 'string' || !ISO_UTC_RE.test(r.exportedAt) || Number.isNaN(Date.parse(r.exportedAt))) return bad()
  const asOf = calendarDate(r.asOf)
  if (!Array.isArray(r.locations) || r.locations.length === 0 || r.locations.length > QOBLEX_MAX_LOCATIONS) return bad('NO_POPULATION_RECORD')
  const codes = new Set<string>()
  const locations = r.locations.map((entry): QoblexLocation => {
    const e = record(entry, ['code', 'company', 'threePl'], ['code', 'company', 'threePl'])
    if (typeof e.code !== 'string' || !QOBLEX_NAME_RE.test(e.code) || typeof e.company !== 'string' || !QOBLEX_NAME_RE.test(e.company) || typeof e.threePl !== 'boolean') return bad('NO_POPULATION_RECORD')
    if (codes.has(e.code)) return bad('DUPLICATE_KEY')
    codes.add(e.code)
    return { code: e.code, company: e.company, threePl: e.threePl }
  })
  const stock = r.stock === undefined ? null : partSpec(r.stock)
  const products = r.products === undefined ? null : partSpec(r.products)
  // A file is read ONCE however many parts use it (the native stock report feeds both datasets; a column map may be shared): a second
  // use must declare the same digest. A column map is never also a data file.
  const names = [stock?.file, products?.file].filter((n): n is string => n !== undefined)
  for (const part of [stock, products]) if (part?.columnMap && names.includes(part.columnMap.file)) return bad('DUPLICATE_KEY')
  if (stock !== null && products !== null && stock.columnMap && products.columnMap && stock.columnMap.file === products.columnMap.file && stock.columnMap.sha256 !== products.columnMap.sha256) return bad()
  return { exportedAt: r.exportedAt, asOf, locations, stock, products }
}

/**
 * Whether the export is usable for THIS run; null when it is. The checks are on the declaration the manifest makes (U10), not on any
 * property of the files.
 */
export function qoblexStaleness(manifest: Pick<Manifest, 'exportedAt' | 'asOf'>, runAsOf: string, now: Date): PackReasonCode | null {
  if (manifest.asOf !== runAsOf) return 'QOBLEX_EXPORT_STALE'
  const exported = Date.parse(manifest.exportedAt)
  const dayEnd = Date.parse(`${runAsOf}T00:00:00.000Z`) + DAY_MS
  if (exported < dayEnd) return 'QOBLEX_EXPORT_STALE'
  const current = now.getTime()
  if (!Number.isFinite(current) || exported > current) return 'QOBLEX_EXPORT_STALE'
  if (current - exported > PACK_CADENCE_MAX_AGE_MS.weekly) return 'QOBLEX_EXPORT_STALE'
  return null
}

type Files = { read(ref: Reference): Buffer; list: Array<{ name: string; sha256: string }> }

/** Reads each named file ONCE (a second request for the same name returns the first bytes), checking its declared digest. */
function fileReader(dir: string): Files {
  const cache = new Map<string, { bytes: Buffer; sha256: string }>()
  const list: Array<{ name: string; sha256: string }> = []
  return {
    list,
    read(ref) {
      const cached = cache.get(ref.file)
      if (cached) {
        if (cached.sha256 !== ref.sha256) return bad()
        return cached.bytes
      }
      let bytes: Buffer
      try { bytes = readTrustedRegularFileBytes(path.join(dir, ref.file), QOBLEX_MAX_FILE_BYTES) } catch { return bad() }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (sha256 !== ref.sha256) return bad()
      cache.set(ref.file, { bytes, sha256 })
      list.push({ name: ref.file, sha256 })
      return bytes
    },
  }
}

/** A cell that is already exactly what the pack will compare: nothing the ingest or parseSku would trim, normalise or refuse. */
const FORBIDDEN_IDENTITY = /[\u0000-\u001f\u007f\u00a0\u200b-\u200d\u2060\ufeff]/
const identityCellIsCanonical = (cell: string): boolean => cell !== '' && cell === cell.trim() && cell === cell.normalize('NFC') && !FORBIDDEN_IDENTITY.test(cell)

/**
 * THE IDENTITIES THE PACK COMPARES ARE THE EXACT TEXT OF THE FILE. The ingest trims and NFC-normalises every cell (and upper-cases a warehouse
 * code), and parseSku does it again, so a SKU written ` A` or in a non-NFC spelling would arrive as `A` and could match a system holding `A`.
 * The same bytes are therefore read again, raw, and EVERY data row's SKU cell (and, in the canonical layout, warehouse code cell) must already
 * be canonical: no outer whitespace, already NFC, no control, zero-width or no-break character, and a warehouse code already upper-case. One
 * that is not makes the part unreadable (IDENTITY_NOT_CANONICAL); nothing is compared in its transformed form. In the native layout the
 * warehouse code is the pinned map's own, never file text. Quantities and costs are the one thing the ingest may normalise: surrounding
 * whitespace is dropped, and the value must then be a plain decimal (no locale formatting, comma, exponent or sign other than a minus), so a
 * padded number has one unambiguous value.
 */
function assertRawIdentities(bytes: Uint8Array, dataset: 'stock-lots' | 'products', mapping: DatasetMapping | null): void {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return bad() }
  const parsed = parseCsvStrict(text, mapping?.delimiter ?? ',')
  let header = parsed.header
  let records = parsed.rows
  if (mapping !== null && mapping.rowsAboveHeader === 1) {
    if (records.length === 0) return bad()
    header = records[0]!.cells
    records = records.slice(1)
  }
  header = header.map((name) => name.normalize('NFC').trim())
  const columns: Array<{ index: number; upper: boolean }> = []
  const find = (name: string, upper: boolean): void => {
    const index = header.indexOf(name)
    if (index < 0 || header.lastIndexOf(name) !== index) return bad()
    columns.push({ index, upper })
  }
  find(mapping === null ? 'sku' : mapping.columns.sku ?? '', false)
  if (mapping === null && dataset === 'stock-lots') find('warehouseCode', true)
  for (const record of records) {
    if (record.cells.length !== header.length) continue
    if (record.cells.every((cell) => cell.trim() === '')) continue
    for (const { index, upper } of columns) {
      const cell = record.cells[index]!
      if (!identityCellIsCanonical(cell) || (upper && cell !== cell.toUpperCase())) return bad('IDENTITY_NOT_CANONICAL')
    }
  }
}

function ingest(dataset: 'stock-lots' | 'products', spec: PartSpec, files: Files): IngestedDataset {
  const bytes = files.read({ file: spec.file, sha256: spec.sha256 })
  let mapping = null
  if (spec.columnMap !== null) {
    // The column map is operator input and must not decide what is compared (rename, replace, fix or skip a value): only the repository's own
    // native map is accepted, by the digest of the bytes read, and it is the pack's own copy that is parsed (qoblex-native-map.ts).
    const mapBytes = files.read(spec.columnMap)
    if (createHash('sha256').update(mapBytes).digest('hex') !== NATIVE_MAP_SHA256) return bad('COLUMN_MAP_NOT_NATIVE')
    mapping = parseColumnMap(QOBLEX_NATIVE_COLUMN_MAP, 'native').datasets[dataset] ?? null
    if (mapping === null) return bad()
  }
  const out = ingestDataset(dataset, bytes, spec.file, mapping)
  assertRawIdentities(bytes, dataset, mapping)
  // Nothing rejected, nothing set aside unaccounted, and not empty: a file that yields no rows says nothing about the stock.
  // EVERY data row is accounted for: none rejected, and the records read are exactly the rows kept. The only map is the native one, which skips
  // nothing and merges nothing. Blank lines are the one thing not counted: a blank line carries no cell, so no stock or product is hidden by it.
  if (out.rejected.length > 0 || out.rows.length === 0 || out.recordsRead !== out.rows.length) return bad()
  return out
}

function stockOf(spec: PartSpec, locations: readonly QoblexLocation[], files: Files): QoblexLot[] {
  const ingested = ingest('stock-lots', spec, files)
  const known = new Set(locations.map((l) => l.code))
  const lots = ingested.rows.map((row): QoblexLot => {
    const v = row.values
    const sku = parseSku(v.sku ?? '')
    if (!sku.ok) return bad('BAD_KEY')
    const location = v.warehouseCode ?? ''
    // A location the manifest does not declare is not guessed at: it is a reason to refuse the whole file.
    if (!known.has(location)) return bad('NO_POPULATION_RECORD')
    const qty = parseDecimalStrict(v.qty)
    if (qty === null) return bad('BAD_VALUE')
    const unitCost = v.unitCost === undefined || v.unitCost === '' ? null : v.unitCost
    if (unitCost !== null && parseDecimalStrict(unitCost) === null) return bad('BAD_VALUE')
    const currency = v.currency ?? ''
    if (!/^[A-Z]{3}$/.test(currency)) return bad('CURRENCY_UNKNOWN')
    return { sku: sku.sku, location, qty: v.qty!, unitCost, currency, fxRateToBase: v.fxRateToBase ?? '', lotRef: v.lotRef ?? '' }
  })
  // One SKU in one location is one row, or several lots told apart by DISTINCT, non-blank references (the loader's own rule). Anything else
  // is a repeated identity, never summed.
  const groups = new Map<string, QoblexLot[]>()
  for (const lot of lots) {
    const id = `${lot.sku}\u0001${lot.location}`
    groups.set(id, [...(groups.get(id) ?? []), lot])
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const refs = group.map((lot) => idToken(lot.lotRef))
    if (refs.some((ref) => ref === '') || new Set(refs).size !== refs.length) return bad('DUPLICATE_KEY')
  }
  return lots
}

function productsOf(spec: PartSpec, files: Files): QoblexProduct[] {
  const ingested = ingest('products', spec, files)
  const products = ingested.rows.map((row): QoblexProduct => {
    const sku = parseSku(row.values.sku ?? '')
    if (!sku.ok) return bad('BAD_KEY')
    const type = row.values.type ?? ''
    if (!(PRODUCT_TYPES as readonly string[]).includes(type)) return bad()
    return { sku: sku.sku, type }
  })
  const seen = new Set<string>()
  for (const product of products) {
    // Two SKUs that differ only in case are one identity to every importer: never both.
    const id = product.sku.toUpperCase()
    if (seen.has(id)) return bad('DUPLICATE_KEY')
    seen.add(id)
  }
  return products
}

function part<T>(run: () => T): QoblexPart<T> {
  try { return { ok: true, value: run() } } catch (error) {
    if (error instanceof Unreadable) return { ok: false, reason: error.reason }
    return { ok: false, reason: 'SOURCE_UNREADABLE' }
  }
}

/** One full read of the export directory for the cycle date `asOf`. Total: it returns a closed reason for anything it cannot prove. */
export function readQoblexExport(dir: string, asOf: string, now: Date): QoblexRead {
  try {
    const resolved = path.resolve(dir)
    if (checkAncestors(resolved, 'qoblex export directory') !== null) return { ok: false, reason: 'SOURCE_UNREADABLE' }
    const files = fileReader(resolved)
    let manifestBytes: Buffer
    try { manifestBytes = readTrustedRegularFileBytes(path.join(resolved, QOBLEX_MANIFEST_FILE), QOBLEX_MAX_FILE_BYTES) } catch { return { ok: false, reason: 'SOURCE_UNREADABLE' } }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes) } catch { return { ok: false, reason: 'SOURCE_UNREADABLE' } }
    const manifest = parseQoblexManifest(text)
    const stale = qoblexStaleness(manifest, asOf, now)
    if (stale !== null) return { ok: false, reason: stale }
    const stock = manifest.stock === null ? ({ ok: false, reason: 'SOURCE_UNREADABLE' } as const) : part(() => stockOf(manifest.stock!, manifest.locations, files))
    const products = manifest.products === null ? ({ ok: false, reason: 'SOURCE_UNREADABLE' } as const) : part(() => productsOf(manifest.products!, files))
    return { ok: true, value: { exportedAt: manifest.exportedAt, asOf: manifest.asOf, locations: manifest.locations, stock, products, files: files.list } }
  } catch (error) {
    return { ok: false, reason: error instanceof Unreadable ? error.reason : 'SOURCE_UNREADABLE' }
  }
}

/**
 * The source an item holds: nothing is read until an item asks, and then once for the run (a shared promise), so R2, R5 and R14 see the
 * same bytes. An error from the ingest (InputError) or anything unexpected is an unreadable part, never a throw.
 */
export function createQoblexSource(options: { dir: string; asOf: string; now: () => Date }): QoblexSource {
  let pending: Promise<QoblexRead> | null = null
  return {
    read() {
      pending ??= Promise.resolve().then(() => readQoblexExport(options.dir, options.asOf, options.now())).catch((): QoblexRead => ({ ok: false, reason: 'SOURCE_UNREADABLE' }))
      return pending
    },
  }
}
