import { toIsoCountryCode } from '@/lib/countries'
import { clampCustomsDescription } from '@/lib/trade/customs-description'

/**
 * Customs data on a WooCommerce product, read from the native REST v3 fields
 * (`customs_commodity_code`, `customs_country_of_origin`, `customs_description`) first.
 * Per field, when the native value is absent the older WC attribute is read instead, and a
 * description with no native or attribute value falls back to the `_customs_description_legacy`
 * product meta that holds the previous longer text while a shorter rewrite awaits approval.
 * A variation in view context already carries its parent's native value.
 */
export type WcCustomsSource = {
  attributes?: { name?: unknown; options?: unknown; option?: unknown }[] | null
  meta_data?: { key?: string; value?: unknown }[] | null
  customs_commodity_code?: unknown
  customs_country_of_origin?: unknown
  customs_description?: unknown
}

export type WcCustomsFields = {
  hsCode: string | null
  countryOfOrigin: string | null
  customsDescription: string | null
}

const LEGACY_DESCRIPTION_META_KEY = '_customs_description_legacy'

function trimmed(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function attributeValue(attrs: WcCustomsSource['attributes'], ...names: string[]): string | null {
  if (!Array.isArray(attrs)) return null
  const normalise = (s: string) => s.toLowerCase().replace(/[_\s]+/g, '')
  const targets = names.map(normalise)
  const attr = attrs.find((a) => {
    const name = trimmed(a?.name)
    return name ? targets.includes(normalise(name)) : false
  })
  if (!attr) return null
  // A product attribute carries `options` (array); a variation attribute carries `option` (singular).
  const candidates: unknown[] = [...(Array.isArray(attr.options) ? attr.options : []), attr.option]
  for (const candidate of candidates) {
    const value = trimmed(candidate)
    if (value) return value
  }
  return null
}

/** A customs value WooCommerce supplied that IMS cannot use (and therefore did not apply). */
export type WcRejectedCustomsValue = { field: keyof WcCustomsFields; value: string }

/**
 * The commodity code IMS can push: digits only, exactly 8 (the warehouse CN8 rule). WooCommerce
 * itself accepts 6-14 digits, so a shorter or longer native code is unusable here and must not
 * displace a valid IMS value. Separators (spaces, dots, dashes) are stripped; any other character
 * makes the value unusable.
 */
function normaliseCommodityCode(raw: string): string | null {
  const compact = raw.replace(/[\s.\-]+/g, '')
  return /^\d{8}$/.test(compact) ? compact : null
}

/**
 * First candidate that normalises to a usable value. A candidate that is present but unusable is
 * recorded as rejected and the next source is tried; when none is usable the field is null, i.e.
 * ABSENT, so the caller preserves the existing IMS value.
 */
function firstUsable(
  field: keyof WcCustomsFields,
  candidates: (string | null)[],
  normalise: (raw: string) => string | null,
  rejected: WcRejectedCustomsValue[],
): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    const usable = normalise(candidate)
    if (usable) return usable
    rejected.push({ field, value: candidate })
  }
  return null
}

export function extractWcCustomsFields(source: WcCustomsSource): WcCustomsFields & { rejected: WcRejectedCustomsValue[] } {
  const rejected: WcRejectedCustomsValue[] = []
  const hsCode = firstUsable(
    'hsCode',
    [trimmed(source.customs_commodity_code), attributeValue(source.attributes, 'hs_code', 'hs code', 'hscode')],
    normaliseCommodityCode,
    rejected,
  )
  const countryOfOrigin = firstUsable(
    'countryOfOrigin',
    [
      trimmed(source.customs_country_of_origin),
      attributeValue(source.attributes, 'country_of_origin', 'Country of Origin', 'coo'),
    ],
    (raw) => toIsoCountryCode(raw),
    rejected,
  )
  const legacy = Array.isArray(source.meta_data)
    ? trimmed(source.meta_data.find((m) => m?.key === LEGACY_DESCRIPTION_META_KEY)?.value)
    : null
  // Clamped on the way in so the stored value is always one WooCommerce and the warehouse accept
  // (a value that clamps to nothing, e.g. only rejected symbols, is unusable); null stays null so
  // "WC omitted it" keeps its meaning.
  const customsDescription = firstUsable(
    'customsDescription',
    [
      trimmed(source.customs_description),
      attributeValue(source.attributes, 'customs_description', 'customs description', 'customsdescription'),
      legacy,
    ],
    (raw) => clampCustomsDescription(raw) || null,
    rejected,
  )
  return { hsCode, countryOfOrigin, customsDescription, rejected }
}
