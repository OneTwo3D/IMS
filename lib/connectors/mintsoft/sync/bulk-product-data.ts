import { parseCsv } from '@/lib/csv'
import { toIsoCountryCode } from '@/lib/countries'
import { isDeclarableCn8, normalizeCn8 } from '@/lib/trade/cn-validate'
import { clampCustomsDescription } from '@/lib/trade/customs-description'

/**
 * THE BULK TRADE-DATA AND COUNTRY-OF-ORIGIN CSV TOOLS (o3d-zvec.20), PORTED FROM THE PLUGIN'S `force_mintsoft_trade_update.py` AND
 * `coo_push.py`. Pure: this file reads no database and makes no network call; scripts/mintsoft-bulk-product-data.ts feeds it.
 *
 * DRY-RUN BY DEFAULT. A plan is only a comparison. The CSV is compared with what IMS holds and with the Mintsoft record IMS last
 * stored (the product link's saved read), so the comparison needs no call to Mintsoft.
 *
 * WHAT "APPLY" MEANS HERE. IMS is the master of product data, so applying writes the validated values onto the IMS product (a
 * compare-and-set per product), and the ordinary product sync then carries them to Mintsoft through its one guarded writer (the
 * producer seam, the outbound-write hold, the payload hash). The tool has no path of its own to Mintsoft. Applying also requires
 * `mintsoft_product_parity_enabled`, so the tool cannot be run live by accident.
 *
 * VALIDATION is IMS's, not the plugin's: a commodity code must be a declarable 2026 CN8 (the plugin accepted any 8 or 10 digits; a
 * ten-digit TARIC code is reduced to its CN8 only when the CSV column is the ten-digit one), a country must be an assigned ISO-2
 * country (a name or alias is accepted and canonicalised), and a customs description is compared as it is clamped on send.
 */

export type BulkKind = 'trade' | 'coo'

export type BulkRow = {
  sku: string
  hsCode?: string
  customsDescription?: string
  countryOfOrigin?: string
}

export type BulkRejected = { line: number; sku: string; reason: string }

export type BulkParse = { rows: BulkRow[]; rejected: BulkRejected[] }

const digits = (value: string | undefined) => (value ?? '').replace(/\D+/g, '')

/** Trade CSV columns: SKU, customs description, and one of "EU 8 digit HS code", "new hs code", "EU 10 digit HS code". */
export function parseTradeCsv(text: string): BulkParse {
  const records = parseCsv(text)
  const header = new Set(Object.keys(records[0] ?? {}))
  for (const required of ['SKU', 'customs description']) {
    if (records.length > 0 && !header.has(required)) throw new Error(`CSV is missing required column: ${required}`)
  }
  if (records.length > 0 && !header.has('EU 8 digit HS code') && !header.has('new hs code') && !header.has('EU 10 digit HS code')) {
    throw new Error("CSV must contain 'EU 8 digit HS code', 'new hs code' or 'EU 10 digit HS code'")
  }
  const rows: BulkRow[] = []
  const rejected: BulkRejected[] = []
  const seen = new Set<string>()
  records.forEach((record, index) => {
    const line = index + 2
    const sku = (record.SKU ?? '').trim()
    if (!sku) return
    const eight = digits(record['EU 8 digit HS code']) || digits(record['new hs code'])
    const ten = digits(record['EU 10 digit HS code'])
    const hs = eight || (ten.length === 10 ? ten.slice(0, 8) : ten)
    const customsDescription = (record['customs description'] ?? '').trim()
    if (seen.has(sku)) { rejected.push({ line, sku, reason: 'duplicate SKU in the CSV; the first row is used' }); return }
    seen.add(sku)
    if (!hs || !customsDescription) { rejected.push({ line, sku, reason: 'missing HS code or customs description' }); return }
    if (!isDeclarableCn8(hs)) { rejected.push({ line, sku, reason: `HS code ${hs} is not a declarable 2026 CN8` }); return }
    rows.push({ sku, hsCode: normalizeCn8(hs), customsDescription })
  })
  return { rows, rejected }
}

