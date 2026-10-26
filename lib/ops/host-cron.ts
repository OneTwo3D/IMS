import { resolveCronEnablement } from '@/lib/domain/settings/cron-enablement'
import type { CrontabJobDef } from '@/lib/crontab-sync'
import { SCHEDULER_CRONTAB_FILE_ENV, SCHEDULER_CRONTAB_FORMAT_ENV } from './scheduler-crontab-file'
import { verifyJobsScheduled } from './read-sync-scheduler'
import { HOST_CRON_PENDING_MESSAGE } from './host-cron-constants'

/**
 * CONTAINER MODE: CRON RUNS ON THE HOST, AND THE APP CANNOT WRITE IT.
 *
 * The container image has no `crontab` binary; host cron reads /etc/cron.d/onetwo3d-ims, which the app only ever reads (mounted
 * read-only, IMS_SCHEDULER_CRONTAB_FILE with IMS_SCHEDULER_CRONTAB_FORMAT=cron.d). So there, saving scheduler settings records them
 * and nothing more: the host must re-render and install the file. This is the ONE place that decides whether the process is in that
 * mode; `reconcileCrontab`, the warning text and the drift indicator all use it.
 */
export function isContainerSchedulerMode(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env[SCHEDULER_CRONTAB_FILE_ENV]?.trim()) && env[SCHEDULER_CRONTAB_FORMAT_ENV]?.trim() === 'cron.d'
}

export type HostCronDrift = { inSync: boolean; differing: string[]; blockProblem: string | null }

/**
 * Is the installed host file what the SAVED settings would render? Reuses the status reader's own check (`verifyJobsScheduled`, which
 * compares the exact generator lines): every job the settings enable must be present at its saved schedule, and no job the settings
 * disable may still be present. `hostText` is the file as the reader returns it (user format, user field already removed). Pure.
 */
export function hostCronDrift(input: {
  jobs: readonly CrontabJobDef[]
  settings: ReadonlyMap<string, string>
  hostText: string
}): HostCronDrift {
  const enabled = (job: CrontabJobDef): boolean => resolveCronEnablement({
    canonical: input.settings.get(`cron_${job.settingKey}_enabled`),
    legacy: job.legacyEnabledKey ? input.settings.get(job.legacyEnabledKey) : undefined,
    hasLegacyKey: Boolean(job.legacyEnabledKey),
    defaultEnabled: job.defaultEnabled,
  })
  const wanted = input.jobs.filter(enabled)
  const schedules: Record<string, string | undefined> = {}
  for (const job of input.jobs) schedules[job.slug] = input.settings.get(`cron_${job.settingKey}_schedule`)
  const verdict = verifyJobsScheduled(input.hostText, wanted, schedules)
  const labels = new Set(input.hostText.split('\n').map((line) => line.trim()))
  const stillInstalled = input.jobs.filter((job) => !enabled(job) && labels.has(`# ${job.label}`)).map((job) => job.slug)
  const differing = [...new Set([...verdict.missing, ...stillInstalled])].sort()
  return { inSync: verdict.blockProblem === null && differing.length === 0, differing, blockProblem: verdict.blockProblem }
}

export function describeHostCronDrift(drift: HostCronDrift): string {
  if (drift.inSync) return 'Host cron is in sync with the saved scheduler settings.'
  if (drift.blockProblem) return `Host cron is out of date: ${drift.blockProblem}.`
  return `Host cron is out of date (${drift.differing.length} job${drift.differing.length === 1 ? '' : 's'} differ: ${drift.differing.join(', ')}). ${HOST_CRON_PENDING_MESSAGE}`
}
