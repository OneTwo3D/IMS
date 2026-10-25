#!/usr/bin/env tsx
/**
 * FIRST-LOAD FX RATES EXPORT (npm run first-load:export-fx-rates): writes IMS's fx_rates rows (base to currency) as the canonical `ims-fx-rates` list for first-load:prepare.
 * Read-only; see lib/first-load/export-fx-rates.ts for the rows, the window and the base-currency stamp, and --help for the usage and the exit codes.
 *
 * HARDENING, the same as first-load:apply: the target is named by an env file (a regular file you own, mode 600), never by an argument; the process environment is REPLACED by
 * a short whitelist plus the file's variables; the target is confirmed twice by what the server says about itself (--expect-db, --expect-system-id); the output directory is
 * mode 700 and yours, and each file is created exclusively, mode 600, so nothing is overwritten.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import pg from 'pg'

import {
  FX_EXPORT_APPLICATION_NAME, FX_EXPORT_EXIT, FX_EXPORT_FILE, FX_EXPORT_HELP, FX_EXPORT_RECORD_FILE, buildExportEnv, exportRecord, parseFxExportArgs, readFxRates, renderFxRatesCsv, type FxExportPort,
} from '../lib/first-load/export-fx-rates'
import { prepareReportDir, publishRecord, readEnvFile } from './lib/first-load-apply-files'

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

export interface CliDeps {
  /** Opens the read-only connection. Production: a pg client with default_transaction_read_only=on. */
  open?: (url: string) => Promise<{ port: FxExportPort; close: () => Promise<void> }>
  now?: () => Date
}

async function defaultOpen(url: string): Promise<{ port: FxExportPort; close: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, options: '-c default_transaction_read_only=on', application_name: FX_EXPORT_APPLICATION_NAME })
  await client.connect()
  return { port: { query: async (sql) => ({ rows: (await client.query(sql)).rows as never[] }) }, close: () => client.end() }
}

export async function runCli(argv: readonly string[], io: CliIo, parentEnv: Readonly<Record<string, string | undefined>> = process.env, deps: CliDeps = {}): Promise<number> {
  const parsed = parseFxExportArgs(argv)
  if (parsed.kind === 'help') { io.out(FX_EXPORT_HELP); return FX_EXPORT_EXIT.OK }
  if (parsed.kind === 'usage') {
    io.err(`${parsed.problems.map((p) => `first-load-export-fx-rates: ${p}`).join('\n')}\n(run with --help for the usage and the exit codes)\n`)
    return FX_EXPORT_EXIT.USAGE
  }
  const { args } = parsed
  const fail = (code: number, problem: string): number => { io.err(`first-load-export-fx-rates: ${problem}\n`); return code }
  const envFile = readEnvFile(args.envFile)
  if (!envFile.ok) return fail(FX_EXPORT_EXIT.USAGE, envFile.problem)
  const built = buildExportEnv(envFile.env, parentEnv, parentEnv.HOME ?? '/tmp')
  if (built.problems.length > 0) return fail(FX_EXPORT_EXIT.USAGE, built.problems.join('; '))
  const dir = prepareReportDir(args.out)
  if (!dir.ok) return fail(FX_EXPORT_EXIT.USAGE, dir.problem)
  // Nothing is overwritten: the directory must hold neither file already.
  const { existsSync } = await import('node:fs')
  for (const name of [FX_EXPORT_FILE, FX_EXPORT_RECORD_FILE]) if (existsSync(path.join(dir.value.dir, name))) return fail(FX_EXPORT_EXIT.USAGE, `${name} already exists in --out; it is never overwritten`)

  let read
  let connection
  try {
    connection = await (deps.open ?? defaultOpen)(built.env.DATABASE_URL!)
    read = await readFxRates(connection.port, args.since)
  } catch (error) {
    return fail(FX_EXPORT_EXIT.REFUSED, `the target could not be read (${error instanceof Error ? error.message : 'error'})`)
  } finally {
    await connection?.close().catch(() => undefined)
  }
  if (read.database !== args.expectDb) return fail(FX_EXPORT_EXIT.REFUSED, '--expect-db does not equal the database the server reports; the target is not the database you named')
  if (read.systemId !== args.expectSystemId) return fail(FX_EXPORT_EXIT.REFUSED, '--expect-system-id does not equal the cluster system identifier the server reports')
  if (read.rows.length === 0) return fail(FX_EXPORT_EXIT.EMPTY, `fx_rates holds no ${read.baseCurrency} row${args.since ? ' on or after --since' : ''}; nothing was written`)

  const csv = renderFxRatesCsv(read)
  const record = exportRecord(read, csv, args.since, (deps.now ?? (() => new Date()))())
  const csvFile = publishRecord(dir.value, FX_EXPORT_FILE, csv)
  const recordFile = publishRecord(dir.value, FX_EXPORT_RECORD_FILE, `${JSON.stringify(record, null, 2)}\n`)
  const file = record.file as { sha256: string; rows: number }
  io.out(`first-load-export-fx-rates: wrote ${file.rows} ${read.baseCurrency} rows (${(record.currencies as string[]).length} currencies, ${String(record.earliestFetchedAt)} to ${String(record.latestFetchedAt)})\n  ${csvFile}\n  ${recordFile}\n  sha256 ${file.sha256}\n`)
  return FX_EXPORT_EXIT.OK
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }).then(
    (code) => { process.exitCode = code },
    (error: unknown) => { process.stderr.write(`first-load-export-fx-rates: internal error: ${error instanceof Error ? error.name : 'Error'}\n`); process.exitCode = FX_EXPORT_EXIT.INTERNAL },
  )
}
