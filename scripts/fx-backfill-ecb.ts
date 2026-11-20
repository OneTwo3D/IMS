#!/usr/bin/env tsx
/**
 * ECB HISTORY BACKFILL (npm run fx:backfill-ecb): loads historical ECB rates from a hand-downloaded eurofxref-hist.csv into fx_rates. See lib/first-load/backfill-ecb-rates.ts for the rules and --help for the usage.
 * It NEVER fetches. HARDENING, the same as first-load:apply and first-load:export-fx-rates: the target is named by an env file (a regular file you own, mode 600), never by an argument; the process
 * environment is replaced by a short whitelist plus the file's variables; the target is confirmed twice by what the server says about itself (--expect-db, --expect-system-id). Nothing prints a connection string.
 */
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import pg from 'pg'

import { buildExportEnv } from '../lib/first-load/export-fx-rates'
import {
  ECB_BACKFILL_APPLICATION_NAME, ECB_BACKFILL_EXIT, ECB_BACKFILL_HELP, parseBackfillArgs, parseEcbCsv, renderBackfillReport, runBackfill, type BackfillPort,
} from '../lib/first-load/backfill-ecb-rates'
import { readEnvFile } from './lib/first-load-apply-files'

export interface CliIo { out: (text: string) => void; err: (text: string) => void }
export interface CliDeps {
  open?: (url: string) => Promise<{ port: BackfillPort; close: () => Promise<void> }>
}

async function defaultOpen(url: string): Promise<{ port: BackfillPort; close: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, application_name: ECB_BACKFILL_APPLICATION_NAME })
  await client.connect()
  return { port: { query: async (sql, params) => ({ rows: (await client.query(sql, params ? [...params] : undefined)).rows as never[] }) }, close: () => client.end() }
}

export async function runCli(argv: readonly string[], io: CliIo, parentEnv: Readonly<Record<string, string | undefined>> = process.env, deps: CliDeps = {}): Promise<number> {
  const parsed = parseBackfillArgs(argv)
  if (parsed.kind === 'help') { io.out(ECB_BACKFILL_HELP); return ECB_BACKFILL_EXIT.OK }
  if (parsed.kind === 'usage') {
    io.err(`${parsed.problems.map((p) => `fx-backfill-ecb: ${p}`).join('\n')}\n(run with --help for the usage and the exit codes)\n`)
    return ECB_BACKFILL_EXIT.USAGE
  }
  const { args } = parsed
  const fail = (code: number, problem: string): number => { io.err(`fx-backfill-ecb: ${problem}\n`); return code }
  const envFile = readEnvFile(args.envFile)
  if (!envFile.ok) return fail(ECB_BACKFILL_EXIT.USAGE, envFile.problem)
  const built = buildExportEnv(envFile.env, parentEnv, parentEnv.HOME ?? '/tmp')
  if (built.problems.length > 0) return fail(ECB_BACKFILL_EXIT.USAGE, built.problems.join('; '))
  let text: string
  try {
    const st = statSync(args.ecbCsv)
    if (!st.isFile()) return fail(ECB_BACKFILL_EXIT.USAGE, '--ecb-csv is not a regular file')
    text = readFileSync(args.ecbCsv, 'utf8')
  } catch {
    return fail(ECB_BACKFILL_EXIT.USAGE, `--ecb-csv could not be read (${path.basename(args.ecbCsv)})`)
  }
  const file = parseEcbCsv(text)
  if (!file.ok) return fail(ECB_BACKFILL_EXIT.REFUSED, `the ECB file is refused: ${file.problems.join('; ')}`)

  let connection
  let outcome
  try {
    connection = await (deps.open ?? defaultOpen)(built.env.DATABASE_URL!)
    outcome = await runBackfill(connection.port, file.file, args)
  } catch (error) {
    return fail(ECB_BACKFILL_EXIT.TARGET, `the target could not be read or written; nothing was committed (${error instanceof Error ? error.name : 'error'})`)
  } finally {
    await connection?.close().catch(() => undefined)
  }
  if (outcome.kind === 'target-refused') return fail(ECB_BACKFILL_EXIT.TARGET, outcome.problem)
  if (outcome.kind === 'refused') return fail(ECB_BACKFILL_EXIT.REFUSED, `refused, nothing was written (base ${outcome.baseCurrency}):\n  ${outcome.refusals.join('\n  ')}`)
  io.out(renderBackfillReport(outcome, args))
  return ECB_BACKFILL_EXIT.OK
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }).then(
    (code) => { process.exitCode = code },
    (error: unknown) => { process.stderr.write(`fx-backfill-ecb: internal error: ${error instanceof Error ? error.name : 'Error'}\n`); process.exitCode = ECB_BACKFILL_EXIT.INTERNAL },
  )
}
