/**
 * ONE ANSWER TO "IS THIS SCHEDULED JOB ON?" (Codex r20 HIGH).
 *
 * A job can have TWO enablement rows: the canonical `cron_<settingKey>_enabled`, and — for jobs that
 * predate it — the registry's `legacyEnabledKey`. The crontab builder has always resolved them
 * canonical-first, legacy-fallback, default-last. Nothing else did.
 *
 * `/api/cron/backup` read ONLY `backup_schedule_enabled`, and so did the Backup settings page. On any
 * installation where the two rows disagree — and they could, because the Scheduled Jobs editor wrote
 * only the canonical row while the Backup panel wrote only the legacy one — that produced two silent
 * failures, in opposite directions:
 *
 *   • canonical on, legacy off: the cron line is installed and fires on schedule, and every
 *     invocation returns "Scheduled backups disabled". A job that runs and does nothing.
 *   • canonical off, legacy on: no cron line exists, and the Backup page's switch shows ON. Backups
 *     are never taken and the screen says they are scheduled.
 *
 * Writing both rows on save fixes new saves. It does NOT fix an installation that is already
 * diverged, and no migration is applied on this branch. So the fix is at READ time, which needs
 * none: every reader resolves through this function, in the crontab builder's order, so a diverged
 * pair resolves the same way everywhere — to the canonical row, which is what the crontab (and
 * therefore whether anything runs at all) was already obeying. The first save from either screen then
 * collapses the pair for good.
 *
 * Deliberately pure and import-free: `lib/crontab-sync.ts` is the one caller that must not pull the
 * registry or the database in.
 */

/** `undefined` and `null` both mean "no row" — Map.get and getSetting disagree on which they return. */
export type StoredSettingValue = string | null | undefined

export function resolveCronEnablement(input: {
  /** `cron_<settingKey>_enabled`. */
  canonical: StoredSettingValue
  /** The registry's `legacyEnabledKey` row, or absent when the job declares no legacy key. */
  legacy: StoredSettingValue
  /** Whether the job declares a legacy key at all — an absent VALUE and no KEY are different cases. */
  hasLegacyKey: boolean
  defaultEnabled: boolean
}): boolean {
  if (input.canonical !== undefined && input.canonical !== null) return input.canonical === 'true'
  if (input.hasLegacyKey && input.legacy !== undefined && input.legacy !== null) {
    return input.legacy === 'true'
  }
  return input.defaultEnabled
}

/**
 * The rows a caller must read to resolve one registry job's enablement.
 *
 * Kept beside the resolver so a reader cannot fetch the canonical row and forget the legacy one —
 * which reduces to reading the canonical row alone, one of the two failure directions above.
 */
export function cronEnablementKeys(job: { settingKey: string; legacyEnabledKey?: string }): {
  canonicalKey: string
  legacyKey: string | null
} {
  return {
    canonicalKey: `cron_${job.settingKey}_enabled`,
    legacyKey: job.legacyEnabledKey ?? null,
  }
}
