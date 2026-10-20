/**
 * A MINIMAL IN-PROCESS HARNESS: publish a synthetic report end to end, with no database and no vendor.
 *
 * It exists so tests (and, later, the CLI's own tests) can drive the whole publication path without item runners.
 * Every item the caller does not supply is `inconclusive` with NO_RUNNER, or `not-applicable` when the phase does
 * not apply it, which is exactly what a build without that runner would report. It makes no vendor call, reads no
 * database and has no clock of its own: the caller passes the time.
 */

import { randomBytes } from 'node:crypto'

import type { ReadinessPhase } from '@/lib/ops/readiness-gate-constants'
import { PACK_ITEM_IDS, itemApplicability, type PackItemId } from '@/lib/reconciliation-pack/constants'
import { publishPackReport, type PublishHooks, type PublishResult } from '@/lib/reconciliation-pack/publish'
import type { ItemInput, StreamBracket } from '@/lib/reconciliation-pack/report'

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${stamp}-${randomBytes(6).toString('hex')}`
}

export function defaultItems(phase: ReadinessPhase, supplied: Partial<Record<PackItemId, ItemInput>> = {}): ItemInput[] {
  return PACK_ITEM_IDS.map((id) => {
    if (itemApplicability(id, phase) === 'not-applicable') return { id, outcome: 'not-applicable', reasons: ['PHASE_NOT_APPLICABLE'] }
    return supplied[id] ?? { id, outcome: 'inconclusive', reasons: ['NO_RUNNER'] }
  })
}

export type SyntheticRun = {
  reportDir: string
  phase: ReadinessPhase
  asOf: string
  systemIdentifier?: string
  now: Date
  items?: Partial<Record<PackItemId, ItemInput>>
  streams?: readonly StreamBracket[]
  hooks?: PublishHooks
}

export function publishSyntheticRun(run: SyntheticRun): PublishResult {
  const finished = run.now.toISOString()
  return publishPackReport(run.reportDir, {
    runId: newRunId(run.now),
    systemIdentifier: run.systemIdentifier ?? 'ims-test',
    phase: run.phase,
    asOf: run.asOf,
    startedAt: finished,
    finishedAt: finished,
    streams: run.streams ?? [],
    items: defaultItems(run.phase, run.items),
  }, run.hooks)
}
