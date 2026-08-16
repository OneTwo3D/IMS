/**
 * A CRONTAB RECONCILIATION THAT RUNS AFTER A COMMITTED WRITE IS NOT PART OF THAT WRITE
 * (o3d-osl8 round 8, findings 1 and 2 — the shape, checked everywhere it occurs).
 *
 * Four screens do the same two things in the same order: persist a setting, then call `syncCrontab`
 * so the managed crontab block matches it.
 *
 *   components/settings/integration-plugins-settings.tsx  (via saveIntegrationPluginState)
 *   components/settings/public-app-url-settings.tsx
 *   components/settings/cron-jobs-settings.tsx
 *   components/onboarding/company-step.tsx
 *
 * Every one of them used to report a scheduler failure the same way it reports a rejected save — a
 * bare red error, no "Saved", and in the wizard's case a step that refuses to advance. The setting
 * is already in the database at that point. "Nothing happened" is the one thing that is certainly
 * untrue, and it is the reading that invites a retry of a write that already landed.
 *
 * Two failure shapes, ONE outcome. `syncCrontab` can RETURN `{ success: false }` (no cron secret, no
 * public app URL, a failed `crontab -` write) and it can THROW (its own `requirePermission`,
 * `getCronSecret`, `getPublicAppUrl`, the settings read, its activity-log write). Round 7 handled
 * only the first; a throw fell through to the caller's catch, where it is indistinguishable from
 * the save itself failing. Both are handled here, identically, so no call site can treat them
 * differently again.
 *
 * What this deliberately does NOT do is retry. See the note in ./plugin-save-outcome.ts: every
 * outbox drain in this app is a cron route invoked BY the crontab being written, so a queued
 * reconciliation would be drained by the thing it is trying to repair.
 */

export const SCHEDULER_RECOVERY =
  'Scheduled jobs may still be running for the previous selection until this is applied. Open '
  + 'Settings → System → Scheduler and use Sync crontab there; that page also reports whether the '
  + 'managed crontab block is currently in drift.'

/** The one sentence, so it cannot be re-typed per screen and drift. */
export function schedulerBehindWarning(what: string, error: string): string {
  return `${what} was SAVED, but the scheduler could not be updated to match it: ${error} ${SCHEDULER_RECOVERY}`
}

export type SchedulerFollowUp = {
  /** Empty when the scheduler now matches. Never rendered as an error — the write is durable. */
  warning: string
}

/**
 * Run a post-commit crontab reconciliation and classify it.
 *
 * `what` names the thing that WAS saved, because the first half of the sentence is the part the
 * operator most needs: the failure that follows is about the scheduler, not about their save.
 */
export async function resolveSchedulerFollowUp(input: {
  what: string
  sync: () => Promise<{ success: boolean; error?: string }>
  fallbackError?: string
}): Promise<SchedulerFollowUp> {
  const fallback = input.fallbackError ?? 'Failed to apply scheduler changes'
  try {
    const result = await input.sync()
    if (result.success) return { warning: '' }
    return { warning: schedulerBehindWarning(input.what, result.error ?? fallback) }
  } catch (error) {
    return { warning: schedulerBehindWarning(input.what, error instanceof Error ? error.message : fallback) }
  }
}
