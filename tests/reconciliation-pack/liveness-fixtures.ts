import type { ReadSyncEntry, ReadSyncReport } from '../../lib/ops/read-sync-status.ts'
import { READ_SYNC_STREAMS, type ReadSyncStreamId } from '../../lib/ops/read-sync-liveness-constants.ts'

export const GENERATED_AT = '2026-10-20T12:00:00.000Z'
export const STAMP_A = '2026-10-20T00:30:00.000Z'
export const STAMP_B = '2026-10-20T06:30:00.000Z'
const HOUR = 3_600_000
const MAX_AGE = 36 * HOUR
const ageOf = (stamp: string) => Date.parse(GENERATED_AT) - Date.parse(stamp)

/** An entry exactly as the status report builds a fresh one: the age is the distance from the report's clock to the stamp. */
export function freshEntry(stream: ReadSyncStreamId, instance: string | null = null, stamp: string = STAMP_A): ReadSyncEntry {
  const def = READ_SYNC_STREAMS.find((candidate) => candidate.id === stream)!
  return { stream, label: def.label, instance, state: 'fresh', lastSuccessAt: stamp, ageMs: ageOf(stamp), maxAgeMs: MAX_AGE, futureTimestamp: false, detail: null, cadence: def.cadence }
}

export function cleanScheduler(): ReadSyncReport['scheduler'] {
  return { examined: true, unreadable: null, blockProblem: null, unscheduled: [], disabled: [] }
}

/** The counts are always the tally of the entries, as the status report computes them. */
export function recount(report: ReadSyncReport): ReadSyncReport {
  const counts = { fresh: 0, stale: 0, never: 0, off: 0 }
  for (const entry of report.entries) counts[entry.state] += 1
  return { ...report, counts }
}

/** A report in which every stream is fresh (the Mintsoft stock sync has two bindings) and the scheduler is clean. */
export function goodReport(overrides: { entries?: ReadSyncEntry[]; scheduler?: Partial<ReadSyncReport['scheduler']> } = {}): ReadSyncReport {
  const entries = overrides.entries ?? [
    freshEntry('woocommerce-order-sweep'),
    freshEntry('mintsoft-stock-sync', 'MAIN'),
    freshEntry('mintsoft-stock-sync', 'OVERFLOW'),
    freshEntry('mintsoft-dispatch-poll'),
    freshEntry('mintsoft-order-status'),
    freshEntry('xero-balance-snapshots'),
    freshEntry('xero-tax-rates'),
  ]
  return recount({ schemaVersion: 1, generatedAt: GENERATED_AT, entries, counts: { fresh: 0, stale: 0, never: 0, off: 0 }, scheduler: { ...cleanScheduler(), ...overrides.scheduler } })
}

function mapEntries(report: ReadSyncReport, stream: ReadSyncStreamId, instance: string | null | undefined, change: (entry: ReadSyncEntry) => ReadSyncEntry): ReadSyncReport {
  return recount({ ...report, entries: report.entries.map((entry) => (entry.stream === stream && (instance === undefined || entry.instance === instance) ? change(entry) : entry)) })
}

/** Raw field overrides, for building a CONTRADICTORY entry on purpose. The counts are re-tallied. */
export function withEntry(report: ReadSyncReport, stream: ReadSyncStreamId, change: Partial<ReadSyncEntry>, instance?: string | null): ReadSyncReport {
  return mapEntries(report, stream, instance, (entry) => ({ ...entry, ...change }))
}

/** A consistent entry with another last-success stamp (age recomputed). */
export function withStamp(report: ReadSyncReport, stream: ReadSyncStreamId, stamp: string, instance?: string | null): ReadSyncReport {
  return mapEntries(report, stream, instance, (entry) => ({ ...entry, lastSuccessAt: stamp, ageMs: ageOf(stamp) }))
}

/** A consistent `stale` entry: the stamp is older than the limit. */
export function makeStale(report: ReadSyncReport, stream: ReadSyncStreamId, instance?: string | null): ReadSyncReport {
  const stamp = new Date(Date.parse(GENERATED_AT) - 100 * HOUR).toISOString()
  return mapEntries(report, stream, instance, (entry) => ({ ...entry, state: 'stale', lastSuccessAt: stamp, ageMs: ageOf(stamp) }))
}

/** A consistent `stale` entry whose stamp lies in the future of the report's clock. */
export function makeFuture(report: ReadSyncReport, stream: ReadSyncStreamId, instance?: string | null): ReadSyncReport {
  const stamp = new Date(Date.parse(GENERATED_AT) + 2 * HOUR).toISOString()
  return mapEntries(report, stream, instance, (entry) => ({ ...entry, state: 'stale', lastSuccessAt: stamp, ageMs: ageOf(stamp), futureTimestamp: true }))
}

export function makeNever(report: ReadSyncReport, stream: ReadSyncStreamId, instance?: string | null): ReadSyncReport {
  return mapEntries(report, stream, instance, (entry) => ({ ...entry, state: 'never', lastSuccessAt: null, ageMs: null, futureTimestamp: false }))
}

export function makeOff(report: ReadSyncReport, stream: ReadSyncStreamId, instance?: string | null): ReadSyncReport {
  return mapEntries(report, stream, instance, (entry) => ({ ...entry, state: 'off', lastSuccessAt: null, ageMs: null, maxAgeMs: null, futureTimestamp: false, detail: 'the plugin is disabled' }))
}

export function withoutStream(report: ReadSyncReport, stream: ReadSyncStreamId): ReadSyncReport {
  return recount({ ...report, entries: report.entries.filter((entry) => entry.stream !== stream) })
}
