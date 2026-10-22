/**
 * THE REPORT: building it from item results, rendering it, and reading it back with nothing trusted.
 *
 * `buildReport` is pure. It refuses (throws) an item result that contradicts itself or its phase: a pass that
 * carries a finding or a reason, a not-applicable outcome for an item the phase applies, an unknown reason.
 * `parseReport` and `parseEvidence` are the other half: whatever a file says is validated against closed sets
 * and strict patterns before ANY field is used, and the derived values (summary, exit code, per-item counts)
 * are recomputed and must equal what the file claims.
 *
 * Text is closed words and numbers. The Markdown names no identity at all; identities live in evidence.jsonl
 * as sanitised tokens, and counts in the JSON are derived from those lines.
 */

import { createHash } from 'node:crypto'

import type { ReadinessPhase } from '@/lib/ops/readiness-gate-constants'
import { READ_SYNC_STREAM_IDS, type ReadSyncStreamId } from '@/lib/ops/read-sync-liveness-constants'
import { bracketStable, decimalText, isStreamStamp, parseDecimalStrict, withinTolerance, type CompareEntry } from '@/lib/reconciliation-pack/compare'
import {
  COMPARISON_BUCKETS,
  FINDING_BUCKETS,
  MAX_ENTRIES_PER_BUCKET,
  MAX_EVIDENCE_LINES_PER_ITEM,
  isKnownCurrency,
  PACK_EVIDENCE_FILE,
  PACK_ITEM_IDS,
  PACK_OUTCOMES,
  PACK_REPORT_KIND,
  PACK_SCHEMA_VERSION,
  PACK_APPLICABILITY,
  SYSTEM_IDENTIFIER_RE,
  getPackItem,
  isPackEmptyProofCode,
  isPackReasonCode,
  isPackSourceCode,
  itemApplicability,
  packExitCode,
  type ComparisonBucket,
  type ItemProof,
  type PackApplicability,
  type PackSourceCode,
  type PackItemId,
  type PackOutcome,
  type PackReasonCode,
} from '@/lib/reconciliation-pack/constants'
import { isSafeTokenShape } from '@/lib/reconciliation-pack/identity'
import { ShapeError, plainList, plainRecord } from '@/lib/reconciliation-pack/shape'

export const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/
export const AS_OF_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
export const SHA256_RE = /^[0-9a-f]{64}$/
const PHASES: readonly ReadinessPhase[] = ['P0', 'P1', 'P2']

/** Every bucket is listed: one evidence line per identity, equal ones included, so a reader recomputes every count itself. */
export const LISTED_BUCKETS: readonly ComparisonBucket[] = COMPARISON_BUCKETS
/** The order evidence lines are written in: findings first, so a cap can never cut a finding to keep an equal. */
const EMIT_ORDER: readonly ComparisonBucket[] = ['onlyIms', 'onlyVendor', 'bothDiffer', 'unsettled', 'excluded', 'outOfPopulation', 'bothEqual']

/** What a caller may hand in for one entry. The currencies default to null; no other field is optional. */
/** The key is checked at runtime against the sanitised-token shape (identity.ts), so the type does not demand the brand. */
export type EntryInput = Omit<CompareEntry, 'imsCurrency' | 'vendorCurrency' | 'imsPresent' | 'vendorPresent' | 'key'> & { key: string; imsCurrency?: string | null; vendorCurrency?: string | null; imsPresent?: boolean; vendorPresent?: boolean }

export type ItemInput = {
  id: PackItemId
  outcome: PackOutcome
  reasons: readonly PackReasonCode[]
  /** Required for a pass (see checkItemConsistency); null/absent otherwise. */
  proof?: ItemProof | null
  /** The sources the item read; a pass must name exactly its catalogue row's. */
  sources?: readonly PackSourceCode[]
  entries?: Partial<Record<ComparisonBucket, readonly EntryInput[]>>
}

export type StreamBracket = { stream: ReadSyncStreamId; start: string | null; end: string | null }

export type ReportInput = {
  runId: string
  systemIdentifier: string
  phase: ReadinessPhase
  asOf: string
  startedAt: string
  finishedAt: string
  streams: readonly StreamBracket[]
  items: readonly ItemInput[]
}

export type ItemResult = {
  id: PackItemId
  applicability: PackApplicability
  outcome: PackOutcome
  reasons: PackReasonCode[]
  proof: ItemProof | null
  sources: PackSourceCode[]
  counts: Record<ComparisonBucket, number>
  bothEqualSha256: string | null
  evidenceLines: number
}

export type ReportSummary = { pass: number; fail: number; inconclusive: number; notApplicable: number }

export type ReportBody = {
  schemaVersion: typeof PACK_SCHEMA_VERSION
  kind: typeof PACK_REPORT_KIND
  runId: string
  systemIdentifier: string
  phase: ReadinessPhase
  asOf: string
  startedAt: string
  finishedAt: string
  sequence: number
  previousReportSha256: string | null
  streams: StreamBracket[]
  items: ItemResult[]
  summary: ReportSummary
  exitCode: number
  evidence: { file: typeof PACK_EVIDENCE_FILE; sha256: string; lines: number }
}
export type ReportRecord = ReportBody & { companionMarkdownSha256: string }

export class ReportInvalid extends Error {}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------------------------
// Derived values: one implementation, used by the builder and by the reader.
// ---------------------------------------------------------------------------------------------

