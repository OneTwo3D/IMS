/**
 * THE PACK'S LIVENESS BRACKET: is the data behind an item still being kept current, at the START and again at the
 * END of the run?
 *
 * `buildReadSyncStatusReport` is read twice. Each read is reduced to plain, validated entries (a stream, its
 * instance, its state, its last-success stamp, its age limit, its age) plus the scheduler block. Two reads make one
 * bracket, and an item's verdict is derived from the bracket by one function:
 *
 *   - Every entry of every stream the item depends on must be `fresh` at BOTH reads, with a usable stamp.
 *   - The stamp must be EQUAL at both reads. Stamps are compared for equality only, never for order, and nothing
 *     here derives an order or an age from two stamps; the age limit is the status report's own `fresh` state.
 *   - The scheduler must have been read and the managed block must be trusted, at both reads, and no job the item's
 *     streams depend on may be unscheduled or disabled.
 *   - If either read failed or came back malformed, EVERY item is inconclusive. There is no "no liveness is fine".
 *
 * Nothing here passes anything. It can only withhold a pass: the item keeps its numbers and becomes inconclusive
 * with STALE_BASIS (or BASIS_MOVED when everything was fresh but a stamp moved, SOURCE_UNREADABLE when a read failed).
 *
 * No database, no network, no write of its own: the status report it calls reads settings, bindings and the
 * crontab (a child process) and nothing else. The report builder is injected, so the tests drive it directly.
 */

import { READ_SYNC_ALARM_CRON_SLUG, READ_SYNC_STREAMS, READ_SYNC_STREAM_IDS, READ_SYNC_STATUS_SCHEMA_VERSION, type ReadSyncStreamId } from '@/lib/ops/read-sync-liveness-constants'
import type { ReadSyncReport } from '@/lib/ops/read-sync-status'
import { isStreamStamp } from '@/lib/reconciliation-pack/compare'
import { getPackItem, type PackItemId, type PackReasonCode } from '@/lib/reconciliation-pack/constants'
import { identityToken, type SafeToken } from '@/lib/reconciliation-pack/identity'
import type { StreamBracket } from '@/lib/reconciliation-pack/report'

export const LIVENESS_STATES = ['fresh', 'stale', 'never', 'off', 'invalid'] as const
export type LivenessState = (typeof LIVENESS_STATES)[number]

/** One entry of one read, reduced to what the bracket needs. `invalid` is any state the status report is not defined to give. */
export type LivenessEntry = {
  stream: ReadSyncStreamId
  /** The binding's warehouse for a per-binding stream; null otherwise. */
  instance: string | null
  state: LivenessState
  lastSuccessAt: string | null
  maxAgeMs: number | null
  ageMs: number | null
}

/** The scheduler block as the pack uses it: booleans and closed job slugs, never the free text the status report carries. */
export type LivenessScheduler = {
  examined: boolean
  unreadable: boolean
  blockProblem: boolean
  unscheduled: readonly string[]
  disabled: readonly string[]
}

export type LivenessRead =
  | { ok: true; entries: readonly LivenessEntry[]; scheduler: LivenessScheduler; duplicates: readonly ReadSyncStreamId[] }
  | { ok: false }

/** The jobs the status report may name: each stream's job, the alarm job, and the stock-sync watchdog (a test pins the last to the status module's constant). */
export const WATCHDOG_JOB_SLUG = 'wms-watchdog'
const JOB_SLUGS: ReadonlySet<string> = new Set([
  ...READ_SYNC_STREAMS.flatMap((def) => (def.cronSlug ? [def.cronSlug] : [])),
  READ_SYNC_ALARM_CRON_SLUG,
  WATCHDOG_JOB_SLUG,
])
const STREAM_IDS: ReadonlySet<string> = new Set(READ_SYNC_STREAM_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stateOf(value: unknown): LivenessState {
  return value === 'fresh' || value === 'stale' || value === 'never' || value === 'off' ? value : 'invalid'
}

/** Keep only job slugs the status report is defined to name; anything else is dropped (it could be anything). */
function closedSlugs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((slug): slug is string => typeof slug === 'string' && JOB_SLUGS.has(slug))
}

/**
 * Reduce one status report to a `LivenessRead`. A report that is not the shape the status command defines is
 * `{ ok: false }`: it is unreadable, and an unreadable liveness read is never read as healthy.
 */
