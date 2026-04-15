// ---------------------------------------------------------------------------
// Dynamic cron job registry
// ---------------------------------------------------------------------------
// Each connector module registers its cron jobs here. The settings page
// calls getAllCronJobs() / getCronJobsByModule() to auto-discover all jobs.
// ---------------------------------------------------------------------------

export type CronJobDef = {
  slug: string            // URL path segment: 'backup', 'wc-reconcile'
  settingKey: string      // underscore form for Setting keys: 'backup', 'wc_sync'
  module: string          // free-form module id: 'system', 'woocommerce', 'xero'
  moduleLabel: string     // display name: 'System', 'WooCommerce', 'Xero'
  label: string           // job display name: 'Database Backup'
  description: string     // short explanation
  defaultSchedule: string // cron expression: '0 1 * * *'
  defaultEnabled: boolean
  legacyEnabledKey?: string // if set, fall back to this Setting key for initial enabled state
}

const registry: CronJobDef[] = []

export function registerCronJobs(jobs: CronJobDef[]): void {
  for (const job of jobs) {
    if (!registry.some((j) => j.slug === job.slug)) {
      registry.push(job)
    }
  }
}

export function getAllCronJobs(): CronJobDef[] {
  return [...registry]
}

export function getCronJobsByModule(): Map<string, { label: string; jobs: CronJobDef[] }> {
  const groups = new Map<string, { label: string; jobs: CronJobDef[] }>()
  for (const job of registry) {
    const existing = groups.get(job.module)
    if (existing) {
      existing.jobs.push(job)
    } else {
      groups.set(job.module, { label: job.moduleLabel, jobs: [job] })
    }
  }
  return groups
}

// ---------------------------------------------------------------------------
// Schedule presets & helpers
// ---------------------------------------------------------------------------

export const INTERVAL_PRESETS = [
  { label: 'Every 1 minute', value: '* * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 10 minutes', value: '*/10 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 2 hours', value: '0 */2 * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
] as const

export const DAILY_PRESETS = [
  { label: 'Daily at 00:00', value: '0 0 * * *' },
  { label: 'Daily at 01:00', value: '0 1 * * *' },
  { label: 'Daily at 02:00', value: '0 2 * * *' },
  { label: 'Daily at 03:00', value: '0 3 * * *' },
  { label: 'Daily at 04:00', value: '0 4 * * *' },
  { label: 'Daily at 05:00', value: '0 5 * * *' },
  { label: 'Daily at 06:00', value: '0 6 * * *' },
  { label: 'Daily at 07:00', value: '0 7 * * *' },
  { label: 'Daily at 08:00', value: '0 8 * * *' },
  { label: 'Daily at 12:00', value: '0 12 * * *' },
  { label: 'Daily at 18:00', value: '0 18 * * *' },
] as const

export const ALL_PRESETS = [...INTERVAL_PRESETS, ...DAILY_PRESETS]

/** Convert a cron expression to a human-readable label, or return the raw expression. */
export function cronToLabel(cron: string): string {
  const match = ALL_PRESETS.find((p) => p.value === cron)
  return match?.label ?? cron
}
