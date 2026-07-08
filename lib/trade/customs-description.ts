/**
 * Customs-description length ceiling.
 *
 * The downstream WMS rejects a product create/update whose customs description
 * exceeds 50 characters ("Invalid Data! CustomsDescription cannot exceed 50
 * characters!"), so IMS never stores or pushes a longer value. This mirrors the
 * hs-code-woo plugin's clamp (includes/classifier-core.php
 * `clamp_customs_description`) so both classifiers enforce the same limit.
 */
export const CUSTOMS_DESCRIPTION_MAX = 50

/**
 * Clamp a customs description to {@link CUSTOMS_DESCRIPTION_MAX} characters,
 * breaking on a word boundary so a word is never cut mid-way. No ellipsis — a
 * customs description must read as a plain phrase. Collapses internal
 * whitespace and trims. Returns '' for nullish/blank input.
 */
export function clampCustomsDescription(desc: string | null | undefined): string {
  const normalized = (desc ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= CUSTOMS_DESCRIPTION_MAX) return normalized
  let cut = normalized.slice(0, CUSTOMS_DESCRIPTION_MAX)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace >= 20) cut = cut.slice(0, lastSpace) // keep a break only if it leaves real text
  return cut.replace(/[\s,;:-]+$/, '')
}
