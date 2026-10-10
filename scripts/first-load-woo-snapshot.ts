/**
 * First-load WooCommerce snapshot: reads a store's variable products and their variations (GET only) into a checksummed snapshot and the
 * canonical variant-parents.csv that first-load:prepare joins Qoblex variants to. Read-only: nothing is written to the store or to IMS.
 *
 *   npm run first-load:woo-snapshot -- --env-file <credentials> --out <dir> --allow-origin <origin>
 *   npm run first-load:woo-snapshot -- --verify <dir>/woo-snapshot.json
 *
 * Exit codes (documented once, in lib/first-load/spec.ts SNAPSHOT_EXIT_CODE_TABLE and docs/first-load-input-spec.md): run with --help to print them.
 */
import process from 'node:process'
import { runSnapshotCli } from '../lib/first-load/woo-snapshot/cli'

runSnapshotCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`first-load-woo-snapshot: internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 6
  },
)
