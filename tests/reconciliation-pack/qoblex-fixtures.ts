import { createHash } from 'node:crypto'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { DATASETS } from '../../lib/first-load/spec.ts'
import type { QoblexExport, QoblexLocation, QoblexLot, QoblexProduct, QoblexRead, QoblexSource } from '../../lib/reconciliation-pack/qoblex-source.ts'
import { scratchDir } from './helpers.ts'

/** The run these fixtures belong to: cycle date 2026-10-19, the clock of helpers.ts NOW (2026-10-20T12:00Z). */
export const ASOF = '2026-10-19'
export const EXPORTED_AT = '2026-10-20T08:00:00Z'

export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')

export type StockRow = { sku: string; location: string; qty: string; unitCost?: string; currency?: string; fx?: string; lot?: string }
export function stockCsv(rows: readonly StockRow[]): string {
  const header = DATASETS['stock-lots'].columns.join(',')
  const lines = rows.map((r) => [r.sku, r.location, r.qty, r.unitCost ?? '', r.currency ?? 'GBP', r.fx ?? '', '', r.lot ?? ''].join(','))
  return [header, ...lines].join('\r\n') + '\r\n'
}
export type ProductRow = { sku: string; type?: string }
export function productsCsv(rows: readonly ProductRow[]): string {
  const columns = DATASETS.products.columns
  const lines = rows.map((r) => columns.map((c) => (c === 'sku' ? r.sku : c === 'name' ? `Name ${r.sku}` : c === 'type' ? (r.type ?? 'SIMPLE') : '')).join(','))
  return [columns.join(','), ...lines].join('\r\n') + '\r\n'
}

export const LOCATIONS: QoblexLocation[] = [
  { code: 'MIL1', company: 'ACME', threePl: false },
  { code: 'CAMBRIDGE', company: 'ACME', threePl: false },
  { code: 'RXT2', company: 'ACME', threePl: true },
]

export type ExportOptions = {
  exportedAt?: string
  asOf?: string
  locations?: readonly QoblexLocation[]
  stock?: string | null
  products?: string | null
  /** Edits the manifest object before it is written (and its digests are computed). */
  patch?: (manifest: Record<string, unknown>) => void
  /** Files written besides the manifest (name -> text); a name given here replaces the standard one. */
  extra?: Record<string, string>
  manifestText?: string
}

export const DEFAULT_STOCK = stockCsv([
  { sku: 'SKU-1', location: 'MIL1', qty: '10', unitCost: '2.5' },
  { sku: 'SKU-2', location: 'CAMBRIDGE', qty: '4', unitCost: '10' },
  { sku: 'SKU-3', location: 'RXT2', qty: '7', unitCost: '1' },
])
export const DEFAULT_PRODUCTS = productsCsv([{ sku: 'SKU-1' }, { sku: 'SKU-2' }, { sku: 'SKU-3' }])

/** An export directory under /var/tmp (a root-owned sticky parent), with a manifest that declares the digest of every file it names. */
export function writeExport(bases: string[], options: ExportOptions = {}): string {
  const dir = scratchDir(bases, 'recon-qoblex-')
  const files: Record<string, string> = { ...(options.extra ?? {}) }
  const manifest: Record<string, unknown> = {
    formatVersion: 1,
    exportedAt: options.exportedAt ?? EXPORTED_AT,
    asOf: options.asOf ?? ASOF,
    baseCurrency: 'GBP',
    locations: (options.locations ?? LOCATIONS).map((l) => ({ ...l })),
  }
  if (options.stock !== null) { files['stock.csv'] ??= options.stock ?? DEFAULT_STOCK; manifest.stock = { file: 'stock.csv', sha256: sha256(files['stock.csv']!) } }
  if (options.products !== null) { files['products.csv'] ??= options.products ?? DEFAULT_PRODUCTS; manifest.products = { file: 'products.csv', sha256: sha256(files['products.csv']!) } }
  options.patch?.(manifest)
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text, { mode: 0o644 })
  writeFileSync(path.join(dir, 'manifest.json'), options.manifestText ?? JSON.stringify(manifest, null, 2), { mode: 0o644 })
  return dir
}

export function writeSubdir(dir: string, name: string): string {
  const sub = path.join(dir, name)
  mkdirSync(sub, { mode: 0o755 })
  return sub
}
export { symlinkSync }

/** A source that hands out a prepared export (no file): for the item tests. */
export function sourceOf(parts: { locations?: readonly QoblexLocation[]; stock?: QoblexLot[] | 'fail'; products?: QoblexProduct[] | 'fail' } | QoblexRead, counter?: { reads: number }): QoblexSource {
  return {
    async read() {
      if (counter) counter.reads += 1
      if ('ok' in parts) return parts
      const p = parts
      const value: QoblexExport = {
        exportedAt: EXPORTED_AT, asOf: ASOF, locations: [...(p.locations ?? LOCATIONS)], files: [],
        stock: p.stock === 'fail' ? { ok: false, reason: 'SOURCE_UNREADABLE' } : { ok: true, value: p.stock ?? [] },
        products: p.products === 'fail' ? { ok: false, reason: 'SOURCE_UNREADABLE' } : { ok: true, value: p.products ?? [] },
      }
      return { ok: true, value }
    },
  }
}
export const lot = (sku: string, location: string, qty: string, unitCost: string | null = '1', over: Partial<QoblexLot> = {}): QoblexLot => ({ sku, location, qty, unitCost, currency: 'GBP', fxRateToBase: '', lotRef: '', ...over })
