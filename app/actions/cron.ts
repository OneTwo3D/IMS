'use server'

import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { getAllCronJobs } from '@/lib/cron-jobs'
import { getCronSecret } from '@/lib/cron-secret'
import {
  buildOtiCrontabBlock,
  parseOtiCrontabStatus,
  spliceOtiBlock,
  type CrontabSecretRef,
  type OtiCrontabStatus,
} from '@/lib/crontab-sync'
import { getIntegrationPluginState, isIntegrationModuleVisible } from '@/lib/integration-plugins'
import { getPublicAppUrl } from '@/lib/public-app-url'

function readOwnCrontab(): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile('crontab', ['-l'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout)
    })
  })
}

/**
 * Prefer cron lines that read CRON_SECRET from the app's .env at RUNTIME
 * (ryxy: an embedded literal silently 401'd every managed job after a secret
 * rotation). Fall back to embedding only when there is no readable .env with
 * a CRON_SECRET line (e.g. env supplied purely by the service manager).
 */
function resolveSecretRef(secret: string): CrontabSecretRef {
  const envFilePath = path.join(process.cwd(), '.env')
  try {
    if (existsSync(envFilePath) && /^CRON_SECRET=/m.test(readFileSync(envFilePath, 'utf8'))) {
      return { kind: 'env-file', envFilePath }
    }
  } catch {
    // unreadable .env → embedded fallback below
  }
  return { kind: 'literal', secret }
}

/**
 * Reads all cron_* settings from the DB, generates the crontab block between
 * OTI markers, and writes it via `crontab -` (safe, no shell injection).
 * Writes the CALLING OS user's crontab — i.e. the user the app runs as.
 */
export async function syncCrontab(): Promise<{ success: boolean; error?: string }> {
  await requirePermission('settings.company')

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

  const block = buildOtiCrontabBlock({ jobs, settings, secretRef: resolveSecretRef(secret), baseUrl })
  if (!block.ok) return { success: false, error: block.error }

  const existingCrontab = await readOwnCrontab()
  const newCrontab = spliceOtiBlock(existingCrontab, block.lines)

  // Write via `crontab -` (stdin pipe, no shell injection)
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

export type CrontabDriftStatus = OtiCrontabStatus & {
  /** OS user whose crontab the app manages (the service user). */
  osUser: string
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
  return {
    ...parseOtiCrontabStatus(crontabText, secret),
    osUser: os.userInfo().username,
  }
}
