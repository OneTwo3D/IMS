/**
 * THE COMMAND LINE OF THE FIRST-LOAD APPLY RUNNER, THE PURE PART: arguments, help text, the environment a run gets, the rehearsal record and the exit mapping.
 *
 * No filesystem, no database, no clock of its own, no process environment: everything comes in as an argument, so each rule can be tested without a process (and each
 * mutation of a rule is red). `scripts/first-load-apply.ts` is the shell that reads the files, opens the connections and calls this.
 *
 * NO SECRET ON AN ARGUMENT LIST. The target database is named by an installation env file (read by path, mode 600). The only identifiers on the command line are
 * names the operator is meant to check (--expect-db, --expect-system-id). Every value is also scanned: one that looks like a URL with credentials is refused outright, so a
 * pasted connection string cannot end up in the process list.
 */
import { APPLY_EXIT_CODES, APPLY_EXIT_CODE_TABLE, APPLY_REPORT_STEM_PREFIX, REHEARSAL_RECORD_FORMAT_VERSION, RUNNER_APPLICATION_NAME, type ApplyExitName } from './constants'

export const CLI_MODES = ['rehearse', 'plan', 'apply'] as const
export type CliMode = (typeof CLI_MODES)[number]

/** The throwaway database a rehearsal restores the target into. A child run refuses any other. */
export const REHEARSAL_DATABASE = 'ims_firstload_rehearsal'

export interface CliArgs {
  mode: CliMode
  manifest: string
  envFile: string
  expectDb: string
  expectSystemId: string
  reportDir: string
  /** apply only: the rehearsal record file. */
  rehearsalRecord: string | null
  resume: boolean
  /** The label the activity log names as the operator of the rows the importers write. */
  operator: string
  /** rehearse only: the parent directory of the throwaway cluster. */
  root: string
  /** INTERNAL: set by a rehearsal on the child it starts. The child runs the whole load on the throwaway database it was handed, as the rehearsal. */
  rehearsalChild: { runDir: string; reportStem: string } | null
}

export type ParsedArgs = { kind: 'help' } | { kind: 'usage'; problems: string[] } | { kind: 'run'; args: CliArgs }

