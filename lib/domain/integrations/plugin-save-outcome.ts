import type { IntegrationPluginState } from '@/lib/integration-plugins'
import { schedulerBehindWarning } from '@/lib/domain/integrations/scheduler-followup'
import { runPostCommit } from '@/lib/domain/post-commit'

/**
 * WHAT A PLUGIN-SELECTION SAVE CAN ACTUALLY REPORT, and what a caller may conclude from each
 * (o3d-osl8 round 7 finding 1; round 8 findings 1 and 2).
 *
 * Both writers — `saveOnboardingPluginState` (the wizard's full-state write) and
 * `saveIntegrationPluginState` (Settings' partial write) — do the same two things in the same
 * order: commit every requested plugin flag in ONE locked transaction, and only then reconcile the
 * OS crontab so the scheduler matches the new selection. Those are two separate durability facts,
 * and the old `{ success: boolean; error?: string }` return could not tell them apart — so the
 * wizard, which treated every falsy `success` as a rejected save, rolled its switches back over a
 * selection that was already committed, and the Settings screen printed a bare red error over one.
 *
 * A discriminated union removes the ability to re-conflate them: there is no `success` field left
 * to test, and the committed outcome carries state that only exists because the write landed.
 *
 * WHY THE MODULE MOVED OUT OF `lib/domain/onboarding` (round 8, finding 2). Round 7 fixed the
 * classification in the wizard and cross-ported only the *warning* to Settings, leaving Settings
 * with a parallel copy of the RULE — and that copy still reported a committed write as a failed
 * save whenever the scheduler call threw. One rule, one implementation, two call sites; the
 * screens do not need different presentation, so there is no presentation parameter here either.
 *
 * WHY NOT A DURABLE OUTBOX RETRY for the scheduler half, which the repo does have
 * (lib/domain/integrations/outbox.ts). Every outbox drain in this app is a cron route
 * (app/api/cron/*) invoked BY the crontab this step is trying to write. An outbox row that
 * reconciles the crontab would therefore be drained by the crontab: in the failure that matters —
 * the managed block absent, stale or unwritable — nothing would ever run it, and the row would sit
 * PENDING while the UI reported the work as scheduled. That is the same class of lie this finding
 * is about, moved into the queue. The recovery is instead an EXPLICIT operator action with an
 * existing home: Settings → System → Scheduler, which already reports crontab drift
 * (getCrontabStatus) and reconciles the crontab whenever the scheduler settings are saved.
 */
export type PluginSelectionSaveResult =
  /** Committed, and the scheduler now matches it. */
  | { status: 'saved' }
  /** The locked transaction returned a conflict. NOTHING was written; the stored selection is unchanged. */
  | { status: 'refused'; error: string }
  /**
   * Committed — `pluginState` is the selection read back under the selection lock inside the
   * transaction that wrote it — but a POST-COMMIT step failed afterwards, so scheduled jobs may
   * still be running for the previous selection until an operator applies them.
   *
   * Produced for a scheduler step that RETURNS a failure and for one that THROWS (round 8, finding
   * 1). Those were different outcomes until this round: a thrown `syncCrontab` escaped the union
   * entirely and surfaced as a rejected server action, which is the caller's "outcome unknown"
   * path — the exact conflation the union exists to prevent, reached by the one shape the round-7
   * fix did not cover. Anything after the commit that can fail is now inside the same guard.
   */
  | { status: 'scheduler-failed'; error: string; pluginState: IntegrationPluginState }

/**
 * The attempt as the CALLER saw it: a returned result, or a rejection.
 *
 * A rejection is its own case rather than being folded into `refused`, because it is not one. A
 * server action rejects when its permission gate throws, when the transaction aborts — and when the
 * TRANSPORT fails, which includes a reply lost after the write committed. The client cannot tell
 * those apart (in production the error arrives as an opaque digest), so it must not act as though
 * it can.
 */
export type PluginSelectionSaveAttempt =
  | { kind: 'result'; result: PluginSelectionSaveResult }
  | { kind: 'rejected'; error: unknown }

export type PluginSelectionSaveView = {
  /** The selection the screen must display after this attempt. */
  plugins: IntegrationPluginState
  /** Did the selection reach the database? Drives `onPluginStateChange`, the "Saved" tick and readiness. */
  committed: boolean
  /** Shown as a failure. Empty when there is none. */
  error: string
  /**
   * Shown as a "saved, but" warning — NOT as a failure, because the selection above is durable and
   * the switches show it. Empty when there is none.
   */
  schedulerWarning: string
}