export function summarise(items: readonly Pick<ItemResult, 'outcome'>[]): ReportSummary {
  const count = (outcome: PackOutcome) => items.filter((item) => item.outcome === outcome).length
  return { pass: count('pass'), fail: count('fail'), inconclusive: count('inconclusive'), notApplicable: count('not-applicable') }
}

/** 1 if an applicable item failed; else 5 if one is inconclusive or NOTHING applicable passed; else 0. Listed-only items never move it. */
export function deriveExitCode(items: readonly Pick<ItemResult, 'outcome' | 'applicability'>[]): number {
  const counted = items.filter((item) => item.applicability === 'applicable')
  if (counted.some((item) => item.outcome === 'fail')) return packExitCode('fail')
  if (counted.some((item) => item.outcome === 'inconclusive')) return packExitCode('inconclusive')
  if (!counted.some((item) => item.outcome === 'pass')) return packExitCode('inconclusive')
  return packExitCode('all-pass')
}

function isReadSyncStream(value: unknown): value is ReadSyncStreamId {
  return typeof value === 'string' && (READ_SYNC_STREAM_IDS as readonly string[]).includes(value)
}

export function equalDigest(keys: readonly string[]): string | null {
  if (keys.length === 0) return null
  return sha256Hex([...keys].sort().join('\n'))
}

/** A decimal in the one text form the comparator writes (no minus zero, no trailing zeros, no padding). */
function isCanonicalDecimal(value: unknown): value is string {
  const parsed = parseDecimalStrict(value)
  return parsed !== null && decimalText(parsed) === value
}

// ---------------------------------------------------------------------------------------------
// Entries: one shape, one judge. The builder judges every entry before writing a byte and the reader judges
// every evidence line again, with the same function, against the catalogue row of the item.
// ---------------------------------------------------------------------------------------------

/** An entry as it is stored: only these fields, only these types. */
export type CleanEntry = {
  key: string
  ims: string | null
  vendor: string | null
  delta: string | null
  imsCurrency: string | null
  vendorCurrency: string | null
  /** Whether each side had the identity. In values mode this is exactly "the side has a value"; in presence mode it is the only record of it. */
  imsPresent: boolean
  vendorPresent: boolean
  settling?: { first: string; later: string[] }
}
const ENTRY_KEYS = ['key', 'ims', 'vendor', 'delta', 'imsCurrency', 'vendorCurrency', 'imsPresent', 'vendorPresent', 'settling'] as const
const MAX_SETTLING_LATER = 8

function nullableDecimal(value: unknown, what: string): string | null {
  if (value === null) return null
  if (!isCanonicalDecimal(value)) throw new ReportInvalid(`an entry ${what} is not a canonical plain decimal`)
  return value
}
function nullableCurrency(value: unknown, what: string): string | null {
  if (value === null) return null
  if (!isKnownCurrency(value)) throw new ReportInvalid(`an entry ${what} is not a known currency`)
  return value
}

/**
 * A presence flag is a boolean. When the caller leaves it out, a VALUES item's flag is read off its value (the only thing
 * it can mean there); a PRESENCE item has no value to read it from, so the caller must say, and a missing flag is refused.
 */
function presenceFlag(flag: unknown, defaultsFor: PackItemId | null, value: unknown, side: string): boolean {
  if (flag !== undefined) {
    if (typeof flag !== 'boolean') throw new ReportInvalid(`an entry ${side} presence flag is not a boolean`)
    return flag
  }
  if (defaultsFor !== null && getPackItem(defaultsFor).mode === 'values') return value !== null
  throw new ReportInvalid(`an entry must say whether the ${side} side has the identity`)
}

/** Copy one caller-owned entry into a clean one (or throw). Used for builder input and for parsed evidence lines alike. */
function cleanEntry(raw: unknown, defaultsFor: PackItemId | null): CleanEntry {
  const r = plainRecord(raw, ENTRY_KEYS, defaultsFor ? ['key', 'ims', 'vendor', 'delta'] : ['key', 'ims', 'vendor', 'delta', 'imsCurrency', 'vendorCurrency', 'imsPresent', 'vendorPresent'], 'an entry')
  if (typeof r.key !== 'string' || !isSafeTokenShape(r.key)) throw new ReportInvalid('an entry key is not a sanitised token')
  const entry: CleanEntry = {
    key: r.key,
    ims: nullableDecimal(r.ims, 'ims value'),
    vendor: nullableDecimal(r.vendor, 'vendor value'),
    delta: nullableDecimal(r.delta, 'delta'),
    imsCurrency: nullableCurrency(r.imsCurrency === undefined ? null : r.imsCurrency, 'ims currency'),
    vendorCurrency: nullableCurrency(r.vendorCurrency === undefined ? null : r.vendorCurrency, 'vendor currency'),
    imsPresent: presenceFlag(r.imsPresent, defaultsFor, r.ims, 'ims'),
    vendorPresent: presenceFlag(r.vendorPresent, defaultsFor, r.vendor, 'vendor'),
  }
  if (r.settling !== undefined) {
    const settling = plainRecord(r.settling, ['first', 'later'], ['first', 'later'], 'settling data')
    if (!isStreamStamp(settling.first)) throw new ReportInvalid('an unsettled entry carries a bad stamp')
    const later = plainList(settling.later, MAX_SETTLING_LATER, 'settling stamps')
    if (!later.every(isStreamStamp)) throw new ReportInvalid('an unsettled entry carries a bad stamp')
    entry.settling = { first: settling.first, later: later as string[] }
  }
  return entry
}