/** COO CSV columns: SKU, coo (ISO-2, or a country name IMS recognises). */
export function parseCooCsv(text: string): BulkParse {
  const records = parseCsv(text)
  const header = new Set(Object.keys(records[0] ?? {}))
  for (const required of ['SKU', 'coo']) {
    if (records.length > 0 && !header.has(required)) throw new Error(`CSV is missing required column: ${required}`)
  }
  const rows: BulkRow[] = []
  const rejected: BulkRejected[] = []
  const seen = new Set<string>()
  records.forEach((record, index) => {
    const line = index + 2
    const sku = (record.SKU ?? '').trim()
    const raw = (record.coo ?? '').trim()
    if (!sku || !raw) return
    if (seen.has(sku)) { rejected.push({ line, sku, reason: 'duplicate SKU in the CSV; the first row is used' }); return }
    seen.add(sku)
    const iso = toIsoCountryCode(raw)
    if (!iso) { rejected.push({ line, sku, reason: `"${raw}" is not an assigned ISO 3166-1 country` }); return }
    rows.push({ sku, countryOfOrigin: iso })
  })
  return { rows, rejected }
}

/** What IMS holds for one product, and what Mintsoft's record (as IMS last stored it) holds. The stored record is optional. */
export type BulkProductState = {
  id: string
  sku: string
  hsCode: string | null
  customsDescription: string | null
  countryOfOrigin: string | null
  /** The product link's saved Mintsoft read, or null when the product has none. */
  stored: { commodityCode: string | null; customsDescription: string | null; countryOfManufacture: string | null } | null
}

export type BulkChange = { field: 'hsCode' | 'customsDescription' | 'countryOfOrigin'; from: string | null; to: string }

export type BulkPlanRow = {
  sku: string
  productId: string | null
  action: 'missing_in_ims' | 'unchanged' | 'would_update'
  changes: BulkChange[]
  /** Whether the stored Mintsoft record already carries the CSV's values (so a push would add nothing there). */
  storedMintsoftAlreadyMatches: boolean | null
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim()

export function planBulkChange(kind: BulkKind, rows: readonly BulkRow[], products: ReadonlyMap<string, BulkProductState>): BulkPlanRow[] {
  return rows.map((row) => {
    const product = products.get(row.sku)
    if (!product) return { sku: row.sku, productId: null, action: 'missing_in_ims', changes: [], storedMintsoftAlreadyMatches: null }
    const changes: BulkChange[] = []
    if (kind === 'trade') {
      if (!same(product.hsCode, row.hsCode)) changes.push({ field: 'hsCode', from: product.hsCode, to: row.hsCode! })
      // Compared as it is clamped on send; the full text is what is stored.
      if (!same(product.customsDescription, row.customsDescription)) changes.push({ field: 'customsDescription', from: product.customsDescription, to: row.customsDescription! })
    } else if (!same(product.countryOfOrigin, row.countryOfOrigin)) {
      changes.push({ field: 'countryOfOrigin', from: product.countryOfOrigin, to: row.countryOfOrigin! })
    }
    let storedMatches: boolean | null = null
    if (product.stored) {
      storedMatches = kind === 'trade'
        ? same(product.stored.commodityCode, row.hsCode) && same(clampCustomsDescription(product.stored.customsDescription), clampCustomsDescription(row.customsDescription))
        : same(product.stored.countryOfManufacture, row.countryOfOrigin)
    }
    return { sku: row.sku, productId: product.id, action: changes.length > 0 ? 'would_update' : 'unchanged', changes, storedMintsoftAlreadyMatches: storedMatches }
  })
}

export type BulkPlanSummary = Record<BulkPlanRow['action'] | 'rejected', number>

export function summariseBulkPlan(plan: readonly BulkPlanRow[], rejected: readonly BulkRejected[]): BulkPlanSummary {
  const summary: BulkPlanSummary = { missing_in_ims: 0, unchanged: 0, would_update: 0, rejected: rejected.length }
  for (const row of plan) summary[row.action] += 1
  return summary
}

/** The no-write report: one line per product that would change, then the totals. Contains no cost and no secret. */
export function renderBulkPlan(kind: BulkKind, plan: readonly BulkPlanRow[], rejected: readonly BulkRejected[], mode: 'dry-run' | 'apply'): string {
  const lines = [`Mintsoft bulk ${kind === 'trade' ? 'trade data' : 'country of origin'} (${mode})`]
  for (const row of plan) {
    if (row.action === 'unchanged') continue
    if (row.action === 'missing_in_ims') { lines.push(`  ${row.sku}: not an IMS product`); continue }
    const note = row.storedMintsoftAlreadyMatches === true ? ' [stored Mintsoft record already matches]' : ''
    lines.push(`  ${row.sku}: ${row.changes.map((c) => `${c.field} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join('; ')}${note}`)
  }
  for (const r of rejected) lines.push(`  line ${r.line} ${r.sku}: REJECTED ${r.reason}`)
  const summary = summariseBulkPlan(plan, rejected)
  lines.push(Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join('  '))
  return lines.join('\n')
}
