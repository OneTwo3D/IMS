/**
 * The PURE half of the product-category helpers: cleaning, normalising and path-splitting a category name.
 *
 * Split out of categories.ts, which imports the database client, so that code that must stay free of a database
 * (the first-load tool and apply runner normalise category names the way the product importer does) can share the
 * one implementation instead of copying it. categories.ts re-exports everything here, so existing imports are unchanged.
 */

const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g
const DIACRITICS = /\p{Diacritic}/gu

export const PRODUCT_CATEGORY_NAME_MAX_LENGTH = 100
export const PRODUCT_CATEGORY_PATH_DELIMITER = '>'
export const PRODUCT_CATEGORY_PATH_DISPLAY_SEPARATOR = ' > '

export function normalizeProductCategoryName(value: string): string {
  return cleanProductCategoryName(value)
    ?.normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLocaleLowerCase('en-US') ?? ''
}

// The minimal named entities WooCommerce category names actually carry. Numeric
// entities (&#038; &#8217; …) are handled generically below, so this set only
// needs the named forms that have no numeric equivalent in practice.
const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/**
 * Decode HTML entities (named + numeric decimal/hex) in a string. WooCommerce
 * returns category/product names HTML-encoded (e.g. "Tool Changers &amp; Multi
 * Material", "&#038;", "&#8217;"), which otherwise get stored and displayed
 * literally. Unknown named entities are left untouched, and a bare "&" (e.g.
 * "R&D", "Salt & Pepper") is preserved because it doesn't match an entity
 * pattern — so decoding is safe to run on already-clean text (idempotent).
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    return NAMED_HTML_ENTITIES[body.toLowerCase()] ?? match
  })
}

export function cleanProductCategoryName(value: string | null | undefined): string | null {
  if (value == null) return null
  const cleaned = decodeHtmlEntities(value)
    .normalize('NFKC')
    .replace(ZERO_WIDTH_CHARS, '')
    .replace(CONTROL_CHARS, ' ')
    .trim()
    .replace(/\s+/g, ' ')
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Split a user-supplied path string like "Apparel > T-Shirts > V-Neck" into
 * cleaned segments. Empty segments are dropped, so "Apparel >> T-Shirts" still
 * yields a 2-segment path. Trims surrounding whitespace and collapses runs.
 */
export function parseProductCategoryPath(input: string | null | undefined): string[] {
  if (!input) return []
  return input
    .split(PRODUCT_CATEGORY_PATH_DELIMITER)
    .map((segment) => cleanProductCategoryName(segment))
    .filter((segment): segment is string => segment !== null && segment.length > 0)
}

/**
 * Build the stored `nameNormalized` for a given sequence of cleaned segments
 * (parent-most first). This is the database identity for a category: two leaves
 * under different parents normalize to different strings so they coexist.
 */
export function buildProductCategoryPathNormalized(cleanedSegments: readonly string[]): string {
  return cleanedSegments
    .map((segment) => normalizeProductCategoryName(segment))
    .join(PRODUCT_CATEGORY_PATH_DELIMITER)
}