const VALUE_FLAGS = ['--manifest', '--env-file', '--expect-db', '--expect-system-id', '--report-dir', '--rehearsal-record', '--operator', '--root', '--rehearsal-child-dir', '--report-stem'] as const
const BOOLEAN_FLAGS = ['--rehearse', '--plan', '--apply', '--resume', '--help'] as const
/** Every flag the parser accepts, and the two the rehearsal uses on its own child (not in the table, not in the help). */
export const KNOWN_FLAGS: readonly string[] = [...VALUE_FLAGS, ...BOOLEAN_FLAGS]
export const INTERNAL_FLAGS: readonly string[] = ['--rehearsal-child-dir', '--report-stem']
const OPERATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/
/** scheme://user:password@host or scheme://user@host?password=...: anything that carries a credential in a URL. */
const CREDENTIAL_IN_URL = /[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@|[?&](password|passwd|pwd|secret|token|key)=/i

export const DEFAULT_ROOT = '/var/tmp'
export const DEFAULT_OPERATOR = 'first-load-apply'

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const problems: string[] = []
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if ((BOOLEAN_FLAGS as readonly string[]).includes(arg)) {
      if (flags.has(arg)) problems.push(`${arg} was given twice`)
      flags.add(arg)
    } else if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) problems.push(`${arg} needs a value`)
      else {
        if (values.has(arg)) problems.push(`${arg} was given twice`)
        values.set(arg, value)
        i += 1
      }
    } else problems.push(`an argument is not recognised (position ${i + 1})`)
  }
  if (flags.has('--help')) return { kind: 'help' }
  for (const [flag, value] of values) if (CREDENTIAL_IN_URL.test(value)) problems.push(`the value of ${flag} looks like it carries a credential; name the target by an env file, never on the command line`)
  const modes = (['--rehearse', '--plan', '--apply'] as const).filter((f) => flags.has(f))
  if (modes.length > 1) problems.push('give at most one of --rehearse, --plan and --apply')
  const mode: CliMode = modes[0] === '--plan' ? 'plan' : modes[0] === '--apply' ? 'apply' : 'rehearse'
  for (const required of ['--manifest', '--env-file', '--expect-db', '--expect-system-id', '--report-dir'] as const) if (!values.has(required)) problems.push(`${required} is required`)
  const isChild = values.has('--rehearsal-child-dir')
  if (mode !== 'apply') {
    if (flags.has('--resume')) problems.push('--resume is only valid with --apply')
    if (values.has('--rehearsal-record')) problems.push('--rehearsal-record is only valid with --apply')
  } else if (isChild) {
    if (values.has('--rehearsal-record') || flags.has('--resume')) problems.push('a rehearsal child takes no --rehearsal-record and no --resume: it IS the rehearsal')
  } else if (!values.has('--rehearsal-record')) problems.push('--apply needs --rehearsal-record: the record a rehearsal of this exact load wrote')
  if (mode !== 'rehearse' && values.has('--root')) problems.push('--root is only valid with --rehearse')
  const operator = values.get('--operator') ?? DEFAULT_OPERATOR
  if (!OPERATOR_PATTERN.test(operator)) problems.push('--operator must be 1 to 64 letters, digits, spaces, dots, dashes or underscores')
  const childDir = values.get('--rehearsal-child-dir')
  const stem = values.get('--report-stem')
  if ((childDir === undefined) !== (stem === undefined)) problems.push('--rehearsal-child-dir and --report-stem are given together or not at all')
  if (stem !== undefined && !STEM_PATTERN.test(stem)) problems.push('--report-stem is not a plain file stem')
  if (childDir !== undefined && mode !== 'apply') problems.push('a rehearsal child runs as --apply')
  if (problems.length > 0) return { kind: 'usage', problems }
  return {
    kind: 'run',
    args: {
      mode,
      manifest: values.get('--manifest')!,
      envFile: values.get('--env-file')!,
      expectDb: values.get('--expect-db')!,
      expectSystemId: values.get('--expect-system-id')!,
      reportDir: values.get('--report-dir')!,
      rehearsalRecord: values.get('--rehearsal-record') ?? null,
      resume: flags.has('--resume'),
      operator,
      root: values.get('--root') ?? DEFAULT_ROOT,
      rehearsalChild: childDir !== undefined && stem !== undefined ? { runDir: childDir, reportStem: stem } : null,
    },
  }
}

