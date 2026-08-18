import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { revalidatePath } from 'next/cache'
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
export async function reconcileCrontab(): Promise<{ success: boolean; error?: string }> {
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

  const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
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
  return result
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
