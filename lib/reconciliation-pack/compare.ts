/**
 * THE PURE COMPARATORS: a keyed set comparison, the tolerance rules and the pending-persistence rule.
 *
 * No database, no clock, no file, no network: rows in, buckets out. Every guard here exists because a review
 * once found its absence:
 *
 *   - Comparison is by IDENTITY, never by total. Two sides with the same row count and one identity swapped
 *     are an `onlyIms` plus an `onlyVendor`, not "equal".
 *   - Counts are not stored. `bucketCounts` derives them from the lists, and the report reader recomputes them.
 *   - A duplicate identity on one side is never summed or picked between (UNREADABLE: DUPLICATE_KEY), and two
 *     different identities that print as the same token are refused the same way, so a token is a safe key.
 *   - An unparsable value is never dropped (BAD_VALUE); a side that is not known complete never passes.
 *   - Nothing compared at all is EMPTY_UNPROVEN unless the caller carries positive evidence that empty is true.
 *   - Identities outside the RECORDED population are listed under outOfPopulation and never become findings.
 *   - A difference is SETTLED before it fails: it must still be there after PENDING_PERSISTENCE_RUNS later
 *     successful runs of its stream, observed as distinct last-success stamps. Stamps are compared for
 *     EQUALITY only. No two stamps are ever ordered, because a clock that moved backwards must not move a
 *     result (an item whose stamp repeats simply makes no progress).
 */

import { Prisma } from '@/app/generated/prisma/client'
import { currencyMinorUnits } from '@/lib/domain/math/decimal'
import {
  COMPARISON_BUCKETS,
  EXACT_DECIMAL_TOLERANCE,
  FINDING_BUCKETS,
  isKnownCurrency,
  isPackEmptyProofCode,
  PENDING_PERSISTENCE_RUNS,
  type ComparisonBucket,
  type ItemProof,
  type PackItemId,
  type Tolerance,
  getPackItem,
  type PackEmptyProofCode,
  type PackReasonCode,
} from '@/lib/reconciliation-pack/constants'
import { canonicalKey, isKey, keyToken, type KeyPart, type SafeToken } from '@/lib/reconciliation-pack/identity'

type Dec = Prisma.Decimal

// ---------------------------------------------------------------------------------------------
// Values and tolerances
// ---------------------------------------------------------------------------------------------

const DECIMAL_TEXT_RE = /^-?(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,12})?$/

/** A decimal from text, or null. Only plain decimal notation: no exponent, no whitespace, no NaN, no number type. */
export function parseDecimalStrict(value: unknown): Dec | null {
  if (typeof value !== 'string' || !DECIMAL_TEXT_RE.test(value)) return null
  return new Prisma.Decimal(value)
}

/** The one text form of a decimal: minus zero is zero, nothing else changes. */
export function decimalText(value: Dec): string {
  return value.isZero() ? '0' : value.toFixed()
}

export type { Tolerance }

/** Whether `tolerance` is a rule this module can apply: a known rule, and every limit a non-negative plain decimal. */
export function isUsableTolerance(tolerance: unknown): tolerance is Tolerance {
  if (typeof tolerance !== 'object' || tolerance === null) return false
  const t = tolerance as Record<string, unknown>
  if (typeof t.rule !== 'string' || !['exact', 'absolute', 'composite', 'minor-unit'].includes(t.rule)) return false
  const nonNegative = (value: unknown) => { const d = parseDecimalStrict(value); return d !== null && !d.isNegative() }
  switch (t.rule) {
    case 'exact': case 'minor-unit': return true
    case 'absolute': return nonNegative(t.limit)
    case 'composite': return nonNegative(t.floor) && nonNegative(t.fraction)
    default: return false // 'none' describes a count, not a measure: it cannot compare values
  }
}

