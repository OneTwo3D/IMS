/**
 * THE READINESS GATE READS THE RECONCILIATION PACK'S NEWEST REPORT.
 *
 * The pack (`npm run reconcile:pack`) publishes a report per run; the gate does not re-run any comparison. It reads the NEWEST
 * report, by sequence (never by a time), through the pack's own chain reader, and turns each item's outcome into the gate's
 * result for that slot:
 *
 *     pass -> pass      fail -> fail      inconclusive -> unreadable      not-applicable -> not-available
 *
 * Nothing is believed because it is on disk. The report counts only if ALL of these hold, and any other state is `unreadable` for
 * every item it would have covered (never a pass, never skipped):
 *   - TRUST: the report directory and every ancestor, every run directory and every file are real (never symlinks), owned by root
 *     or the account running the gate, and not writable by group or others (the rehearsal reports' rules; readPackChain checks the
 *     whole location, so one bad pair anywhere refuses it). The Markdown, the evidence and the JSON are each read ONCE, and the
 *     digests are taken on those very bytes.
 *   - IT IS THIS INSTALLATION'S: the report's cluster system identifier equals the database the gate runs against.
 *   - IT IS ABOUT THIS PHASE: a report made for another phase says nothing about the one asked (an item can apply in one and not the
 *     other).
 *   - IT IS CURRENT: it finished no later than now and no longer ago than its item's cadence allows (daily 36 hours, weekly 8 days,
 *     monthly 35 days).
 *
 * R3, R4 and R15 are also derived by the gate itself from its own run of the invariant report. The two derivations must AGREE: if
 * they do not, the item is unreadable (the stricter reading wins; a disagreement is never a pass).
 *
 * Imports no database client. The default reader touches the disk only.
 */

import { lstatSync } from 'node:fs'

import type { CheckResult } from '@/lib/ops/readiness-gate'
import { PACK_ITEMS, type PackItemId, type ReadinessPhase } from '@/lib/ops/readiness-gate-constants'
import { PACK_CADENCE_MAX_AGE_MS, PACK_ITEM_IDS_BY_SCHEMA, PACK_LEGACY_SCHEMA_VERSION, PACK_OUTCOMES, getPackItem, itemApplicability, type PackOutcome } from '@/lib/reconciliation-pack/constants'
import type { ReportRecord } from '@/lib/reconciliation-pack/report'
import { readPackChain } from '@/lib/reconciliation-pack/trend'

export type PackReportRead = { none: string } | { untrusted: string } | { record: ReportRecord }

/** The newest report in `dir`, or why there is none. Throws only for an error it cannot classify (the caller makes that unreadable). */
export function readNewestPackReport(dir: string): PackReportRead {
  try {
    lstatSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { none: 'the reconciliation pack report directory does not exist' }
    throw error
  }
  const chain = readPackChain(dir)
  // The code is one of the pack's closed words; nothing from a file reaches the text.
  if (!chain.ok) return { untrusted: `the reconciliation pack report location is not trusted (${chain.code}); a report that another account could have written, or a chain that does not verify, proves nothing, so no report was used` }
  if (chain.head === null) return { none: 'no reconciliation pack report was found' }
  return { record: chain.head.record }
}

export type PackAssessContext = {
  phase: ReadinessPhase
  now: Date
  /** The database's cluster system identifier, or why it could not be read. */
  systemIdentifier: string | { unreadable: string }
}

const unreadable = (reason: string): CheckResult => ({ kind: 'unreadable', reason })

/** Why the report as a whole cannot speak for the gate's installation, phase and time; null when it can. */
function reportProblem(record: ReportRecord, context: PackAssessContext, cadenceMs: number): string | null {
  if (typeof context.systemIdentifier !== 'string') return `this installation's system identifier could not be read (${context.systemIdentifier.unreadable}), so the report cannot be attributed to it`
  if (record.systemIdentifier !== context.systemIdentifier) return 'the newest reconciliation pack report is for another installation (its cluster system identifier differs from this database\'s)'
  if (record.phase !== context.phase) return `the newest reconciliation pack report is for phase ${record.phase}, not ${context.phase}`
  const finished = Date.parse(record.finishedAt)
  if (!Number.isFinite(finished)) return 'the newest reconciliation pack report has no readable finish time'
  const age = context.now.getTime() - finished
  if (age < 0) return 'the newest reconciliation pack report is dated in the future'
  if (age > cadenceMs) return `the newest reconciliation pack report finished ${Math.floor(age / 3_600_000)} hours ago, longer than this item's cadence allows (${Math.floor(cadenceMs / 3_600_000)} hours)`
  return null
}

