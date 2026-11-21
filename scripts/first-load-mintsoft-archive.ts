/**
 * First-load MINTSOFT ARCHIVE PLAN (dry run): lists, for every product the owner set to Archived on the lifecycle review sheet, whether it would be
 * archived (discontinued) in Mintsoft and why every other one would not (not found, a bundle, already discontinued, no flag, physical stock above zero),
 * with the Mintsoft product id, the current DisCont flag and the physical stock, and a confirmation token derived from the plan. Read-only: Mintsoft is
 * read with GET only through the lifecycle review's guarded reader; nothing is written anywhere. The write itself is NOT BUILT (--execute is refused).
 *
 *   npm run first-load:mintsoft-archive -- --manifest <run.json> --mintsoft-env-file <file>
 *
 * This wrapper is the only place that names the WMS connector (lib/first-load is connector-agnostic). Exit codes: run with --help.
 */
import process from 'node:process'
import { runMintsoftArchiveCli, WmsCensusFailed, WmsCensusRefused } from '../lib/first-load/mintsoft-archive/cli'
import { MintsoftReviewFailed, MintsoftReviewRefused, readMintsoftProductCensus, readMintsoftReviewConfig } from '../lib/connectors/mintsoft/lifecycle-review-read'

runMintsoftArchiveCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}, {
  flag: '--mintsoft-env-file',
  label: 'Mintsoft',
  read: async (envFile) => {
    try {
      return await readMintsoftProductCensus(readMintsoftReviewConfig(envFile))
    } catch (error) {
      // Both messages are written to carry no key, URL or body.
      if (error instanceof MintsoftReviewRefused) throw new WmsCensusRefused(`refused before any request: ${error.message}`)
      if (error instanceof MintsoftReviewFailed) throw new WmsCensusFailed(error.message)
      throw new WmsCensusFailed('the product census could not be read')
    }
  },
}).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`first-load-mintsoft-archive: internal error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 5
  },
)
