/**
 * THE ORCHESTRATION: plan a load, or apply it step by step, resumably, through PORTS.
 *
 * The runner core never touches a database, an importer or a clock. It is handed:
 *   - `observe(step)`   what the database holds for the step (throws ObservationError when it cannot be read: FAIL CLOSED);
 *   - `execute(...)`    run one residual file through the step's importer and return the importer's own counters and errors;
 *   - `journal`         the run record (audit and the "same load" identity; correctness never depends on it);
 *   - `withStepLock`    the single-runner lock around a step;
 *   - `recheckRails`    the rails re-evaluated inside the lock (optional here, required by the database slice);
 *   - `verify`          post-run verification (optional here, supplied by the verification slice).
 *
 * ACCOUNTING IS COMPUTED FROM THE DATABASE, never from the importers' counters: per unit, state before the step against state after it.
 * `emitted = created + updated + skippedExisting + failed` must hold or the run ends INTERNAL. The importers' counters are kept only as
 * a cross-check that raises a finding (a product the importer counted created but whose recipe is missing is FAILED here).
 */
import {
  REHEARSAL_MAX_AGE_HOURS, REHEARSAL_RECORD_FORMAT_VERSION, RESUMABLE_STATUSES, type ApplyExitName, type ApplyMode, type ApplyStepId, type RowOutcome, type RunStatus, type StepStatus,
} from './constants'
import type { PreparedRun, PreparedStep } from './prepared'
import {
  ObservationError, buildResidual, classifyStep, hasConflict, listConflicts, type ClassifiedStep, type ConflictReport, type ResidualFile, type StepObservation,
} from './residual'

// ---------------------------------------------------------------------------
// Ports and records
// ---------------------------------------------------------------------------

export interface ImporterResult {
  created: number
  updated: number
  skipped: number
  /** The importer's errors[]. Its text is NEVER stored or rendered (it can carry file values and exception text): only a bounded code and a row number survive. */
  errors: string[]
}

/** What survives of one importer message: a code from a closed list and, when the message names one, a row number. Never the text. */
export interface ImporterMessage {
  code: ImporterMessageCode
  row: number | null
}

export const IMPORTER_MESSAGE_CODES = ['ALREADY_EXISTS', 'NOT_FOUND', 'INVALID', 'EXCEPTION', 'OTHER'] as const
export type ImporterMessageCode = (typeof IMPORTER_MESSAGE_CODES)[number]
const MAX_MESSAGES_PER_FILE = 200

/** Reduce importer text to bounded codes and row numbers. The text itself is dropped here, before anything is stored. */
export function summariseImporterErrors(errors: readonly string[]): ImporterMessage[] {
  return errors.slice(0, MAX_MESSAGES_PER_FILE).map((text) => {
    const rowMatch = /\b(?:row|line)\s+(\d{1,7})\b/i.exec(text)
    const code: ImporterMessageCode = /already exists|duplicate|skipp/i.test(text) ? 'ALREADY_EXISTS' : /not found|unknown|missing/i.test(text) ? 'NOT_FOUND' : /invalid|must be|cannot|refus/i.test(text) ? 'INVALID' : 'OTHER'
    return { code, row: rowMatch ? Number(rowMatch[1]) : null }
  })
}

export interface StepJournal {
  status: StepStatus
  emitted: number
  created: number
  updated: number
  skippedExisting: number
  failed: number
  residualSha256: string[]
}

export interface RunRecord {
  /** Compare-and-swap counter: a save names the version it read. */
  version: number
  manifestDigest: string
  runId: string
  status: RunStatus
  currentStep: ApplyStepId | null
  steps: Partial<Record<ApplyStepId, StepJournal>>
}

/** Thrown by `journal.save` when the stored version is not the expected one: another runner moved the record. */
export class StaleJournalError extends Error {
  constructor() {
    super('the run record changed under this runner (another runner holds this load)')
    this.name = 'StaleJournalError'
  }
}

/**
 * Thrown by `withStepLock` when the step cannot be run under its lock: another runner holds it (`busy`), the lock's connection failed while the step ran
 * (`lost`: the exclusion is gone, so the step must stop), or it could not be taken (`unavailable`). The run record is NOT touched on any of them: a runner
 * that does not hold the lock has no business moving the record the holder is moving.
 */
export class StepLockError extends Error {
  constructor(readonly reason: 'busy' | 'lost' | 'unavailable') {
    super(`the step lock was not available (${reason})`)
    this.name = 'StepLockError'
  }
}