/** Sources read as a stored snapshot for the run's cycle date (the as-of basis): a fresh report about an old date proves nothing current. */
const CYCLE_DATED_SOURCES: ReadonlySet<string> = new Set(['xero-trial-balance', 'ims-ledger', 'qoblex-file'])
/** Items whose population is chosen by the cycle date (the closed months before it) although they read no cycle-dated source: a report about an old date proves nothing current. */
const CYCLE_DATED_ITEMS: ReadonlySet<string> = new Set(['R16'])
const DAY_MS = 86_400_000

/**
 * Why an item that reads cycle-dated evidence cannot be taken as current; null when it can. The cycle date must be a real calendar
 * date whose day had ENDED when the run finished (evidence for a day still in progress is not that day's), and the end of that day
 * must be within the item's cadence of the gate's own clock: the report's finish time alone says nothing about the date it read.
 */
function cycleDateProblem(record: ReportRecord, context: PackAssessContext, cadenceMs: number): string | null {
  const asOf = record.asOf
  const start = typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? Date.parse(`${asOf}T00:00:00.000Z`) : Number.NaN
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== asOf) return 'the newest reconciliation pack report has no readable cycle date'
  const dayEnd = start + DAY_MS
  if (Date.parse(record.finishedAt) < dayEnd) return 'the newest reconciliation pack report read its cycle date before that day had ended'
  const age = context.now.getTime() - dayEnd
  if (age > cadenceMs) return `the newest reconciliation pack report is for a cycle date that ended ${Math.floor(age / 3_600_000)} hours ago, longer than this item's cadence allows (${Math.floor(cadenceMs / 3_600_000)} hours)`
  return null
}

/**
 * One slot from one read, by the mapping above.
 *
 * Two readings are made on the catalogue's word, not on the report's: an item the pack's catalogue does not apply in the phase asked
 * about is not available whatever report there is (or is not) - a missing report cannot make it applicable, and the report cannot be
 * believed about it either way - and an item the report lists as inconclusive for NO_RUNNER alone (this build has no runner for it
 * yet) or for VENDOR_READS_OFF alone (the run did not opt in to vendor reads) is not available, the state the slot had before the pack fed the gate. Every other inconclusive item is unreadable.
 */
