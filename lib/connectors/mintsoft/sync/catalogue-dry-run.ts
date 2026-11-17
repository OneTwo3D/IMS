import { buildMintsoftProductUpsertRequest } from '../api/client'
import { classifyIdentifierCodes } from '@/lib/domain/products/identifiers'
import {
  buildMintsoftProductDto,
  hashMintsoftProductDto,
  resolveMintsoftCommodityCode,
  type ProductSyncCandidate,
} from './product-sync'
import { applyMintsoftProductParity } from './product-parity'

/**
 * THE CATALOGUE DRY RUN (o3d-zvec.20): what IMS WOULD send for each product, diffed against the Mintsoft record IMS last stored.
 *
 * NO WRITE and NO NETWORK CALL. It reads IMS products and the saved Mintsoft read on each product link (`WmsProductLink.metadata`),
 * builds the DTO exactly as the sync does (today's setting values, and again with the parity behaviour on), serialises it through the
 * real request builder, and compares field by field. It is the "no unexpected diffs" check before the owner turns parity on.
 *
 * COST IS BUSINESS-SENSITIVE: a cost difference is reported as "differs" and the figures are shown only when `showCost` is asked for.
 */

export type DryRunInput = {
  product: ProductSyncCandidate
  /** The saved Mintsoft read on the product's link (`WmsProductLink.metadata`), or null when it has none. */
  storedRecord: unknown
  /** The IMS unit cost the parity sync would send, or null. Read by the caller. */
  costPrice: number | null
}

export type DryRunOptions = {
  /** The identifier-split setting, as stored. */
  split: boolean
  showCost?: boolean
}

export type FieldDiff = { field: string; ims: string; stored: string }

export type DryRunProductResult = {
  sku: string
  hasStoredRecord: boolean
  /** Does today's payload hash equal the stored one (i.e. would the sync send nothing)? */
  todayMatchesStoredHash: boolean
  todayDiffs: FieldDiff[]
  parityDiffs: FieldDiff[]
  /** Fields the parity behaviour would change relative to what IMS sends today. */
  parityChangesVsToday: string[]
}

const FIELDS = ['Name', 'CustomsDescription', 'EAN', 'UPC', 'Weight', 'Height', 'Width', 'Depth', 'ImageURL', 'CommodityCode', 'CountryOfManufacture', 'CostPrice'] as const

function wireValue(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (value == null) return ''
  if (typeof value === 'object') return String((value as Record<string, unknown>).Code ?? '')
  if (typeof value === 'number') return String(value)
  return String(value).trim()
}

function sendBody(product: ProductSyncCandidate, cost: number | null, parity: boolean, split: boolean): { body: Record<string, unknown>; hash: string } {
  let dto = buildMintsoftProductDto(product)
  const { commodityCode } = resolveMintsoftCommodityCode(dto.commodityCode)
  if (commodityCode !== dto.commodityCode) dto = { ...dto, commodityCode }
  if (parity) dto = applyMintsoftProductParity(dto, product, cost)
  if (split) {
    const codes = classifyIdentifierCodes({ EAN: product.barcode, UPC: product.mpn })
    dto = { ...dto, barcode: codes.gtin || null, mpn: codes.mpn || null }
  }
  const request = buildMintsoftProductUpsertRequest(dto, { externalProductId: product.wmsProductLinks[0]?.externalProductId, omitBarcode: false, omitMpn: false })
  return { body: JSON.parse(request.body) as Record<string, unknown>, hash: hashMintsoftProductDto(dto) }
}