/**
 * Judge an entry against its item and its bucket: the value shape the item's mode demands, a delta that is the
 * difference of the two values, and the tolerance verdict the catalogue's measure gives (bothEqual must be within it,
 * bothDiffer must not be, or the currencies must differ). Nothing is taken on the writer's word.
 */
export function checkEntry(id: PackItemId, bucket: ComparisonBucket, entry: CleanEntry): void {
  const fail = (why: string): never => { throw new ReportInvalid(`item ${id}: ${bucket} entry ${why}`) }
  const spec = getPackItem(id)
  if ((entry.settling !== undefined) !== (bucket === 'unsettled')) fail('settling data belongs to unsettled entries and to nothing else')
  if (!entry.imsPresent && !entry.vendorPresent) fail('is present on neither side')

  // What the entry says about the pair, derived from the recorded fields alone: the bucket is judged against this, never believed.
  let derived: 'onlyIms' | 'onlyVendor' | 'bothEqual' | 'bothDiffer'
  let delta: string | null = null
  if (spec.mode === 'presence') {
    if (entry.ims !== null || entry.vendor !== null || entry.delta !== null || entry.imsCurrency !== null || entry.vendorCurrency !== null) fail('a presence item carries no values')
    derived = entry.imsPresent && entry.vendorPresent ? 'bothEqual' : entry.imsPresent ? 'onlyIms' : 'onlyVendor'
  } else {
    const measure = spec.measure!
    const a = parseDecimalStrict(entry.ims)
    const b = parseDecimalStrict(entry.vendor)
    if (entry.imsPresent !== (a !== null) || entry.vendorPresent !== (b !== null)) fail('has a presence flag that disagrees with its value')
    if (measure.rule === 'minor-unit' && ((a !== null && entry.imsCurrency === null) || (b !== null && entry.vendorCurrency === null))) fail('needs a currency for each value')
    if ((a === null && entry.imsCurrency !== null) || (b === null && entry.vendorCurrency !== null)) fail('has a currency for a missing value')
    if (a !== null && b !== null) {
      if ((entry.imsCurrency === null) !== (entry.vendorCurrency === null)) fail('has a currency on one side only')
      delta = decimalText(a.minus(b))
      let equal: boolean
      if (entry.imsCurrency !== entry.vendorCurrency) equal = false
      else {
        const within = withinTolerance(measure, a, b, entry.imsCurrency)
        if (within === null) fail('has no usable currency for its tolerance')
        equal = within as boolean
      }
      derived = equal ? 'bothEqual' : 'bothDiffer'
    } else {
      derived = a !== null ? 'onlyIms' : 'onlyVendor'
    }
    // A delta exists exactly for a pair that is being judged (the four pair buckets and unsettled), and is the true one.
    const judgedPair = bucket === 'bothEqual' || bucket === 'bothDiffer' || bucket === 'unsettled'
    if (entry.delta !== (judgedPair ? delta : null)) fail('has the wrong delta')
  }

  switch (bucket) {
    case 'onlyIms': case 'onlyVendor': case 'bothEqual': case 'bothDiffer':
      if (derived !== bucket) fail(`is, by its own fields, ${derived}`)
      return
    case 'unsettled':
      if (derived === 'bothEqual') fail('is a pair that does not differ')
      return
    case 'excluded': case 'outOfPopulation':
      return
  }
}

/** One clean item: copied from the caller's, field by field. */
type CleanItem = { id: PackItemId; outcome: PackOutcome; reasons: PackReasonCode[]; proof: ItemProof | null; sources: PackSourceCode[]; entries: Record<ComparisonBucket, CleanEntry[]> }
type CleanInput = { runId: string; systemIdentifier: string; phase: ReadinessPhase; asOf: string; startedAt: string; finishedAt: string; streams: StreamBracket[]; items: CleanItem[] }

function cleanItem(raw: unknown): CleanItem {
  const r = plainRecord(raw, ['id', 'outcome', 'reasons', 'proof', 'sources', 'entries'], ['id', 'outcome', 'reasons'], 'an item')
  if (typeof r.id !== 'string' || !(PACK_ITEM_IDS as readonly string[]).includes(r.id)) throw new ReportInvalid('an item has an unknown id')
  const id = r.id as PackItemId
  if (typeof r.outcome !== 'string' || !(PACK_OUTCOMES as readonly string[]).includes(r.outcome)) throw new ReportInvalid(`item ${id}: unknown outcome`)
  const reasons = plainList(r.reasons, 32, `item ${id} reasons`)
  if (!reasons.every(isPackReasonCode)) throw new ReportInvalid(`item ${id}: unknown reason code`)
  const sources = r.sources === undefined ? [] : plainList(r.sources, 16, `item ${id} sources`)
  if (!sources.every(isPackSourceCode)) throw new ReportInvalid(`item ${id}: unknown source`)
  let proof: ItemProof | null = null
  if (r.proof !== undefined && r.proof !== null) {
    const kind = (plainRecord(r.proof, ['kind', 'source'], ['kind'], `item ${id} proof`)).kind
    const p = plainRecord(r.proof, kind === 'proven-empty' ? ['kind', 'source'] : ['kind'], kind === 'proven-empty' ? ['kind', 'source'] : ['kind'], `item ${id} proof`)
    if (p.kind === 'compared') proof = { kind: 'compared' }
    else if (p.kind === 'proven-empty' && isPackEmptyProofCode(p.source)) proof = { kind: 'proven-empty', source: p.source }
    else throw new ReportInvalid(`item ${id}: bad proof`)
  }
  const entries = Object.fromEntries(COMPARISON_BUCKETS.map((bucket) => [bucket, [] as CleanEntry[]])) as Record<ComparisonBucket, CleanEntry[]>
  if (r.entries !== undefined) {
    const e = plainRecord(r.entries, COMPARISON_BUCKETS, [], `item ${id} entries`)
    for (const bucket of COMPARISON_BUCKETS) {
      if (e[bucket] === undefined) continue
      entries[bucket] = plainList(e[bucket], MAX_ENTRIES_PER_BUCKET, `item ${id} ${bucket} entries`).map((raw) => cleanEntry(raw, id))
    }
  }
  return { id, outcome: r.outcome as PackOutcome, reasons: reasons as PackReasonCode[], proof, sources: sources as PackSourceCode[], entries }
}

