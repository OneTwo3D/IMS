/**
 * TYPED CUSTOM-FIELD VALUES: parse, validate, normalise, format. Pure (no database, no framework), so every rule is unit-tested.
 *
 * Every value arrives as TEXT (a form input, a CSV cell, a URL parameter) and is parsed against the definition's type. A value that
 * does not parse is REFUSED with a sentence an operator can act on; nothing is rounded, truncated or guessed. A blank value means
 * "no value" (the caller deletes the row); it is never stored.
 *
 * The stored shape is one typed column per type (see CustomFieldValue in prisma/schema.prisma):
 *   STRING, LINK -> text      NUMBER, DECIMAL -> decimal (a canonical string, never a float)      BOOLEAN -> boolean
 *   DATE -> date (UTC midnight)      DATETIME -> UTC instant      JSON -> json
 */

export const CUSTOM_FIELD_ENTITIES = ['PRODUCT', 'SALES_ORDER'] as const
export type CustomFieldEntityName = (typeof CUSTOM_FIELD_ENTITIES)[number]

export const CUSTOM_FIELD_TYPES = ['STRING', 'NUMBER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'JSON', 'LINK'] as const
export type CustomFieldTypeName = (typeof CUSTOM_FIELD_TYPES)[number]

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldTypeName, string> = {
  STRING: 'Text',
  NUMBER: 'Whole number',
  DECIMAL: 'Decimal number',
  BOOLEAN: 'Yes / no',
  DATE: 'Date',
  DATETIME: 'Date and time (UTC)',
  JSON: 'JSON',
  LINK: 'Link (web address)',
}

export const CUSTOM_FIELD_TEXT_MAX = 2000
export const CUSTOM_FIELD_JSON_MAX = 20_000
export const CUSTOM_FIELD_OPTION_MAX = 100
export const CUSTOM_FIELD_OPTIONS_MAX_COUNT = 100
export const CUSTOM_FIELD_LABEL_MAX = 80
export const CUSTOM_FIELD_DEFINITIONS_MAX_PER_ENTITY = 100

/** The value of one field as stored, in whichever column its type uses. Exactly one member is set. */
export type StoredCustomFieldValue =
  | { valueText: string }
  | { valueDecimal: string }
  | { valueBoolean: boolean }
  | { valueDate: Date }
  | { valueDateTime: Date }
  | { valueJson: unknown }

/** The columns of a value row, as read back from the database. */
export type CustomFieldValueColumns = {
  valueText: string | null
  valueDecimal: { toString(): string } | null
  valueBoolean: boolean | null
  valueDate: Date | null
  valueDateTime: Date | null
  valueJson: unknown
}

export type CustomFieldDefinitionShape = {
  type: CustomFieldTypeName
  label: string
  options: readonly string[] | null
}

export type ParseResult =
  | { ok: true; blank: true }
  | { ok: true; blank: false; stored: StoredCustomFieldValue; text: string }
  | { ok: false; error: string }

const INTEGER = /^[+-]?\d{1,18}$/
const DECIMAL = /^[+-]?(\d{1,18})(?:\.(\d{1,10}))?$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/i

/** A canonical decimal string: no plus sign, no leading zeros, no trailing fractional zeros, "-0" is "0". */
function canonicalDecimal(sign: string, integer: string, fraction: string | undefined): string {
  const whole = integer.replace(/^0+(?=\d)/, '')
  const frac = (fraction ?? '').replace(/0+$/, '')
  const body = frac ? `${whole}.${frac}` : whole
  return sign === '-' && /[1-9]/.test(body) ? `-${body}` : body
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function parseDateTimeText(text: string): Date | null {
  const m = DATE_TIME.exec(text)
  if (!m) return null
  const [, y, mo, d, h, mi, s, ms, zone] = m
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = s ? Number(s) : 0
  if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null
  const millis = ms ? Number(ms.padEnd(3, '0')) : 0
  let offsetMinutes = 0
  if (zone && zone.toUpperCase() !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const oh = Number(zone.slice(1, 3)), om = Number(zone.slice(4, 6))
    if (oh > 23 || om > 59) return null
    offsetMinutes = sign * (oh * 60 + om)
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000)
}

function parseLink(text: string): string | null {
  if (/\s/.test(text)) return null
  let url: URL
  try { url = new URL(text) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return text
}

/** A CSV export neutralises a leading `=`, `+`, `-`, `@` with an apostrophe; the same text coming back is restored here. */
export function stripFormulaGuard(text: string): string {
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text
}

/**
 * Parse one text input against a definition. `text` is exactly what the operator typed or the cell held.
 * An option list, when the definition has one, is enforced for STRING.
 */
export function parseCustomFieldValue(def: CustomFieldDefinitionShape, rawText: string | null | undefined): ParseResult {
  const text = (rawText ?? '').trim()
  if (text === '') return { ok: true, blank: true }
  const fail = (reason: string): ParseResult => ({ ok: false, error: `${def.label}: ${reason}` })

  switch (def.type) {
    case 'STRING': {
      const value = stripFormulaGuard(text)
      if (value.length > CUSTOM_FIELD_TEXT_MAX) return fail(`must be ${CUSTOM_FIELD_TEXT_MAX} characters or fewer.`)
      if (def.options && def.options.length > 0 && !def.options.includes(value)) {
        return fail(`"${value}" is not one of the allowed choices (${def.options.join(', ')}).`)
      }
      return { ok: true, blank: false, stored: { valueText: value }, text: value }
    }
    case 'LINK': {
      if (text.length > CUSTOM_FIELD_TEXT_MAX) return fail(`must be ${CUSTOM_FIELD_TEXT_MAX} characters or fewer.`)
      const link = parseLink(text)
      if (!link) return fail('must be a web address starting with http:// or https://.')
      return { ok: true, blank: false, stored: { valueText: link }, text: link }
    }
    case 'NUMBER': {
      if (!INTEGER.test(text)) return fail('must be a whole number (digits only, no decimal point).')
      const canonical = canonicalDecimal(text.startsWith('-') ? '-' : '', text.replace(/^[+-]/, ''), undefined)
      return { ok: true, blank: false, stored: { valueDecimal: canonical }, text: canonical }
    }
    case 'DECIMAL': {
      const m = DECIMAL.exec(text)
      if (!m) return fail('must be a number with at most 18 digits before and 10 after the decimal point.')
      const canonical = canonicalDecimal(text.startsWith('-') ? '-' : '', m[1]!, m[2])
      return { ok: true, blank: false, stored: { valueDecimal: canonical }, text: canonical }
    }
    case 'BOOLEAN': {
      const lowered = text.toLowerCase()
      if (['true', 'yes', 'y', '1'].includes(lowered)) return { ok: true, blank: false, stored: { valueBoolean: true }, text: 'true' }
      if (['false', 'no', 'n', '0'].includes(lowered)) return { ok: true, blank: false, stored: { valueBoolean: false }, text: 'false' }
      return fail('must be yes or no (true or false).')
    }
    case 'DATE': {
      const m = DATE_ONLY.exec(text)
      if (!m || !validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return fail('must be a real date written YYYY-MM-DD.')
      return { ok: true, blank: false, stored: { valueDate: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) }, text }
    }
    case 'DATETIME': {
      const at = parseDateTimeText(text)
      if (!at) return fail('must be a real date and time such as 2026-11-18T09:30 (UTC unless it carries a Z or +hh:mm offset).')
      return { ok: true, blank: false, stored: { valueDateTime: at }, text: at.toISOString() }
    }
    case 'JSON': {
      if (text.length > CUSTOM_FIELD_JSON_MAX) return fail(`must be ${CUSTOM_FIELD_JSON_MAX} characters or fewer.`)
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return fail('must be valid JSON.') }
      if (parsed === null) return fail('must be valid JSON other than null (leave the field blank for no value).')
      return { ok: true, blank: false, stored: { valueJson: parsed }, text: JSON.stringify(parsed) }
    }
  }
}

/** Which value column a type uses. */
export function customFieldValueColumn(type: CustomFieldTypeName): 'valueText' | 'valueDecimal' | 'valueBoolean' | 'valueDate' | 'valueDateTime' | 'valueJson' {
  switch (type) {
    case 'STRING': case 'LINK': return 'valueText'
    case 'NUMBER': case 'DECIMAL': return 'valueDecimal'
    case 'BOOLEAN': return 'valueBoolean'
    case 'DATE': return 'valueDate'
    case 'DATETIME': return 'valueDateTime'
    case 'JSON': return 'valueJson'
  }
}

/** The empty row to write: every column null except the one the stored value fills (an update must clear the others). */
export function storedToColumns(stored: StoredCustomFieldValue): {
  valueText: string | null; valueDecimal: string | null; valueBoolean: boolean | null; valueDate: Date | null; valueDateTime: Date | null; valueJson: unknown | null
} {
  return {
    valueText: 'valueText' in stored ? stored.valueText : null,
    valueDecimal: 'valueDecimal' in stored ? stored.valueDecimal : null,
    valueBoolean: 'valueBoolean' in stored ? stored.valueBoolean : null,
    valueDate: 'valueDate' in stored ? stored.valueDate : null,
    valueDateTime: 'valueDateTime' in stored ? stored.valueDateTime : null,
    valueJson: 'valueJson' in stored ? stored.valueJson : null,
  }
}

/** The text form of a stored value, the exact form `parseCustomFieldValue` accepts back (forms, CSV export, filters). Null when the row holds nothing for its type. */
export function formatCustomFieldValue(type: CustomFieldTypeName, row: CustomFieldValueColumns): string | null {
  switch (type) {
    case 'STRING': case 'LINK': return row.valueText
    case 'NUMBER': case 'DECIMAL': return row.valueDecimal == null ? null : canonicalFromStored(row.valueDecimal.toString())
    case 'BOOLEAN': return row.valueBoolean == null ? null : row.valueBoolean ? 'true' : 'false'
    case 'DATE': return row.valueDate == null ? null : row.valueDate.toISOString().slice(0, 10)
    case 'DATETIME': return row.valueDateTime == null ? null : row.valueDateTime.toISOString()
    case 'JSON': return row.valueJson == null ? null : JSON.stringify(row.valueJson)
  }
}

function canonicalFromStored(text: string): string {
  const m = DECIMAL.exec(text)
  return m ? canonicalDecimal(text.startsWith('-') ? '-' : '', m[1]!, m[2]) : text
}

// ---------------------------------------------------------------------------
// Definition fields
// ---------------------------------------------------------------------------

export const CUSTOM_FIELD_SLUG = /^[a-z][a-z0-9_]{0,39}$/

export function validateCustomFieldSlug(kind: 'key' | 'namespace', value: string): string | null {
  if (!CUSTOM_FIELD_SLUG.test(value)) {
    return `The ${kind} must start with a lower-case letter and use only lower-case letters, digits and underscores (40 characters at most).`
  }
  return null
}

/** Trim, drop blanks, refuse duplicates and over-long choices. Returns the cleaned list, or an error. */
export function normaliseCustomFieldOptions(input: readonly string[] | null | undefined): { ok: true; options: string[] | null } | { ok: false; error: string } {
  if (!input) return { ok: true, options: null }
  const seen = new Set<string>()
  const options: string[] = []
  for (const raw of input) {
    const option = raw.trim()
    if (!option) continue
    if (option.length > CUSTOM_FIELD_OPTION_MAX) return { ok: false, error: `A choice must be ${CUSTOM_FIELD_OPTION_MAX} characters or fewer: "${option.slice(0, 20)}…"` }
    if (seen.has(option)) return { ok: false, error: `The choice "${option}" is listed twice.` }
    seen.add(option)
    options.push(option)
  }
  if (options.length > CUSTOM_FIELD_OPTIONS_MAX_COUNT) return { ok: false, error: `A field can have at most ${CUSTOM_FIELD_OPTIONS_MAX_COUNT} choices.` }
  return { ok: true, options: options.length > 0 ? options : null }
}

/** The options column is a JSON array of strings; anything else reads as no options. */
export function readCustomFieldOptions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const options = raw.filter((o): o is string => typeof o === 'string')
  return options.length > 0 ? options : null
}

/** The CSV column header for a field. */
export const CUSTOM_FIELD_CSV_PREFIX = 'cf:'
export const customFieldCsvHeader = (key: string): string => `${CUSTOM_FIELD_CSV_PREFIX}${key}`