/** What a step lock lends the step's body: a check, bound to THAT acquisition, that the lock is still held. Importer calls are made only after it passes. */
export interface StepLock {
  assertLive(): Promise<void>
}

export interface VerificationItem {
  id: string
  result: 'pass' | 'fail'
  expected: string
  actual: string
}

export interface ApplyPorts {
  journal: {
    load(): Promise<RunRecord | null>
    /** `expectedVersion` null creates the record (it must not exist); otherwise the stored version must equal it. Throws StaleJournalError. */
    save(record: RunRecord, expectedVersion: number | null): Promise<void>
  }
  observe(step: ApplyStepId): Promise<StepObservation>
  /**
   * Rails evaluated once, before anything is written (plan and apply alike), with the facts the core knows: whether a run record already exists.
   * Returns the problems found (empty = the target may be loaded). An unreadable database throws ObservationError.
   */
  preflight?(facts: { resuming: boolean }): Promise<string[]>
  withStepLock<T>(step: ApplyStepId, body: (lock: StepLock) => Promise<T>): Promise<T>
  /** Rails re-evaluated at the start of a step and again just before its first write. Returns the problems found (empty = still holds). */
  recheckRails?(step: ApplyStepId, phase: 'step-start' | 'before-first-write'): Promise<string[]>
  /** Persist a residual file exclusively (the file is evidence); optional. */
  storeResidual?(file: ResidualFile): Promise<void>
  /** `lock` is the handle of the step lock this call runs under; an executor that makes several importer calls checks it before each. */
  execute(step: ApplyStepId, file: ResidualFile, lock: StepLock): Promise<ImporterResult>
  verify?(run: PreparedRun, steps: StepResult[]): Promise<VerificationItem[]>
}

export interface RehearsalRecord {
  formatVersion: number
  manifestDigest: string
  verdict: string
  systemId: string
  /** ISO 8601. */
  finishedAt: string
}

export interface ApplyOptions {
  mode: ApplyMode
  resume: boolean
  /** The rehearsal the apply depends on (mode 'apply' only). */
  rehearsal: unknown
  /** The target's system identifier (mode 'apply' only). */
  systemId: string | null
  /**
   * Set ONLY by the rehearsal itself, on the throwaway database it made: this run IS the rehearsal, so it needs no record of one. The command line sets it only after it has
   * proved the database is the throwaway (docs/first-load-apply.md, "The rehearsal"). Never set it from an operator's argument.
   */
  thisIsTheRehearsal?: true
  now: Date
  maxRehearsalAgeHours: number
}

export interface UnitOutcome {
  key: string
  outcome: RowOutcome
  reason: string | null
}

export interface StepResult {
  step: ApplyStepId
  status: StepStatus
  emitted: number
  created: number
  updated: number
  skippedExisting: number
  failed: number
  /** Plan mode: units that would be loaded. Apply mode: the residual size sent to the importer. */
  toLoad: number
  residual: Array<{ name: string; rows: number; sha256: string }>
  conflicts: ConflictReport[]
  rows: UnitOutcome[]
  importer: Array<{ file: string; created: number; updated: number; skipped: number; errors: ImporterMessage[] }>
  counterFindings: string[]
  error: string | null
}

export interface ApplyResult {
  exit: ApplyExitName
  mode: ApplyMode
  problems: string[]
  steps: StepResult[]
  verification: VerificationItem[]
  record: RunRecord | null
}

// ---------------------------------------------------------------------------
// The rehearsal gate
// ---------------------------------------------------------------------------