/** Every flag of the command, once: the help text and docs/first-load-apply.md are both generated from or compared with this table. */
export const CLI_FLAGS: ReadonlyArray<{ flag: string; value: string; applies: string; meaning: string }> = [
  { flag: '--manifest', value: '<file>', applies: 'all', meaning: 'The apply manifest (JSON). A relative preparedDir or wooSnapshot path in it is relative to the manifest file.' },
  { flag: '--env-file', value: '<file>', applies: 'all', meaning: 'The installation env file naming the target (DATABASE_URL inside). A regular file owned by the caller, mode 600. The process environment is replaced by a short whitelist plus this file.' },
  { flag: '--expect-db', value: '<name>', applies: 'all', meaning: 'Must equal current_database() as the server reports it, or the command refuses (exit 3).' },
  { flag: '--expect-system-id', value: '<id>', applies: 'all', meaning: 'Must equal the cluster system identifier as the server reports it, or the command refuses (exit 3).' },
  { flag: '--report-dir', value: '<dir>', applies: 'all', meaning: 'Where the reports and the rehearsal record are published. Created mode 700 if absent; a real directory owned by the caller, closed to group and others.' },
  { flag: '--rehearse', value: '', applies: 'mode', meaning: 'The default. Copy the target into a throwaway cluster, run the whole load there and write a rehearsal record. The target is only read, and proved unchanged.' },
  { flag: '--plan', value: '', applies: 'mode', meaning: 'Read the target and report what a load would do. Writes nothing to the database.' },
  { flag: '--apply', value: '', applies: 'mode', meaning: 'Load the target: restore point, steps, verification, census. Needs --rehearsal-record.' },
  { flag: '--rehearsal-record', value: '<file>', applies: '--apply', meaning: 'The record a rehearsal of this exact load wrote: same digest, same target system id, same newest migration as this checkout, verdict OK, within 24 hours.' },
  { flag: '--resume', value: '', applies: '--apply', meaning: 'Continue an interrupted load of the same digest (also verifies an APPLIED run). Needs the restore point recorded on the run record, unchanged.' },
  { flag: '--operator', value: '<label>', applies: '--apply, --rehearse', meaning: 'Who the activity log names for the rows written (letters, digits, spaces, dots, dashes, underscores; default first-load-apply).' },
  { flag: '--root', value: '<dir>', applies: '--rehearse', meaning: 'Where the throwaway cluster is made (default /var/tmp; not on a RAM-backed file system; every ancestor must be trustworthy).' },
  { flag: '--help', value: '', applies: 'all', meaning: 'Print this text.' },
]

