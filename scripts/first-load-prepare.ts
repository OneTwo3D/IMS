/**
 * First-load input preparation: native Qoblex / Mintsoft / WooCommerce export files (through a column map) or canonical
 * CSVs in, importer-ready CSV files and a validation report out. File in, file out: no database, no network.
 *
 *   npm run first-load:prepare -- --manifest <run.json> --out <dir> [--run-id <id>]
 *   npm run first-load:prepare -- --manifest <run.json> --dry-run
 *
 * Exit codes (documented once, in lib/first-load/spec.ts EXIT_CODE_TABLE and docs/first-load-input-spec.md):
 * run with --help to print them.
 */
import process from 'node:process'
import { runCli } from '../lib/first-load/cli'

runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`first-load-prepare: internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 5
  },
)
