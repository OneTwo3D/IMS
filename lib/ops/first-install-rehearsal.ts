/**
 * THE PURE HALF OF THE FRESH-INSTALL REHEARSAL: its vocabulary, its verdict rules and its report.
 *
 * `scripts/rehearse-first-install.ts` stands up a throwaway PostgreSQL cluster and runs the first
 * install against it (migrate deploy, db:seed, scripts/provision-instance.mjs). Everything that
 * DECIDES something lives here and nothing here touches a database, a process or the file system,
 * so each decision can be exercised, and mutated, without a cluster:
 *
 *   - the exit codes, documented ONCE in docs/installation.md and asserted against this table;
 *   - the step catalogue and which steps are required;
 *   - what counts as a correctly seeded installation (`assessSeededRows`);
 *   - restore parity, table by table (`compareParity`);
 *   - the guards that keep a rehearsal away from any database that is not its own cluster
 *     (`assertThrowawayDatabaseUrl`) and away from connector credentials (`assertNoConnectorEnv`);
 *   - the verdict, and the JSON and Markdown renderings of the report.
 */

import { INSTANCE_ROLE_ENV_VAR } from '@/lib/ops/instance-identity'

/** The rehearsal's exit codes. docs/installation.md documents this table once; a test compares them. */
export const REHEARSAL_EXIT = {
  /** Every required step passed and the teardown left nothing behind. */
  OK: 0,
  /** The rehearsal ran and the report is RED: a required step failed, was skipped, or threw. */
  RED: 1,
  /** The rehearsal REFUSED to start (bad arguments, no PostgreSQL binaries, run as root, tmpfs). */
  REFUSED: 2,
  /** The teardown could not remove everything it created (cluster, env file, directory or a process). */
  TEARDOWN_INCOMPLETE: 3,
} as const

export type RehearsalExitCode = (typeof REHEARSAL_EXIT)[keyof typeof REHEARSAL_EXIT]

export const REHEARSAL_EXIT_MEANING: Record<RehearsalExitCode, string> = {
  [REHEARSAL_EXIT.OK]: 'GREEN: every required step passed and the teardown left nothing behind.',
  [REHEARSAL_EXIT.RED]: 'RED: a required step failed, was skipped, or threw. The report says which.',
  [REHEARSAL_EXIT.REFUSED]: 'Refused to start: bad arguments, no PostgreSQL server binaries, run as root, or the work directory is on a RAM-backed file system. Nothing was created.',
  [REHEARSAL_EXIT.TEARDOWN_INCOMPLETE]: 'The teardown could not remove everything it created (cluster, env file, directory or a process). The report names what is left. Takes precedence over RED.',
}

export type StepId =
  | 'migrate-deploy'
  | 'migrate-status'
  | 'seed'
  | 'provision'
  | 'seeded-rows'
  | 'base-currency-unlocked'
  | 'system-identifier'
  | 'preflight-production'
  | 'validate-db'
  | 'invariant-preflight'
  | 'outbound-status'
  | 'restore-parity'

export type StepDefinition = {
  id: StepId
  /** The numbered report item this step evidences; 0 when it is a prerequisite that has no item of its own. */
  item: number
  title: string
  /** A prerequisite: when it fails, every later step is skipped because there is nothing to inspect. */
  prerequisite: boolean
}

/** In execution order. The numbers are the report items of the rehearsal brief (and o3d-zjsb5.2/.3). */
export const STEP_CATALOGUE: readonly StepDefinition[] = [
  { id: 'migrate-deploy', item: 1, title: 'Every migration applied by migrate deploy', prerequisite: true },
  { id: 'migrate-status', item: 1, title: 'Migration status reports the schema up to date', prerequisite: false },
  { id: 'seed', item: 0, title: 'npm run db:seed', prerequisite: true },
  { id: 'provision', item: 0, title: 'scripts/provision-instance.mjs (SMTP unset, no connector credentials)', prerequisite: true },
  { id: 'seeded-rows', item: 2, title: 'Seeded Organisation (GBP), warehouse, currency and tax rows', prerequisite: false },
  { id: 'base-currency-unlocked', item: 3, title: 'isBaseCurrencyLocked() is false before any data', prerequisite: false },
  { id: 'system-identifier', item: 4, title: 'Cluster system_identifier recorded', prerequisite: false },
  { id: 'preflight-production', item: 5, title: 'npm run preflight:production', prerequisite: false },
  { id: 'validate-db', item: 6, title: 'npm run validate:db', prerequisite: false },
  { id: 'invariant-preflight', item: 7, title: 'npm run invariant-check:preflight exits 0', prerequisite: false },
  { id: 'outbound-status', item: 8, title: 'npm run outbound:status reports every connector held', prerequisite: false },
  { id: 'restore-parity', item: 9, title: 'Restore point dumped and restored into a second database: row-count and md5 parity per table', prerequisite: false },
]

