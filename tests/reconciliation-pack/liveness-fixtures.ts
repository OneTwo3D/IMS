import type { ReadSyncEntry, ReadSyncReport } from '../../lib/ops/read-sync-status.ts'
import { READ_SYNC_STREAMS, type ReadSyncStreamId } from '../../lib/ops/read-sync-liveness-constants.ts'

export const STAMP_A = '2026-10-20T00:30:00.000Z'
export const STAMP_B = '2026-10-20T06:30:00.000Z'

export function freshEntry(stream: ReadSyncStreamId, instance: string | null = null, stamp: string = STAMP_A): ReadSyncEntry {
  const def = READ_SYNC_STREAMS.find((candidate) => candidate.id === stream)!
  return { stream, label: def.label, instance, state: 'fresh', lastSuccessAt: stamp, ageMs: 3_600_000, maxAgeMs: 36 * 3_600_000, futureTimestamp: false, detail: null, cadence: def.cadence }
}

export function cleanScheduler(): ReadSyncReport['scheduler'] {
  return { examined: true, unreadable: null, blockProblem: null, unscheduled: [], disabled: [] }
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
  const counts = { fresh: 0, stale: 0, never: 0, off: 0 }
  for (const entry of entries) counts[entry.state] += 1
  return { schemaVersion: 1, generatedAt: '2026-10-20T12:00:00.000Z', entries, counts, scheduler: { ...cleanScheduler(), ...overrides.scheduler } }
}

export function withEntry(report: ReadSyncReport, stream: ReadSyncStreamId, change: Partial<ReadSyncEntry>, instance?: string | null): ReadSyncReport {
  return { ...report, entries: report.entries.map((entry) => (entry.stream === stream && (instance === undefined || entry.instance === instance) ? { ...entry, ...change } : entry)) }
}

export function withoutStream(report: ReadSyncReport, stream: ReadSyncStreamId): ReadSyncReport {
  return { ...report, entries: report.entries.filter((entry) => entry.stream !== stream) }
}
