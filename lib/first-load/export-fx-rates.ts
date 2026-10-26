/**
 * THE ims-fx-rates EXPORT (npm run first-load:export-fx-rates): the rows of IMS's fx_rates table, base to currency, as the canonical `ims-fx-rates` dataset that
 * first-load:prepare reads (docs/first-load-input-spec.md, "Dataset: ims-fx-rates"). It is how a foreign purchase order's rate gets into a prepared run: the transform applies the
 * central lookup rule (lib/currencies/fx-select.ts) over this list at the end of the order's created day.
 *
 * READ-ONLY. The connection is opened `default_transaction_read_only=on`, and the whole read is ONE `BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ` transaction, so the file is
 * a single consistent state of the table and no statement in this module can write. The only statements are the four below; a test pins that list.
 *
 * WHICH ROWS. Only rows whose `fromCurrency` is the installation's base currency (the organisation's `baseCurrency`); rows from any other currency are counted in the record and
 * not exported. ALL such rows are exported, manual-override rows included (they are rows like any other: an admin's pin is simply the latest row, app/actions/currencies.ts
 * setManualFxRate). `--since <YYYY-MM-DD>` keeps only rows fetched on or after that day (UTC). The DEFAULT IS ALL ROWS, because the file has to cover the created date of every
 * open purchase order and the oldest open order is not known to this command: a default window could silently be younger than an order. A narrower window can never produce a
 * WRONG rate (a lookup that finds no row at or before the order's day refuses the order, FX_RATE_MISSING), but it can make a good order refuse, so the narrowing is the operator's
 * explicit choice. The table holds at most one row per currency per fetch, so the full history is small (a few hundred rows per currency per year).
 *
 * EVERY ROW CARRIES THE BASE CURRENCY it was exported against (`baseCurrency`), and first-load:prepare rejects (BASE_CURRENCY_MISMATCH) a row whose base differs from the run
 * manifest's. A list exported from a GBP installation therefore cannot be used in a run whose base is EUR.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { serializeCsv } from './csv'

export const FX_EXPORT_FILE = 'ims-fx-rates.csv'
export const FX_EXPORT_RECORD_FILE = 'ims-fx-rates.export.json'
export const FX_EXPORT_COLUMNS = ['currency', 'rate', 'fetchedAt', 'baseCurrency'] as const

/** The only statements this module sends. Anything else is a bug and a test fails. */
export const FX_EXPORT_STATEMENTS = {
  begin: 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ',
  identity: `select current_database() as db, (select system_identifier::text from pg_control_system()) as sid`,
  // The application's own rule (lib/base-currency.ts resolveBaseCurrencyCode): the organisation's baseCurrency, GBP when there is no organisation row.
  base: `select coalesce((select "baseCurrency" from "organisations" order by "createdAt", "id" limit 1), 'GBP') as base`,
  rows: `select "fromCurrency" as "fromCurrency", "toCurrency" as "toCurrency", "rate"::text as rate, to_char("fetchedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "fetchedAt" from "fx_rates" order by "fromCurrency", "toCurrency", "fetchedAt", "id"`,
  rollback: 'ROLLBACK',
} as const

export interface FxExportPort {
  query<T>(sql: string): Promise<{ rows: T[] }>
}