export type StepStatus = 'passed' | 'failed' | 'skipped'

export type StepResult = {
  id: StepId
  item: number
  title: string
  /** False only for a step that is skipped-with-reason because what it needs does not exist on this tree yet. */
  required: boolean
  status: StepStatus
  /** Why a step failed or was skipped; one line. */
  reason?: string
  /** What the step observed. Never a secret. */
  detail: Record<string, unknown>
  durationMs: number
}

export type TeardownResult = {
  clusterStopped: boolean
  postmasterPid: number | null
  envFileShredded: boolean
  rootRemoved: boolean
  /** Processes that were part of this rehearsal's cluster and are still alive after the teardown. */
  orphanPids: number[]
  errors: string[]
}

export type RehearsalReport = {
  schemaVersion: 1
  tool: 'rehearse-first-install'
  runId: string
  verdict: 'GREEN' | 'RED'
  exitCode: RehearsalExitCode
  startedAt: string
  finishedAt: string
  durationMs: number
  host: { node: string; postgresServer: string | null }
  cluster: {
    root: string
    port: number | null
    role: string | null
    scramVerified: boolean
    systemIdentifier: string | null
    sourceDatabase: string
    restoreDatabase: string
  }
  steps: StepResult[]
  teardown: TeardownResult | null
  notes: string[]
  /** The signal that interrupted the run, if one did: an interrupted run is RED whatever its steps say. */
  interrupted: string | null
}

/** A required step that did not pass makes the report RED; an optional step never does. */
export function isRed(steps: readonly StepResult[]): boolean {
  return steps.some((step) => step.required && step.status !== 'passed')
}

export function rehearsalExitCode(steps: readonly StepResult[], teardown: TeardownResult | null, interrupted: string | null = null): RehearsalExitCode {
  if (teardown === null || teardownIncomplete(teardown)) return REHEARSAL_EXIT.TEARDOWN_INCOMPLETE
  return isRed(steps) || interrupted !== null ? REHEARSAL_EXIT.RED : REHEARSAL_EXIT.OK
}

export function teardownIncomplete(teardown: TeardownResult): boolean {
  return !teardown.clusterStopped
    || !teardown.envFileShredded
    || !teardown.rootRemoved
    || teardown.orphanPids.length > 0
    || teardown.errors.length > 0
}

// ---------------------------------------------------------------------------------------------
// Item 2: what a correctly seeded installation looks like.
// ---------------------------------------------------------------------------------------------

export const EXPECTED_BASE_CURRENCY = 'GBP'
export const EXPECTED_SEED_CURRENCIES = ['CAD', 'EUR', 'GBP', 'NOK', 'SEK', 'USD'] as const
export const EXPECTED_DEFAULT_WAREHOUSE_CODE = 'DEFAULT'
export const EXPECTED_STANDARD_TAX_RATE = 'UK Standard Rate (20%)'
export const EXPECTED_MIN_TAX_RATES = 4

export type SeededRowFacts = {
  organisations: Array<{ id: string; baseCurrency: string; country: string }>
  warehouses: Array<{ code: string; isDefault: boolean }>
  taxRates: Array<{ name: string; rate: string; isDefault: boolean }>
  currencies: string[]
  adminUsers: number
  smtpSettingKeys: string[]
}

export type Assessment = { ok: boolean; failures: string[] }

/**
 * Is this what `db:seed` plus `provision-instance.mjs` is documented to leave behind?
 *
 * THE BASE-CURRENCY ASSERTION IS HERE AND NOWHERE ELSE. The rehearsal rule that an Organisation on a
 * non-GBP base currency makes the report RED is carried by exactly this one check, so a mutation that
 * removes it is the proof the rule can fail (see tests/scripts/rehearse-first-install.test.ts).
 */
