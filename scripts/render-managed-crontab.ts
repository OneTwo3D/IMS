#!/usr/bin/env tsx
/**
 * Prints the managed crontab block (the exact text the in-app scheduler sync writes) on stdout, preceded by comment lines that say
 * where the values came from.
 *
 *   node dist-scripts/render-managed-crontab.mjs --base-url http://127.0.0.1:3000 --secret-file /etc/ims/cron.env [--log-path /var/log/ims/cron.log]
 *   node dist-scripts/render-managed-crontab.mjs ... --format cron.d --cron-user root   (an /etc/cron.d file: PRODUCTION)
 *   node dist-scripts/render-managed-crontab.mjs --check                (is the host cron file what the saved settings render? exit 0 / 1)
 *   node dist-scripts/render-managed-crontab.mjs ... --defaults-only        (no database: every job on, at its registry default)
 *
 * For a deployment whose cron runs on the HOST (the container image): install the output in the host's crontab for the account that
 * calls the app, and mount that file read-only into the container at IMS_SCHEDULER_CRONTAB_FILE so the read-sync status and the
 * reconciliation pack can see that the jobs are scheduled. By default the SAVED scheduler settings (enablement and schedule per job)
 * are read from DATABASE_URL with the app's own reader (a job with no saved row uses its default); re-render after any change in
 * Settings and after every deploy. The cron secret is NEVER printed: the lines read CRON_SECRET from `--secret-file` at run time.
 */
import { allJobsEnabledSettings, renderManagedCrontab } from '../lib/ops/render-managed-crontab.ts'
import { DEFAULT_CRON_LOG_PATH } from '../lib/crontab-sync.ts'
import { getAllCronJobs } from '../lib/cron-jobs/index.ts'

function arg(name: string): string | null {
  const at = process.argv.indexOf(name)
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1]! : null
}

async function main(): Promise<number> {
  if (process.argv.includes('--check')) return check()
  const baseUrl = arg('--base-url')
  const secretFile = arg('--secret-file')
  const defaultsOnly = process.argv.includes('--defaults-only')
  if (!baseUrl || !secretFile) {
    process.stderr.write('usage: render-managed-crontab --base-url <origin> --secret-file <absolute path of the file holding CRON_SECRET> [--log-path <path>] [--format user|cron.d] [--cron-user <account>] [--defaults-only]\n')
    return 2
  }
  const format = arg('--format') ?? 'user'
  if (format !== 'user' && format !== 'cron.d') {
    process.stderr.write('--format must be user or cron.d\n')
    return 2
  }
  let jobs = getAllCronJobs()
  let settings = allJobsEnabledSettings(jobs)
  if (!defaultsOnly) {
    if (!process.env.DATABASE_URL) {
      process.stderr.write('DATABASE_URL is required to read the saved scheduler settings (or pass --defaults-only)\n')
      return 2
    }
    const { readCronJobsAndSettings } = await import('../lib/crontab-reconcile.ts')
    ;({ jobs, settings } = await readCronJobsAndSettings())
    const { db } = await import('../lib/db/index.ts')
    await db.$disconnect()
  }
  const rendered = renderManagedCrontab({ jobs, settings, defaultsOnly, baseUrl, secretFile, logPath: arg('--log-path') ?? DEFAULT_CRON_LOG_PATH, format, cronUser: arg('--cron-user') ?? 'root' })
  if (!rendered.ok) {
    process.stderr.write(`${rendered.error}\n`)
    return 1
  }
  process.stdout.write(rendered.text)
  return 0
}

/** --check: compare the saved settings with the host cron file this process can read (IMS_SCHEDULER_CRONTAB_FILE). Exit 0 in sync, 1 out of date or unreadable. */
async function check(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    process.stderr.write('DATABASE_URL is required\n')
    return 2
  }
  const { readCronJobsAndSettings } = await import('../lib/crontab-reconcile.ts')
  const { readCrontabForReport } = await import('../lib/ops/read-sync-status.ts')
  const { hostCronDrift, describeHostCronDrift } = await import('../lib/ops/host-cron.ts')
  const { db } = await import('../lib/db/index.ts')
  try {
    const [saved, host] = await Promise.all([readCronJobsAndSettings(), readCrontabForReport()])
    if (!host.resolved) {
      process.stdout.write(host.reason.startsWith('Host cron is out of date:') ? `${host.reason}\n` : `host cron could not be read: ${host.reason}\n`)
      return 1
    }
    const drift = hostCronDrift({ jobs: saved.jobs, settings: saved.settings, hostText: host.text, allJobs: getAllCronJobs() })
    process.stdout.write(`${describeHostCronDrift(drift)}\n`)
    return drift.inSync ? 0 : 1
  } finally {
    await db.$disconnect()
  }
}

main().then((code) => { process.exitCode = code }, (error: unknown) => {
  process.stderr.write(`render failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
