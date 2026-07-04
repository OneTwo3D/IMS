/**
 * Deterministic HS/CN confidence scoring (6igm.2) — IMS port of the hs-code-woo plugin's
 * hs-validate-core.php `validate()`. Given a proposed CN code plus the product's customs
 * description / name / category, it produces a transparent 0-100 confidence, a band
 * (high/medium/low), and a set of flags explaining what the score reflects.
 *
 * This is the AUTHORITATIVE confidence used by the approval queue (6igm.3), never the model's
 * self-reported confidence (6igm.1) — the model can be over-confident. The write-blocking flags
 * (invalid_format / not_in_2026 / superseded) are the codes an approval must never commit.
 *
 * Reuses the 2026 CN reference from cn-validate (bhdm.3): isCurrentCn8 for status, normalizeCn8
 * for the digits, isDeclarableCn8 for the strict authoritative gate.
 */
import { isCurrentCn8, isDeclarableCn8, normalizeCn8 } from '@/lib/trade/cn-validate'

export type HsBand = 'high' | 'medium' | 'low'

/** Residual "Other" 6-digit subheadings where dissimilar products get over-consolidated. */
export const PARTS_BASKET_PREFIXES = ['848590', '848490', '732690', '392690', '761699']

/** Product-name keyword → the heading it really belongs in (Section XVI Note 2). */
export const OWN_HEADING_KEYWORDS: Record<string, string> = {
  motor: '8501',
  fan: '8414',
  pcb: '8534',
  'control board': '8537',
  sensor: '8543',
  bearing: '8482',
  screw: '7318',
  bolt: '7318',
  'ptfe tube': '3917',
  filament: '3916',
  belt: '4010',
}

/** Brand / proper-noun tokens that must not stand alone as a customs description. */
export const BRAND_WORDS = [
  'ldo', 'voron', 'linneo', 'linneoflon', 'vitalii3d', 'misumi', 'phaetus', 'bondtech',
  'e3d', 'nevermore', 'bigtreetech', 'btt', 'biqu', 'onetwo3d', 'polymaker', 'fysetc',
  'mandala', 'roseworks', 'igus', 'trianglelab', 'mellow', 'chaoticlab', 'siboor',
  'formbot', 'sovol', 'bambu', 'prusa', 'jst', 'molex',
]

/** Banned standalone tokens for the description check. */
export const STOP_WORDS = [
  'parts', 'part', 'accessory', 'accessories', 'spares', 'spare',
  'misc', 'miscellaneous', 'other', 'assorted', 'various', 'etc',
]

/** Category-path substring → expected 4-digit heading(s). */
export const DEFAULT_CATEGORY_MAP: Record<string, string[]> = {
  'stepper motor': ['8501'],
  'controller board': ['8537', '8542'],
  'wiring harness': ['8544'],
  'heater pad': ['8516'],
  'air filtration': ['8421'],
  '3d printer kit': ['8485'],
  'full kit': ['8485'],
  'printed part': ['3926'],
  fastener: ['7318'],
  stepper: ['8501'],
  nozzle: ['8487'],
  hotend: ['8419', '8516'],
  pcb: ['8534'],
  fan: ['8414'],
  connector: ['8536'],
  harness: ['8544'],
  cable: ['8544'],
  display: ['8531', '9013'],
  probe: ['9031', '8536'],
  hepa: ['8421'],
  frame: ['7604'],
  filament: ['3916'],
  belt: ['4010'],
  bearing: ['8482'],
  motor: ['8501'],
}

/** Flags that must BLOCK an authoritative write, even under operator override (a non-declarable code). */
export const WRITE_BLOCKING_FLAGS = ['invalid_format', 'not_in_2026', 'superseded'] as const

export type HsValidationRow = {
  cnCode?: string | null
  customsDescription?: string | null
  name?: string | null
  /** Richer text (title + description + attributes) for the parts-basket keyword check; falls back to name. */
  text?: string | null
  categoryPath?: string | null
}

