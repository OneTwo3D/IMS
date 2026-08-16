import type { IntegrationPluginState } from '@/lib/integration-plugins'

/**
 * WHAT `saveOnboardingPluginState` CAN ACTUALLY REPORT, and what a caller may conclude from each
 * (o3d-osl8 round 7, finding 1).
 *
 * The action writes every exclusivity-bearing plugin flag in ONE locked transaction and only then
 * reconciles the OS crontab. Those are two separate durability facts, and the old
 * `{ success: boolean; error?: string }` return could not tell them apart — so the wizard, which
 * treats every falsy `success` as a rejected save, rolled its switches back over a selection that
 * was already committed. The operator then saw the OLD accounting connector while the database, the
 * runtime module gates and the next server render all used the NEW one.
 *
 * A discriminated union removes the ability to re-conflate them: there is no `success` field left
 * to test, and the two committed outcomes carry state that only exists because the write landed.
 */
export type SaveOnboardingPluginStateResult =
  /** Committed, and the scheduler now matches it. */
  | { status: 'saved' }
  /** The locked transaction returned a conflict. NOTHING was written; the stored selection is unchanged. */
  | { status: 'refused'; error: string }
  /**
   * Committed — `pluginState` is the selection read back under the selection lock inside the
   * transaction that wrote it — but `syncCrontab` failed afterwards, so scheduled jobs may still be
   * running for the previous selection until an operator applies them.
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
export type OnboardingPluginSaveAttempt =
  | { kind: 'result'; result: SaveOnboardingPluginStateResult }
  | { kind: 'rejected'; error: unknown }

export type OnboardingPluginSaveView = {
  /** The selection the wizard must display after this attempt. */
  plugins: IntegrationPluginState
  /** Did the selection reach the database? Drives `onPluginStateChange` and the step's readiness. */
  committed: boolean
  /** Shown as a failure. Empty when there is none. */
  error: string
  /**
   * Shown as a "saved, but" warning — NOT as a failure, because the selection above is durable and
   * the switches show it. Empty when there is none.
   */
  schedulerWarning: string
}

const SCHEDULER_RECOVERY =
  'Scheduled jobs may still be running for the previous selection until this is applied. Open '
  + 'Settings → System → Scheduler and use Sync crontab there; that page also reports whether the '
  + 'managed crontab block is currently in drift.'

const UNKNOWN_OUTCOME =
  'The save request failed before it could report its outcome, so it is NOT known whether this '
  + 'selection was stored. The switches below still show what was requested, which may or may not '
  + 'be what is saved — reload this page to see the stored selection before changing it again.'

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
export function resolveOnboardingPluginSaveView(input: {
  attempt: OnboardingPluginSaveAttempt
  /** What the operator asked for — what the switches are optimistically showing. */
  requested: IntegrationPluginState
  /** What they showed before the toggle. */
  previous: IntegrationPluginState
}): OnboardingPluginSaveView {
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
      schedulerWarning:
        `Your integration selection was SAVED, but the scheduler could not be updated to match it: ${result.error} `
        + SCHEDULER_RECOVERY,
    }
  }

  return { plugins: requested, committed: true, error: '', schedulerWarning: '' }
}
