/**
 * EVERY FIELD OF AN ACCOUNTING PAYLOAD THAT NAMES A XERO TAX TYPE, found by name rather than listed, so a new document shape is covered by default.
 *
 * The senders read: line-level `taxType` (invoices, bills, credit notes, supplier credit notes, manual-journal lines), header-level `taxType` (supplier credit note), `shippingTaxType` and
 * `discountTaxType` (sales invoice / update, lib/connectors/xero/sync-processor.ts ~6119-6164, invoices.ts ~161-174), and the event mirror's copies of the same
 * (lib/domain/accounting/accounting-document-event-builder.ts ~87-158: lines[].taxType, the shipping and discount lines). A key counts when it is `taxType` or ends in `TaxType`,
 * except `reportTaxType` (a REPORT category such as OUTPUT, not a tax code). The TAX_RATE_SYNC payload defines rates rather than using them and is excluded by the callers.
 */
const TAX_CODE_KEY = /^(?:taxType|[A-Za-z]+TaxType)$/
const NOT_A_CODE_KEY = new Set(['reportTaxType', 'xeroReportTaxType'])
const MAX_DEPTH = 8

export function isTaxCodeKey(key: string): boolean {
  return TAX_CODE_KEY.test(key) && !NOT_A_CODE_KEY.has(key)
}

/** The distinct, non-empty tax codes carried anywhere in `payload` under a tax-code key. */
export function taxCodesInPayload(payload: unknown): string[] {
  const found = new Set<string>()
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string') { if (isTaxCodeKey(key) && child.trim() !== '') found.add(child.trim()) } else walk(child, depth + 1)
    }
  }
  walk(payload, 0)
  return [...found].sort()
}