/** What `--apply` requires first: a rehearsal of THIS load (same digest) that ended OK on a target with the same system id, recently. */
export function checkRehearsalGate(record: unknown, expected: { manifestDigest: string; systemId: string | null; now: Date; maxAgeHours: number }): string[] {
  // The ceiling is fixed here: a caller cannot widen it, and an unusable limit or clock is a refusal, not "no limit".
  if (!Number.isFinite(expected.maxAgeHours) || expected.maxAgeHours <= 0) return ['the rehearsal age limit is not a positive finite number of hours']
  if (!(expected.now instanceof Date) || !Number.isFinite(expected.now.getTime())) return ['the current time is not a valid date']
  const maxAgeHours = Math.min(expected.maxAgeHours, REHEARSAL_MAX_AGE_HOURS)
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return ['no rehearsal report was supplied: --apply needs a rehearsal of this exact load first']
  const r = record as Record<string, unknown>
  const problems: string[] = []
  if (r.formatVersion !== REHEARSAL_RECORD_FORMAT_VERSION) problems.push('the rehearsal report is not format version 1')
  if (r.verdict !== 'OK') problems.push('the rehearsal verdict is missing or is not OK')
  if (r.manifestDigest !== expected.manifestDigest) problems.push('the rehearsal was of a different load (its manifest digest differs)')
  if (expected.systemId === null || typeof r.systemId !== 'string' || r.systemId !== expected.systemId) problems.push('the rehearsal was run against a different target (its system id differs, or the target\'s is unknown)')
  const finished = typeof r.finishedAt === 'string' ? Date.parse(r.finishedAt) : NaN
  if (Number.isNaN(finished)) problems.push('the rehearsal report has no usable finishedAt')
  else {
    const ageMs = expected.now.getTime() - finished
    if (ageMs < 0) problems.push('the rehearsal report claims to have finished in the future')
    else if (ageMs > maxAgeHours * 3_600_000) problems.push(`the rehearsal is older than ${maxAgeHours} hour(s)`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function emptyResult(step: ApplyStepId, status: StepStatus): StepResult {
  return { step, status, emitted: 0, created: 0, updated: 0, skippedExisting: 0, failed: 0, toLoad: 0, residual: [], conflicts: [], rows: [], importer: [], counterFindings: [], error: null }
}

/** The kind of failure and nothing else: an exception message can carry file values or secrets. */
function describeError(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : 'Error'
}

function rowsOf(classified: ClassifiedStep, outcome: (c: ClassifiedStep['units'][number]) => { outcome: RowOutcome; reason: string | null }): UnitOutcome[] {
  return classified.units.map((c) => ({ key: c.unit.key, ...outcome(c) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** Plan (read only) or apply. Never throws for an expected refusal: the exit name and problems say what happened. */
export async function runLoad(prepared: PreparedRun, ports: ApplyPorts, options: ApplyOptions): Promise<ApplyResult> {
  const finish = (exit: ApplyExitName, problems: string[], steps: StepResult[], record: RunRecord | null, verification: VerificationItem[] = []): ApplyResult =>
    ({ exit, mode: options.mode, problems, steps, verification, record })

  if (options.mode === 'apply' && options.thisIsTheRehearsal !== true) {
    const gate = checkRehearsalGate(options.rehearsal, { manifestDigest: prepared.manifestDigest, systemId: options.systemId, now: options.now, maxAgeHours: options.maxRehearsalAgeHours })
    if (gate.length > 0) return finish('PRECONDITION_REFUSED', gate, [], null)
  }

  // ---- Read-only pass: observe and classify every selected step. A plan stops here. ----------------------------------------------------
  const classified = new Map<ApplyStepId, ClassifiedStep>()
  try {
    for (const step of prepared.steps) classified.set(step.step, classifyStep(step.step, step.units, await ports.observe(step.step)))
  } catch (error) {
    if (error instanceof ObservationError) return finish('PRECONDITION_REFUSED', [`the database could not be read (${describeError(error)}); an unreadable state is never assumed to be empty`], [], null)
    throw error
  }

  const planSteps = prepared.steps.map((step): StepResult => {
    const c = classified.get(step.step)!
    const residual = buildResidual(step.step, step.data, c)
    return {
      ...emptyResult(step.step, 'PENDING'),
      emitted: c.counts.emitted,
      toLoad: c.counts.absent,
      skippedExisting: c.counts.presentMatching,
      residual: residual.map((r) => ({ name: r.name, rows: r.rows, sha256: r.sha256 })),
      conflicts: listConflicts(c),
      rows: rowsOf(c, (u) => (u.state === 'absent' ? { outcome: 'planned', reason: null } : u.state === 'present-matching' ? { outcome: 'would-skip-existing', reason: null } : { outcome: 'conflict', reason: u.conflict?.code ?? null })),
    }
  })
  const anyConflict = prepared.steps.some((s) => hasConflict(classified.get(s.step)!))

  // The run record is read (never written) in both modes: the rails need to know whether this is a fresh load or a resume.
  let existing: RunRecord | null
  try {
    existing = await ports.journal.load()
    if (ports.preflight) {
      const problems = await ports.preflight({ resuming: existing !== null })
      if (problems.length > 0) return finish('PRECONDITION_REFUSED', problems, planSteps, existing)
    }
  } catch (error) {
    if (error instanceof ObservationError) return finish('PRECONDITION_REFUSED', [`the database could not be read (${describeError(error)}); an unreadable state is never assumed to be empty`], planSteps, null)
    throw error
  }

  if (options.mode === 'plan') {
    return finish(anyConflict ? 'PRECONDITION_REFUSED' : 'OK', anyConflict ? ['the database holds data that conflicts with the files; see the conflicts per step (a plan writes nothing)'] : [], planSteps, null)
  }

  // ---- Run record: create, or resume the SAME load ----------------------------------------------------------------------------------
  if (existing === null && options.resume) return finish('PRECONDITION_REFUSED', ['--resume was given but no run record exists for this database'], planSteps, null)
  if (existing !== null) {
    if (!options.resume) return finish('PRECONDITION_REFUSED', ['a run record already exists in this database; this command refuses to start a second load over it (use --resume for the same load)'], planSteps, existing)
    if (existing.manifestDigest !== prepared.manifestDigest) return finish('PRECONDITION_REFUSED', [`the run record is for a different load (recorded digest ${existing.manifestDigest}, this load ${prepared.manifestDigest})`], planSteps, existing)
    // An APPLIED run is resumable for VERIFICATION ONLY: no step is run and no importer is called.
    if (!RESUMABLE_STATUSES.has(existing.status) && existing.status !== 'APPLIED') return finish('PRECONDITION_REFUSED', [`the run record is ${existing.status}, which is not resumable`], planSteps, existing)
  }
  // From here on a conflict means a fresh run found foreign data (nothing written yet), or a resume found it (earlier writes stand).
  if (anyConflict) return finish(existing === null ? 'PRECONDITION_REFUSED' : 'CONFLICT', ['the database holds data that conflicts with the files; see the conflicts per step'], planSteps, existing)

  if (existing !== null && existing.status === 'APPLIED') return verifyApplied(prepared, ports, existing, planSteps, finish)

  let record: RunRecord
  try {
    if (existing === null) {
      record = { version: 1, manifestDigest: prepared.manifestDigest, runId: prepared.manifest.runId, status: 'RUNNING', currentStep: null, steps: {} }
      await ports.journal.save(record, null)
    } else {
      record = { ...existing, version: existing.version + 1, status: 'RUNNING' }
      await ports.journal.save(record, existing.version)
    }
  } catch (error) {
    if (error instanceof StaleJournalError) return finish('PRECONDITION_REFUSED', [error.message], planSteps, existing)
    throw error
  }

  const results: StepResult[] = []
  const persist = async (patch: Partial<RunRecord>, step?: { id: ApplyStepId; journal: StepJournal }): Promise<void> => {
    const next: RunRecord = { ...record, ...patch, version: record.version + 1, steps: step ? { ...record.steps, [step.id]: step.journal } : record.steps }
    await ports.journal.save(next, record.version)
    record = next
  }
  const stop = async (exit: ApplyExitName, status: RunStatus, problems: string[], step: ApplyStepId | null): Promise<ApplyResult> => {
    try {
      await persist({ status, currentStep: step })
    } catch {
      // The record could not be updated (another runner, or the store is gone). The exit and the report still say what happened.
    }
    return finish(exit, problems, results, record)
  }

  for (const step of prepared.steps) {
    let outcome: StepOutcome
    try {
      outcome = await ports.withStepLock(step.step, (lock) => runStep(step, ports, persist, lock))
    } catch (error) {
      if (error instanceof StaleJournalError || error instanceof StepLockError) return finish('STEP_FAILED', [`${step.step}: ${error.message}`], results, record)
      if (error instanceof ObservationError) {
        const failed = { ...emptyResult(step.step, 'FAILED'), error: describeError(error) }
        results.push(failed)
        return stop('STEP_FAILED', 'STEP_FAILED', [`${step.step}: the database could not be read (${failed.error}); the run is resumable`], step.step)
      }
      throw error
    }
    results.push(outcome.result)
    if (outcome.halt !== null) return stop(outcome.halt.exit, outcome.halt.exit === 'CONFLICT' ? 'CONFLICT' : 'STEP_FAILED', outcome.halt.problems, step.step)
  }

  // Self-check: the accounting identity, for every step.
  for (const r of results) {
    if (r.emitted !== r.created + r.updated + r.skippedExisting + r.failed) return stop('INTERNAL', 'STEP_FAILED', [`${r.step}: the row accounting does not reconcile (emitted ${r.emitted} != created ${r.created} + updated ${r.updated} + skipped ${r.skippedExisting} + failed ${r.failed})`], r.step)
  }

  let verification: VerificationItem[] = []
  try {
    await persist({ status: 'APPLIED', currentStep: null })
    if (ports.verify) verification = await ports.verify(prepared, results)
  } catch (error) {
    if (error instanceof StaleJournalError) return finish('STEP_FAILED', [error.message], results, record)
    throw error
  }
  if (verification.some((v) => v.result === 'fail')) {
    await persist({ status: 'VERIFY_FAILED' }).catch(() => undefined)
    return finish('VERIFY_FAILED', verification.filter((v) => v.result === 'fail').map((v) => `${v.id}: expected ${v.expected}, found ${v.actual}`), results, record, verification)
  }
  if (!ports.verify) {
    // Nothing verified the load, so it is NOT reported as a success: the record stays APPLIED and a later --resume verifies it.
    await persist({ status: 'APPLIED' })
    return finish('APPLIED_UNVERIFIED', ['no post-run verification was run: this runner has no verification port'], results, record, verification)
  }
  await persist({ status: 'VERIFIED' })
  return finish('OK', [], results, record, verification)
}

/**
 * Resume of an APPLIED run: verification only. Nothing is loaded and no importer is called. Without a verification port nothing is written at all
 * and the result is the same APPLIED_UNVERIFIED; with one, the verdict is recorded (VERIFIED or VERIFY_FAILED) by compare-and-swap.
 */
async function verifyApplied(
  prepared: PreparedRun,
  ports: ApplyPorts,
  existing: RunRecord,
  planSteps: StepResult[],
  finish: (exit: ApplyExitName, problems: string[], steps: StepResult[], record: RunRecord | null, verification?: VerificationItem[]) => ApplyResult,
): Promise<ApplyResult> {
  if (!ports.verify) return finish('APPLIED_UNVERIFIED', ['no post-run verification was run: this runner has no verification port'], planSteps, existing)
  let verification: VerificationItem[]
  try {
    verification = await ports.verify(prepared, planSteps)
    const failed = verification.some((v) => v.result === 'fail')
    const next: RunRecord = { ...existing, version: existing.version + 1, status: failed ? 'VERIFY_FAILED' : 'VERIFIED' }
    await ports.journal.save(next, existing.version)
    existing = next
  } catch (error) {
    if (error instanceof StaleJournalError) return finish('STEP_FAILED', [error.message], planSteps, existing)
    throw error
  }
  if (verification.some((v) => v.result === 'fail')) {
    return finish('VERIFY_FAILED', verification.filter((v) => v.result === 'fail').map((v) => `${v.id}: expected ${v.expected}, found ${v.actual}`), planSteps, existing, verification)
  }
  return finish('OK', [], planSteps, existing, verification)
}

interface StepOutcome {
  result: StepResult
  /** Set when the run must stop after this step, with the exit to report. */
  halt: { exit: ApplyExitName; problems: string[] } | null
}

async function runStep(
  step: PreparedStep,
  ports: ApplyPorts,
  persist: (patch: Partial<RunRecord>, step?: { id: ApplyStepId; journal: StepJournal }) => Promise<void>,
  lock: StepLock,
): Promise<StepOutcome> {
  const id = step.step
  const fail = (exit: ApplyExitName, problems: string[], result: StepResult): StepOutcome => ({ result, halt: { exit, problems } })

  if (ports.recheckRails) {
    const problems = await ports.recheckRails(id, 'step-start')
    if (problems.length > 0) return fail('STEP_FAILED', problems.map((p) => `${id}: a rail no longer holds: ${p}`), { ...emptyResult(id, 'FAILED'), error: problems.join('; ') })
  }
  // The residual is computed UNDER the lock, from a fresh read: whatever the earlier read said, only this one counts.
  const before = classifyStep(id, step.units, await ports.observe(id))
  if (hasConflict(before)) {
    const conflicts = listConflicts(before)
    // Problem text reaches logs: a closed code and a count per code, never a key. The keys are in the conflict report (rows and conflicts), which is the controlled place for them.
    const byCode = new Map<string, number>()
    for (const c of conflicts) byCode.set(c.code, (byCode.get(c.code) ?? 0) + 1)
    return fail('CONFLICT', [`${id}: ${conflicts.length} conflict(s): ${[...byCode.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, n]) => `${code} x${n}`).join(', ')}`], { ...emptyResult(id, 'CONFLICT'), emitted: before.counts.emitted, conflicts })
  }
  const residual = buildResidual(id, step.data, before)
  const result: StepResult = {
    ...emptyResult(id, 'RUNNING'),
    emitted: before.counts.emitted,
    toLoad: before.counts.absent,
    residual: residual.map((r) => ({ name: r.name, rows: r.rows, sha256: r.sha256 })),
  }

  if (residual.length > 0) {
    if (ports.recheckRails) {
      const problems = await ports.recheckRails(id, 'before-first-write')
      if (problems.length > 0) return fail('STEP_FAILED', problems.map((p) => `${id}: a rail no longer holds: ${p}`), { ...result, status: 'FAILED', error: problems.join('; ') })
    }
    if (ports.storeResidual) for (const file of residual) await ports.storeResidual(file)
    await persist({ currentStep: id }, { id, journal: { status: 'RUNNING', emitted: result.emitted, created: 0, updated: 0, skippedExisting: 0, failed: 0, residualSha256: residual.map((r) => r.sha256) } })
    for (const file of residual) {
      try {
        const answer = await ports.execute(id, file, lock)
        result.importer.push({ file: file.name, created: answer.created, updated: answer.updated, skipped: answer.skipped, errors: summariseImporterErrors(answer.errors) })
      } catch (error) {
        result.error = `the importer failed on ${file.name}: ${describeError(error)}`
        result.importer.push({ file: file.name, created: 0, updated: 0, skipped: 0, errors: [{ code: 'EXCEPTION', row: null }] })
        break
      }
    }
  }

  // Accounting from the database: the state of every unit before against after.
  const after = classifyStep(id, step.units, await ports.observe(id))
  const beforeState = new Map(before.units.map((u) => [u.unit.key, u.state]))
  let loadedRows = 0
  result.rows = rowsOf(after, (u) => {
    const was = beforeState.get(u.unit.key)
    if (was === 'present-matching' && u.state === 'present-matching') return { outcome: 'skipped-existing', reason: null }
    if (was === 'absent' && u.state === 'present-matching') return { outcome: 'created', reason: null }
    if (u.state === 'absent') return { outcome: 'failed', reason: 'not loaded' }
    return { outcome: 'failed', reason: u.conflict?.code ?? 'changed during the step' }
  })
  for (const row of result.rows) {
    if (row.outcome === 'created') result.created++
    else if (row.outcome === 'skipped-existing') result.skippedExisting++
    else result.failed++
  }
  result.conflicts = listConflicts(after)
  for (const u of after.units) if (beforeState.get(u.unit.key) === 'absent' && u.state === 'present-matching') loadedRows += u.unit.rowIndexes.length
  // Cross-check against the importers' own counters: a disagreement is a finding that names what the database shows.
  const claimedCreated = result.importer.reduce((t, i) => t + i.created, 0)
  if (result.importer.length > 0 && claimedCreated !== loadedRows) {
    // A count only: which units are not loaded is in the step's rows (the controlled place for keys).
    const notLoaded = result.rows.filter((r) => r.outcome === 'failed').length
    result.counterFindings.push(`the importer(s) reported ${claimedCreated} row(s) created, the database shows ${loadedRows}${notLoaded > 0 ? `; ${notLoaded} unit(s) not loaded (see the step's rows)` : ''}`)
  }
  if (after.counts.foreign > 0) result.counterFindings.push(`${after.counts.foreign} database row(s) of this step were not emitted by this run`)

  const ok = result.failed === 0 && result.error === null && after.counts.foreign === 0
  result.status = ok ? 'DONE' : 'FAILED'
  if (!ok && result.error === null) result.error = `${result.failed} unit(s) were not loaded or do not match the file${after.counts.foreign > 0 ? `; ${after.counts.foreign} foreign row(s)` : ''}`
  await persist({ currentStep: ok ? null : id }, { id, journal: { status: result.status, emitted: result.emitted, created: result.created, updated: result.updated, skippedExisting: result.skippedExisting, failed: result.failed, residualSha256: residual.map((r) => r.sha256) } })
  return { result, halt: ok ? null : { exit: 'STEP_FAILED', problems: [`${id}: ${result.error}`] } }
}
