/**
 * RUNNING THE ITEMS: which run, which are skipped and why, which streams they stand on, and what a runner that misbehaves
 * becomes. No file, no database and no clock of its own: everything comes in through the ports below, so a test drives the
 * whole of it and the command only wires the real ones.
 *
 *   - An item the phase does not apply is not-applicable; one the run was not asked for is inconclusive NOT_SELECTED; one with
 *     no runner on this build is inconclusive NO_RUNNER. Nothing here is ever a pass by omission.
 *   - An item that stands on a read-sync stream is not run unless the stream is fresh at the start with a last-success stamp, and
 *     its result is replaced by BASIS_MOVED unless the SAME stamp is read again at the end (equality only, never an order). A
 *     missing liveness reader makes such an item STALE_BASIS: no reader is not "fresh".
 *   - A runner that throws, names another item, or returns something the report builder refuses is INTERNAL_ERROR for that item
 *     alone; the others still publish. The report builder is the judge of every item, here in isolation and again in the
 *     publication, so no runner can loosen its own test.
 *
 * LivenessPort and BasisPort are the seams for the read-sync liveness reader and the as-of basis check, which are built
 * separately. The command wires neither today (the first makes every stream-dependent item STALE_BASIS, the second makes
 * --basis-only print BASIS_UNAVAILABLE_NOT_BUILT); when they land they are wired here without touching the runners.
 */

import type { ReadSyncStreamId } from '@/lib/ops/read-sync-liveness-constants'
import type { ReadinessPhase } from '@/lib/ops/readiness-gate-constants'
import type { AcceptanceFile } from '@/lib/ops/readiness-gate'
import { PACK_ITEM_IDS, getPackItem, itemApplicability, type PackItemId, type PackReasonCode } from '@/lib/reconciliation-pack/constants'
import { isStreamStamp } from '@/lib/reconciliation-pack/compare'
import { runInvariantItem } from '@/lib/reconciliation-pack/invariant-items'
import { buildReport, type ItemInput, type StreamBracket } from '@/lib/reconciliation-pack/report'

export type StreamReading = { state: 'fresh' | 'stale' | 'off' | 'unknown'; lastSuccess: string | null }
export type StreamReadings = Partial<Record<ReadSyncStreamId, StreamReading>>
/** Reads every stream's state and last-success stamp. May throw: the run then treats every stream as unknown. */
export interface LivenessPort { read(): Promise<StreamReadings> }
export interface BasisReading { ok: boolean; codes: readonly string[] }
export interface BasisPort { check(asOf: string): Promise<BasisReading> }

export type RunContext = {
  phase: ReadinessPhase
  asOf: string
  now: () => Date
  acceptances: AcceptanceFile
  /** The invariant report, run at most once per pack run and shared. null when it could not be run. */
  invariant: () => Promise<unknown>
}
export type ItemRunner = (context: RunContext) => Promise<ItemInput>

export type RunPlan = {
  phase: ReadinessPhase
  asOf: string
  selected: readonly PackItemId[] | null
  context: RunContext
  liveness?: LivenessPort
  runners?: Partial<Record<PackItemId, ItemRunner>>
}

/** The runners this build has. R3, R4 and R15 read the shared invariant report. */
export function builtInRunners(): Partial<Record<PackItemId, ItemRunner>> {
  const fromInvariant = (id: 'R3' | 'R4' | 'R15'): ItemRunner => async (context) =>
    runInvariantItem(id, await context.invariant(), { phase: context.phase, now: context.now(), acceptances: context.acceptances })
  return { R3: fromInvariant('R3'), R4: fromInvariant('R4'), R15: fromInvariant('R15') }
}

/** Run the invariant report once and share the answer; a throw is a null answer (every dependent item is then inconclusive). */
export function memoisedInvariant(run: () => Promise<unknown>): () => Promise<unknown> {
  let pending: Promise<unknown> | null = null
  return () => {
    pending ??= run().catch(() => null)
    return pending
  }
}

