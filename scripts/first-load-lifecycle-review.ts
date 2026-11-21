/**
 * First-load OWNER LIFECYCLE REVIEW SHEET: writes lifecycle-review.xlsx (every product and variation that is draft in WooCommerce, Archived in Qoblex or
 * discontinued in Mintsoft, for the owner to give its IMS status; plus every product for the SKU mapping check) and its generation record, which
 * first-load:prepare binds the filled sheet to. Read-only: nothing is written to WooCommerce, Mintsoft, Qoblex or IMS.
 *
 *   npm run first-load:lifecycle-review -- --manifest <run.json> --out <dir> [--mintsoft-env-file <file>]
 *
 * This wrapper is the only place that names the WMS connector (lib/first-load is connector-agnostic): it supplies the GET-only Mintsoft reader
 * (lib/connectors/mintsoft/lifecycle-review-read.ts). Exit codes: run with --help.
 */
import process from 'node:process'
import { WmsReadFailed, WmsReadRefused, runLifecycleReviewCli } from '../lib/first-load/lifecycle-review/cli'
import { MintsoftReviewFailed, MintsoftReviewRefused, readMintsoftReviewConfig, readMintsoftReviewListing } from '../lib/connectors/mintsoft/lifecycle-review-read'

runLifecycleReviewCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}, {
  wms: {
    flag: '--mintsoft-env-file',
    label: 'Mintsoft',
    read: async (envFile) => {
      try {
        return await readMintsoftReviewListing(readMintsoftReviewConfig(envFile))
      } catch (error) {
        // Both messages are written to carry no key, URL or body.
        if (error instanceof MintsoftReviewRefused) throw new WmsReadRefused(`refused before any request: ${error.message}`)
        if (error instanceof MintsoftReviewFailed) throw new WmsReadFailed(error.message)
        throw new WmsReadFailed('the listing could not be read')
      }
    },
  },
}).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`first-load-lifecycle-review: internal error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 5
  },
)