export function assessSeededRows(facts: SeededRowFacts): Assessment {
  const failures: string[] = []

  if (facts.organisations.length !== 1) {
    failures.push(`expected exactly one Organisation row, found ${facts.organisations.length}`)
  }
  const organisation = facts.organisations.find((row) => row.id === 'default')
  if (!organisation) {
    failures.push("the seeded Organisation 'default' is missing")
  } else {
    if (organisation.baseCurrency !== EXPECTED_BASE_CURRENCY) {
      failures.push(`Organisation.baseCurrency is ${organisation.baseCurrency}, expected ${EXPECTED_BASE_CURRENCY} (the one-way door, o3d-zjsb5.3)`)
    }
    if (organisation.country !== 'GB') {
      failures.push(`Organisation.country is ${organisation.country}, expected GB`)
    }
  }

  const defaultWarehouse = facts.warehouses.find((row) => row.code === EXPECTED_DEFAULT_WAREHOUSE_CODE)
  if (!defaultWarehouse) {
    failures.push(`the ${EXPECTED_DEFAULT_WAREHOUSE_CODE} warehouse is missing`)
  } else if (!defaultWarehouse.isDefault) {
    failures.push(`the ${EXPECTED_DEFAULT_WAREHOUSE_CODE} warehouse is not flagged default`)
  }
  if (facts.warehouses.length !== 1) {
    failures.push(`expected exactly one warehouse on a fresh install, found ${facts.warehouses.length}`)
  }

  if (facts.taxRates.length < EXPECTED_MIN_TAX_RATES) {
    failures.push(`expected at least ${EXPECTED_MIN_TAX_RATES} seeded tax rates, found ${facts.taxRates.length}`)
  }
  const standard = facts.taxRates.find((row) => row.name === EXPECTED_STANDARD_TAX_RATE)
  if (!standard) {
    failures.push(`the tax rate '${EXPECTED_STANDARD_TAX_RATE}' is missing`)
  } else if (!standard.isDefault) {
    failures.push(`the tax rate '${EXPECTED_STANDARD_TAX_RATE}' is not the default`)
  }

  const missingCurrencies = EXPECTED_SEED_CURRENCIES.filter((code) => !facts.currencies.includes(code))
  if (missingCurrencies.length > 0) {
    failures.push(`seeded currencies missing: ${missingCurrencies.join(', ')}`)
  }

  if (facts.adminUsers !== 1) {
    failures.push(`expected exactly one admin user from provision-instance.mjs, found ${facts.adminUsers}`)
  }
  if (facts.smtpSettingKeys.length > 0) {
    failures.push(`SMTP settings were stored (${facts.smtpSettingKeys.join(', ')}); the rehearsal runs with SMTP unset`)
  }

  return { ok: failures.length === 0, failures }
}

export const BASE_CURRENCY_LOCK_TABLES = ['products', 'suppliers', 'customers', 'purchase_orders', 'sales_orders', 'stock_movements'] as const

export type BaseCurrencyLockFacts = {
  isBaseCurrencyLocked: boolean
  tableCounts: Record<string, number>
  lockSettingRows: number
}

/**
 * Item 3. The application's answer is only evidence under the preconditions the report records, so
 * EVERY recorded fact is part of the verdict: the application says unlocked, each of the six tables the
 * lock reads is empty, and no `base_currency_locked` setting row exists (a row valued false still
 * means somebody wrote one before the rehearsal looked).
 */
