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

/**
 * The binding of a tax-code field to the tax RATE the producer read the code from, carried as a sibling key in the same object (never read by a sender): `taxType` -> `taxRateId`,
 * `shippingTaxType` -> `shippingTaxRateId`, `discountTaxType` -> `discountTaxRateId`. The enqueue guard (lib/tax/retired-tax-code-guard.ts) uses it to check, under the lock, that the code
 * still IS that rate's code.
 */
export function bindingKeyFor(codeKey: string): string {
  return codeKey === 'taxType' ? 'taxRateId' : codeKey.replace(/TaxType$/, 'TaxRateId')
}

export type TaxCodeOccurrence = { code: string; taxRateId: string | null }

/** Every tax-code field of `payload` (one entry per occurrence, not per distinct code) with the rate id bound beside it, or null. */
export function taxCodeOccurrences(payload: unknown): TaxCodeOccurrence[] {
  const out: TaxCodeOccurrence[] = []
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
    const record = value as Record<string, unknown>
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === 'string') {
        if (isTaxCodeKey(key) && child.trim() !== '') {
          const bound = record[bindingKeyFor(key)]
          out.push({ code: child.trim(), taxRateId: typeof bound === 'string' && bound !== '' ? bound : null })
        }
      } else walk(child, depth + 1)
    }
  }
  walk(payload, 0)
  return out
}

/** Every rate id a payload binds (beside a tax-code field, or on its own), distinct. */
export function taxRateBindings(payload: unknown): string[] {
  const out = new Set<string>()
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string') { if ((key === 'taxRateId' || /^[a-z]+TaxRateId$/.test(key)) && child !== '') out.add(child) } else walk(child, depth + 1)
    }
  }
  walk(payload, 0)
  return [...out]
}

export type TaxRateBindingLine = { taxRateId: string; /** The tax type sent beside the binding (`taxType` for `taxRateId`, `shippingTaxType` for `shippingTaxRateId`), trimmed; null when the object carries none. */ code: string | null }

/** Every rate binding of `payload` with the tax type sent beside it, one entry per occurrence (a binding with no tax type beside it has code null). */
export function taxRateBindingLines(payload: unknown): TaxRateBindingLine[] {
  const out: TaxRateBindingLine[] = []
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
    const record = value as Record<string, unknown>
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === 'string') {
        if ((key === 'taxRateId' || /^[a-z]+TaxRateId$/.test(key)) && child !== '') {
          const typeKey = key === 'taxRateId' ? 'taxType' : key.replace(/TaxRateId$/, 'TaxType')
          const sent = record[typeKey]
          out.push({ taxRateId: child, code: typeof sent === 'string' && sent.trim() !== '' ? sent.trim() : null })
        }
      } else walk(child, depth + 1)
    }
  }
  walk(payload, 0)
  return out
}