export function reduceStatusReport(report: unknown): LivenessRead {
  if (!isRecord(report) || report.schemaVersion !== READ_SYNC_STATUS_SCHEMA_VERSION) return { ok: false }
  if (!Array.isArray(report.entries) || !isRecord(report.scheduler)) return { ok: false }
  const scheduler = report.scheduler
  const unscheduled = closedSlugs(scheduler.unscheduled)
  const disabled = closedSlugs(scheduler.disabled)
  if (unscheduled === null || disabled === null) return { ok: false }
  // `unscheduled` and `disabled` are lists of job slugs. A slug outside the registry's closed set means the report is
  // not what this reader understands; refuse rather than drop it silently.
  if ((scheduler.unscheduled as unknown[]).length !== unscheduled.length || (scheduler.disabled as unknown[]).length !== disabled.length) return { ok: false }
  if (typeof scheduler.examined !== 'boolean') return { ok: false }
  if (scheduler.unreadable !== null && typeof scheduler.unreadable !== 'string') return { ok: false }
  if (scheduler.blockProblem !== null && typeof scheduler.blockProblem !== 'string') return { ok: false }

  const entries: LivenessEntry[] = []
  const seen = new Set<string>()
  const duplicates = new Set<ReadSyncStreamId>()
  for (const raw of report.entries) {
    if (!isRecord(raw) || typeof raw.stream !== 'string' || !STREAM_IDS.has(raw.stream)) return { ok: false }
    if (raw.instance !== null && typeof raw.instance !== 'string') return { ok: false }
    const stream = raw.stream as ReadSyncStreamId
    const instance = raw.instance as string | null
    const lastSuccessAt = typeof raw.lastSuccessAt === 'string' && isStreamStamp(raw.lastSuccessAt) ? raw.lastSuccessAt : null
    const identity = `${stream}\u0000${instance ?? ''}\u0000${instance === null ? 'n' : 'i'}`
    if (seen.has(identity)) duplicates.add(stream)
    seen.add(identity)
    entries.push({ stream, instance, state: stateOf(raw.state), lastSuccessAt, maxAgeMs: finiteOrNull(raw.maxAgeMs), ageMs: finiteOrNull(raw.ageMs) })
  }
  return {
    ok: true,
    entries,
    scheduler: {
      examined: scheduler.examined,
      unreadable: scheduler.unreadable !== null,
      blockProblem: scheduler.blockProblem !== null,
      unscheduled,
      disabled,
    },
    duplicates: [...duplicates],
  }
}

export type LivenessDeps = { build?: () => Promise<ReadSyncReport> }

