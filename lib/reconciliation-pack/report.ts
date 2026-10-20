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
import { bracketStable, isStreamStamp, type CompareEntry, parseDecimalStrict } from '@/lib/reconciliation-pack/compare'
import {
  COMPARISON_BUCKETS,
  FINDING_BUCKETS,
  MAX_EVIDENCE_LINES_PER_ITEM,
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

export const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/
export const AS_OF_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
export const SHA256_RE = /^[0-9a-f]{64}$/
const PHASES: readonly ReadinessPhase[] = ['P0', 'P1', 'P2']

/** The buckets whose members are listed one per evidence line. bothEqual is a count and a digest of its identities. */
export const LISTED_BUCKETS: readonly ComparisonBucket[] = ['onlyIms', 'onlyVendor', 'bothDiffer', 'unsettled', 'excluded', 'outOfPopulation']

export type ItemInput = {
  id: PackItemId
  outcome: PackOutcome
  reasons: readonly PackReasonCode[]
  /** Required for a pass (see checkItemConsistency); null/absent otherwise. */
  proof?: ItemProof | null
  /** The sources the item read; a pass must name exactly its catalogue row's. */
  sources?: readonly PackSourceCode[]
  entries?: Partial<Record<ComparisonBucket, readonly CompareEntry[]>>
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

export function equalDigest(entries: readonly CompareEntry[]): string | null {
  if (entries.length === 0) return null
  return sha256Hex([...entries.map((entry) => entry.key)].sort().join('\n'))
}

function validateEntry(entry: CompareEntry): void {
  if (!isSafeTokenShape(entry.key)) throw new ReportInvalid('an entry key is not a sanitised token')
  for (const value of [entry.ims, entry.vendor, entry.delta]) {
    if (value !== null && parseDecimalStrict(value) === null) throw new ReportInvalid('an entry value is not a plain decimal')
  }
  if (entry.settling) {
    if (!isStreamStamp(entry.settling.first) || !entry.settling.later.every(isStreamStamp)) throw new ReportInvalid('an unsettled entry carries a bad stamp')
  }
}

/** Evidence lines for one item, findings first, capped. Returns the lines and whether the cap cut any. */
function itemEvidence(item: ItemInput): { lines: string[]; counts: Record<ComparisonBucket, number>; cut: boolean } {
  const counts = Object.fromEntries(COMPARISON_BUCKETS.map((bucket) => [bucket, 0])) as Record<ComparisonBucket, number>
  const lines: string[] = []
  let cut = false
  for (const bucket of COMPARISON_BUCKETS) {
    const entries = item.entries?.[bucket] ?? []
    entries.forEach(validateEntry)
    if (bucket === 'bothEqual') { counts.bothEqual = entries.length; continue }
    for (const entry of entries) {
      if (lines.length >= MAX_EVIDENCE_LINES_PER_ITEM) { cut = true; continue }
      const line: Record<string, unknown> = { item: item.id, bucket, key: entry.key, ims: entry.ims, vendor: entry.vendor, delta: entry.delta }
      if (entry.settling) line.settling = entry.settling
      lines.push(JSON.stringify(line))
      counts[bucket] += 1
    }
  }
  return { lines, counts, cut }
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

export function buildReport(input: ReportInput, sequence: number, previousReportSha256: string | null): { body: ReportBody; evidenceText: string; markdown: string } {
  if (!RUN_ID_RE.test(input.runId)) throw new ReportInvalid('runId has the wrong shape')
  if (!SYSTEM_IDENTIFIER_RE.test(input.systemIdentifier)) throw new ReportInvalid('systemIdentifier has the wrong shape')
  if (!PHASES.includes(input.phase)) throw new ReportInvalid('unknown phase')
  if (!AS_OF_RE.test(input.asOf) || Number.isNaN(Date.parse(`${input.asOf}T00:00:00Z`))) throw new ReportInvalid('asOf is not a date')
  if (!isStreamStamp(input.startedAt) || !isStreamStamp(input.finishedAt)) throw new ReportInvalid('a run time is not an ISO time')
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ReportInvalid('sequence must be a positive integer')
  if ((sequence === 1) !== (previousReportSha256 === null)) throw new ReportInvalid('previousReportSha256 is null exactly for sequence 1')
  if (previousReportSha256 !== null && !SHA256_RE.test(previousReportSha256)) throw new ReportInvalid('previousReportSha256 is not a sha256')
  const streams = [...input.streams].sort((a, b) => a.stream.localeCompare(b.stream))
  for (const [index, bracket] of streams.entries()) {
    if (!isReadSyncStream(bracket.stream) || (index > 0 && streams[index - 1]!.stream === bracket.stream)) throw new ReportInvalid('a stream is unknown or repeated')
    for (const stamp of [bracket.start, bracket.end]) if (stamp !== null && !isStreamStamp(stamp)) throw new ReportInvalid('a stream stamp is not an ISO time')
  }
  const byId = new Map(input.items.map((item) => [item.id, item]))
  if (byId.size !== input.items.length || PACK_ITEM_IDS.some((id) => !byId.has(id)) || input.items.length !== PACK_ITEM_IDS.length) {
    throw new ReportInvalid('the report must carry each of R1 to R15 exactly once')
  }

  const evidenceLines: string[] = []
  const items: ItemResult[] = PACK_ITEM_IDS.map((id) => {
    const item = byId.get(id)!
    const applicability = itemApplicability(id, input.phase)
    const evidence = itemEvidence(item)
    const proof = item.proof ?? null
    const sources = [...(item.sources ?? [])].sort()
    const reasons = checkItemConsistency({ id, outcome: item.outcome, reasons: item.reasons, proof, sources }, applicability, evidence.counts, evidence.cut, streams)
    const outcome = item.outcome
    evidenceLines.push(...evidence.lines)
    return { id, applicability, outcome, reasons, proof, sources, counts: evidence.counts, bothEqualSha256: equalDigest(item.entries?.bothEqual ?? []), evidenceLines: evidence.lines.length }
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
  return { body, evidenceText, markdown: renderMarkdown(body) }
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
    if (typeof entry.evidenceLines !== 'number' || entry.evidenceLines !== LISTED_BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0)) throw new ReportInvalid(`item ${id}: evidenceLines is not the sum of the listed counts`)
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

/** Validate evidence text against a parsed report: digest, line count, strict lines, and per-item per-bucket counts recomputed from the lines. */
export function verifyEvidence(text: string, record: ReportRecord): void {
  if (sha256Hex(text) !== record.evidence.sha256) throw new ReportInvalid('the evidence does not match the digest the report records')
  if (text.length > 0 && !text.endsWith('\n')) throw new ReportInvalid('the evidence does not end with a newline')
  const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n')
  if (lines.length !== record.evidence.lines) throw new ReportInvalid('the evidence line count does not match the report')
  const tally = new Map<string, number>()
  for (const line of lines) {
    let entry: unknown
    try { entry = JSON.parse(line) } catch { throw new ReportInvalid('an evidence line is not JSON') }
    if (!isRecord(entry)) throw new ReportInvalid('an evidence line is not an object')
    const keys = Object.keys(entry).includes('settling') ? ['item', 'bucket', 'key', 'ims', 'vendor', 'delta', 'settling'] : ['item', 'bucket', 'key', 'ims', 'vendor', 'delta']
    exactKeys(entry, keys, 'an evidence line')
    if (typeof entry.item !== 'string' || !(PACK_ITEM_IDS as readonly string[]).includes(entry.item)) throw new ReportInvalid('an evidence line names an unknown item')
    if (typeof entry.bucket !== 'string' || !(LISTED_BUCKETS as readonly string[]).includes(entry.bucket)) throw new ReportInvalid('an evidence line names an unknown bucket')
    if (!isSafeTokenShape(entry.key)) throw new ReportInvalid('an evidence key is not a sanitised token')
    for (const value of [entry.ims, entry.vendor, entry.delta]) if (value !== null && parseDecimalStrict(value) === null) throw new ReportInvalid('an evidence value is not a plain decimal')
    if (entry.settling !== undefined) {
      if (entry.bucket !== 'unsettled' || !isRecord(entry.settling)) throw new ReportInvalid('settling data on a line that is not unsettled')
      exactKeys(entry.settling, ['first', 'later'], 'settling data')
      if (!isStreamStamp(entry.settling.first) || !Array.isArray(entry.settling.later) || !entry.settling.later.every(isStreamStamp)) throw new ReportInvalid('bad settling stamps')
    } else if (entry.bucket === 'unsettled') throw new ReportInvalid('an unsettled line carries no settling data')
    const tallyKey = `${entry.item}/${entry.bucket}`
    tally.set(tallyKey, (tally.get(tallyKey) ?? 0) + 1)
  }
  for (const item of record.items) {
    for (const bucket of LISTED_BUCKETS) {
      if ((tally.get(`${item.id}/${bucket}`) ?? 0) !== item.counts[bucket]) throw new ReportInvalid(`item ${item.id}: ${bucket} count is not what the evidence lists`)
    }
  }
}