function cleanInput(raw: unknown): CleanInput {
  const r = plainRecord(raw, ['runId', 'systemIdentifier', 'phase', 'asOf', 'startedAt', 'finishedAt', 'streams', 'items'], ['runId', 'systemIdentifier', 'phase', 'asOf', 'startedAt', 'finishedAt', 'streams', 'items'], 'the report input')
  if (typeof r.runId !== 'string' || !RUN_ID_RE.test(r.runId)) throw new ReportInvalid('runId has the wrong shape')
  if (typeof r.systemIdentifier !== 'string' || !SYSTEM_IDENTIFIER_RE.test(r.systemIdentifier)) throw new ReportInvalid('systemIdentifier has the wrong shape')
  if (typeof r.phase !== 'string' || !(PHASES as readonly string[]).includes(r.phase)) throw new ReportInvalid('unknown phase')
  if (typeof r.asOf !== 'string' || !AS_OF_RE.test(r.asOf) || Number.isNaN(Date.parse(`${r.asOf}T00:00:00Z`))) throw new ReportInvalid('asOf is not a date')
  if (!isStreamStamp(r.startedAt) || !isStreamStamp(r.finishedAt)) throw new ReportInvalid('a run time is not an ISO time')
  const streams = plainList(r.streams, READ_SYNC_STREAM_IDS.length, 'streams').map((raw): StreamBracket => {
    const b = plainRecord(raw, ['stream', 'start', 'end'], ['stream', 'start', 'end'], 'a stream bracket')
    if (!isReadSyncStream(b.stream)) throw new ReportInvalid('a stream is unknown')
    for (const stamp of [b.start, b.end]) if (stamp !== null && !isStreamStamp(stamp)) throw new ReportInvalid('a stream stamp is not an ISO time')
    return { stream: b.stream, start: b.start as string | null, end: b.end as string | null }
  })
  const items = plainList(r.items, PACK_ITEM_IDS.length, 'items').map(cleanItem)
  return { runId: r.runId, systemIdentifier: r.systemIdentifier, phase: r.phase as ReadinessPhase, asOf: r.asOf, startedAt: r.startedAt as string, finishedAt: r.finishedAt as string, streams, items }
}

/** Evidence lines for one item, findings first, capped. Every line is built from named fields of a clean entry. */
function itemEvidence(item: CleanItem, maxLines: number): { lines: string[]; counts: Record<ComparisonBucket, number>; cut: boolean; equalKeys: string[] } {
  const counts = Object.fromEntries(COMPARISON_BUCKETS.map((bucket) => [bucket, 0])) as Record<ComparisonBucket, number>
  const lines: string[] = []
  const equalKeys: string[] = []
  const seen = new Set<string>()
  let cut = false
  for (const bucket of EMIT_ORDER) {
    for (const entry of item.entries[bucket]) {
      checkEntry(item.id, bucket, entry)
      if (seen.has(entry.key)) throw new ReportInvalid(`item ${item.id}: an identity appears twice`)
      seen.add(entry.key)
      if (lines.length >= maxLines) { cut = true; continue }
      lines.push(evidenceLine(item.id, bucket, entry))
      counts[bucket] += 1
      if (bucket === 'bothEqual') equalKeys.push(entry.key)
    }
  }
  return { lines, counts, cut, equalKeys }
}

function evidenceLine(item: PackItemId, bucket: ComparisonBucket, entry: CleanEntry): string {
  const line = { item, bucket, key: entry.key, ims: entry.ims, vendor: entry.vendor, delta: entry.delta, imsCurrency: entry.imsCurrency, vendorCurrency: entry.vendorCurrency, imsPresent: entry.imsPresent, vendorPresent: entry.vendorPresent, ...(entry.settling ? { settling: { first: entry.settling.first, later: [...entry.settling.later] } } : {}) }
  return JSON.stringify(line)
}

/** The item record every reader and writer accepts: one place, so the builder and the reader cannot drift apart. */
export type ItemRecordView = { id: PackItemId; outcome: PackOutcome; reasons: readonly PackReasonCode[]; proof: ItemProof | null; sources: readonly PackSourceCode[] }

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
}

