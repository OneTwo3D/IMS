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
  attributes?: { name?: unknown; options?: unknown }[] | null
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
  if (!attr || !Array.isArray(attr.options)) return null
  for (const option of attr.options) {
    const value = trimmed(option)
    if (value) return value
  }
  return null
}

export function extractWcCustomsFields(source: WcCustomsSource): WcCustomsFields {
  const hsCode =
    trimmed(source.customs_commodity_code) ?? attributeValue(source.attributes, 'hs_code', 'hs code', 'hscode')
  const origin =
    trimmed(source.customs_country_of_origin) ??
    attributeValue(source.attributes, 'country_of_origin', 'Country of Origin', 'coo')
  const legacy = Array.isArray(source.meta_data)
    ? trimmed(source.meta_data.find((m) => m?.key === LEGACY_DESCRIPTION_META_KEY)?.value)
    : null
  const descriptionRaw =
    trimmed(source.customs_description) ??
    attributeValue(source.attributes, 'customs_description', 'customs description', 'customsdescription') ??
    legacy
  // Clamped on the way in so the stored value is always one WooCommerce and the warehouse accept;
  // null stays null so "WC omitted it" keeps its meaning.
  const customsDescription = descriptionRaw ? clampCustomsDescription(descriptionRaw) : descriptionRaw
  return { hsCode, countryOfOrigin: toIsoCountryCode(origin), customsDescription }
}
