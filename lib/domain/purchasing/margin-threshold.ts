import { toDecimal, type Decimal } from '@/lib/domain/math/decimal'
import type { LineMarginResult } from '@/lib/domain/purchasing/line-margin'

/**
 * Minimum gross-margin threshold for purchase-order lines. INTERNAL ONLY, exactly like the margin it
 * guards: nothing here may reach a supplier (portal, quote view, PO PDF, email).
 *
 * Settings: a global minimum margin %, plus optional per-category and per-product overrides, and a mode:
 *  - 'warn'  the form marks a line below its minimum; saving and sending are not affected.
 *  - 'block' the server refuses to save or send a PO with a line below its minimum, unless an override
 *            note is supplied (recorded on the PO with who and when).
 * No threshold configured at all means nothing is assessed and behaviour is unchanged.
 *
 * Resolution, most specific first: the line product's own override, then its parent product's (a variation
 * inherits its parent's), then the nearest category override up the line product's category chain (the
 * variation's own category, else its parent's), then the global minimum.
 *
 * A margin that is UNAVAILABLE (no price, cost, VAT or rate) is never blocked and never warned: it is
 * unknown, and the form says so.
 *
 * All arithmetic is Decimal; percentages leave as 2 dp strings.
 */

export type MarginThresholdMode = 'warn' | 'block'

export type MarginThresholdSettings = {
  mode: MarginThresholdMode
  /** Global minimum gross margin %, a decimal string, or null when there is none. */
  globalPct: string | null
  /** Category id -> minimum margin %. */
  categories: Record<string, string>
  /** Product id -> minimum margin %. */
  products: Record<string, string>
}

export const MARGIN_THRESHOLD_SETTING_KEY = 'po_min_margin_threshold'

export const NO_MARGIN_THRESHOLD: MarginThresholdSettings = Object.freeze({
  mode: 'warn',
  globalPct: null,
  categories: Object.freeze({}) as Record<string, string>,
  products: Object.freeze({}) as Record<string, string>,
}) as MarginThresholdSettings

export const MIN_MARGIN_PCT_MAX = 99.99
export const OVERRIDE_NOTE_MIN_LENGTH = 5
export const OVERRIDE_NOTE_MAX_LENGTH = 500

/** A percentage 0 to 99.99 with at most 2 decimals, as a normalised 2 dp string; null when it is not one. */
export function normaliseMinMarginPct(input: unknown): string | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    input = String(input)
  }
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null
  const d = toDecimal(s)
  if (d.lt(0) || d.gt(MIN_MARGIN_PCT_MAX)) return null
  return d.toFixed(2)
}

function normaliseMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const pct = normaliseMinMarginPct(v)
    if (id && pct !== null) out[id] = pct
  }
  return out
}

/**
 * Tolerant read of the stored JSON. A missing, malformed or partly invalid value degrades to "less
 * threshold", never to an error: an unreadable setting must not stop purchasing.
 */
export function parseMarginThresholdSettings(raw: string | null | undefined): MarginThresholdSettings {
  if (!raw) return NO_MARGIN_THRESHOLD
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NO_MARGIN_THRESHOLD
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_MARGIN_THRESHOLD
  const o = parsed as Record<string, unknown>
  return {
    mode: o.mode === 'block' ? 'block' : 'warn',
    globalPct: normaliseMinMarginPct(o.globalPct),
    categories: normaliseMap(o.categories),
    products: normaliseMap(o.products),
  }
}

export type MarginThresholdValidation =
  | { ok: true; settings: MarginThresholdSettings }
  | { ok: false; error: string }

/** Strict validation of what an operator submits. Any invalid value refuses the whole save. */
export function validateMarginThresholdInput(input: {
  mode: unknown
  globalPct: unknown
  categories: unknown
  products: unknown
}): MarginThresholdValidation {
  if (input.mode !== 'warn' && input.mode !== 'block') return { ok: false, error: 'Mode must be warn or block' }
  let globalPct: string | null = null
  if (input.globalPct !== null && input.globalPct !== undefined && String(input.globalPct).trim() !== '') {
    globalPct = normaliseMinMarginPct(input.globalPct)
    if (globalPct === null) return { ok: false, error: 'The global minimum margin must be a percentage from 0 to 99.99' }
  }
  const maps: Record<'categories' | 'products', Record<string, string>> = { categories: {}, products: {} }
  for (const key of ['categories', 'products'] as const) {
    const raw = input[key]
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `Invalid ${key} overrides` }
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const pct = normaliseMinMarginPct(v)
      if (!id || pct === null) return { ok: false, error: `Each ${key === 'categories' ? 'category' : 'product'} minimum margin must be a percentage from 0 to 99.99` }
      maps[key][id] = pct
    }
  }
  return { ok: true, settings: { mode: input.mode, globalPct, categories: maps.categories, products: maps.products } }
}