/** The largest absolute difference the rule accepts for this pair, or null when the rule cannot be applied (unknown currency). */
export function toleranceLimit(tolerance: Tolerance, ims: Dec, vendor: Dec, currency?: string | null): Dec | null {
  switch (tolerance.rule) {
    case 'exact': return new Prisma.Decimal(EXACT_DECIMAL_TOLERANCE)
    case 'absolute': return new Prisma.Decimal(tolerance.limit)
    case 'composite': {
      const base = Prisma.Decimal.max(ims.abs(), vendor.abs())
      return Prisma.Decimal.max(new Prisma.Decimal(tolerance.floor), base.mul(tolerance.fraction))
    }
    case 'minor-unit': {
      if (!isKnownCurrency(currency)) return null
      return new Prisma.Decimal(1).div(new Prisma.Decimal(10).pow(currencyMinorUnits(currency)))
    }
  }
}

/** Whether two values agree under the rule. Inclusive: a difference exactly at the limit agrees. null = the rule could not be applied. */
export function withinTolerance(tolerance: Tolerance, ims: Dec, vendor: Dec, currency?: string | null): boolean | null {
  const limit = toleranceLimit(tolerance, ims, vendor, currency)
  if (limit === null) return null
  return ims.minus(vendor).abs().lte(limit)
}

// ---------------------------------------------------------------------------------------------
// Stability bracket and pending persistence
// ---------------------------------------------------------------------------------------------

const STAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/
export function isStreamStamp(value: unknown): value is string {
  return typeof value === 'string' && STAMP_RE.test(value) && !Number.isNaN(Date.parse(value))
}

/** The read bracket: the stream stamp at the start and the end of a read must both exist and be EQUAL. */
export function bracketStable(start: string | null, end: string | null): boolean {
  return isStreamStamp(start) && isStreamStamp(end) && start === end
}

export type DifferenceKind = 'onlyIms' | 'onlyVendor' | 'bothDiffer'
/**
 * One difference carried between runs. Its identity is the token it is filed under PLUS `kind` PLUS `signature` (the values and
 * currencies it was seen with): a value that changed between runs is a NEW difference, first seen now, not a continuation.
 * `sequence` is the report sequence the difference was first seen in; null only in memory, for one first seen in the run being built
 * (the builder fills it with the sequence it assigns).
 */
export type CarriedDifference = { kind: DifferenceKind; signature: string; sequence: number | null; first: string; later: readonly string[] }
/**
 * `usable` is whether the carried map came from a trusted, same-installation, same-phase previous report that carries the state in the
 * exact shape. When it is false the map is empty and every difference is first seen (the item says so: SETTLING_STATE_UNUSABLE).
 */
export type SettlingInput = { carried: ReadonlyMap<string, CarriedDifference>; stamp: string | null; usable: boolean }

/** The one text form of what a difference looked like: its kind, both values and both currencies. Used by the comparator and by the carry-over reader alike. */
export function differenceSignature(kind: DifferenceKind, parts: { ims: string | null; vendor: string | null; imsCurrency: string | null; vendorCurrency: string | null }): string {
  return JSON.stringify([kind, parts.ims, parts.vendor, parts.imsCurrency, parts.vendorCurrency])
}

/**
 * Advance one difference. Returns the record to carry and whether it has persisted (is now a finding).
 * A repeated stamp (the first one, or one already counted) is the same run of the stream: no progress. A previous record of another
 * kind or another signature is not this difference: it starts over, first seen at this stamp.
 */
export function advanceDifference(kind: DifferenceKind, signature: string, previous: CarriedDifference | undefined, stamp: string): { carried: CarriedDifference; persisted: boolean } {
  if (!previous || previous.kind !== kind || previous.signature !== signature) return { carried: { kind, signature, sequence: null, first: stamp, later: [] }, persisted: false }
  if (previous.later.length >= PENDING_PERSISTENCE_RUNS) return { carried: previous, persisted: true }
  if (stamp === previous.first || previous.later.includes(stamp)) return { carried: previous, persisted: false }
  const later = [...previous.later, stamp]
  return { carried: { ...previous, later }, persisted: later.length >= PENDING_PERSISTENCE_RUNS }
}

// ---------------------------------------------------------------------------------------------
// Keyed comparison
// ---------------------------------------------------------------------------------------------