export function assessBaseCurrencyLock(facts: BaseCurrencyLockFacts): Assessment {
  const failures: string[] = []
  if (facts.isBaseCurrencyLocked !== false) failures.push('isBaseCurrencyLocked() returned true on a fresh install: something wrote master data or the lock setting before the rehearsal read it')
  for (const table of BASE_CURRENCY_LOCK_TABLES) {
    const count = facts.tableCounts[table]
    if (count !== 0) failures.push(`${table} holds ${count === undefined ? 'an unknown number of' : count} row(s) on a fresh install`)
  }
  if (facts.lockSettingRows !== 0) failures.push(`a base_currency_locked setting row exists (${facts.lockSettingRows}) on a fresh install`)
  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------------------------------------
// Item 9: restore parity.
// ---------------------------------------------------------------------------------------------

export type TableFingerprint = { rows: number; md5: string }
export type ParityMismatch = {
  table: string
  kind: 'missing-in-restore' | 'unexpected-in-restore' | 'row-count' | 'md5'
  source?: TableFingerprint
  restored?: TableFingerprint
}
export type ParityResult = {
  ok: boolean
  tablesCompared: number
  tablesWithRows: number
  totalRows: number
  mismatches: ParityMismatch[]
}

/**
 * Compare the source database with the database restored from its dump, table by table.
 *
 * EVERY table of EITHER side is compared (the union, not the source list alone), so a table the
 * restore dropped and a table the restore invented are both mismatches. A comparison over nothing,
 * or over tables that are all empty, is VACUOUS and is reported as a failure by the caller; the
 * counts are returned so the report can print the precondition it reached.
 */
export function compareParity(
  source: ReadonlyMap<string, TableFingerprint>,
  restored: ReadonlyMap<string, TableFingerprint>,
): ParityResult {
  const names = [...new Set([...source.keys(), ...restored.keys()])].sort()
  const mismatches: ParityMismatch[] = []
  let tablesWithRows = 0
  let totalRows = 0
  for (const table of names) {
    const left = source.get(table)
    const right = restored.get(table)
    if (left && !right) {
      mismatches.push({ table, kind: 'missing-in-restore', source: left })
      continue
    }
    if (!left && right) {
      mismatches.push({ table, kind: 'unexpected-in-restore', restored: right })
      continue
    }
    if (!left || !right) continue
    if (left.rows > 0) tablesWithRows += 1
    totalRows += left.rows
    if (left.rows !== right.rows) {
      mismatches.push({ table, kind: 'row-count', source: left, restored: right })
    } else if (left.md5 !== right.md5) {
      mismatches.push({ table, kind: 'md5', source: left, restored: right })
    }
  }
  return { ok: mismatches.length === 0, tablesCompared: names.length, tablesWithRows, totalRows, mismatches }
}

/** Parity is only evidence when it looked at something that held rows. */
export function assessParity(result: ParityResult): Assessment {
  const failures: string[] = []
  if (result.tablesCompared === 0) failures.push('no tables were compared, so parity proves nothing')
  if (result.tablesWithRows === 0) failures.push('every compared table was empty, so parity proves nothing')
  for (const mismatch of result.mismatches) {
    failures.push(`${mismatch.table}: ${mismatch.kind}${mismatch.source && mismatch.restored
      ? ` (source ${mismatch.source.rows} rows ${mismatch.source.md5}, restored ${mismatch.restored.rows} rows ${mismatch.restored.md5})`
      : ''}`)
  }
  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------------------------------------
// Item 8: outbound:status, required once the script exists on this tree.
// ---------------------------------------------------------------------------------------------

export const OUTBOUND_STATUS_SCRIPT = 'outbound:status'

export function outboundStatusScriptPresent(scripts: Record<string, string> | undefined): boolean {
  return typeof scripts?.[OUTBOUND_STATUS_SCRIPT] === 'string' && scripts[OUTBOUND_STATUS_SCRIPT].trim() !== ''
}

/**
 * The connectors an outbound hold must account for, exactly once each.
 */
// wms-connector-boundary-ok: o3d-zjsb5.2: the list of connectors the outbound hold covers; names no connector flow
export const EXPECTED_OUTBOUND_CONNECTORS = ['woocommerce', 'mintsoft', 'xero'] as const

/**
 * ALL HELD, read strictly from `npm run outbound:status -- --json --expect-held`.
 *
 * The report is parsed as JSON (the npm banner before it and the trailing "Exit code" line are
 * ignored) and the verdict is a per-connector EQUALITY: every expected connector appears exactly once
 * and its `state` is exactly `held`. `granted`, `unreadable`, `not held`, an unknown state, a missing,
 * duplicated or unknown connector, `anyGranted: true`, a missing report or a non-zero exit each fail.
 * Free text is never searched for the word "held", so a negation cannot satisfy it.
 */
export function assessOutboundStatus(run: { exitCode: number | null; stdout: string }): Assessment {
  const failures: string[] = []
  if (run.exitCode !== 0) failures.push(`outbound:status exited ${run.exitCode}`)

  // EXACTLY ONE top-level JSON object, with nothing but the npm banner (`> ...` lines and blanks)
  // before it and nothing but the `Exit code N.` line and blanks after it. Two reports, a stale block,
  // or any other text leave no unambiguous answer to "which one is the status", so they fail.
  const lines = run.stdout.split('\n')
  const starts = lines.flatMap((line, index) => (line === '{' ? [index] : []))
  let parsed: unknown = null
  if (starts.length !== 1) {
    failures.push(`outbound:status output must contain exactly one JSON report, found ${starts.length}`)
    return { ok: false, failures }
  }
  const startLine = starts[0]!
  const endLine = lines.findIndex((line, index) => index > startLine && line === '}')
  if (endLine === -1) {
    failures.push('outbound:status output is not a JSON report with a connectors list')
    return { ok: false, failures }
  }
  const stray = [
    ...lines.slice(0, startLine).filter((line) => line.trim() !== '' && !line.startsWith('>')),
    ...lines.slice(endLine + 1).filter((line) => line.trim() !== '' && !/^Exit code \d+\.?$/.test(line.trim())),
  ]
  if (stray.length > 0) failures.push(`outbound:status printed unexpected text around the report: ${stray.slice(0, 2).join(' | ')}`)
  try {
    parsed = JSON.parse(lines.slice(startLine, endLine + 1).join('\n'))
  } catch {
    parsed = null
  }
  const connectors = (parsed as { connectors?: unknown } | null)?.connectors
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(connectors)) {
    failures.push('outbound:status output is not a JSON report with a connectors list')
    return { ok: false, failures }
  }

  const entries = connectors as Array<{ connector?: unknown; state?: unknown }>
  for (const connector of EXPECTED_OUTBOUND_CONNECTORS) {
    const mine = entries.filter((entry) => entry.connector === connector)
    if (mine.length === 0) failures.push(`outbound:status has no entry for ${connector}`)
    else if (mine.length > 1) failures.push(`outbound:status lists ${connector} more than once`)
    else if (mine[0]!.state !== 'held') failures.push(`outbound:status says ${connector} is ${JSON.stringify(mine[0]!.state)}, not held`)
  }
  for (const entry of entries) {
    if (!(EXPECTED_OUTBOUND_CONNECTORS as readonly unknown[]).includes(entry.connector)) failures.push(`outbound:status lists an unknown connector ${String(entry.connector)}`)
  }
  if ((parsed as { anyGranted?: unknown }).anyGranted !== false) failures.push('outbound:status does not say anyGranted is false')
  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------------------------------------
// Guards.
// ---------------------------------------------------------------------------------------------

export class RehearsalGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RehearsalGuardError'
  }
}

