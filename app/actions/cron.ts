'use server'

import { existsSync, readFileSync } from 'fs'
import os from 'os'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { getCronSecret } from '@/lib/cron-secret'
import {
  emulateRuntimeSecretExtraction,
  parseOtiCrontabStatus,
  type OtiCrontabStatus,
} from '@/lib/crontab-sync'
import { reconcileCrontab, readOwnCrontab } from '@/lib/crontab-reconcile'
// The BARREL, not @/lib/cron-registry: registration is an import side effect of the job modules,
// so the registry is EMPTY unless something has imported them. Reading it bare would have mirrored
// no legacy key and reported nothing.
import { getAllCronJobs } from '@/lib/cron-jobs'
import { serializeSettingValue } from '@/lib/settings-store'
import { runPostCommit } from '@/lib/domain/post-commit'
import { combinePostCommitOutcomes, type SettingSaveResult } from '@/lib/domain/settings/setting-save-outcome'

/**
 * Reconcile the OS crontab from the stored cron_* settings, behind the permission gate.
 *
 * The gate and the work are separate modules now (o3d-osl8 round 9, finding 4): the work lives in
 * lib/crontab-reconcile.ts, and callers that have ALREADY run this same permission check call it
 * directly rather than re-entering a gate whose failure mode is a thrown `NEXT_REDIRECT`.
 *
 * NO UI CALLS THIS TODAY, stated rather than implied. The operator recovery for a crontab that is
 * behind is Settings -> System -> Scheduler -> Save & Apply, which goes through
 * `saveCronJobSettings` below; the drift warnings on that page say so. The rounds 7-8 warning text
 * said "use Sync crontab there", naming a button that was never built (corrected in
 * lib/domain/integrations/scheduler-followup.ts). This export is kept as the gated entry point for
 * an explicit re-sync, and it is the ONLY server action wrapping the ungated reconciliation.
 */
export async function syncCrontab(): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')
  return reconcileCrontab()
}

export type CronJobSettingInput = {
  settingKey: string
  enabled: boolean
  schedule: string
}

/**
 * SAVE EVERY SCHEDULED-JOB SETTING IN ONE TRANSACTION, THEN RECONCILE (o3d-osl8 round 9, finding 1).
 *
 * The scheduled-jobs editor used to fire `2 x jobs` parallel `setSetting` calls through
 * `Promise.all`, then call `syncCrontab`. Two defects, one shape:
 *
 *   * PARTIAL COMMIT. `Promise.all` rejects on the first failure while the rest keep going, so a
 *     failed save could leave an ARBITRARY SUBSET of the editor's rows stored — a crontab derived
 *     from half of one operator edit — and the screen reported the whole save as failed.
 *   * A COMMITTED WRITE REPORTED AS A FAILED SAVE. `setSetting` committed its upsert and then
 *     awaited `logActivity` and `revalidatePath`; either rejecting rejected the action, and the
 *     screen's outer catch rendered that as "an error occurred" over rows that are in the database.
 *
 * One transaction removes the first. The post-commit guard removes the second: nothing after the
 * commit — the audit row, the cache revalidation, the crontab write — may reject this action.
 */
export async function saveCronJobSettings(jobs: CronJobSettingInput[]): Promise<SettingSaveResult> {
  await requirePermission('settings.company')

  // THE LEGACY ENABLEMENT ROW IS MIRRORED, NOT LEFT BEHIND (Codex r20 HIGH).
  //
  // A registry job may declare a `legacyEnabledKey` — the row the crontab consulted before the
  // canonical `cron_<job>_enabled` existed, and which `buildOtiCrontabBlock` still falls back to
  // while the canonical row is absent. For `backup` that legacy row is `backup_schedule_enabled`,
  // and it is ALSO the row `/api/cron/backup` gates its own execution on. Writing only the
  // canonical row therefore produced the exact disagreement the fallback was meant to prevent: the
  // cron line installed, the route skipping every invocation, and neither screen showing anything
  // wrong. Mirroring here is the other half of `saveBackupScheduleSettings`, which writes both rows
  // from the Backup screen.
  const legacyKeyBySettingKey = new Map(
    getAllCronJobs()
      .filter((job) => job.legacyEnabledKey)
      .map((job) => [job.settingKey, job.legacyEnabledKey!]),
  )

  const entries: Array<[string, string]> = jobs.flatMap((job) => {
    const rows: Array<[string, string]> = [
      [`cron_${job.settingKey}_enabled`, String(job.enabled)],
      [`cron_${job.settingKey}_schedule`, job.schedule],
    ]
    const legacy = legacyKeyBySettingKey.get(job.settingKey)
    if (legacy) rows.push([legacy, String(job.enabled)])
    return rows
  })
  if (entries.length === 0) return { status: 'saved' }

  await db.$transaction(async (tx) => {
    for (const [key, value] of entries) {
      await tx.setting.upsert({
        where: { key },
        create: { key, value: serializeSettingValue(key, value) },
        update: { value: serializeSettingValue(key, value) },
      })
    }
  })

  // POST-COMMIT. Split in two so the warning sentence stays true about WHICH artefact lags.
  // BOTH STEPS ALWAYS RUN (Codex r20 HIGH). Returning early on the local step meant a transient
  // activity-log failure left the crontab un-reconciled — on the very screen whose whole purpose is
  // to change it — under a warning that talked about the audit row instead.
  const local = await runPostCommit(async () => {
    await logActivity({
      entityType: 'SETTING',
      tag: 'settings',
      action: 'updated',
      description: `Updated scheduled job settings (${jobs.length} jobs)`,
    })
  }, 'Failed to record the scheduled-job change')

  const scheduler = await runPostCommit(reconcileCrontab, 'Failed to sync crontab')

  return combinePostCommitOutcomes({ local, scheduler })
}

export type CrontabDriftStatus = OtiCrontabStatus & {
  /** OS user whose crontab the app manages (the service user). */
  osUser: string
  /** Runtime-env mode only: does the .env pipeline still yield the ACTIVE secret? null otherwise. */
  runtimeSecretMatches: boolean | null
}

/**
 * Drift inspection for the scheduler settings page (ryxy): reports whether
 * the app user's crontab has a managed block, how it sources its secret, and
 * whether an embedded secret is STALE (the silent-401 failure mode), plus any
 * unmanaged /api/cron/ lines that will drift outside the app's control.
 */
export async function getCrontabStatus(): Promise<CrontabDriftStatus> {
  await requirePermission('settings.company')
  const [crontabText, secret] = await Promise.all([readOwnCrontab(), getCronSecret()])
  const status = parseOtiCrontabStatus(crontabText, secret)

  // Runtime-env blocks can drift too (Codex): an edited-but-not-restarted .env
  // or a service-manager override makes the pipeline yield a value the app no
  // longer accepts. Re-run the emulation against the .env path the cron line
  // ACTUALLY reads (Codex r2: checking process.cwd()/.env could report a block
  // pointing at a stale/other path as healthy).
  let runtimeSecretMatches: boolean | null = null
  if (status.secretMode === 'runtime-env' && status.runtimeEnvPath && secret) {
    const envFilePath = status.runtimeEnvPath
    try {
      runtimeSecretMatches = existsSync(envFilePath)
        ? emulateRuntimeSecretExtraction(readFileSync(envFilePath, 'utf8')) === secret
        : false
    } catch {
      runtimeSecretMatches = false
    }
  }

  return {
    ...status,
    osUser: os.userInfo().username,
    runtimeSecretMatches,
  }
}