const inconclusive = (id: PackItemId, reason: PackReasonCode): ItemInput => ({ id, outcome: 'inconclusive', reasons: [reason] })

async function readStreams(port: LivenessPort | undefined): Promise<StreamReadings | null> {
  if (!port) return null
  try { return await port.read() } catch { return null }
}

function stampOf(readings: StreamReadings | null, stream: ReadSyncStreamId): string | null {
  const reading = readings?.[stream]
  return reading && reading.state === 'fresh' && isStreamStamp(reading.lastSuccess) ? reading.lastSuccess : null
}

/**
 * The report builder is the judge: an item it refuses (in isolation, against empty defaults for the others) becomes
 * INTERNAL_ERROR so one bad runner cannot take the publication down, and cannot loosen its own test either.
 */
function judged(item: ItemInput, plan: Pick<RunPlan, 'phase' | 'asOf'>, brackets: readonly StreamBracket[]): ItemInput {
  const stamp = '2026-01-01T00:00:00.000Z'
  const others = PACK_ITEM_IDS.filter((id) => id !== item.id).map((id): ItemInput => itemApplicability(id, plan.phase) === 'not-applicable' ? { id, outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE'] } : inconclusive(id, 'NO_RUNNER'))
  try {
    buildReport({ runId: '20260101T000000Z-000000000000', systemIdentifier: '1000000000', phase: plan.phase, asOf: plan.asOf, startedAt: stamp, finishedAt: stamp, streams: [...brackets], items: [item, ...others] }, 1, null)
    return item
  } catch {
    // ReportInvalid or anything else the builder throws: this item cannot be published as it is.
    return inconclusive(item.id, 'INTERNAL_ERROR')
  }
}

export async function runItems(plan: RunPlan): Promise<{ items: ItemInput[]; streams: StreamBracket[] }> {
  const runners = { ...builtInRunners(), ...(plan.runners ?? {}) }
  const start = await readStreams(plan.liveness)
  const results = new Map<PackItemId, ItemInput>()
  const attempted: PackItemId[] = []

  for (const id of PACK_ITEM_IDS) {
    if (itemApplicability(id, plan.phase) === 'not-applicable') { results.set(id, { id, outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE'] }); continue }
    if (plan.selected !== null && !plan.selected.includes(id)) { results.set(id, inconclusive(id, 'NOT_SELECTED')); continue }
    const runner = runners[id]
    if (!runner) { results.set(id, inconclusive(id, 'NO_RUNNER')); continue }
    if (getPackItem(id).streams.some((stream) => stampOf(start, stream) === null)) { results.set(id, inconclusive(id, 'STALE_BASIS')); continue }
    attempted.push(id)
    try {
      const produced = await runner(plan.context)
      results.set(id, produced.id === id ? produced : inconclusive(id, 'INTERNAL_ERROR'))
    } catch {
      results.set(id, inconclusive(id, 'INTERNAL_ERROR'))
    }
  }

  // The stamps again, after every read: an item that stands on a stream keeps its result only if the stamp is the same one.
  const end = attempted.some((id) => getPackItem(id).streams.length > 0) ? await readStreams(plan.liveness) : null
  const streams = new Map<ReadSyncStreamId, StreamBracket>()
  for (const id of attempted) {
    for (const stream of getPackItem(id).streams) {
      const first = stampOf(start, stream)
      const last = stampOf(end, stream)
      streams.set(stream, { stream, start: first, end: last })
      if (first === null || last === null || first !== last) results.set(id, inconclusive(id, first === null || last === null ? 'STALE_BASIS' : 'BASIS_MOVED'))
    }
  }
  const brackets = [...streams.values()]
  const items = PACK_ITEM_IDS.map((id) => {
    const item = results.get(id)!
    return attempted.includes(id) ? judged(item, plan, brackets) : item
  })
  return { items, streams: brackets }
}
