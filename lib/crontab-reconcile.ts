import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { revalidatePath } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { getAllCronJobs } from '@/lib/cron-jobs'
import { getCronSecret } from '@/lib/cron-secret'
import {
  buildOtiCrontabBlock,
  emulateRuntimeSecretExtraction,
  isCronSafePath,
  spliceOtiBlock,
  type CrontabSecretRef,
} from '@/lib/crontab-sync'
import { getIntegrationPluginState, isIntegrationModuleVisible } from '@/lib/integration-plugins'
import { getPublicAppUrl } from '@/lib/public-app-url'
import { withCrontabReconcileLock, type HeldCrontabReconcileLock } from '@/lib/crontab-reconcile-lock'

/**
 * THE CRONTAB RECONCILIATION, SEPARATED FROM ITS PERMISSION GATE (o3d-osl8 round 9, finding 4).
 *
 * `syncCrontab` in app/actions/cron.ts is a `'use server'` export, so it re-runs
 * `requirePermission('settings.company')` on every call. That gate answers a missing, invalidated
 * or 2FA-unverified session by calling `redirect()`, which signals by THROWING `NEXT_REDIRECT`.
 *
 * Post-commit steps run inside a guard that classifies failures instead of rejecting the action
 * (lib/domain/post-commit.ts). Round 8's guard was a catch-all, so a redirect raised by this
 * re-entered gate was converted into "saved, but the scheduler is behind" and the operator stayed
 * on the page instead of going to the challenge. Two independent fixes, both applied:
 *
 *   1. `runPostCommit` calls `unstable_rethrow` before classifying anything, so a framework throw
 *      from ANY post-commit step propagates.
 *   2. the reconciliation no longer carries a gate to re-enter. Callers that have ALREADY gated —
 *      `savePublicAppUrl`, `saveCronJobSettings`, `saveIntegrationPluginState`, all of which run
 *      `requirePermission('settings.company')` as their first statement — call this directly.
 *
 * NOT exported from a `'use server'` module, deliberately: a module's export surface there is an
 * RPC manifest, and an ungated crontab writer on it would be reachable by anyone who can reach the
 * app. The only server action wrapping this is `syncCrontab`, which gates first.
 *
 * Reads all cron_* settings, generates the crontab block between OTI markers, and writes it via
 * `crontab -` (stdin pipe, no shell injection) for the CALLING OS user — i.e. the user the app runs
 * as.
 */
export type CrontabReconcileResult = {
  /** Did the crontab itself change? This, and only this, is whether the SCHEDULER is up to date. */
  success: boolean
  /** Why the crontab write failed. */
  error?: string
  /**
   * A step AFTER a successful crontab write did not complete — the audit row, the rendered cache
   * (Codex r20 MEDIUM).
   *
   * It is reported separately because it is a different fact with a different remedy. This function
   * used to `await` the audit row and the revalidate on the success path, so a logging failure
   * turned an APPLIED crontab into `{ success: false }` at the caller — a screen telling the
   * operator the scheduler could not be updated and to go and re-apply it, over a crontab that was
   * already correct. That is worse than the missing audit row it was reporting, and worse still when
   * combined with a local failure, since the scheduler warning is the one that wins.
   */
  followUpError?: string
}

/**
 * SERIALIZED, AND THE SERIALIZATION COVERS THE SNAPSHOT (Codex r21 HIGH).
 *
 * Everything from reading the settings to writing the crontab happens under ONE cross-process lock,
 * so two saves committing opposite enablement cannot end with the earlier snapshot writing last —
 * the state the previous round removed by a different route: an enablement row on, no cron line,
 * and every caller reporting success. The whole argument, including why a lock taken after the
 * snapshot would not have helped and why a session advisory lock is the right risk class for a
 * derived, re-derivable artefact, is in lib/crontab-reconcile-lock.ts.
 *
 * THE LOCK IS TAKEN HERE, NOT AT THE CALL SITES, and that is deliberate. Six server actions
 * reconcile the crontab — `savePublicAppUrl`, `saveBackupScheduleSettings`,
 * `saveIntegrationPluginState`, `saveCronJobSettings`, `saveOnboardingPluginState` and the gated
 * `syncCrontab` — and a seventh will be added by someone who has not read this file. A rule that
 * every caller must remember to wrap is a rule that will be broken; taking it inside the only
 * function that touches the crontab makes coverage a property of the code rather than of a habit.
 *
 * The audit row and the cache revalidation stay OUTSIDE the lock: they observe a write that has
 * already happened and cannot change it, so holding the exclusion across them would only make every
 * other reconciliation wait for a log insert.
 */