export type SideRow = { key: readonly KeyPart[]; value?: string | null; currency?: string | null }

export type CompareEntry = {
  key: SafeToken
  ims: string | null
  vendor: string | null
  delta: string | null
  /** The currency each side's row carried (null when it carried none). Present so a reader can re-judge the pair. */
  imsCurrency: string | null
  vendorCurrency: string | null
  /** Whether each side had the identity (a presence-only comparison records nothing else about it). */
  imsPresent: boolean
  vendorPresent: boolean
  /** On unsettled entries, and on the failing entries of a comparison that settles: the stream stamps the difference was seen under. */
  settling?: { sequence: number | null; first: string; later: string[] }
}

export type CompareInput = {
  ims: readonly SideRow[]
  vendor: readonly SideRow[]
  /** Positive evidence that each side was read to the end (not capped, not truncated, not a partial page). */
  imsComplete: boolean
  vendorComplete: boolean
  /** Positive evidence, by name, that an empty comparison is the true answer (for example a vendor total of zero). */
  emptyProof?: PackEmptyProofCode
  /** values or presence, fixed per item by the catalogue (getPackItem(id).mode); never inferred from the rows. */
  mode: 'values' | 'presence'
  /** Required in values mode; ignored in presence mode. */
  tolerance?: Tolerance
  /** The recorded population, as canonical keys. Absent = everything is in. */
  population?: ReadonlySet<string>
  /** Identities with an unexpired written exclusion, as canonical keys. */
  excluded?: ReadonlySet<string>
  /** Absent = a difference needs no settling (an invariant, not a vendor lag). */
  settling?: SettlingInput
}

export type CompareResult =
  | { status: 'compared'; buckets: Record<ComparisonBucket, CompareEntry[]>; nextCarried: Map<string, CarriedDifference>; proof: ItemProof | null; carriedUnusable: boolean }
  | { status: 'unreadable'; reason: PackReasonCode }

function emptyBuckets(): Record<ComparisonBucket, CompareEntry[]> {
  return Object.fromEntries(COMPARISON_BUCKETS.map((bucket) => [bucket, [] as CompareEntry[]])) as unknown as Record<ComparisonBucket, CompareEntry[]>
}

type Indexed = { token: SafeToken; value: string | null; dec: Dec | null; currency: string | null }
type Mode = 'values' | 'presence'

/** Index one side by canonical key, refusing (with a closed code) any row that cannot be read exactly. */
function indexSide(rows: unknown, mode: Mode, minorUnit: boolean): Map<string, Indexed> | PackReasonCode {
  if (!Array.isArray(rows)) return 'SOURCE_UNREADABLE'
  const map = new Map<string, Indexed>()
  const tokens = new Set<string>()
  for (const row of rows as unknown[]) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return 'BAD_KEY'
    const { key, value, currency } = row as { key?: unknown; value?: unknown; currency?: unknown }
    if (!isKey(key)) return 'BAD_KEY'
    const canonical = canonicalKey(key)
    const token = keyToken(key)
    if (map.has(canonical) || tokens.has(token)) return 'DUPLICATE_KEY'
    let dec: Dec | null = null
    let text: string | null = null
    if (mode === 'values') {
      if (value === undefined || value === null) return 'VALUE_MISSING'
      dec = parseDecimalStrict(value)
      if (dec === null) return 'BAD_VALUE'
      text = decimalText(dec)
    } else if (value !== undefined && value !== null) {
      return 'VALUE_SHAPE_MISMATCH'
    }
    let currencyText: string | null = null
    if (currency !== undefined && currency !== null) {
      if (!isKnownCurrency(currency)) return 'CURRENCY_UNKNOWN'
      currencyText = currency
    } else if (minorUnit && mode === 'values') {
      return 'CURRENCY_UNKNOWN'
    }
    map.set(canonical, { token, value: text, dec, currency: currencyText })
    tokens.add(token)
  }
  return map
}

