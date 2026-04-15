'use server'

import { execFile } from 'child_process'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import { logActivity } from '@/lib/activity-log'
import { requirePermission } from '@/lib/auth/server'
import { getAllCronJobs } from '@/lib/cron-jobs'
import { getCronSecret } from '@/lib/cron-secret'
import { getIntegrationPluginState, isIntegrationModuleVisible } from '@/lib/integration-plugins'
import { getPublicAppUrl } from '@/lib/public-app-url'

// Strict cron expression validation: 5 fields, only digits / * / , / - / /
const CRON_RE = /^(\*|(\*\/)?[0-9]+([,-][0-9]+)*)( (\*|(\*\/)?[0-9]+([,-][0-9]+)*)){4}$/

/**
 * Reads all cron_* settings from the DB, generates the crontab block between
 * OTI markers, and writes it via `crontab -` (safe, no shell injection).
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

  // Build crontab lines
  const lines: string[] = [
    '# --- OTI CRON START ---',
    '# Managed by One Two Inventory — do not edit manually',
    `CRON_SECRET="${secret}"`,
    `BASE_URL="${baseUrl}/api/cron"`,
    '',
  ]

  for (const job of jobs) {
    const cronEnabled = settings.get(`cron_${job.settingKey}_enabled`)
    let enabled: boolean
    if (cronEnabled !== undefined) {
      enabled = cronEnabled === 'true'
    } else if (job.legacyEnabledKey) {
      enabled = settings.get(job.legacyEnabledKey) === 'true'
    } else {
      enabled = job.defaultEnabled
    }
    if (!enabled) continue

    const schedule = settings.get(`cron_${job.settingKey}_schedule`) ?? job.defaultSchedule
    if (!CRON_RE.test(schedule)) {
      return { success: false, error: `Invalid cron schedule for ${job.label}: "${schedule}"` }
    }

    lines.push(
      `# ${job.label}`,
      `${schedule}  curl -sf -o /dev/null -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/${job.slug}" >> /var/log/oti-cron.log 2>&1`,
      '',
    )
  }

  lines.push('# --- OTI CRON END ---')

  // Read existing crontab, preserve lines outside our markers
  const existingCrontab = await new Promise<string>((resolve) => {
    execFile('crontab', ['-l'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : stdout)
    })
  })

  const START_MARKER = '# --- OTI CRON START ---'
  const END_MARKER = '# --- OTI CRON END ---'
  const startIdx = existingCrontab.indexOf(START_MARKER)
  const endIdx = existingCrontab.indexOf(END_MARKER)

  let before = ''
  let after = ''

  if (startIdx !== -1 && endIdx !== -1) {
    before = existingCrontab.slice(0, startIdx)
    after = existingCrontab.slice(endIdx + END_MARKER.length)
  } else {
    before = existingCrontab
    if (before && !before.endsWith('\n')) before += '\n'
  }

  const newCrontab = before + lines.join('\n') + '\n' + after.replace(/^\n+/, '')

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
      description: 'Crontab synced from scheduled jobs settings',
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
