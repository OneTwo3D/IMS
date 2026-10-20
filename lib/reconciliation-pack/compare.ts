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
  PENDING_PERSISTENCE_RUNS,
  type ComparisonBucket,
  type ItemProof,
  type PackEmptyProofCode,
  type PackReasonCode,
} from '@/lib/reconciliation-pack/constants'
import { canonicalKey, keyToken, type KeyPart, type SafeToken } from '@/lib/reconciliation-pack/identity'

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

export type Tolerance =
  | { rule: 'exact' }
  | { rule: 'absolute'; limit: string }
  | { rule: 'composite'; floor: string; fraction: string }
  | { rule: 'minor-unit' }

const CURRENCY_RE = /^[A-Z]{3}$/

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
      if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) return null
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
export type CarriedDifference = { kind: DifferenceKind; first: string; later: readonly string[] }
export type SettlingInput = { carried: ReadonlyMap<string, CarriedDifference>; stamp: string | null }

/**
 * Advance one difference. Returns the record to carry and whether it has persisted (is now a finding).
 * A repeated stamp (the first one, or one already counted) is the same run of the stream: no progress.
 */
export function advanceDifference(kind: DifferenceKind, previous: CarriedDifference | undefined, stamp: string): { carried: CarriedDifference; persisted: boolean } {
  if (!previous || previous.kind !== kind) return { carried: { kind, first: stamp, later: [] }, persisted: false }
  if (previous.later.length >= PENDING_PERSISTENCE_RUNS) return { carried: previous, persisted: true }
  if (stamp === previous.first || previous.later.includes(stamp)) return { carried: previous, persisted: false }
  const later = [...previous.later, stamp]
  return { carried: { kind, first: previous.first, later }, persisted: later.length >= PENDING_PERSISTENCE_RUNS }
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
  /** Only on unsettled entries: the stream stamps the difference was seen under. */
  settling?: { first: string; later: string[] }
}

export type CompareInput = {
  ims: readonly SideRow[]
  vendor: readonly SideRow[]
  /** Positive evidence that each side was read to the end (not capped, not truncated, not a partial page). */
  imsComplete: boolean
  vendorComplete: boolean
  /** Positive evidence, by name, that an empty comparison is the true answer (for example a vendor total of zero). */
  emptyProof?: PackEmptyProofCode
  tolerance: Tolerance
  /** The recorded population, as canonical keys. Absent = everything is in. */
  population?: ReadonlySet<string>
  /** Identities with an unexpired written exclusion, as canonical keys. */
  excluded?: ReadonlySet<string>
  /** Absent = a difference needs no settling (an invariant, not a vendor lag). */
  settling?: SettlingInput
}

export type CompareResult =
  | { status: 'compared'; buckets: Record<ComparisonBucket, CompareEntry[]>; nextCarried: Map<string, CarriedDifference>; proof: ItemProof }
  | { status: 'unreadable'; reason: PackReasonCode }

function emptyBuckets(): Record<ComparisonBucket, CompareEntry[]> {
  return Object.fromEntries(COMPARISON_BUCKETS.map((bucket) => [bucket, [] as CompareEntry[]])) as unknown as Record<ComparisonBucket, CompareEntry[]>
}

type Indexed = { token: SafeToken; value: string | null; dec: Dec | null; currency: string | null }

/** Index one side by canonical key; null when a key repeats, a value is bad, or two keys print alike. */
function indexSide(rows: readonly SideRow[]): { map: Map<string, Indexed>; hasValues: boolean } | PackReasonCode {
  const map = new Map<string, Indexed>()
  const tokens = new Set<string>()
  let valued = 0
  for (const row of rows) {
    const canonical = canonicalKey(row.key)
    const token = keyToken(row.key)
    if (map.has(canonical) || tokens.has(token)) return 'DUPLICATE_KEY'
    let dec: Dec | null = null
    let value: string | null = null
    if (row.value !== undefined && row.value !== null) {
      dec = parseDecimalStrict(row.value)
      if (dec === null) return 'BAD_VALUE'
      value = dec.toFixed()
      valued += 1
    }
    map.set(canonical, { token, value, dec, currency: row.currency ?? null })
    tokens.add(token)
  }
  if (valued !== 0 && valued !== rows.length) return 'VALUE_SHAPE_MISMATCH'
  return { map, hasValues: valued > 0 }
}

