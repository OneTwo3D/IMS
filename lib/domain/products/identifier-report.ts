import { classifyIdentifierCodes } from './identifiers'

/**
 * READ-ONLY reclassification of the identifiers IMS already holds (o3d-mu0a). Pure: it takes rows and returns what
 * the GTIN/MPN split WOULD do, so the owner can review it. Nothing here, or in the script that calls it, writes data:
 * production gets no backfills.
 */

export type IdentifierReportInput = { sku: string; barcode: string | null; mpn: string | null }

export type IdentifierReportAction =
  /** barcode and mpn are already where the split would put them. */
  | 'unchanged'
  /** The barcode is not a GTIN and Product.mpn is empty: the value would move to mpn and barcode would clear. */
  | 'move_barcode_to_mpn'
  /** The barcode is not a GTIN but mpn already holds the same value: barcode would clear, mpn stays. */
  | 'clear_duplicate_barcode'
  /** barcode holds a part number and mpn holds the GTIN: the two would swap. */
  | 'swap'
  /** A third distinct code neither slot can take. Never guessed: a human decides. */
  | 'leftover'

export type IdentifierReportRow = IdentifierReportInput & {
  gtin: string
  newMpn: string
  leftover: string
  action: IdentifierReportAction
}

export type IdentifierReport = {
  scanned: number
  withIdentifiers: number
  counts: Record<IdentifierReportAction, number>
  /** Everything except 'unchanged', in input order. */
  rows: IdentifierReportRow[]
}

const blank = (value: string | null | undefined) => (value ?? '').trim()

export function classifyProductIdentifiers(input: IdentifierReportInput): IdentifierReportRow {
  const barcode = blank(input.barcode)
  const mpn = blank(input.mpn)
  const codes = classifyIdentifierCodes({ EAN: barcode, UPC: mpn })
  const base = { ...input, gtin: codes.gtin, newMpn: codes.mpn, leftover: codes.leftover }

  if (codes.leftover) return { ...base, action: 'leftover' }
  if (codes.gtin === barcode && codes.mpn === mpn) return { ...base, action: 'unchanged' }
  if (barcode && codes.gtin === mpn && codes.mpn === barcode && mpn) return { ...base, action: 'swap' }
  if (barcode && !codes.gtin && mpn && codes.mpn === mpn) return { ...base, action: 'clear_duplicate_barcode' }
  return { ...base, action: 'move_barcode_to_mpn' }
}

export function buildIdentifierReport(products: IdentifierReportInput[]): IdentifierReport {
  const counts: Record<IdentifierReportAction, number> = {
    unchanged: 0, move_barcode_to_mpn: 0, clear_duplicate_barcode: 0, swap: 0, leftover: 0,
  }
  const rows: IdentifierReportRow[] = []
  let withIdentifiers = 0
  for (const product of products) {
    if (!blank(product.barcode) && !blank(product.mpn)) continue
    withIdentifiers += 1
    const row = classifyProductIdentifiers(product)
    counts[row.action] += 1
    if (row.action !== 'unchanged') rows.push(row)
  }
  return { scanned: products.length, withIdentifiers, counts, rows }
}
