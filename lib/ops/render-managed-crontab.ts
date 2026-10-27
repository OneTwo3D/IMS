import { buildOtiCrontabBlock, type CrontabJobDef } from '@/lib/crontab-sync'

/**
 * THE MANAGED CRONTAB, RENDERED OUTSIDE THE APP (container deployments: cron runs on the host).
 *
 * The block is built by the same generator the in-app scheduler writes with (`buildOtiCrontabBlock`) from the same inputs: the
 * registered jobs and the SAVED `cron_<job>_enabled` / `cron_<job>_schedule` rows. A job with no saved row falls back to its
 * registry default, exactly as the in-app writer does. `defaultsOnly` ignores the saved rows entirely (for a host that has no
 * database yet); the output then says so on a comment line, because it will drift from Settings as soon as anything is saved.
 *
 * The comment lines are placed BEFORE the managed block's start marker, so the block itself is byte-identical to what the in-app
 * writer produces and the drift check is unaffected.
 */
export type RenderManagedCrontabInput = {
  jobs: readonly (CrontabJobDef & { module?: unknown })[]
  settings: Map<string, string>
  defaultsOnly: boolean
  baseUrl: string
  secretFile: string
  logPath: string
  /** `user` (default): the text `crontab -l` shows. `cron.d`: an /etc/cron.d file, every job line carrying a user field. */
  format?: 'user' | 'cron.d'
  /** The account the jobs run as, for `cron.d`. */
  cronUser?: string
}

export function renderManagedCrontab(input: RenderManagedCrontabInput): { ok: true; text: string } | { ok: false; error: string } {
  const settings = input.defaultsOnly ? new Map<string, string>() : input.settings
  const block = buildOtiCrontabBlock({
    jobs: [...input.jobs] as CrontabJobDef[],
    settings,
    secretRef: { kind: 'env-file', envFilePath: input.secretFile },
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    logPath: input.logPath,
  })
  if (!block.ok) return block
  const format = input.format ?? 'user'
  const cronUser = input.cronUser ?? 'root'
  if (format === 'cron.d' && !/^[a-z_][a-z0-9_-]*$/i.test(cronUser)) return { ok: false, error: 'the cron user is not a valid account name' }
  // cron.d: the schedule is followed by the account the job runs as. Only job lines (they start with a schedule) get one.
  const lines = format === 'cron.d'
    ? block.lines.map((line) => (/^[0-9*@]/.test(line) ? line.replace(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+/, `$1  ${cronUser}  `) : line))
    : block.lines
  const source = input.defaultsOnly
    ? '# Source: DEFAULTS ONLY (--defaults-only: saved scheduler settings were NOT read; every job is shown enabled at its registry default).'
    : '# Source: saved scheduler settings read from the database (a job with no saved row uses its registry default).'
  return {
    ok: true,
    text: `${[
      source,
      '# Re-render and reinstall this file after ANY scheduler change in Settings, and after every deploy.',
      ...(format === 'cron.d' ? ['# Layout: cron.d (every job line has a user field). Install as /etc/cron.d/<name without dots>, root:root, mode 0644.'] : []),
      ...lines,
    ].join('\n')}\n`,
  }
}

/** The settings map for `--defaults-only`: every job on, so the default schedules are what is rendered. */
export function allJobsEnabledSettings(jobs: readonly CrontabJobDef[]): Map<string, string> {
  return new Map(jobs.map((job) => [`cron_${job.settingKey}_enabled`, 'true'] as const))
}