function validCarried(carried: unknown): boolean {
  if (!(carried instanceof Map)) return false
  for (const [key, record] of carried) {
    if (typeof key !== 'string' || typeof record !== 'object' || record === null) return false
    const r = record as Partial<CarriedDifference>
    if (r.kind !== 'onlyIms' && r.kind !== 'onlyVendor' && r.kind !== 'bothDiffer') return false
    if (typeof r.signature !== 'string' || r.signature.length === 0) return false
    if (r.sequence !== null && !(typeof r.sequence === 'number' && Number.isSafeInteger(r.sequence) && r.sequence >= 1)) return false
    if (!isStreamStamp(r.first) || !Array.isArray(r.later) || !r.later.every(isStreamStamp)) return false
    if (new Set([r.first, ...r.later]).size !== r.later.length + 1) return false
  }
  return true
}

export function compareKeyed(input: CompareInput): CompareResult {
  const unreadable = (reason: PackReasonCode): CompareResult => ({ status: 'unreadable', reason })
  if (input.imsComplete !== true || input.vendorComplete !== true) return unreadable('READ_INCOMPLETE')
  const mode = input.mode
  if (mode !== 'values' && mode !== 'presence') return unreadable('BAD_MODE')
  if (mode === 'values' && !isUsableTolerance(input.tolerance)) return unreadable('BAD_TOLERANCE')
  if (input.population !== undefined && !(input.population instanceof Set)) return unreadable('NO_POPULATION_RECORD')
  if (input.excluded !== undefined && !(input.excluded instanceof Set)) return unreadable('NO_POPULATION_RECORD')
  if (input.settling !== undefined && (typeof input.settling.usable !== 'boolean' || !validCarried(input.settling.carried) || (!input.settling.usable && input.settling.carried.size > 0))) return unreadable('SOURCE_UNREADABLE')
  const minorUnit = mode === 'values' && input.tolerance!.rule === 'minor-unit'
  const ims = indexSide(input.ims, mode, minorUnit)
  if (typeof ims === 'string') return unreadable(ims)
  const vendor = indexSide(input.vendor, mode, minorUnit)
  if (typeof vendor === 'string') return unreadable(vendor)
  const stamp = input.settling?.stamp ?? null
  if (input.settling && !isStreamStamp(stamp)) return unreadable('STALE_BASIS')

  const buckets = emptyBuckets()
  const nextCarried = new Map<string, CarriedDifference>()
  const keys = new Set<string>([...ims.keys(), ...vendor.keys()])
  // CARRIED IDENTITIES ARE RE-CHECKED FIRST: they are judged, and listed within each bucket, before any identity first seen now, so a
  // cap on the listing can cut a new identity and never one whose settling is already under way.
  const tokenOf = (canonical: string): string => (ims.get(canonical) ?? vendor.get(canonical))!.token
  const carriedKeys = input.settling ? input.settling.carried : null
  const ordered = [...keys].sort()
  const order = carriedKeys ? [...ordered.filter((k) => carriedKeys.has(tokenOf(k))), ...ordered.filter((k) => !carriedKeys.has(tokenOf(k)))] : ordered
  for (const canonical of order) {
    const a = ims.get(canonical)
    const b = vendor.get(canonical)
    const token = (a ?? b)!.token
    const entry: CompareEntry = { key: token, ims: a?.value ?? null, vendor: b?.value ?? null, delta: null, imsCurrency: a?.currency ?? null, vendorCurrency: b?.currency ?? null, imsPresent: a !== undefined, vendorPresent: b !== undefined }
    if (input.population && !input.population.has(canonical)) { buckets.outOfPopulation.push(entry); continue }
    if (input.excluded?.has(canonical)) { buckets.excluded.push(entry); continue }

    let kind: DifferenceKind | null = null
    if (a && !b) kind = 'onlyIms'
    else if (!a && b) kind = 'onlyVendor'
    else if (a && b && mode === 'values') {
      // Both rows carry a decimal here: indexSide refused anything else.
      if ((a.currency === null) !== (b.currency === null)) return unreadable('CURRENCY_UNKNOWN')
      entry.delta = decimalText(a.dec!.minus(b.dec!))
      if (a.currency !== b.currency) kind = 'bothDiffer'
      else {
        const within = withinTolerance(input.tolerance as Tolerance, a.dec!, b.dec!, a.currency)
        if (within === null) return unreadable('CURRENCY_UNKNOWN')
        if (!within) kind = 'bothDiffer'
      }
    }
    if (kind === null) { buckets.bothEqual.push(entry); continue }
    if (!input.settling) { buckets[kind].push(entry); continue }
    const advanced = advanceDifference(kind, differenceSignature(kind, entry), input.settling.carried.get(token), stamp as string)
    nextCarried.set(token, advanced.carried)
    const settling = { sequence: advanced.carried.sequence, first: advanced.carried.first, later: [...advanced.carried.later] }
    if (advanced.persisted) buckets[kind].push({ ...entry, settling })
    else buckets.unsettled.push({ ...entry, settling })
  }

  // What was actually JUDGED: identities in the population and not excluded. Excluded and out-of-population identities
  // are listed but were never compared, so they prove nothing.
  const judged = (['onlyIms', 'onlyVendor', 'bothEqual', 'bothDiffer', 'unsettled'] as const).reduce((sum, bucket) => sum + buckets[bucket].length, 0)
  if (judged === 0 && !isPackEmptyProofCode(input.emptyProof)) return unreadable('EMPTY_UNPROVEN')
  // A proof exists only for something that could pass: equal identities that were really compared, or a named proof that
  // the judged population is empty. A comparison with nothing but findings or unsettled identities has none.
  const proof: ItemProof | null = buckets.bothEqual.length > 0 ? { kind: 'compared' } : judged === 0 ? { kind: 'proven-empty', source: input.emptyProof as PackEmptyProofCode } : null
  return { status: 'compared', buckets, nextCarried, proof, carriedUnusable: input.settling !== undefined && !input.settling.usable }
}