/** One liveness read. Any failure to produce a well-formed report is `{ ok: false }`, with nothing about the cause kept. */
export async function readLiveness(deps: LivenessDeps = {}): Promise<LivenessRead> {
  try {
    const build = deps.build ?? (async () => (await import('@/lib/ops/read-sync-status')).buildReadSyncStatusReport())
    return reduceStatusReport(await build())
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------------------------
// The bracket
// ---------------------------------------------------------------------------------------------

/** One stream instance across both reads. */
export type InstanceBracket = {
  stream: ReadSyncStreamId
  instance: SafeToken | null
  stateAtStart: LivenessState | null
  stateAtEnd: LivenessState | null
  lastSuccessAtStart: string | null
  lastSuccessAtEnd: string | null
  maxAgeMsAtStart: number | null
  maxAgeMsAtEnd: number | null
  ageMsAtStart: number | null
  ageMsAtEnd: number | null
  /** Present in both reads. */
  inBothReads: boolean
  /** `fresh` at both reads, with a usable stamp at both. */
  fresh: boolean
  /** Both stamps usable and EQUAL (equality only). */
  stable: boolean
}

export type SchedulerBracket = { atStart: LivenessScheduler | null; atEnd: LivenessScheduler | null }

export type LivenessBracket = {
  readable: boolean
  instances: readonly InstanceBracket[]
  scheduler: SchedulerBracket
  /** Streams that had two entries for one instance in either read. */
  ambiguous: readonly ReadSyncStreamId[]
}

function instanceKey(entry: LivenessEntry): string {
  return entry.instance === null ? 'null' : `s:${entry.instance}`
}

export function bracketLiveness(start: LivenessRead, end: LivenessRead): LivenessBracket {
  if (!start.ok || !end.ok) {
    return {
      readable: false,
      instances: [],
      scheduler: { atStart: start.ok ? start.scheduler : null, atEnd: end.ok ? end.scheduler : null },
      ambiguous: [],
    }
  }
  const keys = new Map<string, { stream: ReadSyncStreamId; a: LivenessEntry | undefined; b: LivenessEntry | undefined }>()
  const at = (stream: ReadSyncStreamId, entry: LivenessEntry) => `${stream}\u0000${instanceKey(entry)}`
  for (const entry of start.entries) keys.set(at(entry.stream, entry), { stream: entry.stream, a: entry, b: undefined })
  for (const entry of end.entries) {
    const key = at(entry.stream, entry)
    const found = keys.get(key)
    if (found) found.b = entry
    else keys.set(key, { stream: entry.stream, a: undefined, b: entry })
  }
  const instances: InstanceBracket[] = []
  for (const { stream, a, b } of keys.values()) {
    const usableStart = a !== undefined && a.state === 'fresh' && isStreamStamp(a.lastSuccessAt)
    const usableEnd = b !== undefined && b.state === 'fresh' && isStreamStamp(b.lastSuccessAt)
    const instance = (a ?? b)!.instance
    instances.push({
      stream,
      instance: instance === null ? null : identityToken('warehouse', instance),
      stateAtStart: a?.state ?? null,
      stateAtEnd: b?.state ?? null,
      lastSuccessAtStart: a?.lastSuccessAt ?? null,
      lastSuccessAtEnd: b?.lastSuccessAt ?? null,
      maxAgeMsAtStart: a?.maxAgeMs ?? null,
      maxAgeMsAtEnd: b?.maxAgeMs ?? null,
      ageMsAtStart: a?.ageMs ?? null,
      ageMsAtEnd: b?.ageMs ?? null,
      inBothReads: a !== undefined && b !== undefined,
      fresh: usableStart && usableEnd,
      stable: isStreamStamp(a?.lastSuccessAt) && isStreamStamp(b?.lastSuccessAt) && a!.lastSuccessAt === b!.lastSuccessAt,
    })
  }
  instances.sort((x, y) => (x.stream === y.stream ? String(x.instance).localeCompare(String(y.instance)) : x.stream.localeCompare(y.stream)))
  return {
    readable: true,
    instances,
    scheduler: { atStart: start.scheduler, atEnd: end.scheduler },
    ambiguous: [...new Set([...start.duplicates, ...end.duplicates])].sort(),
  }
}

// ---------------------------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------------------------

export type LivenessVerdict = { ok: true } | { ok: false; reason: PackReasonCode }

function schedulerTrusted(s: LivenessScheduler | null): s is LivenessScheduler {
  return s !== null && s.examined && !s.unreadable && !s.blockProblem
}

function dependentJobs(streams: readonly ReadSyncStreamId[]): Set<string> {
  const jobs = new Set<string>()
  for (const def of READ_SYNC_STREAMS) if (streams.includes(def.id) && def.cronSlug) jobs.add(def.cronSlug)
  return jobs
}

/**
 * Whether the streams in `streams` support a pass. Withholds only: STALE_BASIS when any dependent entry is not fresh
 * at either read (or is missing, or ambiguous), or the scheduler is unreadable / untrusted / names a dependent job as
 * unscheduled or disabled; BASIS_MOVED when everything was fresh and a stamp or an instance set moved; SOURCE_UNREADABLE
 * when a read failed. An empty `streams` list depends on no stream: only an unreadable bracket stops it.
 */
export function streamsVerdict(bracket: LivenessBracket, streams: readonly ReadSyncStreamId[]): LivenessVerdict {
  if (!bracket.readable) return { ok: false, reason: 'SOURCE_UNREADABLE' }
  if (streams.length === 0) return { ok: true }

  let stale = false
  let moved = false
  for (const stream of streams) {
    if (bracket.ambiguous.includes(stream)) stale = true
    const own = bracket.instances.filter((instance) => instance.stream === stream)
    if (own.length === 0) { stale = true; continue }
    for (const instance of own) {
      if (!instance.inBothReads) { moved = true; continue }
      if (!instance.fresh) { stale = true; continue }
      if (!instance.stable) moved = true
    }
  }
  const jobs = dependentJobs(streams)
  for (const side of [bracket.scheduler.atStart, bracket.scheduler.atEnd]) {
    if (!schedulerTrusted(side)) { stale = true; continue }
    if (side.unscheduled.some((slug) => jobs.has(slug)) || side.disabled.some((slug) => jobs.has(slug))) stale = true
  }
  if (stale) return { ok: false, reason: 'STALE_BASIS' }
  if (moved) return { ok: false, reason: 'BASIS_MOVED' }
  return { ok: true }
}

/** The verdict for one catalogue item: its dependent streams, from the catalogue. */
export function itemLivenessVerdict(bracket: LivenessBracket, id: PackItemId): LivenessVerdict {
  return streamsVerdict(bracket, getPackItem(id).streams)
}

/**
 * The published stream brackets for `streams`: one per stream, the stamp at the start and at the end.
 * A stream whose verdict is not ok is published with a null `end`, so the report builder and the report reader
 * (which accept a pass only on an equal, usable start and end) cannot pass an item on it even if a caller ignored the
 * verdict. Where a stream has several instances the stamp shown is that of the instance first by identity token (an
 * order over names, not over time); the verdict above has already required every instance to be fresh and unmoved.
 */
export function publishedStreamBrackets(bracket: LivenessBracket, streams: readonly ReadSyncStreamId[]): StreamBracket[] {
  const out: StreamBracket[] = []
  for (const stream of [...new Set(streams)].sort()) {
    const own = bracket.instances.filter((instance) => instance.stream === stream)
    const first = own[0]
    const verdict = streamsVerdict(bracket, [stream])
    const start = first && isStreamStamp(first.lastSuccessAtStart) ? first.lastSuccessAtStart : null
    const end = verdict.ok && first && isStreamStamp(first.lastSuccessAtEnd) ? first.lastSuccessAtEnd : null
    out.push({ stream, start, end })
  }
  return out
}