export function assessPackItem(read: PackReportRead, id: PackItemId, context: PackAssessContext): CheckResult {
  if (itemApplicability(id, context.phase) === 'not-applicable') return { kind: 'not-available', reason: `${id} does not apply in phase ${context.phase} (the reconciliation pack's catalogue)` }
  if ('none' in read) return unreadable(`${read.none}, so ${id} is not established`)
  if ('untrusted' in read) return unreadable(`${read.untrusted}; ${id} is not established`)
  const record = read.record
  // A report published under an older catalogue (schema version 1: R1 to R15) never carried an item added later. That is the state the slot had before the item existed (not available), not a malformed report.
  if (record.schemaVersion === PACK_LEGACY_SCHEMA_VERSION && !(PACK_ITEM_IDS_BY_SCHEMA[PACK_LEGACY_SCHEMA_VERSION] as readonly string[]).includes(id)) return { kind: 'not-available', reason: `${id} was added after reconciliation pack run ${record.runId} was published (schema version ${record.schemaVersion}), so that report does not carry it` }
  const spec = getPackItem(id)
  const problem = reportProblem(record, context, PACK_CADENCE_MAX_AGE_MS[spec.cadence])
    ?? (spec.sources.some((source) => CYCLE_DATED_SOURCES.has(source)) || CYCLE_DATED_ITEMS.has(id) ? cycleDateProblem(record, context, PACK_CADENCE_MAX_AGE_MS[spec.cadence]) : null)
  if (problem !== null) return unreadable(`${problem}, so ${id} is not established`)
  const matches = record.items.filter((item) => item.id === id)
  if (matches.length !== 1) return unreadable(`the newest reconciliation pack report lists ${id} ${matches.length} times, expected exactly once`)
  const item = matches[0]!
  const outcome = item.outcome as PackOutcome
  if (!(PACK_OUTCOMES as readonly string[]).includes(outcome)) return unreadable(`${id} has an outcome this gate does not know`)
  const detail = { source: 'reconciliation-pack', runId: record.runId, sequence: record.sequence, asOf: record.asOf, reasons: [...item.reasons] }
  const codes = item.reasons.length > 0 ? ` (${item.reasons.join(', ')})` : ''
  switch (outcome) {
    case 'pass': return { kind: 'pass', summary: `${id} passed in the reconciliation pack run ${record.runId} for ${record.asOf}`, detail }
    case 'fail': return { kind: 'fail', reasons: [`${id} failed in the reconciliation pack run ${record.runId} for ${record.asOf}${codes}`], detail }
    case 'inconclusive':
      if (item.reasons.length === 1 && item.reasons[0] === 'NO_RUNNER') return { kind: 'not-available', reason: `${id} has no runner on the build that made reconciliation pack run ${record.runId}, so it was not checked` }
      // The run was not started with --vendor-reads-only: no vendor was contacted and nothing was claimed. The slot is exactly what it
      // was before the pack could read vendors (not available), so merging the vendor items changes no live verdict until a run opts in.
      if (item.reasons.length === 1 && item.reasons[0] === 'VENDOR_READS_OFF') return { kind: 'not-available', reason: `${id} was not read in reconciliation pack run ${record.runId}: the run was not started with --vendor-reads-only, so no vendor was contacted` }
      // No Qoblex export was named: nothing was read and nothing was claimed, so the slot is what it was before the pack could read one.
      if (item.reasons.length === 1 && item.reasons[0] === 'QOBLEX_EXPORT_OFF') return { kind: 'not-available', reason: `${id} was not read in reconciliation pack run ${record.runId}: the run was not started with --qoblex-export, so no Qoblex export was read` }
      return unreadable(`the reconciliation pack could not prove ${id} in run ${record.runId}${codes}`)
    case 'not-applicable':
      // The catalogue has already said (above) where an item does not apply; a report that calls an item not applicable where the catalogue applies it is not believed.
      return unreadable(`${id} is listed as not applicable in phase ${record.phase} but the catalogue applies it there`)
  }
}

/**
 * R3, R4 and R15: the gate's own derivation and the pack's must be the SAME kind of result. Two passes are a pass and two fails are a
 * fail (the gate's own result, with its detail); anything else - one passes and the other does not, either is unreadable - is
 * unreadable. A disagreement never becomes a pass, and neither side can overrule the other's failure into a pass.
 */
export function combineDerivations(id: PackItemId, gate: CheckResult, pack: CheckResult): CheckResult {
  if (gate.kind === 'pass' && pack.kind === 'pass') return gate
  if (gate.kind === 'fail' && pack.kind === 'fail') return gate
  if (gate.kind === 'unreadable' && pack.kind === 'unreadable') return unreadable(`${gate.reason}; and ${pack.reason}`)
  return unreadable(`${id} is read two ways and they do not agree: the gate's own reading of the invariant report is ${gate.kind}, the reconciliation pack's is ${pack.kind}${pack.kind === 'unreadable' ? ` (${pack.reason})` : ''}; the stricter reading wins, so it is not established`)
}

/** The gate's slots for all sixteen items, from one read of the pack report. */
export function assessPackItems(read: PackReportRead, context: PackAssessContext): Record<PackItemId, CheckResult> {
  return Object.fromEntries(PACK_ITEMS.map((item) => [item.id, assessPackItem(read, item.id, context)])) as Record<PackItemId, CheckResult>
}