export interface FxExportRead {
  database: string
  systemId: string
  baseCurrency: string
  rows: Array<{ currency: string; rate: string; fetchedAt: string }>
  /** Rows whose fromCurrency is not the base: counted, never exported. */
  otherBaseRows: number
  /** Rows of the base currency older than --since: counted, never exported. */
  beforeSinceRows: number
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** `since` is a YYYY-MM-DD day or null (all rows). Returns the ISO instant of its start (UTC), or null when it is not a real date. */
export function sinceInstant(since: string): string | null {
  if (!DATE.test(since)) return null
  const t = Date.parse(`${since}T00:00:00.000Z`)
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== since ? null : new Date(t).toISOString()
}

export async function readFxRates(port: FxExportPort, since: string | null): Promise<FxExportRead> {
  const from = since === null ? null : sinceInstant(since)
  if (since !== null && from === null) throw new Error('--since is not a real YYYY-MM-DD date')
  await port.query(FX_EXPORT_STATEMENTS.begin)
  try {
    const id = (await port.query<{ db: string; sid: string }>(FX_EXPORT_STATEMENTS.identity)).rows[0]
    const baseRow = (await port.query<{ base: string }>(FX_EXPORT_STATEMENTS.base)).rows[0]
    const baseCurrency = (baseRow?.base ?? '').trim().toUpperCase()
    if (!id || !/^[A-Z]{3}$/.test(baseCurrency)) throw new Error('the database has no usable organisation base currency')
    const all = (await port.query<{ fromCurrency: string; toCurrency: string; rate: string; fetchedAt: string }>(FX_EXPORT_STATEMENTS.rows)).rows
    const rows: FxExportRead['rows'] = []
    let otherBaseRows = 0
    let beforeSinceRows = 0
    for (const r of all) {
      if (r.fromCurrency.trim().toUpperCase() !== baseCurrency) { otherBaseRows++; continue }
      if (from !== null && r.fetchedAt < from) { beforeSinceRows++; continue }
      rows.push({ currency: r.toCurrency, rate: r.rate, fetchedAt: r.fetchedAt })
    }
    return { database: id.db, systemId: id.sid, baseCurrency, rows, otherBaseRows, beforeSinceRows }
  } finally {
    await port.query(FX_EXPORT_STATEMENTS.rollback)
  }
}

export function renderFxRatesCsv(read: Pick<FxExportRead, 'baseCurrency' | 'rows'>): string {
  return serializeCsv(FX_EXPORT_COLUMNS, read.rows.map((r) => [r.currency, r.rate, r.fetchedAt, read.baseCurrency]))
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The record published beside the CSV: what was read, from what, and the digest the prepared run's inputs can be checked against. */
export function exportRecord(read: FxExportRead, csv: string, since: string | null, exportedAt: Date): Record<string, unknown> {
  const instants = read.rows.map((r) => r.fetchedAt).sort()
  return {
    formatVersion: 1,
    dataset: 'ims-fx-rates',
    exportedAt: exportedAt.toISOString(),
    database: read.database,
    systemId: read.systemId,
    baseCurrency: read.baseCurrency,
    since,
    file: { name: FX_EXPORT_FILE, sha256: sha256Hex(csv), bytes: Buffer.byteLength(csv, 'utf8'), rows: read.rows.length },
    currencies: [...new Set(read.rows.map((r) => r.currency))].sort(),
    earliestFetchedAt: instants[0] ?? null,
    latestFetchedAt: instants[instants.length - 1] ?? null,
    otherBaseRowsNotExported: read.otherBaseRows,
    rowsBeforeSinceNotExported: read.beforeSinceRows,
  }
}

export const FX_EXPORT_HELP = [
  'Usage: first-load-export-fx-rates --env-file <file> --expect-db <name> --expect-system-id <id> --out <dir> [--since <YYYY-MM-DD>]',
  '',
  'Reads IMS\'s fx_rates table (read-only, one REPEATABLE READ READ ONLY transaction) and writes the canonical ims-fx-rates list for first-load:prepare,',
  `${FX_EXPORT_FILE}, and its record ${FX_EXPORT_RECORD_FILE} (digest, row count, range), mode 600, into a new or empty directory mode 700 that you own.`,
  '',
  '  --env-file <file>          the installation env file (DATABASE_URL inside): a regular file you own, mode 600. The environment is replaced by a short whitelist.',
  '  --expect-db <name>         must equal current_database(); otherwise nothing is read.',
  '  --expect-system-id <id>    must equal the cluster system identifier; otherwise nothing is read.',
  '  --out <dir>                output directory (created mode 700 when absent; must be empty).',
  '  --since <YYYY-MM-DD>       only rows fetched on or after that day (UTC). DEFAULT: ALL rows. A window can only make an order refuse (no rate on or before its day), never take a wrong rate.',
  '  --help                     this text',
  '',
  'Exit codes: 0 written; 2 usage; 3 target not confirmed (--expect-db / --expect-system-id) or database unreadable; 4 nothing to export (no base-currency rows); 6 internal error.',
  '',
].join('\n')

export const FX_EXPORT_EXIT = { OK: 0, USAGE: 2, REFUSED: 3, EMPTY: 4, INTERNAL: 6 } as const

export interface FxExportArgs {
  envFile: string
  expectDb: string
  expectSystemId: string
  out: string
  since: string | null
}

export type FxExportParsed = { kind: 'help' } | { kind: 'usage'; problems: string[] } | { kind: 'run'; args: FxExportArgs }

const CREDENTIAL_IN_ARG = /[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*@|[?&](password|passwd|pwd|secret|token|key)=/i

export function parseFxExportArgs(argv: readonly string[]): FxExportParsed {
  const problems: string[] = []
  const values = new Map<string, string>()
  const known = ['--env-file', '--expect-db', '--expect-system-id', '--out', '--since']
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (!known.includes(arg)) { problems.push(`an argument is not recognised (position ${i + 1})`); continue }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) { problems.push(`${arg} needs a value`); continue }
    if (values.has(arg)) problems.push(`${arg} was given twice`)
    if (CREDENTIAL_IN_ARG.test(value)) problems.push(`the value of ${arg} looks like it carries a credential; name the target by an env file`)
    values.set(arg, value)
    i += 1
  }
  for (const required of ['--env-file', '--expect-db', '--expect-system-id', '--out']) if (!values.has(required)) problems.push(`${required} is required`)
  const since = values.get('--since') ?? null
  if (since !== null && sinceInstant(since) === null) problems.push('--since must be a real date, YYYY-MM-DD')
  if (problems.length > 0) return { kind: 'usage', problems }
  return { kind: 'run', args: { envFile: values.get('--env-file')!, expectDb: values.get('--expect-db')!, expectSystemId: values.get('--expect-system-id')!, out: path.resolve(values.get('--out')!), since } }
}

/** Every connection of this command carries this application name. */
export const FX_EXPORT_APPLICATION_NAME = 'first-load-export-fx-rates'

/** The only part of the caller's environment this command looks at. Never DATABASE_URL, never a PG variable. */
const INHERITED_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const
/** A variable of the env file that would point a client library somewhere else: refused, not dropped. */
const FORBIDDEN_FROM_FILE = /^(PG[A-Z]*|PSQL.*|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|PS4)$/

/** The environment of one run: a short whitelist from the caller, then the env file's own variables. The database is the file's DATABASE_URL, never an inherited one. */
export function buildExportEnv(fileEnv: Readonly<Record<string, string>>, parentEnv: Readonly<Record<string, string | undefined>>, home: string): { env: Record<string, string>; problems: string[] } {
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
  return { env, problems }
}
