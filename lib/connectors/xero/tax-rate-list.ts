/**
 * THE XERO TAX-RATE LIST: strict validation of Xero's GET /TaxRates body, and the canonical form + digest that prove a stored
 * copy is one complete read. Pure: no database, no network, no clock. Xero is the tax-rate master (the owner ruling that put
 * `xero.tax-rate` under Xero), so a stored copy of its list is only worth having if it is exactly what Xero said.
 *
 *   - EVERY row is validated or the WHOLE body is refused. An unknown field, a field of the wrong type, a value that cannot be
 *     held exactly, a duplicate TaxType, an empty list or a body that is not the list at all makes the caller keep the previous
 *     list. Nothing is dropped, defaulted or coerced: a refused read is louder than a quietly shorter list.
 *   - The digest binds the rows to the organisation and is computed from the normalised rows in a fixed order and a fixed
 *     spelling (decimals as six-place text), so the writer and the reader of the stored rows reach the same value from the same
 *     data and from nothing else.
 */

import { createHash } from 'node:crypto'

export const XERO_TAX_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export const XERO_TAX_RATE_STATUSES = ['ACTIVE', 'DELETED', 'ARCHIVED', 'PENDING'] as const
export type XeroTaxRateStatus = (typeof XERO_TAX_RATE_STATUSES)[number]

/** Hard bound on the list. Xero holds tens of rates per organisation; a body past this is not a tax-rate list. */
export const XERO_TAX_RATE_LIST_MAX_ROWS = 2000

export type StoredTaxComponent = { name: string; rate: string; compound: boolean; nonRecoverable: boolean }
export type CanApplyFlags = { assets: boolean | null; equity: boolean | null; expenses: boolean | null; liabilities: boolean | null; revenue: boolean | null }
export type NormalisedXeroTaxRate = {
  taxType: string
  name: string
  status: XeroTaxRateStatus
  reportTaxType: string | null
  /** Six-place decimal text, or null when Xero did not say. */
  effectiveRate: string | null
  displayTaxRate: string | null
  components: StoredTaxComponent[]
  canApply: CanApplyFlags
}

export type ParsedTaxRateList = { ok: true; rows: NormalisedXeroTaxRate[] } | { ok: false; reason: string }

const ROW_KEYS = new Set(['Name', 'TaxType', 'Status', 'ReportTaxType', 'TaxComponents', 'DisplayTaxRate', 'EffectiveRate', 'CanApplyToAssets', 'CanApplyToEquity', 'CanApplyToExpenses', 'CanApplyToLiabilities', 'CanApplyToRevenue'])
const COMPONENT_KEYS = new Set(['Name', 'Rate', 'IsCompound', 'IsNonRecoverable'])
const BODY_KEYS = new Set(['Id', 'Status', 'ProviderName', 'DateTimeUTC', 'TaxRates'])
const MAX_RATE = 1000

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const cleanText = (value: unknown, max = 255): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)

/** A finite non-negative number that six decimal places hold exactly, as six-place text; null when it is not one. */
export function sixPlaceDecimal(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_RATE) return null
  const text = value.toFixed(6)
  return Number(text) === value ? text : null
}

class Refused extends Error {}
const refuse = (reason: string): never => { throw new Refused(reason) }

function optionalBoolean(row: Record<string, unknown>, key: string, where: string): boolean | null {
  if (!(key in row) || row[key] === undefined) return null
  if (typeof row[key] !== 'boolean') return refuse(`${where}: ${key} is not a boolean`)
  return row[key] as boolean
}
function optionalDecimal(row: Record<string, unknown>, key: string, where: string): string | null {
  if (!(key in row) || row[key] === undefined) return null
  const text = sixPlaceDecimal(row[key])
  return text === null ? refuse(`${where}: ${key} is not a rate held exactly`) : text
}