export type HsValidationConfig = {
  categoryMap?: Record<string, string[]>
  partsBasketPrefixes?: string[]
  ownHeadingKeywords?: Record<string, string>
  stopWords?: string[]
  brandWords?: string[]
  /** CN-reference status lookup; defaults to the production 2026 list (current if present, else
   *  absent — production has no superseded codes). Injectable so the cross-language contract
   *  fixtures (which use a sample reference table with a superseded code) can be verified. */
  codeStatus?: (code: string) => HsCodeStatus
}

export type HsCodeStatus = 'current' | 'superseded' | 'absent'

export type HsValidation = {
  confidence: number
  band: HsBand
  flags: string[]
  notes: string
  /**
   * Subset of flags that block an authoritative write. NOTE: this is LENIENT (first-8) by design,
   * matching the plugin — an overlong raw code (e.g. "8501109900") is truncated before the format
   * check and can score with NO blocking flags. An approval gate (6igm.3) must ALSO require
   * `declarable === true` (the strict exact-8 gate) before committing — do not rely on
   * writeBlockingFlags alone. Safe-to-write == declarable && writeBlockingFlags.length === 0.
   */
  writeBlockingFlags: string[]
  /** Strict isDeclarableCn8 on the RAW code (exactly 8 digits AND in the 2026 list). */
  declarable: boolean
  /** The canonical first-8-digit code that was scored — what an approval should persist. */
  normalizedCode: string | null
}

const str = (value: string | null | undefined): string => (typeof value === 'string' ? value : '')