const UNKNOWN_OUTCOME =
  'The save request failed before it could report its outcome, so it is NOT known whether this '
  + 'selection was stored. The switches below still show what was requested, which may or may not '
  + 'be what is saved — reload this page to see the stored selection before changing it again.'

/**
 * Run everything a plugin-selection save still owes AFTER its transaction committed, and classify
 * the outcome (o3d-osl8 round 8, finding 1).
 *
 * THE DEFECT THIS EXISTS TO MAKE UNREPEATABLE. Round 7 gave a *returned* scheduler failure its own
 * outcome, by hand, at one call site:
 *
 *     const cronResult = await syncCrontab()
 *     if (!cronResult.success) return { status: 'scheduler-failed', ... }
 *
 * A THROWN one walked straight past that `if` and out of the action, where a server action's
 * rejection means "the outcome is unknown" — so the one thing the caller knew for certain (the
 * write committed) was reported as the one thing nobody knew. And `syncCrontab` throws readily: its
 * own permission gate, `getCronSecret`, `getPublicAppUrl`, the settings read and its activity-log
 * write are all `await`s that can reject.
 *
 * So the classification is not a shape a call site has to remember to write. `postCommit` covers
 * EVERY post-commit step — the activity log and the cache revalidation as well as the scheduler —
 * because each of those is an `await` after the commit, and any of them throwing had exactly the
 * same effect.
 *
 * `postCommit` may still RETURN a failure; returned and thrown produce the identical outcome, which
 * is the invariant this round is enforcing.
 *
 * ROUND 9, FINDING 4 — the classification is delegated to `runPostCommit` rather than written here,
 * because the catch this function used to own was a catch-all: it mapped Next's `NEXT_REDIRECT` to
 * `scheduler-failed` too, so a post-commit step that re-entered a permission gate produced a
 * "saved, but the scheduler is behind" warning instead of the auth redirect the framework was
 * asking for. One guard, one `unstable_rethrow`, every post-commit site.
 */
export async function completePluginSelectionSave(input: {
  /** The selection read back under the lock, inside the transaction that wrote it. */
  committed: IntegrationPluginState
  postCommit: () => Promise<void | { success: boolean; error?: string }>
  /** Fallback text when the step failed without saying why. */
  fallbackError?: string
}): Promise<PluginSelectionSaveResult> {
  const outcome = await runPostCommit(input.postCommit, input.fallbackError ?? 'Failed to apply scheduler changes')
  if (outcome.status === 'ok') return { status: 'saved' }
  return { status: 'scheduler-failed', error: outcome.error, pluginState: input.committed }
}

/**
 * Every outcome of one plugin-selection save, resolved in ONE place.
 *
 * Pure and exhaustive on purpose: this is the decision the wizard got wrong, and a decision spread
 * across a component's try/catch cannot be enumerated or tested. It is the same shape as
 * `resolveConnectorOrphanBannerState` for the same reason.
 *
 * THE RULE, in one line: the previous selection is restored ONLY when the save is known to have
 * committed nothing.
 */
export function resolvePluginSelectionSaveView(input: {
  attempt: PluginSelectionSaveAttempt
  /** What the operator asked for — what the switches are optimistically showing. */
  requested: IntegrationPluginState
  /** What they showed before the toggle. */
  previous: IntegrationPluginState
}): PluginSelectionSaveView {
  const { attempt, requested, previous } = input

  if (attempt.kind === 'rejected') {
    // NOT rolled back. Restoring `previous` asserts that nothing was written, which is exactly what
    // a rejection cannot establish. The switches keep showing the request, the message says the
    // outcome is unknown, and the operator is told to reload rather than to trust either.
    return {
      plugins: requested,
      committed: false,
      error: (attempt.error instanceof Error ? `${attempt.error.message}. ` : '') + UNKNOWN_OUTCOME,
      schedulerWarning: '',
    }
  }

  const { result } = attempt
  if (result.status === 'refused') {
    // The only outcome that committed nothing, and therefore the only one a rollback describes.
    return { plugins: previous, committed: false, error: result.error, schedulerWarning: '' }
  }

  if (result.status === 'scheduler-failed') {
    // Committed. The state shown is the one read back under the lock, not this caller's copy of
    // what it asked for, so a UI that disagrees with the database cannot survive here.
    return {
      plugins: result.pluginState,
      committed: true,
      error: '',
      schedulerWarning: schedulerBehindWarning('Your integration plugin selection', result.error),
    }
  }

  return { plugins: requested, committed: true, error: '', schedulerWarning: '' }
}
