/**
 * THE RUN RECORD: one row per database, moved only by compare-and-swap.
 *
 * `save(record, null)` creates the row and succeeds only when there is none (the unique `singleton` column makes a second row impossible).
 * `save(record, n)` writes version n+1 only while the stored version is still n and the stored digest is this load's: one statement,
 * `UPDATE ... WHERE version = n`, whose affected-row count is the answer. Two runners that both read version n cannot both win.
 *
 * Audit and identity only: the runner derives what to load from the data tables, never from this row, so a lost or stale record can
 * stop a run but cannot make it load the wrong rows.
 */
import { db } from '@/lib/db'
import { APPLY_STEP_IDS, RUN_STATUSES, type ApplyStepId, type RunStatus } from '../constants'
import { StaleJournalError, type ApplyPorts, type RunRecord, type StepJournal } from '../orchestrate'
import { ObservationError } from '../residual'
import { DATABASE_READ_FAILED } from './observe'

export const JOURNAL_WRITE_FAILED = 'the run record could not be written'

function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value)
}

function isStep(value: string | null): value is ApplyStepId {
  return value !== null && (APPLY_STEP_IDS as readonly string[]).includes(value)
}

/** Facts recorded once on the run record (never rewritten). Absent record: none. */
export async function loadFacts(): Promise<Record<string, unknown>> {
  try {
    const row = await db.firstLoadApplyRun.findFirst({ select: { facts: true } })
    return row === null || typeof row.facts !== 'object' || row.facts === null || Array.isArray(row.facts) ? {} : (row.facts as Record<string, unknown>)
  } catch {
    throw new ObservationError(DATABASE_READ_FAILED)
  }
}

/** The statement client setFactOnceIn needs: the pooled client or a transaction. */
type RawClient = { $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number> }

/**
 * Record a fact only if it is not recorded yet, through `client` - a transaction, so the fact commits (or rolls back) WITH the writes of that transaction. Returns true when this call
 * recorded it. A failure of the statement is JOURNAL_WRITE_FAILED (the driver's text is dropped).
 */
export async function setFactOnceIn(client: RawClient, key: string, value: unknown): Promise<boolean> {
  try {
    const changed = await client.$executeRaw`UPDATE first_load_apply_runs SET facts = facts || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb) WHERE singleton AND NOT jsonb_exists(facts, ${key}::text)`
    return changed === 1
  } catch {
    throw new Error(JOURNAL_WRITE_FAILED)
  }
}

/** Record a fact only if it is not recorded yet: the first value is the one the orders were created under. Returns true when this call recorded it. */
export function setFactOnce(key: string, value: unknown): Promise<boolean> {
  return setFactOnceIn(db, key, value)
}

export function createJournal(): ApplyPorts['journal'] {
  return {
    async load(): Promise<RunRecord | null> {
      let row
      try {
        row = await db.firstLoadApplyRun.findFirst()
      } catch {
        throw new ObservationError(DATABASE_READ_FAILED)
      }
      if (row === null) return null
      // A record this runner cannot read is not "no record": it is somebody else's, and treating it as absent would let a second load start over it.
      if (!isRunStatus(row.status) || (row.currentStep !== null && !isStep(row.currentStep))) throw new ObservationError('the run record holds a value this runner does not know')
      return {
        version: row.version,
        manifestDigest: row.manifestDigest,
        runId: row.runId,
        status: row.status,
        currentStep: row.currentStep as ApplyStepId | null,
        steps: row.steps as Partial<Record<ApplyStepId, StepJournal>>,
      }
    },

    async save(record: RunRecord, expectedVersion: number | null): Promise<void> {
      if (expectedVersion === null ? record.version !== 1 : record.version !== expectedVersion + 1) {
        throw new RangeError('a run record save must advance the version by exactly one')
      }
      const steps = JSON.stringify(record.steps)
      let changed: number
      try {
        changed = expectedVersion === null
          ? await db.$executeRaw`
              INSERT INTO first_load_apply_runs (id, singleton, version, manifest_digest, run_id, status, current_step, steps)
              VALUES (${`flr_${record.manifestDigest.slice(0, 24)}`}, true, ${record.version}, ${record.manifestDigest}, ${record.runId}, ${record.status}, ${record.currentStep}, ${steps}::jsonb)
              ON CONFLICT DO NOTHING`
          : await db.$executeRaw`
              UPDATE first_load_apply_runs
                 SET version = ${record.version}, status = ${record.status}, current_step = ${record.currentStep}, steps = ${steps}::jsonb, updated_at = CURRENT_TIMESTAMP
               WHERE singleton AND version = ${expectedVersion} AND manifest_digest = ${record.manifestDigest} AND run_id = ${record.runId}`
      } catch {
        // A constraint violation is the database refusing a value (a status the CHECK does not know): a defect, not a lost race. The driver's text is dropped.
        throw new Error(JOURNAL_WRITE_FAILED)
      }
      if (changed !== 1) throw new StaleJournalError()
    },
  }
}