/**
 * ASCII-only lowercasing — folds A-Z only, leaving every other character untouched. JS's
 * String.toLowerCase() is Unicode-aware (e.g. it folds the Kelvin sign U+212A to "k"), which
 * would tokenise differently from the PHP/Python validators (byte-level strtolower). Matching
 * ASCII-only keeps this port behaviourally identical to the cross-language contract.
 */
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** ^\d{8}$ against the first-8-digits form (mirrors the plugin's lenient is_valid_format). */
function isValidFormat(normalizedCode: string): boolean {
  return /^\d{8}$/.test(normalizedCode)
}

function tokens(text: string): string[] {
  return asciiLower(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

/** Description has ≥2 tokens and no standalone stop word. */
export function descriptionPasses(desc: string, stopWords: string[] = STOP_WORDS): boolean {
  const trimmed = desc.trim()
  if (trimmed === '') return false
  const toks = tokens(trimmed)
  if (toks.length < 2) return false
  const stops = new Set(stopWords)
  return !toks.some((t) => stops.has(t))
}

/** Description is made up ONLY of brand tokens (+ numbers / stop words) — brand-only, non-declarable in substance. */
export function descriptionIsBrandOnly(
  desc: string,
  brandWords: string[] = BRAND_WORDS,
  stopWords: string[] = STOP_WORDS,
): boolean {
  const toks = tokens(desc.trim())
  if (toks.length === 0) return false
  const brands = new Set(brandWords)
  const stops = new Set(stopWords)
  let hasBrand = false
  for (const t of toks) {
    if (/^\d+$/.test(t) || stops.has(t)) continue // numbers and stop words don't count either way
    if (brands.has(t)) {
      hasBrand = true
      continue
    }
    return false // a real, non-brand article word — not brand-only
  }
  return hasBrand
}

export function isPartsBasket(code: string, prefixes: string[] = PARTS_BASKET_PREFIXES): boolean {
  const six = normalizeCn8(code).slice(0, 6)
  return six !== '' && prefixes.includes(six)
}

export function nameMatchesOwnHeading(name: string, keywords: Record<string, string> = OWN_HEADING_KEYWORDS): boolean {
  const hay = asciiLower(name)
  return Object.keys(keywords).some((kw) => kw !== '' && hay.includes(kw))
}

export function expectedFamily(categoryPath: string, categoryMap: Record<string, string[]>): string[] | null {
  const hay = asciiLower(categoryPath)
  for (const [needle, headings] of Object.entries(categoryMap)) {
    if (needle !== '' && hay.includes(asciiLower(needle))) return headings
  }
  return null
}

export function bandFor(score: number): HsBand {
  if (score >= 85) return 'high'
  if (score >= 60) return 'medium'
  return 'low'
}

/** Subset of `flags` that block an authoritative write. */
export function writeBlockingFlags(flags: string[]): string[] {
  const blocking = new Set<string>(WRITE_BLOCKING_FLAGS)
  return flags.filter((f) => blocking.has(f))
}

/**
 * Fail-closed approval gate (6igm.3): an HS-code validation may be committed to a product only if
 * the code is strictly declarable (exactly-8 + in the 2026 list) AND carries no write-blocking
 * flag. Advisory flags (category_mismatch, description_problem) are the operator's call and never
 * block. Both conditions are required — writeBlockingFlags alone is lenient (see HsValidation).
 */
export function isApprovableHsValidation(validation: HsValidation): boolean {
  return validation.declarable && validation.writeBlockingFlags.length === 0
}

/**
 * Full validation + transparent confidence score. Faithful port of the plugin's validate():
 * code presence/status, category plausibility, description quality, and parts-basket specificity,
 * clamped to 0-100 and banded. See hs-code-woo SPEC.md.
 */
export function validateHsCode(row: HsValidationRow, config: HsValidationConfig = {}): HsValidation {
  const categoryMap = config.categoryMap ?? DEFAULT_CATEGORY_MAP
  const basket = config.partsBasketPrefixes ?? PARTS_BASKET_PREFIXES
  const own = config.ownHeadingKeywords ?? OWN_HEADING_KEYWORDS
  const stopWords = config.stopWords ?? STOP_WORDS
  const brandWords = config.brandWords ?? BRAND_WORDS
  const codeStatus = config.codeStatus ?? ((c: string): HsCodeStatus => (isCurrentCn8(c) ? 'current' : 'absent'))

  const rawCode = str(row.cnCode)
  const code = normalizeCn8(rawCode)
  const desc = str(row.customsDescription)
  const name = str(row.name)
  const cat = str(row.categoryPath)
  const matchText = str(row.text) || name

  let score = 0
  const flags: string[] = []

  // 1. Code presence & status.
  const hasCode = code !== ''
  if (!hasCode) {
    flags.push('missing_code')
    score -= 60
  } else {
    if (!isValidFormat(code)) flags.push('invalid_format')
    switch (codeStatus(code)) {
      case 'current':
        score += 60
        break
      case 'superseded':
        flags.push('superseded')
        score += 35 // was valid (60) minus the -25 superseded penalty
        break
      default:
        flags.push('not_in_2026')
        score -= 40
    }
  }

  // 2. Category plausibility.
  if (hasCode) {
    const family = expectedFamily(cat, categoryMap)
    if (family !== null) {
      const heading = code.slice(0, 4)
      if (family.includes(heading)) {
        score += 20
      } else {
        flags.push('category_mismatch')
        score -= 20
      }
    }
  }

  // 3. Description.
  if (descriptionIsBrandOnly(desc, brandWords, stopWords)) {
    flags.push('brand_only_description')
    score -= 15
  } else if (descriptionPasses(desc, stopWords)) {
    score += 15
  } else {
    flags.push('description_problem')
    score -= 15
  }

  // 4. Specificity / parts-basket.
  if (hasCode) {
    if (isPartsBasket(code, basket)) {
      if (nameMatchesOwnHeading(matchText, own)) {
        flags.push('parts_basket_own_heading')
        score -= 30
      }
    } else {
      score += 5
    }
  }

  // 5. Clamp + band.
  score = Math.max(0, Math.min(100, score))

  return {
    confidence: score,
    band: bandFor(score),
    flags,
    notes: flags.length === 0 ? 'no automated red flag' : flags.join('; '),
    writeBlockingFlags: writeBlockingFlags(flags),
    declarable: isDeclarableCn8(rawCode),
    normalizedCode: hasCode ? code : null,
  }
}
