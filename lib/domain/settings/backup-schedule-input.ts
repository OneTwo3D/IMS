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
 * A whole-number floor of 1 on both counts because the purge reads them as `parseInt(x) || default`:
 * a blank or a `0` silently became 30 days / 10 files at purge time, which is a schedule the
 * operator never chose and the screen never showed back to them.
 */
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