export function checkItemConsistency(input: ItemRecordView, applicability: PackApplicability, counts: Record<ComparisonBucket, number>, cut: boolean, streams: readonly StreamBracket[]): PackReasonCode[] {
  const fail = (why: string): never => { throw new ReportInvalid(`item ${input.id}: ${why}`) }
  if (!(PACK_OUTCOMES as readonly string[]).includes(input.outcome)) fail('unknown outcome')
  for (const reason of input.reasons) if (!isPackReasonCode(reason)) fail('unknown reason code')
  if (!input.sources.every(isPackSourceCode) || new Set(input.sources).size !== input.sources.length) fail('unknown or repeated source')
  const spec = getPackItem(input.id)
  if (!input.sources.every((source) => spec.sources.includes(source))) fail('a source the catalogue does not list for this item')
  const reasons = [...new Set(input.reasons)]
  const findings = FINDING_BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0)
  const everything = COMPARISON_BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0)
  const has = (code: PackReasonCode) => reasons.includes(code)

  // Reason/count coupling that holds for every outcome.
  if (has('PHASE_NOT_APPLICABLE') !== (input.outcome === 'not-applicable')) fail('PHASE_NOT_APPLICABLE belongs to not-applicable and nothing else')
  if (has('UNSETTLED_PENDING') !== (counts.unsettled > 0)) fail('UNSETTLED_PENDING and the unsettled count must agree')
  if (has('NO_RUNNER') && (input.outcome !== 'inconclusive' || everything !== 0)) fail('NO_RUNNER is an inconclusive item with nothing listed')
  if (findings > 0 && (input.outcome !== 'fail' || !has('DIFFERENCES'))) fail('a finding makes the item a fail with DIFFERENCES')
  if (input.proof !== null && input.outcome !== 'pass') fail('only a pass carries a proof')

  if (applicability === 'not-applicable') {
    if (input.outcome !== 'not-applicable' || reasons.length !== 1) fail('the phase does not apply it, so it must be not-applicable with PHASE_NOT_APPLICABLE only')
  } else if (input.outcome === 'not-applicable') {
    fail('the phase applies it, so it cannot be not-applicable')
  }
  if (input.outcome === 'not-applicable' && (everything !== 0 || input.sources.length !== 0)) fail('a not-applicable item lists nothing and reads nothing')

  if (input.outcome === 'pass') {
    if (reasons.length > 0) fail('a pass carries no reason')
    if (counts.unsettled > 0) fail('a pass has nothing unsettled')
    const proof = input.proof
    if (proof === null) throw new ReportInvalid(`item ${input.id}: a pass needs a proof: identities compared, or a named proof that empty is true`)
    if (proof.kind !== 'compared' && proof.kind !== 'proven-empty') fail('unknown proof kind')
    if (proof.kind === 'compared' && counts.bothEqual === 0) fail('a "compared" proof needs at least one identity compared and equal')
    if (proof.kind === 'proven-empty' && (counts.bothEqual !== 0 || !isPackEmptyProofCode(proof.source))) fail('a "proven-empty" proof needs nothing compared and a named proof source')
    if (!sameSet(input.sources, spec.sources)) fail('a pass names exactly the sources its catalogue row lists')
    for (const stream of spec.streams) {
      const bracket = streams.find((entry) => entry.stream === stream)
      if (!bracket || !bracketStable(bracket.start, bracket.end)) fail(`a pass needs an equal start and end stamp for stream ${stream}`)
    }
  } else if (input.outcome === 'fail') {
    if (!has('DIFFERENCES')) fail('a fail names DIFFERENCES')
  } else if (input.outcome === 'inconclusive') {
    if (reasons.length === 0) fail('inconclusive needs a reason code')
    if (has('DIFFERENCES')) fail('an inconclusive item reports no difference')
  }
  if (cut) {
    if (input.outcome === 'pass') fail('a capped listing cannot pass')
    if (!reasons.includes('CAP_EXCEEDED')) reasons.push('CAP_EXCEEDED')
  }
  return reasons
}

export type BuiltReport = { body: ReportBody; record: ReportRecord; jsonText: string; evidenceText: string; markdown: string }

/**
 * Build a report from caller data. The caller's objects are copied field by field into clean ones (shape.ts) before
 * anything else; every entry is judged; the records and the evidence are built from the clean values only; and
 * then the finished text is read back by the SAME validation a reader applies (parseReport, verifyEvidence, the
 * Markdown digest) BEFORE this function returns. Nothing reaches a file unless it has already passed the reader.
 */
/** Tests lower the cap so the cut can be exercised without a hundred thousand entries; it can never be raised above the constant. */
export type BuildOptions = { maxLinesPerItem?: number }

