/**
 * The two variables that put the process in CONTAINER MODE (host cron.d file mounted read-only). A leaf module so that both
 * lib/ops/scheduler-crontab-file.ts and lib/ops/cron-heartbeats.ts (imported by lib/crontab-sync.ts) can name them without an import cycle.
 */
export const SCHEDULER_CRONTAB_FILE_ENV = 'IMS_SCHEDULER_CRONTAB_FILE'
export const SCHEDULER_CRONTAB_FORMAT_ENV = 'IMS_SCHEDULER_CRONTAB_FORMAT'