export async function reconcileCrontab(): Promise<CrontabReconcileResult> {
  const outcome = await withCrontabReconcileLock(applyCrontabFromSettings)
  if (!outcome.locked) return { success: false, error: outcome.error }
  const result = outcome.result

  // THE CRONTAB IS ALREADY WRITTEN, OR ALREADY NOT (Codex r20 MEDIUM). Nothing below can change
  // that, so nothing below may turn `result` into a failure. `unstable_rethrow` runs first for the
  // same reason it does in `runPostCommit`: a swallowed NEXT_REDIRECT leaves a principal whose
  // session just became invalid sitting on a page instead of at the challenge.
  try {
    if (result.success) {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'crontab_sync',
        description: `Crontab synced from scheduled jobs settings (user ${os.userInfo().username})`,
      })
    } else {
      await logActivity({
        entityType: 'SYSTEM',
        tag: 'system',
        action: 'crontab_sync',
        level: 'ERROR',
        description: `Crontab sync failed: ${result.error}`,
      })
    }

    revalidatePath('/settings/system')
  } catch (error) {
    unstable_rethrow(error)
    return {
      ...result,
      followUpError: error instanceof Error ? error.message : 'Failed to record the crontab change',
    }
  }

  return result
}

/**
 * The read-modify-write itself: SNAPSHOT the settings, read the crontab, write the crontab.
 *
 * Not exported, and called from exactly one place — `reconcileCrontab` above, under the lock. All
 * three steps belong to one another; a caller that ran this without the lock would reintroduce the
 * defect in full, which is why there is nothing here for anyone else to reach.
 */
async function applyCrontabFromSettings(
  lock: HeldCrontabReconcileLock,
): Promise<{ success: boolean; error?: string }> {
  const secret = await getCronSecret()
  if (!secret) {
    return { success: false, error: 'Cron secret is not configured.' }
  }

  const baseUrl = await getPublicAppUrl()
  if (!baseUrl) {
    return { success: false, error: 'Public app URL is not configured.' }
  }
  const pluginState = await getIntegrationPluginState()
  const jobs = getAllCronJobs().filter((job) => isIntegrationModuleVisible(job.module, pluginState))

  // Read enabled/schedule settings for every registered job, plus legacy keys
  const settingKeys = jobs.flatMap((j) => [
    `cron_${j.settingKey}_enabled`,
    `cron_${j.settingKey}_schedule`,
  ])
  const legacyKeys = jobs
    .filter((j) => j.legacyEnabledKey)
    .map((j) => j.legacyEnabledKey!)

  const rows = await db.setting.findMany({
    where: { key: { in: [...settingKeys, ...legacyKeys] } },
  })
  const settings = new Map(rows.map((r) => [r.key, r.value]))

  const logPath = process.env.OTI_CRON_LOG_PATH?.trim() || undefined
  const block = buildOtiCrontabBlock({ jobs, settings, secretRef: resolveSecretRef(secret), baseUrl, logPath })
  if (!block.ok) return { success: false, error: block.error }

  const existingCrontab = await readOwnCrontab()
  const newCrontab = spliceOtiBlock(existingCrontab, block.lines)

  // THE EXCLUSION MUST STILL EXIST AT THE MOMENT OF THE WRITE. PostgreSQL frees a session advisory
  // lock the instant its connection dies, so from that instant another reconciliation can be
  // running — and this one is holding a snapshot it took believing it was alone. Reporting a
  // failure sends the operator to Save & Apply, which re-derives the crontab from the committed
  // rows; writing anyway would silently reinstate the interleaving this lock exists to prevent.
  if (lock.lost) {
    return {
      success: false,
      error: 'The crontab reconciliation lock was lost before the write, so the crontab was not '
        + 'changed. Re-apply from Settings -> System -> Scheduler.',
    }
  }

  return new Promise<{ success: boolean; error?: string }>((resolve) => {
    const proc = execFile('crontab', ['-'], { timeout: 5000 }, (err) => {
      if (err) {
        resolve({ success: false, error: `crontab write failed: ${err.message}` })
      } else {
        resolve({ success: true })
      }
    })
    proc.stdin?.write(newCrontab)
    proc.stdin?.end()
  })
}

export function readOwnCrontab(): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile('crontab', ['-l'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout)
    })
  })
}

/**
 * Prefer cron lines that read CRON_SECRET from the app's .env at RUNTIME
 * (ryxy: an embedded literal silently 401'd every managed job after a secret
 * rotation) — but ONLY when the Node-side emulation of the exact shell
 * pipeline proves the .env yields the ACTIVE process secret byte-for-byte
 * (Codex: line presence alone chose runtime mode even when the .env value was
 * stale, exotic, or shadowed by a service-manager override). Everything else
 * embeds the current literal, which is always correct at sync time.
 */
export function resolveSecretRef(secret: string): CrontabSecretRef {
  const envFilePath = path.join(process.cwd(), '.env')
  try {
    if (
      isCronSafePath(envFilePath)
      && existsSync(envFilePath)
      && emulateRuntimeSecretExtraction(readFileSync(envFilePath, 'utf8')) === secret
    ) {
      return { kind: 'env-file', envFilePath }
    }
  } catch {
    // unreadable .env → embedded fallback below
  }
  return { kind: 'literal', secret }
}