function diff(body: Record<string, unknown>, stored: Record<string, unknown> | null, showCost: boolean): FieldDiff[] {
  const diffs: FieldDiff[] = []
  for (const field of FIELDS) {
    if (!(field in body) && !(stored && wireValue(stored, field))) continue
    const ims = wireValue(body, field)
    const theirs = stored ? wireValue(stored, field) : ''
    // Numbers compare as numbers (Mintsoft echoes 1.50 and IMS sends 1.5).
    const equal = ims === theirs || (ims !== '' && theirs !== '' && Number.isFinite(Number(ims)) && Number(ims) === Number(theirs))
    if (equal) continue
    // A field IMS does not send is not a diff: IMS leaves it alone.
    if (!(field in body)) continue
    diffs.push(field === 'CostPrice' && !showCost ? { field, ims: '(hidden)', stored: '(hidden)' } : { field, ims, stored: theirs })
  }
  return diffs
}

export function compareProductToStored(input: DryRunInput, options: DryRunOptions): DryRunProductResult {
  const { product, costPrice } = input
  const link = product.wmsProductLinks[0] ?? null
  const stored = input.storedRecord && typeof input.storedRecord === 'object' && !Array.isArray(input.storedRecord) ? input.storedRecord as Record<string, unknown> : null
  const today = sendBody(product, costPrice, false, options.split)
  const parity = sendBody(product, costPrice, true, options.split)
  const parityChangesVsToday = FIELDS.filter((field) => JSON.stringify(today.body[field] ?? null) !== JSON.stringify(parity.body[field] ?? null)).map(String)
  return {
    sku: product.sku,
    hasStoredRecord: stored != null,
    todayMatchesStoredHash: Boolean(link?.payloadHash && link.payloadHash === today.hash),
    todayDiffs: diff(today.body, stored, Boolean(options.showCost)),
    parityDiffs: diff(parity.body, stored, Boolean(options.showCost)),
    parityChangesVsToday,
  }
}

export type DryRunSummary = {
  products: number
  withoutStoredRecord: number
  todayMatchesStoredHash: number
  todayWithFieldDiffs: number
  parityWithFieldDiffs: number
  parityChangesPayload: number
  byField: Record<string, number>
}

export function summariseDryRun(results: readonly DryRunProductResult[]): DryRunSummary {
  const byField: Record<string, number> = {}
  for (const result of results) for (const field of result.parityChangesVsToday) byField[field] = (byField[field] ?? 0) + 1
  return {
    products: results.length,
    withoutStoredRecord: results.filter((r) => !r.hasStoredRecord).length,
    todayMatchesStoredHash: results.filter((r) => r.todayMatchesStoredHash).length,
    todayWithFieldDiffs: results.filter((r) => r.todayDiffs.length > 0).length,
    parityWithFieldDiffs: results.filter((r) => r.parityDiffs.length > 0).length,
    parityChangesPayload: results.filter((r) => r.parityChangesVsToday.length > 0).length,
    byField,
  }
}

export function renderDryRun(results: readonly DryRunProductResult[], options: { maxLines?: number } = {}): string {
  const summary = summariseDryRun(results)
  const lines = ['Mintsoft catalogue dry run (no write, no network call)']
  lines.push(`  products: ${summary.products}  without a stored Mintsoft record: ${summary.withoutStoredRecord}`)
  lines.push(`  today's payload hash equals the stored one: ${summary.todayMatchesStoredHash}`)
  lines.push(`  differ from the stored record, as sent today: ${summary.todayWithFieldDiffs}; with parity on: ${summary.parityWithFieldDiffs}`)
  lines.push(`  parity would change the payload of: ${summary.parityChangesPayload} ${JSON.stringify(summary.byField)}`)
  let shown = 0
  for (const result of results) {
    if (result.parityDiffs.length === 0) continue
    if (options.maxLines && shown >= options.maxLines) { lines.push('  ...'); break }
    shown += 1
    lines.push(`  ${result.sku}: ${result.parityDiffs.map((d) => `${d.field} stored=${JSON.stringify(d.stored)} ims=${JSON.stringify(d.ims)}`).join('; ')}`)
  }
  lines.push('Nothing was written and nothing was sent.')
  return lines.join('\n')
}