export type ThrowawayTarget = {
  host: string
  port: number
  user: string
  /** The only databases this rehearsal may name. */
  databases: readonly string[]
}

/**
 * REFUSE ANY DATABASE_URL THAT IS NOT THE THROWAWAY CLUSTER.
 *
 * Called before every child process is spawned and before every connection the rehearsal opens, on
 * the value that is ABOUT to be used rather than on the one it meant to build. Host, port, role and
 * database must all be the rehearsal's own; a URL with a query string (a `?host=` or `?schema=`
 * could redirect it), a second host, or no password is refused too.
 */
export function assertThrowawayDatabaseUrl(rawUrl: string | undefined, target: ThrowawayTarget): void {
  if (!rawUrl) throw new RehearsalGuardError('refusing to run a step with no DATABASE_URL: the rehearsal never falls back to an inherited one')
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new RehearsalGuardError('refusing to run: DATABASE_URL is not a URL')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const problems: string[] = []
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') problems.push(`protocol ${url.protocol}`)
  if (url.hostname !== target.host) problems.push(`host ${url.hostname} is not ${target.host}`)
  if (Number(url.port) !== target.port) problems.push(`port ${url.port || '(default)'} is not the throwaway cluster's ${target.port}`)
  if (decodeURIComponent(url.username) !== target.user) problems.push('role is not the rehearsal role')
  if (!url.password) problems.push('no password (the throwaway cluster authenticates with scram)')
  if (!target.databases.includes(database)) problems.push(`database ${database || '(none)'} is not one of ${target.databases.join(', ')}`)
  if (url.search !== '' || url.hash !== '') problems.push('the URL carries a query string or fragment')
  if (problems.length > 0) {
    throw new RehearsalGuardError(`refusing to run against a DATABASE_URL that is not the throwaway cluster: ${problems.join('; ')}`)
  }
}

/** Environment name prefixes that carry a connector credential, an outbound grant or an email transport. */
export const FORBIDDEN_ENV_PATTERNS: readonly RegExp[] = [
  /^SMTP_/,
  /^WC_/,
  /^WOO/,
  // wms-connector-boundary-ok: o3d-zjsb5.2: an env-name prefix this guard REFUSES; it names no connector flow
  /^MINTSOFT/,
  /^XERO/,
  /^QB_/,
  /^QUICKBOOKS/,
  /^SHOPIFY/,
  /^SHIPHERO/,
  /^FEDEX/,
  /^CLICKDROP/,
  /^QOBLEX/,
  /^NOTIFICATION_EMAIL$/,
  /^PG(HOST|PORT|USER|DATABASE|PASSWORD|PASSFILE|SERVICE|OPTIONS)$/,
  /^SHADOW_DATABASE_URL$/,
]