/** True when any minimum is configured. With none, nothing is assessed and nothing is blocked. */
export function hasAnyMarginThreshold(s: MarginThresholdSettings): boolean {
  return s.globalPct !== null || Object.keys(s.categories).length > 0 || Object.keys(s.products).length > 0
}

export type MarginThresholdSource = 'product' | 'parent-product' | 'category' | 'global'

export type ResolvedMinimum = { pct: string; source: MarginThresholdSource }

export type ProductThresholdContext = {
  productId: string
  /** The parent product's id when the line product is a variation. */
  parentId: string | null
  /** The line product's category id, then its ancestors' (nearest first). A variation with no category passes its parent's chain. */
  categoryChain: readonly string[]
}

export function resolveMinimumMarginPct(
  settings: MarginThresholdSettings,
  ctx: ProductThresholdContext,
): ResolvedMinimum | null {
  const own = settings.products[ctx.productId]
  if (own !== undefined) return { pct: own, source: 'product' }
  if (ctx.parentId) {
    const parent = settings.products[ctx.parentId]
    if (parent !== undefined) return { pct: parent, source: 'parent-product' }
  }
  for (const id of ctx.categoryChain) {
    const c = settings.categories[id]
    if (c !== undefined) return { pct: c, source: 'category' }
  }
  if (settings.globalPct !== null) return { pct: settings.globalPct, source: 'global' }
  return null
}

export type LineThresholdState = 'none' | 'unknown' | 'ok' | 'below'

export type LineThresholdAssessment = {
  state: LineThresholdState
  /** The minimum that applied, when one did. */
  minPct: string | null
  source: MarginThresholdSource | null
  /** The line's margin %, when it has one. */
  marginPct: string | null
}

/**
 * One line against its resolved minimum. No minimum: 'none'. A margin that is unavailable: 'unknown' (never
 * below). Otherwise 'below' when the margin % is strictly under the minimum; equal passes.
 */
export function assessLineAgainstMinimum(margin: LineMarginResult, minimum: ResolvedMinimum | null): LineThresholdAssessment {
  if (!minimum) return { state: 'none', minPct: null, source: null, marginPct: margin.kind === 'ok' ? margin.marginPct : null }
  if (margin.kind !== 'ok') return { state: 'unknown', minPct: minimum.pct, source: minimum.source, marginPct: null }
  const below: boolean = toDecimal(margin.marginPct).lt(toDecimal(minimum.pct) as Decimal)
  return { state: below ? 'below' : 'ok', minPct: minimum.pct, source: minimum.source, marginPct: margin.marginPct }
}

/** An override note must carry real words: trimmed, within bounds. Returns the trimmed note or null. */
export function normaliseOverrideNote(note: unknown): string | null {
  if (typeof note !== 'string') return null
  const t = note.trim()
  if (t.length < OVERRIDE_NOTE_MIN_LENGTH || t.length > OVERRIDE_NOTE_MAX_LENGTH) return null
  return t
}

export type ThresholdDecision =
  | { kind: 'clear' }
  /** warn mode: lines are below, nothing is refused. */
  | { kind: 'warn'; belowCount: number }
  /** block mode with no valid note. */
  | { kind: 'blocked'; belowCount: number }
  /** block mode, below lines, and a valid note: allowed, and the override is recorded. */
  | { kind: 'overridden'; belowCount: number; note: string }

/** The whole policy in one place: what to do with these assessments under this mode and note. */
export function decideThreshold(
  mode: MarginThresholdMode,
  assessments: readonly Pick<LineThresholdAssessment, 'state'>[],
  overrideNote: unknown,
): ThresholdDecision {
  const belowCount = assessments.filter((a) => a.state === 'below').length
  if (belowCount === 0) return { kind: 'clear' }
  if (mode === 'warn') return { kind: 'warn', belowCount }
  const note = normaliseOverrideNote(overrideNote)
  return note ? { kind: 'overridden', belowCount, note } : { kind: 'blocked', belowCount }
}

export { MARGIN_BLOCK_ERROR_PREFIX } from '@/lib/domain/purchasing/margin-threshold-constants'