export function buildReport(raw: ReportInput, sequence: number, previousReportSha256: string | null, options: BuildOptions = {}): BuiltReport {
  const maxLines = options.maxLinesPerItem ?? MAX_EVIDENCE_LINES_PER_ITEM
  if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > MAX_EVIDENCE_LINES_PER_ITEM) throw new ReportInvalid('the line cap must be a whole number from 1 to the constant')
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ReportInvalid('sequence must be a positive integer')
  if ((sequence === 1) !== (previousReportSha256 === null)) throw new ReportInvalid('previousReportSha256 is null exactly for sequence 1')
  if (previousReportSha256 !== null && !SHA256_RE.test(previousReportSha256)) throw new ReportInvalid('previousReportSha256 is not a sha256')
  let input: CleanInput
  try { input = cleanInput(raw) } catch (error) {
    if (error instanceof ShapeError) throw new ReportInvalid(error.message)
    throw error
  }
  const streams = [...input.streams].sort((a, b) => a.stream.localeCompare(b.stream))
  for (const [index, bracket] of streams.entries()) if (index > 0 && streams[index - 1]!.stream === bracket.stream) throw new ReportInvalid('a stream is repeated')
  const byId = new Map(input.items.map((item) => [item.id, item]))
  if (byId.size !== input.items.length || PACK_ITEM_IDS.some((id) => !byId.has(id)) || input.items.length !== PACK_ITEM_IDS.length) {
    throw new ReportInvalid('the report must carry each of R1 to R15 exactly once')
  }

  const evidenceLines: string[] = []
  const items: ItemResult[] = PACK_ITEM_IDS.map((id) => {
    const item = byId.get(id)!
    const applicability = itemApplicability(id, input.phase)
    const evidence = itemEvidence(item, maxLines)
    const sources = [...item.sources].sort()
    const reasons = checkItemConsistency({ id, outcome: item.outcome, reasons: item.reasons, proof: item.proof, sources }, applicability, evidence.counts, evidence.cut, streams)
    evidenceLines.push(...evidence.lines)
    return { id, applicability, outcome: item.outcome, reasons, proof: item.proof, sources, counts: evidence.counts, bothEqualSha256: equalDigest(evidence.equalKeys), evidenceLines: evidence.lines.length }
  })
  const evidenceText = evidenceLines.length ? `${evidenceLines.join('\n')}\n` : ''
  const body: ReportBody = {
    schemaVersion: PACK_SCHEMA_VERSION,
    kind: PACK_REPORT_KIND,
    runId: input.runId,
    systemIdentifier: input.systemIdentifier,
    phase: input.phase,
    asOf: input.asOf,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    sequence,
    previousReportSha256,
    streams,
    items,
    summary: summarise(items),
    exitCode: deriveExitCode(items),
    evidence: { file: PACK_EVIDENCE_FILE, sha256: sha256Hex(evidenceText), lines: evidenceLines.length },
  }
  const markdown = renderMarkdown(body)
  const record: ReportRecord = { ...body, companionMarkdownSha256: sha256Hex(markdown) }
  const jsonText = `${JSON.stringify(record, null, 2)}\n`
  // The reader's own validation, on the finished text, before anything can be written.
  const parsed = parseReport(jsonText)
  verifyEvidence(evidenceText, parsed)
  if (sha256Hex(markdown) !== parsed.companionMarkdownSha256) throw new ReportInvalid('the Markdown does not match its digest')
  return { body, record, jsonText, evidenceText, markdown }
}

/** The Markdown: closed words, validated values and counts. It names no identity. */
export function renderMarkdown(body: ReportBody): string {
  const out: string[] = []
  out.push('# Reconciliation pack', '')
  out.push(`- Run: ${body.runId}`, `- System: ${body.systemIdentifier}`, `- Phase: ${body.phase}`, `- As of: ${body.asOf}`)
  out.push(`- Started: ${body.startedAt}`, `- Finished: ${body.finishedAt}`)
  out.push(`- Sequence: ${body.sequence}`, `- Previous report sha256: ${body.previousReportSha256 ?? 'none (first report)'}`)
  out.push(`- Evidence: ${body.evidence.file}, ${body.evidence.lines} lines, sha256 ${body.evidence.sha256}`)
  out.push(`- Summary: ${body.summary.pass} pass, ${body.summary.fail} fail, ${body.summary.inconclusive} inconclusive, ${body.summary.notApplicable} not-applicable`)
  out.push(`- Exit code: ${body.exitCode}`, '')
  out.push('This report renders no overall verdict; the readiness gate decides. Identities are in the evidence file only, as sanitised tokens.', '')
  out.push('| Item | Title | Phase applicability | Outcome | Proof | Sources | Reasons | onlyIms | onlyVendor | bothEqual | bothDiffer | unsettled | outOfPopulation | excluded |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const item of body.items) {
    const c = item.counts
    out.push(`| ${item.id} | ${getPackItem(item.id).title} | ${item.applicability} | ${item.outcome} | ${item.proof ? (item.proof.kind === 'compared' ? 'compared' : `proven-empty (${item.proof.source})`) : '-'} | ${item.sources.join(', ') || '-'} | ${item.reasons.join(', ') || '-'} | ${c.onlyIms} | ${c.onlyVendor} | ${c.bothEqual} | ${c.bothDiffer} | ${c.unsettled} | ${c.outOfPopulation} | ${c.excluded} |`)
  }
  out.push('', '| Stream | Stamp at start | Stamp at end |', '|---|---|---|')
  for (const s of body.streams) out.push(`| ${s.stream} | ${s.start ?? 'none'} | ${s.end ?? 'none'} |`)
  out.push('')
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------------------------

const BODY_KEYS = ['schemaVersion', 'kind', 'runId', 'systemIdentifier', 'phase', 'asOf', 'startedAt', 'finishedAt', 'sequence', 'previousReportSha256', 'streams', 'items', 'summary', 'exitCode', 'evidence', 'companionMarkdownSha256']
const ITEM_KEYS = ['id', 'applicability', 'outcome', 'reasons', 'proof', 'sources', 'counts', 'bothEqualSha256', 'evidenceLines']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ReportInvalid(`${what} has unexpected or missing fields`)
}

