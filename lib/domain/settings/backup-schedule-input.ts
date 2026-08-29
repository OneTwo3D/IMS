/**
 * The values the backup schedule panel may hold, in one import-free place (Codex r20 HIGH).
 *
 * Shared between `saveBackupScheduleSettings` — which is the gate — and the screen, which uses it
 * for immediate feedback. Separate from the action because a `'use server'` module may only export
 * async functions, and the screen must not import one for a constant.
 */

/** `''` means "do not upload"; the two named targets are what /api/cron/backup acts on. */
export const BACKUP_AUTO_UPLOAD_TARGETS: readonly string[] = ['', 's3', 'sftp']

export type BackupScheduleInput = {
  enabled: boolean
  retentionDays: string
  maxCount: string
  autoUpload: string
}

/**
 * Validate a backup schedule edit, or say why not.
 *
 * A WHOLE-NUMBER FLOOR OF 1 ON BOTH COUNTS, and the reason is not tidiness. `/api/cron/backup` reads
 * them as `parseInt(await getSetting(k) || 'default')`, and the fallback only catches an EMPTY row:
 *
 *   • `''`  → 30 days / 10 files. Harmless, and the only case the `||` was written for.
 *   • `'0'` → retentionDays 0 makes the purge cutoff `now`, so EVERY backup is older than it; and
 *     maxBackups 0 makes `i >= maxBackups` true for every file. Each of those deletes the whole
 *     backup set on the next scheduled run, moments after taking one.
 *   • `'abc'` → NaN, and both comparisons are false, so nothing is ever purged and the disk fills.
 *
 * The number input on the screen has `min={1}`, which is advice to a browser and was never a gate;
 * the generic writer this panel used stored whatever arrived.
 */
export const BACKUP_RETENTION_FALLBACK_DAYS = 30
export const BACKUP_MAX_COUNT_FALLBACK = 10

/**
 * What the purge should use for a stored value, given rows written before the gate above existed.
 *
 * Validating the WRITER does not fix a row already in the database, and the two values whose reading
 * is destructive are exactly the ones a writer with no gate could store. Anything not a positive
 * whole number reads as the documented default — never as "delete everything" and never as "never
 * purge".
 */
export function resolveBackupPurgeLimit(stored: string | null | undefined, fallback: number): number {
  const parsed = Number(stored)
  if (!Number.isInteger(parsed) || parsed < 1) return fallback
  return parsed
}
export function validateBackupScheduleInput(
  input: BackupScheduleInput,
): { ok: true; retentionDays: number; maxCount: number; autoUpload: string } | { ok: false; error: string } {
  const retentionDays = Number(input.retentionDays)
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    return { ok: false, error: 'Retention (days) must be a whole number of at least 1.' }
  }
  const maxCount = Number(input.maxCount)
  if (!Number.isInteger(maxCount) || maxCount < 1) {
    return { ok: false, error: 'Max backups must be a whole number of at least 1.' }
  }
  const autoUpload = input.autoUpload.trim()
  if (!BACKUP_AUTO_UPLOAD_TARGETS.includes(autoUpload)) {
    return { ok: false, error: 'Auto-upload must be None, S3 or SFTP.' }
  }
  return { ok: true, retentionDays, maxCount, autoUpload }
}
