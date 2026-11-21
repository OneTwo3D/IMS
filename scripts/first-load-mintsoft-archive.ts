/**
 * First-load MINTSOFT ARCHIVE: for every product the owner set to Archived on the lifecycle review sheet, plans (dry run, the default) and on an explicit
 * confirmation carries out setting the product discontinued (`DisCont`) in Mintsoft.
 *
 *   npm run first-load:mintsoft-archive -- --manifest <run.json> --mintsoft-env-file <file>
 *   npm run first-load:mintsoft-archive -- --manifest <run.json> --mintsoft-env-file <file> --execute --plan-token <MSA-...> \
 *     --env-file <ims.env> --expect-db <name> --expect-system-id <id> --operator <name>
 *
 * The dry run reads Mintsoft with GET only through the lifecycle review's guarded reader and writes nothing anywhere. --execute writes to the LIVE
 * Mintsoft tenant (lib/connectors/mintsoft/first-load-archive-write.ts: the verified partial body, one product at a time, each re-read and verified) only
 * with the system switch first_load_mintsoft_archive_enabled on in the IMS target, the token of the reviewed plan, and the import proven there; each
 * write is recorded in the target's activity log. The transport's outbound-write grant applies: the operator's environment must carry
 * MINTSOFT_WRITE_ALLOWED for exactly this tenant, or the write is held before it leaves.
 *
 * The IMS target is hardened as first-load:apply's: named by an env file (a regular file you own, mode 600), never an argument; the database URL is the
 * file's DATABASE_URL, never an inherited one; the target is confirmed by what the server says about itself (--expect-db, --expect-system-id).
 *
 * This wrapper is the only place that names the WMS connector (lib/first-load is connector-agnostic). Exit codes: run with --help.
 */
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import pg from 'pg'
import { runWmsArchiveCli, WmsCensusFailed, WmsCensusRefused } from '../lib/first-load/wms-discontinue/cli'
import type { ArchiveTargetPort } from '../lib/first-load/wms-discontinue/target'
import { buildExportEnv } from '../lib/first-load/export-fx-rates'
import { MintsoftReviewFailed, MintsoftReviewRefused, readMintsoftProductCensus, readMintsoftReviewConfig } from '../lib/connectors/mintsoft/lifecycle-review-read'
import { createMintsoftArchiveWriter } from '../lib/connectors/mintsoft/first-load-archive-write'
import { readEnvFile } from './lib/first-load-apply-files'

const APPLICATION_NAME = 'first-load-mintsoft-archive'
/** A literal, not an import of lib/domain/settings/system-switches.ts (it loads the settings store); tests/first-load/mintsoft-archive-write.test.ts holds it equal. */
export const ARCHIVE_SWITCH_KEY = 'first_load_mintsoft_archive_enabled'

async function openTarget(envFile: string): Promise<{ port: ArchiveTargetPort; close: () => Promise<void> }> {
  const file = readEnvFile(envFile)
  if (!file.ok) throw new Error(file.problem)
  const built = buildExportEnv(file.env, process.env, process.env.HOME ?? '/tmp')
  if (built.problems.length > 0) throw new Error(built.problems.join('; '))
  const client = new pg.Client({ connectionString: built.env.DATABASE_URL, connectionTimeoutMillis: 10_000, application_name: APPLICATION_NAME })
  try {
    await client.connect()
  } catch {
    throw new Error('the database named by the env file could not be reached')
  }
  return { port: { query: async (sql, values) => ({ rows: (await client.query(sql, values as unknown[] | undefined)).rows as never[] }) }, close: () => client.end() }
}

runWmsArchiveCli(process.argv.slice(2), {
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
}, 'first-load-mintsoft-archive', {
  switchKey: ARCHIVE_SWITCH_KEY,
  openWriter: (envFile) => {
    try {
      return createMintsoftArchiveWriter(readMintsoftReviewConfig(envFile))
    } catch (error) {
      if (error instanceof MintsoftReviewRefused) throw new WmsCensusRefused(`refused before any request: ${error.message}`)
      throw error
    }
  },
  openTarget,
  newId: () => randomUUID(),
}).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`first-load-mintsoft-archive: internal error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 5
  },
)