/** Validate JSON text as a report record. Nothing in the result was taken on trust; derived values are recomputed. */
export function parseReport(text: string): ReportRecord {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new ReportInvalid('the report is not JSON') }
  if (!isRecord(raw)) throw new ReportInvalid('the report is not an object')
  exactKeys(raw, BODY_KEYS, 'the report')
  if (raw.schemaVersion !== PACK_SCHEMA_VERSION || raw.kind !== PACK_REPORT_KIND) throw new ReportInvalid('wrong schema version or kind')
  if (typeof raw.runId !== 'string' || !RUN_ID_RE.test(raw.runId)) throw new ReportInvalid('bad runId')
  if (typeof raw.systemIdentifier !== 'string' || !SYSTEM_IDENTIFIER_RE.test(raw.systemIdentifier)) throw new ReportInvalid('bad systemIdentifier')
  if (typeof raw.phase !== 'string' || !(PHASES as readonly string[]).includes(raw.phase)) throw new ReportInvalid('bad phase')
  if (typeof raw.asOf !== 'string' || !AS_OF_RE.test(raw.asOf)) throw new ReportInvalid('bad asOf')
  if (!isStreamStamp(raw.startedAt) || !isStreamStamp(raw.finishedAt)) throw new ReportInvalid('bad run time')
  if (typeof raw.sequence !== 'number' || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1) throw new ReportInvalid('bad sequence')
  if (raw.previousReportSha256 !== null && !(typeof raw.previousReportSha256 === 'string' && SHA256_RE.test(raw.previousReportSha256))) throw new ReportInvalid('bad previousReportSha256')
  if ((raw.sequence === 1) !== (raw.previousReportSha256 === null)) throw new ReportInvalid('previousReportSha256 is null exactly for sequence 1')
  if (typeof raw.companionMarkdownSha256 !== 'string' || !SHA256_RE.test(raw.companionMarkdownSha256)) throw new ReportInvalid('bad companionMarkdownSha256')
  const phase = raw.phase as ReadinessPhase

  if (!Array.isArray(raw.streams) || raw.streams.length > READ_SYNC_STREAM_IDS.length) throw new ReportInvalid('bad streams')
  const streams: StreamBracket[] = raw.streams.map((entry: unknown) => {
    if (!isRecord(entry)) throw new ReportInvalid('bad stream entry')
    exactKeys(entry, ['stream', 'start', 'end'], 'a stream entry')
    if (!isReadSyncStream(entry.stream)) throw new ReportInvalid('unknown stream')
    for (const stamp of [entry.start, entry.end]) if (stamp !== null && !isStreamStamp(stamp)) throw new ReportInvalid('bad stream stamp')
    return { stream: entry.stream, start: entry.start as string | null, end: entry.end as string | null }
  })
  if (new Set(streams.map((s) => s.stream)).size !== streams.length) throw new ReportInvalid('a stream is repeated')

  if (!Array.isArray(raw.items) || raw.items.length !== PACK_ITEM_IDS.length) throw new ReportInvalid('the report must carry R1 to R15')
  const items: ItemResult[] = raw.items.map((entry: unknown, index: number) => {
    if (!isRecord(entry)) throw new ReportInvalid('bad item')
    exactKeys(entry, ITEM_KEYS, 'an item')
    const id = PACK_ITEM_IDS[index]!
    if (entry.id !== id) throw new ReportInvalid('items are not R1 to R15 in order')
    const applicability = itemApplicability(id, phase)
    if (entry.applicability !== applicability || !(PACK_APPLICABILITY as readonly string[]).includes(entry.applicability as string)) throw new ReportInvalid(`item ${id}: applicability does not match the catalogue`)
    if (typeof entry.outcome !== 'string' || !(PACK_OUTCOMES as readonly string[]).includes(entry.outcome)) throw new ReportInvalid(`item ${id}: bad outcome`)
    if (!Array.isArray(entry.reasons) || !entry.reasons.every(isPackReasonCode) || new Set(entry.reasons).size !== entry.reasons.length) throw new ReportInvalid(`item ${id}: bad reasons`)
    let proof: ItemProof | null = null
    if (entry.proof !== null) {
      if (!isRecord(entry.proof)) throw new ReportInvalid(`item ${id}: bad proof`)
      if (entry.proof.kind === 'compared') { exactKeys(entry.proof, ['kind'], 'a proof'); proof = { kind: 'compared' } }
      else if (entry.proof.kind === 'proven-empty' && isPackEmptyProofCode(entry.proof.source)) { exactKeys(entry.proof, ['kind', 'source'], 'a proof'); proof = { kind: 'proven-empty', source: entry.proof.source } }
      else throw new ReportInvalid(`item ${id}: bad proof`)
    }
    if (!Array.isArray(entry.sources) || !entry.sources.every(isPackSourceCode)) throw new ReportInvalid(`item ${id}: bad sources`)
    const sources = entry.sources as PackSourceCode[]
    if (!isRecord(entry.counts)) throw new ReportInvalid(`item ${id}: bad counts`)
    exactKeys(entry.counts, COMPARISON_BUCKETS, 'counts')
    const counts = Object.fromEntries(COMPARISON_BUCKETS.map((bucket) => {
      const n = (entry.counts as Record<string, unknown>)[bucket]
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new ReportInvalid(`item ${id}: bad count`)
      return [bucket, n]
    })) as Record<ComparisonBucket, number>
    if (entry.bothEqualSha256 !== null && !(typeof entry.bothEqualSha256 === 'string' && SHA256_RE.test(entry.bothEqualSha256))) throw new ReportInvalid(`item ${id}: bad bothEqualSha256`)
    if ((entry.bothEqualSha256 === null) !== (counts.bothEqual === 0)) throw new ReportInvalid(`item ${id}: bothEqual count and digest disagree`)
    if (typeof entry.evidenceLines !== 'number' || entry.evidenceLines !== COMPARISON_BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0)) throw new ReportInvalid(`item ${id}: evidenceLines is not the sum of the counts`)
    const result: ItemResult = { id, applicability, outcome: entry.outcome as PackOutcome, reasons: entry.reasons as PackReasonCode[], proof, sources, counts, bothEqualSha256: entry.bothEqualSha256 as string | null, evidenceLines: entry.evidenceLines }
    // The same consistency rules the builder applies.
    checkItemConsistency({ id, outcome: result.outcome, reasons: result.reasons, proof, sources }, applicability, counts, false, streams)
    return result
  })

  if (!isRecord(raw.summary)) throw new ReportInvalid('bad summary')
  exactKeys(raw.summary, ['pass', 'fail', 'inconclusive', 'notApplicable'], 'the summary')
  const summary = summarise(items)
  for (const key of Object.keys(summary) as Array<keyof ReportSummary>) if (raw.summary[key] !== summary[key]) throw new ReportInvalid('the summary does not match the items')
  if (raw.exitCode !== deriveExitCode(items)) throw new ReportInvalid('the exit code does not match the items')
  if (!isRecord(raw.evidence)) throw new ReportInvalid('bad evidence record')
  exactKeys(raw.evidence, ['file', 'sha256', 'lines'], 'the evidence record')
  if (raw.evidence.file !== PACK_EVIDENCE_FILE || typeof raw.evidence.sha256 !== 'string' || !SHA256_RE.test(raw.evidence.sha256) || typeof raw.evidence.lines !== 'number' || !Number.isSafeInteger(raw.evidence.lines)) throw new ReportInvalid('bad evidence record')
  if (raw.evidence.lines !== items.reduce((sum, item) => sum + item.evidenceLines, 0)) throw new ReportInvalid('the evidence line count does not match the items')

  return {
    schemaVersion: PACK_SCHEMA_VERSION, kind: PACK_REPORT_KIND, runId: raw.runId, systemIdentifier: raw.systemIdentifier, phase, asOf: raw.asOf,
    startedAt: raw.startedAt, finishedAt: raw.finishedAt, sequence: raw.sequence, previousReportSha256: raw.previousReportSha256 as string | null,
    streams, items, summary, exitCode: raw.exitCode, evidence: { file: PACK_EVIDENCE_FILE, sha256: raw.evidence.sha256, lines: raw.evidence.lines },
    companionMarkdownSha256: raw.companionMarkdownSha256,
  }
}

