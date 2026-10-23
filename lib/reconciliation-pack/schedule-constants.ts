/**
 * THE SCHEDULED RECONCILIATION PACK: constants and closed codes. Pure and import-light (the scheduling documentation, the cron
 * registry entry and the runner all import this file; the runner is lib/ops/reconciliation-pack-schedule.ts).
 *
 * The scheduled job runs the SAME command an operator runs (`npm run reconcile:pack`) as a child process, so every hardening
 * the command has (the environment whitelist, the account check by uid, the credential-argument screen, the report-directory
 * trust check, the run lock) applies unchanged; the job adds nothing to bypass them and takes none of their decisions.
 *
 * It is OFF by default. When it is on it still refuses to run without a phase (there is no default phase), and it reads a
 * vendor only when a second, separate setting says so (also off by default).
 */

/** The npm script the job runs: the operator's command (constants.ts PACK_COMMAND is `npm run` plus this name; a test pins both to package.json). */
export const PACK_SCHEDULE_NPM_SCRIPT = 'reconcile:pack'
export const PACK_SCHEDULE_SLUG = 'reconciliation-pack'
export const PACK_SCHEDULE_SETTING_KEY = 'reconciliation_pack'
/** `cron_<settingKey>_enabled` and `cron_<settingKey>_schedule` are the framework's rows; these two are the job's own. */
export const PACK_SCHEDULE_PHASE_SETTING = 'reconciliation_pack_schedule_phase'
export const PACK_SCHEDULE_VENDOR_READS_SETTING = 'reconciliation_pack_schedule_vendor_reads'
export const PACK_SCHEDULE_ENABLED_SETTING = `cron_${PACK_SCHEDULE_SETTING_KEY}_enabled`

/** Off by default, and the default schedule (daily, 03:00) only matters once an operator turns the job on. */
export const PACK_SCHEDULE_DEFAULT_ENABLED = false
export const PACK_SCHEDULE_DEFAULT_CRON = '0 3 * * *'
export const PACK_SCHEDULE_PHASES = ['P0', 'P1', 'P2'] as const
export type PackSchedulePhase = (typeof PACK_SCHEDULE_PHASES)[number]

export const PACK_SCHEDULE_RECORD_ACTION = 'reconciliation_pack_scheduled_run'
export const PACK_SCHEDULE_RECORD_VERSION = 1

/** A pack run that has not finished in this long is killed (with its process group) and recorded as CHILD_TIMED_OUT. */
export const PACK_SCHEDULE_CHILD_TIMEOUT_MS = 45 * 60 * 1000
/**
 * Scheduled runs that read WooCommerce are spaced at least this far apart (one per window), on top of the framework's own limit
 * of one start per hour for every cron route. The pack's per-run request budget and pace are the command's (constants.ts); this
 * bounds how many runs spend a budget. A refused start is recorded as VENDOR_READS_TOO_SOON.
 */
export const PACK_SCHEDULE_VENDOR_WINDOW_MS = 20 * 60 * 60 * 1000
export const PACK_SCHEDULE_VENDOR_RATE_KEY = 'cron:reconciliation-pack:vendor-reads'

/** Why the job did not run the pack, decided by the job itself before any child was started. */
export const PACK_SCHEDULE_REFUSALS = {
  SCHEDULE_DISABLED: 'the scheduled job is switched off (the route was called anyway, for example by a crontab line that is out of date); nothing was run',
  PHASE_NOT_SET: 'no phase is set for the scheduled pack, and there is no default phase because an item applies in some phases and not others; nothing was run',
  PHASE_INVALID: 'the stored phase is not P0, P1 or P2; nothing was run',
  SETTINGS_UNREADABLE: 'the job\'s settings could not be read; nothing was run',
  ALREADY_RUNNING: 'another scheduled run of the pack is in progress; this start did not run',
  LOCK_UNAVAILABLE: 'the exclusion that keeps scheduled runs apart could not be taken; nothing was run',
  VENDOR_READS_TOO_SOON: 'a scheduled run that reads WooCommerce was already started inside the spacing window; this start did not run',
} as const
export type PackScheduleRefusal = keyof typeof PACK_SCHEDULE_REFUSALS

/** Why a run that was started is not a published report, decided by the job from how the command ended. */
export const PACK_SCHEDULE_FAILURES = {
  CHILD_NOT_STARTED: 'the command could not be started, or was ended by a signal',
  CHILD_TIMED_OUT: 'the command did not finish in time and was killed',
  EXIT_WITHOUT_REPORT: 'the command exited with a code that means a report was published, but it named no report in the report directory (it may have failed before the pack ran)',
  EXIT_CODE_UNKNOWN: 'the command exited with a code the pack does not define',
  REPORT_UNVERIFIED: 'the command exited with a code that means a report was published and named one, but the pack\'s own reader does not verify it (it is missing or unreadable, is not valid, its digests do not match, it names another run, its sequence is not a positive integer, or its exit code is not the command\'s)',
  NO_CODE_PRINTED: 'the command refused or stopped, but printed no code the pack defines',
} as const
export type PackScheduleFailure = keyof typeof PACK_SCHEDULE_FAILURES

/** Not a fault: two starts met and one gave way, spacing held a start back, or a stale scheduler entry called a switched-off job. Recorded, but the framework run is `skipped`, not `failed`. */
export const PACK_SCHEDULE_NOT_A_FAULT_CODES: readonly string[] = ['SCHEDULE_DISABLED', 'ALREADY_RUNNING', 'LOCK_HELD', 'LOCK_STALE_CONTENDED', 'VENDOR_READS_TOO_SOON']

export const PACK_SCHEDULE_OUTCOMES = ['published', 'refused', 'failed'] as const
export type PackScheduleOutcome = (typeof PACK_SCHEDULE_OUTCOMES)[number]

/**
 * Every key of the activity-log record's metadata, each with the grammar its value must match. There is no free-form field: a
 * test walks a record and fails on a key with no row here or a value that does not match. Key names avoid the words the
 * activity log redacts by key name.
 */
export const PACK_SCHEDULE_RECORD_FIELDS: ReadonlyArray<{ field: string; grammar: string }> = [
  { field: 'schemaVersion', grammar: 'the integer 1' },
  { field: 'scheduleRunId', grammar: 'a UUID: the scheduled-job run id (also in the cron run log)' },
  { field: 'outcome', grammar: 'published, refused or failed' },
  { field: 'code', grammar: 'a closed code: the pack\'s exit name (all-pass, fail, inconclusive) when a report was published, otherwise a code from the pack\'s refusal tables or from this table' },
  { field: 'codeMeaning', grammar: 'the fixed sentence the pack or this table gives that code' },
  { field: 'exitCode', grammar: 'an integer 0 to 255, or null when the command never produced one' },
  { field: 'exitMeaning', grammar: 'the fixed sentence of the pack\'s exit-code table for that code, or null' },
  { field: 'phase', grammar: 'P0, P1 or P2, or null when none was set' },
  { field: 'vendorReads', grammar: 'true when the run was started with --vendor-reads-only, otherwise false' },
  { field: 'runId', grammar: 'the pack run id (8 digits, T, 6 digits, Z, a hyphen and 12 lower-case hex digits) or null' },
  { field: 'sequence', grammar: 'the report\'s sequence number (a positive integer) or null' },
  { field: 'reportJson', grammar: 'the path of the published JSON report under the default report directory, or null' },
  { field: 'reportMarkdown', grammar: 'the path of the published Markdown report under the default report directory, or null' },
  { field: 'durationMs', grammar: 'a non-negative integer' },
]

export const PACK_SCHEDULE_RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/