export function compareKeyed(input: CompareInput): CompareResult {
  if (!input.imsComplete || !input.vendorComplete) return { status: 'unreadable', reason: 'READ_INCOMPLETE' }
  const ims = indexSide(input.ims)
  if (typeof ims === 'string') return { status: 'unreadable', reason: ims }
  const vendor = indexSide(input.vendor)
  if (typeof vendor === 'string') return { status: 'unreadable', reason: vendor }
  if (input.ims.length > 0 && input.vendor.length > 0 && ims.hasValues !== vendor.hasValues) return { status: 'unreadable', reason: 'VALUE_SHAPE_MISMATCH' }
  const stamp = input.settling?.stamp ?? null
  if (input.settling && !isStreamStamp(stamp)) return { status: 'unreadable', reason: 'STALE_BASIS' }

  const buckets = emptyBuckets()
  const nextCarried = new Map<string, CarriedDifference>()
  const keys = new Set<string>([...ims.map.keys(), ...vendor.map.keys()])
  for (const canonical of [...keys].sort()) {
    const a = ims.map.get(canonical)
    const b = vendor.map.get(canonical)
    const token = (a ?? b)!.token
    const entry: CompareEntry = { key: token, ims: a?.value ?? null, vendor: b?.value ?? null, delta: null }
    if (input.population && !input.population.has(canonical)) { buckets.outOfPopulation.push(entry); continue }
    if (input.excluded?.has(canonical)) { buckets.excluded.push(entry); continue }

    let kind: DifferenceKind | null = null
    if (a && !b) kind = 'onlyIms'
    else if (!a && b) kind = 'onlyVendor'
    else if (a && b) {
      if (a.dec && b.dec) {
        entry.delta = a.dec.minus(b.dec).toFixed()
        if (a.currency !== b.currency && input.tolerance.rule === 'minor-unit') kind = 'bothDiffer'
        else {
          const within = withinTolerance(input.tolerance, a.dec, b.dec, a.currency)
          if (within === null) return { status: 'unreadable', reason: 'CURRENCY_UNKNOWN' }
          if (!within) kind = 'bothDiffer'
        }
      }
    }
    if (kind === null) { buckets.bothEqual.push(entry); continue }
    if (!input.settling) { buckets[kind].push(entry); continue }
    const advanced = advanceDifference(kind, input.settling.carried.get(token), stamp as string)
    nextCarried.set(token, advanced.carried)
    if (advanced.persisted) buckets[kind].push(entry)
    else buckets.unsettled.push({ ...entry, settling: { first: advanced.carried.first, later: [...advanced.carried.later] } })
  }

  const compared = COMPARISON_BUCKETS.filter((bucket) => bucket !== 'outOfPopulation').reduce((sum, bucket) => sum + buckets[bucket].length, 0)
  if (compared === 0 && !input.emptyProof) return { status: 'unreadable', reason: 'EMPTY_UNPROVEN' }
  const proof: ItemProof = compared === 0 ? { kind: 'proven-empty', source: input.emptyProof! } : { kind: 'compared' }
  return { status: 'compared', buckets, nextCarried, proof }
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
  if (findings > 0) return { outcome: 'fail', reasons: unsettled > 0 ? ['DIFFERENCES', 'UNSETTLED_PENDING'] : ['DIFFERENCES'] }
  if (unsettled > 0) return { outcome: 'inconclusive', reasons: ['UNSETTLED_PENDING'] }
  return { outcome: 'pass', reasons: [] }
}