/**
 * Validate evidence text against a parsed report: the digest, the line count, every line (strict fields, the item's
 * mode and measure, the true delta, the verdict), then every per-item per-bucket count and every bothEqual digest
 * RECOMPUTED from the lines. The report's own counts and digests are what is being checked, never what is believed.
 */
export function verifyEvidence(text: string, record: ReportRecord): void {
  if (sha256Hex(text) !== record.evidence.sha256) throw new ReportInvalid('the evidence does not match the digest the report records')
  if (text.length > 0 && !text.endsWith('\n')) throw new ReportInvalid('the evidence does not end with a newline')
  const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n')
  if (lines.length !== record.evidence.lines) throw new ReportInvalid('the evidence line count does not match the report')
  const tally = new Map<string, number>()
  const equalKeys = new Map<PackItemId, string[]>()
  const seen = new Map<string, Set<string>>()
  for (const line of lines) {
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { throw new ReportInvalid('an evidence line is not JSON') }
    let fields: Record<string, unknown>
    try { fields = plainRecord(parsed, ['item', 'bucket', ...ENTRY_KEYS], ['item', 'bucket', 'key', 'ims', 'vendor', 'delta', 'imsCurrency', 'vendorCurrency', 'imsPresent', 'vendorPresent'], 'an evidence line') } catch (error) {
      if (error instanceof ShapeError) throw new ReportInvalid(error.message)
      throw error
    }
    if (typeof fields.item !== 'string' || !(PACK_ITEM_IDS as readonly string[]).includes(fields.item)) throw new ReportInvalid('an evidence line names an unknown item')
    if (typeof fields.bucket !== 'string' || !(LISTED_BUCKETS as readonly string[]).includes(fields.bucket)) throw new ReportInvalid('an evidence line names an unknown bucket')
    const id = fields.item as PackItemId
    const bucket = fields.bucket as ComparisonBucket
    let entry: CleanEntry
    try {
      const { item: _item, bucket: _bucket, ...rest } = fields
      void _item; void _bucket
      entry = cleanEntry(rest, null)
    } catch (error) {
      if (error instanceof ShapeError) throw new ReportInvalid(error.message)
      throw error
    }
    checkEntry(id, bucket, entry)
    const identities = seen.get(id) ?? new Set<string>()
    if (identities.has(entry.key)) throw new ReportInvalid(`item ${id}: an identity appears twice in the evidence`)
    identities.add(entry.key)
    seen.set(id, identities)
    const tallyKey = `${id}/${bucket}`
    tally.set(tallyKey, (tally.get(tallyKey) ?? 0) + 1)
    if (bucket === 'bothEqual') equalKeys.set(id, [...(equalKeys.get(id) ?? []), entry.key])
  }
  for (const item of record.items) {
    for (const bucket of LISTED_BUCKETS) {
      if ((tally.get(`${item.id}/${bucket}`) ?? 0) !== item.counts[bucket]) throw new ReportInvalid(`item ${item.id}: ${bucket} count is not what the evidence lists`)
    }
    if (equalDigest(equalKeys.get(item.id) ?? []) !== item.bothEqualSha256) throw new ReportInvalid(`item ${item.id}: the bothEqual identities do not match their digest`)
  }
}
