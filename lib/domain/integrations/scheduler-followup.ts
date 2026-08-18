/**
 * A CRONTAB RECONCILIATION THAT RUNS AFTER A COMMITTED WRITE IS NOT PART OF THAT WRITE
 * (o3d-osl8 round 8, findings 1 and 2 — the shape, checked everywhere it occurs).
 *
 * Four screens do the same two things in the same order: persist a setting, then reconcile the
 * managed crontab block so the scheduler matches it.
 *
 *   components/settings/integration-plugins-settings.tsx  (via saveIntegrationPluginState)
 *   components/settings/public-app-url-settings.tsx       (via savePublicAppUrl)
 *   components/settings/cron-jobs-settings.tsx            (via saveCronJobSettings)
 *   components/onboarding/company-step.tsx                (via savePublicAppUrl)
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

/**
 * THE RECOVERY HAS TO NAME A CONTROL THAT EXISTS (o3d-osl8 round 9).
 *
 * Rounds 7 and 8 wrote "use Sync crontab there". There is no such button: the scheduler tab renders
 * `CronJobsSettings`, whose only control is Save & Apply, and the drift warnings on that page
 * already say "Save the scheduler settings to write it". A warning that sends an operator to look
 * for a control that was never built is the same class of defect as the warning itself was written
 * to fix — a message the reader cannot act on — and it survived two rounds of review because the
 * assertions matched on "Settings → System → Scheduler" and stopped there.
 */
export const SCHEDULER_RECOVERY =
  'Scheduled jobs may still be running for the previous selection until this is applied. Open '
  + 'Settings → System → Scheduler and press Save & Apply there; that page also reports whether the '
  + 'managed crontab block is currently in drift.'

/** The one sentence, so it cannot be re-typed per screen and drift. */
export function schedulerBehindWarning(what: string, error: string): string {
  return `${what} was SAVED, but the scheduler could not be updated to match it: ${error} ${SCHEDULER_RECOVERY}`
}

/**
 * WHY THERE IS NO LONGER A CLIENT-SIDE `resolveSchedulerFollowUp` (round 9, finding 4).
 *
 * Round 8 gave three of those screens a shared client helper that ran `syncCrontab` and classified
 * the result in a catch. Two things were wrong with it. The catch was a catch-all, so a
 * `NEXT_REDIRECT` raised by `syncCrontab`'s own re-entered permission gate became a scheduler
 * warning instead of a redirect. And running the reconciliation as a SECOND round trip meant the
 * write and its post-commit step could not be one atomic-then-guarded unit — the screen was left
 * holding a sequence it had to classify correctly, which is the thing that kept going wrong.
 *
 * All three now call a server action that commits and then runs every post-commit step inside
 * `runPostCommit` (which rethrows framework control flow first). This module keeps only the
 * SENTENCE, which is shared by the plugin resolver and the settings resolver.
 */