function parseRow(raw: unknown, index: number): NormalisedXeroTaxRate {
  const where = `row ${index}`
  if (!isPlainObject(raw)) return refuse(`${where}: not an object`)
  for (const key of Object.keys(raw)) if (!ROW_KEYS.has(key)) return refuse(`${where}: unknown field ${key.slice(0, 40)}`)
  if (typeof raw.TaxType !== 'string' || !XERO_TAX_TYPE_RE.test(raw.TaxType)) return refuse(`${where}: TaxType is not a tax type`)
  if (!cleanText(raw.Name)) return refuse(`${where}: Name is not a name`)
  if (typeof raw.Status !== 'string' || !(XERO_TAX_RATE_STATUSES as readonly string[]).includes(raw.Status)) return refuse(`${where}: Status is not a known status`)
  let reportTaxType: string | null = null
  if ('ReportTaxType' in raw && raw.ReportTaxType !== undefined) {
    if (!cleanText(raw.ReportTaxType, 64)) return refuse(`${where}: ReportTaxType is malformed`)
    reportTaxType = raw.ReportTaxType
  }
  if (!Array.isArray(raw.TaxComponents)) return refuse(`${where}: TaxComponents is not a list`)
  const components = raw.TaxComponents.map((component, c): StoredTaxComponent => {
    const at = `${where} component ${c}`
    if (!isPlainObject(component)) return refuse(`${at}: not an object`)
    for (const key of Object.keys(component)) if (!COMPONENT_KEYS.has(key)) return refuse(`${at}: unknown field ${key.slice(0, 40)}`)
    if (!cleanText(component.Name)) return refuse(`${at}: Name is not a name`)
    const rate = sixPlaceDecimal(component.Rate)
    if (rate === null) return refuse(`${at}: Rate is not a rate held exactly`)
    return { name: component.Name as string, rate, compound: optionalBoolean(component, 'IsCompound', at) === true, nonRecoverable: optionalBoolean(component, 'IsNonRecoverable', at) === true }
  })
  return {
    taxType: raw.TaxType,
    name: raw.Name,
    status: raw.Status as XeroTaxRateStatus,
    reportTaxType,
    effectiveRate: optionalDecimal(raw, 'EffectiveRate', where),
    displayTaxRate: optionalDecimal(raw, 'DisplayTaxRate', where),
    components,
    canApply: {
      assets: optionalBoolean(raw, 'CanApplyToAssets', where),
      equity: optionalBoolean(raw, 'CanApplyToEquity', where),
      expenses: optionalBoolean(raw, 'CanApplyToExpenses', where),
      liabilities: optionalBoolean(raw, 'CanApplyToLiabilities', where),
      revenue: optionalBoolean(raw, 'CanApplyToRevenue', where),
    },
  }
}

/**
 * Validate the whole body of GET /TaxRates. Total: never throws, and a refusal carries a short reason that names no value
 * from the body beyond a truncated field name.
 */
export function parseXeroTaxRateList(body: unknown): ParsedTaxRateList {
  try {
    if (!isPlainObject(body)) return { ok: false, reason: 'the body is not an object' }
    for (const key of Object.keys(body)) if (!BODY_KEYS.has(key)) return { ok: false, reason: `the body has an unknown field ${key.slice(0, 40)}` }
    if ('Status' in body && body.Status !== 'OK') return { ok: false, reason: 'the body status is not OK' }
    if (!Array.isArray(body.TaxRates)) return { ok: false, reason: 'the body has no TaxRates list' }
    if (body.TaxRates.length === 0) return { ok: false, reason: 'the TaxRates list is empty' }
    if (body.TaxRates.length > XERO_TAX_RATE_LIST_MAX_ROWS) return { ok: false, reason: 'the TaxRates list is longer than any real list' }
    const rows = body.TaxRates.map((raw, index) => parseRow(raw, index))
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.taxType)) return { ok: false, reason: 'the TaxRates list names a TaxType twice' }
      seen.add(row.taxType)
    }
    return { ok: true, rows }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.message }
    return { ok: false, reason: 'the body could not be read' }
  }
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The canonical, ordered form the digest is taken over. */
function canonicalRow(row: NormalisedXeroTaxRate): unknown[] {
  return [
    row.taxType, row.name, row.status, row.reportTaxType, row.effectiveRate, row.displayTaxRate,
    row.components.map((c) => [c.name, c.rate, c.compound, c.nonRecoverable]),
    [row.canApply.assets, row.canApply.equity, row.canApply.expenses, row.canApply.liabilities, row.canApply.revenue],
  ]
}

/** sha256 (hex) over the organisation and the rows in TaxType order. Equal digests mean equal tenants and equal rows. */
export function digestTaxRateList(tenantId: string, rows: readonly NormalisedXeroTaxRate[]): string {
  const ordered = [...rows].sort((a, b) => byCodePoint(a.taxType, b.taxType)).map(canonicalRow)
  return createHash('sha256').update(JSON.stringify(['xero-tax-rate-list/v1', tenantId, ordered])).digest('hex')
}

/** Re-validate a stored `components` value (JSONB read back). Null when it is not exactly the stored shape. */
export function readStoredComponents(value: unknown): StoredTaxComponent[] | null {
  if (!Array.isArray(value)) return null
  const out: StoredTaxComponent[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) return null
    const keys = Object.keys(entry)
    if (keys.length !== 4 || !['name', 'rate', 'compound', 'nonRecoverable'].every((k) => keys.includes(k))) return null
    if (typeof entry.name !== 'string' || typeof entry.rate !== 'string' || !/^[0-9]{1,4}\.[0-9]{6}$/.test(entry.rate) || typeof entry.compound !== 'boolean' || typeof entry.nonRecoverable !== 'boolean') return null
    out.push({ name: entry.name, rate: entry.rate, compound: entry.compound, nonRecoverable: entry.nonRecoverable })
  }
  return out
}