export function helpText(): string {
  return [
    'Usage: first-load-apply --manifest <file> --env-file <file> --expect-db <name> --expect-system-id <id> --report-dir <dir> [--rehearse | --plan | --apply --rehearsal-record <file> [--resume]]',
    '',
    ...CLI_FLAGS.map((row) => `  ${`${row.flag} ${row.value}`.trim().padEnd(26)} ${row.meaning}`),
    '',
    'No secret is ever an argument: the target is named by --env-file. THE APPLICATION MUST BE STOPPED for --apply (docs/first-load-apply.md has the checklist).',
    '',
    'Exit codes:',
    ...APPLY_EXIT_CODE_TABLE.map((row) => `  ${row.code}  ${row.name}: ${row.meaning}`),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// The environment of a run
// ---------------------------------------------------------------------------

/** The only part of the caller's environment a run inherits. Never DATABASE_URL, never a PG variable, never a grant or a credential. */
export const INHERITED_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const

/** A variable of the installation env file that the runner will not take from it, because it would point the runner somewhere else. */
const FORBIDDEN_FROM_FILE = /^(PG[A-Z]*|PSQL.*|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|PS4)$/

export interface RunnerEnv {
  env: Record<string, string>
  problems: string[]
}

/**
 * The environment of one run: a short whitelist from the caller, then the installation env file's own variables, then the application name every connection carries.
 * The database is the file's DATABASE_URL, never an inherited one. A variable that would redirect a client library is refused rather than dropped (a file that sets it is not the
 * file the operator thinks it is).
 */
export function buildRunnerEnv(fileEnv: Readonly<Record<string, string>>, parentEnv: Readonly<Record<string, string | undefined>>, home: string): RunnerEnv {
  const problems: string[] = []
  const env: Record<string, string> = { HOME: home }
  for (const name of INHERITED_ENV) {
    const value = parentEnv[name]
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(fileEnv)) {
    if (FORBIDDEN_FROM_FILE.test(name)) problems.push(`the env file sets ${name}, which would redirect a client library; remove it from the file`)
    else env[name] = value
  }
  if (typeof env.DATABASE_URL !== 'string' || env.DATABASE_URL === '') problems.push('the env file has no DATABASE_URL')
  env['PGAPPNAME'] = RUNNER_APPLICATION_NAME
  return { env, problems }
}

/** The libpq variables for a child that must connect without a password on its command line: pg_dump, pg_restore. Derived from the URL; the URL itself is not passed. */
export function libpqEnvFromUrl(url: string): { env: Record<string, string>; problems: string[] } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { env: {}, problems: ['DATABASE_URL is not a URL'] }
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return { env: {}, problems: ['DATABASE_URL is not a postgresql URL'] }
  const env: Record<string, string> = {}
  if (parsed.hostname !== '') env['PGHOST'] = decodeURIComponent(parsed.hostname)
  if (parsed.port !== '') env['PGPORT'] = parsed.port
  if (parsed.username !== '') env['PGUSER'] = decodeURIComponent(parsed.username)
  if (parsed.password !== '') env['PGPASSWORD'] = decodeURIComponent(parsed.password)
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (database === '') return { env: {}, problems: ['DATABASE_URL names no database'] }
  env['PGDATABASE'] = database
  const sslmode = parsed.searchParams.get('sslmode')
  if (sslmode) env['PGSSLMODE'] = sslmode
  env['PGAPPNAME'] = RUNNER_APPLICATION_NAME
  return { env, problems: [] }
}

// ---------------------------------------------------------------------------
// The rehearsal record and the exit mapping
// ---------------------------------------------------------------------------

export interface RehearsalRecordFile {
  formatVersion: number
  manifestDigest: string
  verdict: string
  /** The system identifier of the TARGET cluster (not of the throwaway the rehearsal ran on). */
  systemId: string
  finishedAt: string
  /** The newest migration of the checkout the rehearsal ran from: an apply from a checkout with another schema is refused by the command. */
  schemaHead: string
  /** For the audit; the apply's gate reads only the five fields above. */
  loadExit: string | null
  targetUnchanged: boolean
  teardownComplete: boolean
}

/** The record an apply insists on. The verdict is OK only when the rehearsal's load ended OK and the target was proved unchanged. */
export function buildRehearsalRecord(args: { manifestDigest: string; targetSystemId: string; schemaHead: string; finishedAt: Date; loadExit: ApplyExitName | null; targetUnchanged: boolean; teardownComplete: boolean }): RehearsalRecordFile {
  // The verdict is a closed word and is the string 'OK' ONLY when every condition holds: a load that ended OK on a copy of a target that then changed is not a rehearsal of this target.
  const verdict = args.loadExit === null ? 'NOT_RUN' : !args.targetUnchanged ? 'TARGET_CHANGED' : !args.teardownComplete ? 'TEARDOWN_INCOMPLETE' : args.loadExit
  return {
    formatVersion: REHEARSAL_RECORD_FORMAT_VERSION,
    manifestDigest: args.manifestDigest,
    verdict,
    systemId: args.targetSystemId,
    finishedAt: args.finishedAt.toISOString(),
    schemaHead: args.schemaHead,
    loadExit: args.loadExit,
    targetUnchanged: args.targetUnchanged,
    teardownComplete: args.teardownComplete,
  }
}

export function exitCodeOf(name: ApplyExitName): number {
  return APPLY_EXIT_CODES[name]
}

export function exitNameOfCode(code: number | null): ApplyExitName | null {
  const found = APPLY_EXIT_CODE_TABLE.find((row) => row.code === code)
  return found ? found.name : null
}

/** A file stem for a report: mode, run id and a compact UTC stamp. Never a path; the caller joins it to the report directory. */
export function reportStem(mode: CliMode, runId: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${APPLY_REPORT_STEM_PREFIX}${mode}-${runId}-${stamp}`
}

/** The command's own check of a rehearsal record, on top of the core's gate: the schema it was made against is the schema of this checkout. A record with no schema head is refused. */
export function checkRecordSchema(record: unknown, schemaHead: string): string[] {
  const head = typeof record === 'object' && record !== null && !Array.isArray(record) ? (record as Record<string, unknown>).schemaHead : undefined
  if (typeof head !== 'string' || head === '') return ['the rehearsal record names no schema head: it was not made by this command']
  if (head !== schemaHead) return ['the rehearsal was made against another schema (its newest migration differs from this checkout\'s); rehearse again from this checkout']
  return []
}