/**
 * Compare for one catalogue item: the MODE and the TOLERANCE are the catalogue's, never the caller's. The reader
 * re-judges every evidence entry against the same catalogue row, so a runner cannot loosen its own test.
 */
export function compareItem(id: PackItemId, input: Omit<CompareInput, 'mode' | 'tolerance'>): CompareResult {
  const spec = getPackItem(id)
  return compareKeyed({ ...input, mode: spec.mode, tolerance: spec.measure ?? undefined })
}

/** Counts are DERIVED from the lists, every time. */
export function bucketCounts(buckets: Record<ComparisonBucket, readonly unknown[]>): Record<ComparisonBucket, number> {
  return Object.fromEntries(COMPARISON_BUCKETS.map((bucket) => [bucket, buckets[bucket].length])) as Record<ComparisonBucket, number>
}

/** The outcome a comparison supports. Pass needs a complete, stable, settled, empty-of-findings comparison. */
export function outcomeOfComparison(result: CompareResult): { outcome: 'pass' | 'fail' | 'inconclusive'; reasons: PackReasonCode[] } {
  if (result.status === 'unreadable') return { outcome: 'inconclusive', reasons: [result.reason] }
  const findings = FINDING_BUCKETS.reduce((sum, bucket) => sum + result.buckets[bucket].length, 0)
  const unsettled = result.buckets.unsettled.length
  // An unsettled difference whose carried state could not be used is said to be so: it cannot mature while that holds.
  const unusable: PackReasonCode[] = unsettled > 0 && result.carriedUnusable ? ['SETTLING_STATE_UNUSABLE'] : []
  if (findings > 0) return { outcome: 'fail', reasons: unsettled > 0 ? ['DIFFERENCES', 'UNSETTLED_PENDING', ...unusable] : ['DIFFERENCES'] }
  if (unsettled > 0) return { outcome: 'inconclusive', reasons: ['UNSETTLED_PENDING', ...unusable] }
  if (result.proof === null) return { outcome: 'inconclusive', reasons: ['EMPTY_UNPROVEN'] }
  return { outcome: 'pass', reasons: [] }
}
