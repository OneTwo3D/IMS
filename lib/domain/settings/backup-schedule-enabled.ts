import { getAllCronJobs } from '@/lib/cron-jobs'
import { cronEnablementKeys, resolveCronEnablement, type StoredSettingValue } from '@/lib/domain/settings/cron-enablement'

/**
 * BACKUP SLUG. The registry entry is what carries the legacy key and the default, and looking it up
 * rather than restating them is what keeps this level with `lib/cron-jobs/system.ts`.
 */
const BACKUP_JOB_SLUG = 'backup'

/**
 * Is the scheduled backup job on? — the ONE answer, for the route and for the settings page.
 *
 * The barrel, not `@/lib/cron-registry`: registration is an import side effect of the job modules,
 * so the bare registry is empty and this would silently fall through to a default.
 *
 * See `cron-enablement.ts` for why a single resolver is the fix and why it needs no migration.
 */
export async function isBackupScheduleEnabled(
  read: (key: string) => Promise<StoredSettingValue>,
): Promise<boolean> {
  const job = getAllCronJobs().find((candidate) => candidate.slug === BACKUP_JOB_SLUG)
  if (!job) {
    // The registry no longer has a backup job. Refusing to run is the only safe reading: the
    // alternative is taking backups on a schedule nothing describes.
    return false
  }

  const { canonicalKey, legacyKey } = cronEnablementKeys(job)
  const [canonical, legacy] = await Promise.all([
    read(canonicalKey),
    legacyKey ? read(legacyKey) : Promise.resolve(null),
  ])

  return resolveCronEnablement({
    canonical,
    legacy,
    hasLegacyKey: Boolean(legacyKey),
    defaultEnabled: job.defaultEnabled,
  })
}
