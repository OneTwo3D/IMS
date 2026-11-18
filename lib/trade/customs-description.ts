/**
 * Customs-description length ceiling: WooCommerce's native customs-description field
 * limit (35), stricter than the downstream WMS's own 50 ("Invalid Data!
 * CustomsDescription cannot exceed 50 characters!"). IMS never stores or pushes a
 * longer value, so anything it holds is acceptable to both. This mirrors the
 * hs-code-woo plugin's clamp so both classifiers enforce the same limit.
 */
export const CUSTOMS_DESCRIPTION_MAX = 35

/**
 * Characters WooCommerce's native customs-description validator rejects: angle brackets,
 * emoji / pictographs, and trademark-style symbols.
 */
const WC_REJECTED_CHARS = /[<>\p{Extended_Pictographic}\p{Emoji_Presentation}‍️™®©]/gu

/**
 * Clamp a customs description to {@link CUSTOMS_DESCRIPTION_MAX} characters,
 * breaking on a word boundary so a word is never cut mid-way. No ellipsis — a
 * customs description must read as a plain phrase. Drops characters WooCommerce's
 * validator rejects (`<`, `>`, emoji, symbols such as the trademark sign), collapses
 * internal whitespace and trims. Returns '' for nullish/blank input.
 */
export function clampCustomsDescription(desc: string | null | undefined): string {
  const normalized = (desc ?? '').replace(WC_REJECTED_CHARS, '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= CUSTOMS_DESCRIPTION_MAX) return normalized
  let cut = normalized.slice(0, CUSTOMS_DESCRIPTION_MAX)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace >= 15) cut = cut.slice(0, lastSpace) // keep a break only if it leaves real text
  return cut.replace(/[\s,;:-]+$/, '')
}

/** Words that carry no customs meaning on their own ("parts", "accessories", "spares", articles/prepositions). */
const CUSTOMS_STOP_WORDS = new Set([
  'a', 'an', 'the', 'for', 'of', 'and', 'or', 'with', 'to', 'in', 'on',
  'part', 'parts', 'accessory', 'accessories', 'spare', 'spares', 'item', 'items', 'product', 'products',
])

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/**
 * True when an AI-proposed customs description is unusable: blank, made only of stop words
 * ("parts", "accessories"), or brand-only — a single word that is just the leading word of the
 * product name (the brand position in a catalogue name). Deliberately conservative: a
 * single-word description equal to the first name word is rejected and the keyword rule used.
 */
export function isUnusableCustomsDescription(desc: string, productName: string): boolean {
  const meaningful = tokenize(desc).filter((t) => !CUSTOMS_STOP_WORDS.has(t))
  if (meaningful.length === 0) return true
  const nameTokens = tokenize(productName)
  if (nameTokens.length >= 2 && meaningful.length === 1 && meaningful[0] === nameTokens[0]) return true
  return false
}

/**
 * Pick the customs description to carry on a proposal record. An operator-set or Woo-ingested
 * value always wins — an AI description only fills a blank. Proposals never overwrite stored data.
 */
export function resolveProposedCustomsDescription(
  existing: string | null | undefined,
  ai: string | null | undefined,
): string | null {
  const current = (existing ?? '').trim()
  if (current) return existing as string
  const generated = clampCustomsDescription(ai)
  return generated || null
}