/** Throws when a child's environment carries anything a rehearsal must never hand a process. */
export function assertNoConnectorEnv(env: Record<string, string | undefined>): void {
  const offending = Object.keys(env).filter((name) => env[name] !== undefined && FORBIDDEN_ENV_PATTERNS.some((pattern) => pattern.test(name)))
  if (offending.length > 0) {
    throw new RehearsalGuardError(`refusing to spawn: the environment carries ${offending.sort().join(', ')} (connector credentials, an email transport or a libpq override)`)
  }
}

/** The one name a rehearsal declares its instance under; production preflight requires `production`. */
export const REHEARSAL_INSTANCE_ROLE_VAR = INSTANCE_ROLE_ENV_VAR

// ---------------------------------------------------------------------------------------------
// Report rendering.
// ---------------------------------------------------------------------------------------------

/** Replace every secret value with a marker, longest first so a prefix cannot leave a tail behind. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of [...secrets].filter((value) => value.length >= 6).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('***')
    out = out.split(encodeURIComponent(secret)).join('***')
  }
  return out
}

export function buildReport(input: Omit<RehearsalReport, 'schemaVersion' | 'tool' | 'verdict' | 'exitCode' | 'durationMs'>): RehearsalReport {
  const exitCode = rehearsalExitCode(input.steps, input.teardown, input.interrupted)
  const red = isRed(input.steps) || input.interrupted !== null || exitCode !== REHEARSAL_EXIT.OK
  return {
    schemaVersion: 1,
    tool: 'rehearse-first-install',
    verdict: red ? 'RED' : 'GREEN',
    exitCode,
    durationMs: Date.parse(input.finishedAt) - Date.parse(input.startedAt),
    ...input,
  }
}

function cell(value: unknown): string {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function detailLine(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return ''
  return entries
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('; ')
}

export function renderMarkdown(report: RehearsalReport): string {
  const lines: string[] = []
  lines.push(`# Fresh-install rehearsal: ${report.verdict}`)
  lines.push('')
  lines.push(`- Run: \`${report.runId}\``)
  lines.push(`- Started: ${report.startedAt}; finished: ${report.finishedAt} (${Math.round(report.durationMs / 1000)}s)`)
  lines.push(`- Exit code: ${report.exitCode} (${REHEARSAL_EXIT_MEANING[report.exitCode]})`)
  lines.push(`- Node ${report.host.node}; PostgreSQL ${report.host.postgresServer ?? 'not started'}`)
  lines.push(`- Throwaway cluster: port ${report.cluster.port ?? 'none'}, role \`${report.cluster.role ?? 'none'}\`, scram verified: ${report.cluster.scramVerified}`)
  lines.push(`- system_identifier: ${report.cluster.systemIdentifier ?? 'not read'}`)
  lines.push(`- Databases: \`${report.cluster.sourceDatabase}\` (installed) and \`${report.cluster.restoreDatabase}\` (restored from the dump)`)
  lines.push('')
  lines.push('| Item | Step | Required | Result | Detail |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const step of report.steps) {
    const result = step.status === 'passed' ? 'PASS' : step.status === 'failed' ? 'FAIL' : 'SKIPPED'
    const detail = [step.reason, detailLine(step.detail)].filter(Boolean).join(' | ')
    lines.push(`| ${step.item === 0 ? '-' : step.item} | ${cell(step.title)} | ${step.required ? 'yes' : 'no'} | ${result} | ${cell(detail)} |`)
  }
  lines.push('')
  lines.push('## Teardown')
  lines.push('')
  if (report.teardown === null) {
    lines.push('- The teardown did not run to completion.')
  } else {
    lines.push(`- Cluster stopped: ${report.teardown.clusterStopped} (postmaster pid ${report.teardown.postmasterPid ?? 'none'})`)
    lines.push(`- Env file shredded: ${report.teardown.envFileShredded}`)
    lines.push(`- Directory removed: ${report.teardown.rootRemoved}`)
    lines.push(`- Orphan PIDs: ${report.teardown.orphanPids.length === 0 ? 'none' : report.teardown.orphanPids.join(', ')}`)
    for (const error of report.teardown.errors) lines.push(`- Teardown error: ${error}`)
  }
  if (report.notes.length > 0) {
    lines.push('')
    lines.push('## Notes')
    lines.push('')
    for (const note of report.notes) lines.push(`- ${note}`)
  }
  lines.push('')
  return lines.join('\n')
}
