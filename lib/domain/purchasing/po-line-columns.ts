// Optional Order Lines columns on the purchase-order detail page. The choice is kept per browser in localStorage
// (the same approach as the purchase-order list's column picker); nothing is stored on the server.

export type PoLineOptionalCol = 'barcode' | 'supplierSku'

export const PO_LINE_OPTIONAL_COLS: ReadonlyArray<{ key: PoLineOptionalCol; label: string }> = [
  { key: 'barcode', label: 'Barcode' },
  { key: 'supplierSku', label: 'Supplier SKU' },
]

export const PO_LINE_COLS_STORAGE_KEY = 'po-detail-cols'
export const PO_LINE_COLS_DEFAULT: PoLineOptionalCol[] = ['barcode', 'supplierSku']

/** Reads the stored choice. Anything unreadable falls back to the default; an empty list is a valid choice (both hidden). */
export function parsePoLineCols(raw: string | null | undefined): PoLineOptionalCol[] {
  if (raw == null) return PO_LINE_COLS_DEFAULT
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return PO_LINE_COLS_DEFAULT
    const valid = PO_LINE_OPTIONAL_COLS.map((c) => c.key)
    return valid.filter((k) => parsed.includes(k))
  } catch {
    return PO_LINE_COLS_DEFAULT
  }
}
