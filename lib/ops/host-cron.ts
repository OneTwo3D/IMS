import { SCHEDULER_CRONTAB_FILE_ENV, SCHEDULER_CRONTAB_FORMAT_ENV } from './scheduler-crontab-file'

/**
 * CONTAINER MODE: CRON RUNS ON THE HOST, AND THE APP CANNOT WRITE IT.
 *
 * The container image has no `crontab` binary; host cron reads /etc/cron.d/onetwo3d-ims, which the app only ever reads (mounted
 * read-only, IMS_SCHEDULER_CRONTAB_FILE with IMS_SCHEDULER_CRONTAB_FORMAT=cron.d). So there, saving scheduler settings records them
 * and nothing more: the host must re-render and install the file. This is the ONE place that decides whether the process is in that
 * mode; `reconcileCrontab` and the Scheduler page use it.
 */
export function isContainerSchedulerMode(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env[SCHEDULER_CRONTAB_FILE_ENV]?.trim()) && env[SCHEDULER_CRONTAB_FORMAT_ENV]?.trim() === 'cron.d'
}
