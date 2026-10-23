/**
 * THE XERO TAX-RATE LIST: strict validation of Xero's GET /TaxRates body, and the canonical form + digest that prove a stored
 * copy is one complete read. Pure: no database, no network, no clock. Xero is the tax-rate master (the owner ruling that put
 * `xero.tax-rate` under Xero), so a stored copy of its list is only worth having if it is exactly what Xero said.
 *
 *   - EVERY row is validated or the WHOLE body is refused. A known field of the wrong type, a missing required field, a value that
 *     cannot be held exactly, a duplicate TaxType, an empty list or a body that is not the list at all makes the caller keep the
 *     previous list. Nothing is defaulted or coerced: a refused read is louder than a quietly shorter list.
 *   - A key this module does not know (at body, row or component level) is IGNORED: not stored, not in the digest, and reported by
 *     NAME only in `ignored` so the caller can log it once per run. A case or punctuation variant of a KNOWN key ('taxtype',
 *     'Tax_Type') is not unknown, it is an alias that could shadow the real field, so it refuses the whole body.
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

/** Names (never values) of the keys that were ignored, by level, sorted, de-duplicated, bounded. */
export type IgnoredXeroKeys = { body: string[]; row: string[]; component: string[] }
export type ParsedTaxRateList = { ok: true; rows: NormalisedXeroTaxRate[]; ignored: IgnoredXeroKeys } | { ok: false; reason: string }

const ROW_KEYS = new Set(['Name', 'TaxType', 'Status', 'ReportTaxType', 'TaxComponents', 'DisplayTaxRate', 'EffectiveRate', 'CanApplyToAssets', 'CanApplyToEquity', 'CanApplyToExpenses', 'CanApplyToLiabilities', 'CanApplyToRevenue'])
const COMPONENT_KEYS = new Set(['Name', 'Rate', 'IsCompound', 'IsNonRecoverable'])
const BODY_KEYS = new Set(['Id', 'Status', 'ProviderName', 'DateTimeUTC', 'TaxRates'])
const MAX_RATE = 1000
const MAX_IGNORED_NAMES = 50

const squash = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '')
const KNOWN_SQUASHED = {
  body: new Map([...BODY_KEYS].map((key) => [squash(key), key] as const)),
  row: new Map([...ROW_KEYS].map((key) => [squash(key), key] as const)),
  component: new Map([...COMPONENT_KEYS].map((key) => [squash(key), key] as const)),
}
/** A printable, bounded rendering of a key NAME for a log line. */
const safeName = (key: string) => key.replace(/[^\x20-\x7e]/g, '?').slice(0, 40)

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

type Collector = { body: Set<string>; row: Set<string>; component: Set<string> }

/** Ignore an unknown key (recording its name); refuse a variant of a known one. */
function screenKeys(object: Record<string, unknown>, known: ReadonlySet<string>, level: keyof Collector, collector: Collector, where: string): void {
  for (const key of Object.keys(object)) {
    if (known.has(key)) continue
    if (KNOWN_SQUASHED[level].has(squash(key))) refuse(`${where}: ${safeName(key)} is a variant of a known field`)
    collector[level].add(safeName(key))
  }
}

function parseRow(raw: unknown, index: number, collector: Collector): NormalisedXeroTaxRate {
  const where = `row ${index}`
  if (!isPlainObject(raw)) return refuse(`${where}: not an object`)
  screenKeys(raw, ROW_KEYS, 'row', collector, where)
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
    screenKeys(component, COMPONENT_KEYS, 'component', collector, at)
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
    const collector: Collector = { body: new Set(), row: new Set(), component: new Set() }
    screenKeys(body, BODY_KEYS, 'body', collector, 'the body')
    if ('Status' in body && body.Status !== 'OK') return { ok: false, reason: 'the body status is not OK' }
    if (!Array.isArray(body.TaxRates)) return { ok: false, reason: 'the body has no TaxRates list' }
    if (body.TaxRates.length === 0) return { ok: false, reason: 'the TaxRates list is empty' }
    if (body.TaxRates.length > XERO_TAX_RATE_LIST_MAX_ROWS) return { ok: false, reason: 'the TaxRates list is longer than any real list' }
    const rows = body.TaxRates.map((raw, index) => parseRow(raw, index, collector))
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.taxType)) return { ok: false, reason: 'the TaxRates list names a TaxType twice' }
      seen.add(row.taxType)
    }
    const names = (set: Set<string>) => [...set].sort().slice(0, MAX_IGNORED_NAMES)
    return { ok: true, rows, ignored: { body: names(collector.body), row: names(collector.row), component: names(collector.component) } }
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
