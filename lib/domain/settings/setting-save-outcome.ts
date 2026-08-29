import { schedulerBehindWarning } from '@/lib/domain/integrations/scheduler-followup'

/**
 * WHAT A SETTINGS SAVE CAN REPORT (o3d-osl8 round 9, finding 1).
 *
 * `setSetting` used to return `void`: it committed a `settings` upsert and then awaited
 * `logActivity` and `revalidatePath`. Either of those rejecting rejected the whole action, and every
 * screen behind it — the Public App URL panel, the Company onboarding step, the scheduled-jobs
 * editor and ten others — has an outer `catch` that renders a rejection as a red "failed to save".
 * Over a value that is in the database. That is the same defect rounds 7 and 8 fixed twice at the
 * sites they happened to be looking at, surviving at the sites they were not.
 *
 * Fixing it at each SCREEN was what produced two wrong inventories. It is fixed at the WRITER
 * instead: the settings actions return this union and no longer reject after their commit, so every
 * caller — including the ten that read no result at all — is covered by construction rather than by
 * a sweep.
 */
export type SettingSaveResult =
  /** Committed, and everything derived from it (audit row, caches, crontab) matches. */
  | { status: 'saved' }
  /** NOTHING was written — the request was rejected before the transaction. The stored value stands. */
  | { status: 'refused'; error: string }
  /**
   * COMMITTED. A post-commit step did not complete, so a DERIVED artefact may lag the stored value.
   * Never rendered as a failed save.
   *
   * `step` exists so the sentence stays TRUE. The scheduler case has an operator recovery ("open
   * Settings → System → Scheduler and sync") and rounds 7-8 pinned its wording; the local case —
   * the activity-log row or the rendered cache — has neither, and calling it "the scheduler could
   * not be updated" would be a second, smaller lie in the place built to stop the first one.
   */
  | { status: 'post-commit-failed'; step: 'scheduler' | 'local'; error: string }

/**
 * The non-scheduler half of the same sentence: the value is stored, a derived artefact is not.
 * There is no operator action to name, so it says so rather than inventing one.
 */
export function savedButFollowUpFailedWarning(what: string, error: string): string {
  return `${what} was SAVED, but a follow-up step after the save did not complete: ${error} The `
    + 'stored value is correct; the audit-log entry or the page cache for it may be missing until '
    + 'the next successful save.'
}

export type SettingSaveView = {
  /** Did the value reach the database? Drives the "Saved" tick and whether a wizard step may advance. */
  committed: boolean
  /** Rendered as a failure. Empty when there is none. */
  error: string
  /** Rendered as a "saved, but" warning. Empty when there is none. */
  warning: string
}

/**
 * The whole decision, in one pure place, for the same reason as
 * `resolvePluginSelectionSaveView`: a decision spread across a component's try/catch cannot be
 * enumerated or tested, and that is precisely how it drifted per screen.
 *
 * `what` names the thing that WAS saved, because the first half of the sentence is the part the
 * operator most needs: what follows is about a derived artefact, not about their save.
 */
export function resolveSettingSaveView(input: { result: SettingSaveResult; what: string }): SettingSaveView {
  const { result, what } = input
  if (result.status === 'refused') return { committed: false, error: result.error, warning: '' }
  if (result.status === 'post-commit-failed') {
    return {
      committed: true,
      error: '',
      warning: result.step === 'scheduler'
        ? schedulerBehindWarning(what, result.error)
        : savedButFollowUpFailedWarning(what, result.error),
    }
  }
  return { committed: true, error: '', warning: '' }
}

/**
 * COMBINE A LOCAL AND A SCHEDULER POST-COMMIT OUTCOME — BOTH ARE ALWAYS ATTEMPTED (Codex r20 HIGH).
 *
 * The two writers that reconcile the crontab used to `return` on a failed LOCAL step, so a transient
 * activity-log or revalidate failure skipped the reconciliation entirely. For the backup schedule
 * that is the worst possible skip: the enable switch IS a crontab line, so the operator switched
 * backups on, the row committed, and no scheduled invocation was ever installed — under a warning
 * that said only the audit entry or a cache might lag, which was false.
 *
 * So the caller runs BOTH steps and hands the results here. The scheduler outcome wins when both
 * fail: it is the one with a named operator recovery (Settings -> System -> Scheduled Jobs -> Save &
 * Apply), and it is the one that describes an artefact the system's behaviour depends on. A missing
 * audit row is real but it is not something the operator can act on differently, and reporting it
 * INSTEAD of the stale crontab is how the false sentence got written in the first place.
 */
export function combinePostCommitOutcomes(input: {
  local: { status: 'ok' } | { status: 'failed'; error: string }
  scheduler: { status: 'ok' } | { status: 'failed'; error: string }
}): SettingSaveResult {
  if (input.scheduler.status === 'failed') {
    return { status: 'post-commit-failed', step: 'scheduler', error: input.scheduler.error }
  }
  if (input.local.status === 'failed') {
    return { status: 'post-commit-failed', step: 'local', error: input.local.error }
  }
  return { status: 'saved' }
}
