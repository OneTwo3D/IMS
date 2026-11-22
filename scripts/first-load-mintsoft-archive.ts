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
 * with the system switch first_load_mintsoft_archive_enabled on in the IMS target, the token of the reviewed plan, the import proven there, and the
 * Mintsoft step (M) live in the target's env file (MINTSOFT_WRITE_ALLOWED for exactly this tenant and MINTSOFT_WRITES_LIVE_FROM reached: the
 * woo-mintsoft plugin's product sync is retired); the producer hold is judged on the target's env file too, never the operator's shell. Each write is
 * recorded in the target's activity log; one run at a time per target (an advisory lock).
 *
 * The IMS target is hardened as first-load:apply's: named by an env file (a regular file you own, mode 600), never an argument; the database URL is the
 * file's DATABASE_URL, never an inherited one; the target is confirmed by what the server says about itself (--expect-db, --expect-system-id).
 *
 * This wrapper is the only place that names the WMS connector (lib/first-load is connector-agnostic). Exit codes: run with --help.
 */
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { runWmsArchiveCli, type ArchiveTarget } from '../lib/first-load/wms-discontinue/cli'
import { openArchiveTargetConnection } from '../lib/db/first-load-archive-target'
import { SESSION_LOCK_DATABASE_URL_ENV } from '../lib/db/database-url-schema.mjs'
import { buildExportEnv } from '../lib/first-load/export-fx-rates'
import { createMintsoftArchiveWiring } from '../lib/connectors/mintsoft/first-load-archive-write'
import { readEnvFile } from './lib/first-load-apply-files'

const APPLICATION_NAME = 'first-load-mintsoft-archive'
/** A literal, not an import of lib/domain/settings/system-switches.ts (it loads the settings store); tests/first-load/mintsoft-archive-write.test.ts holds it equal. */
export const ARCHIVE_SWITCH_KEY = 'first_load_mintsoft_archive_enabled'

/**
 * The target: its env file's DATABASE_URL (never an inherited one), on one session built by the session-lock factory (the run's advisory lock lives on
 * it), and its variables (the installation's own rules for the write: grant, live-from, producer hold).
 */
async function openTarget(envFile: string): Promise<ArchiveTarget> {
  const file = readEnvFile(envFile)
  if (!file.ok) throw new Error(file.problem)
  const built = buildExportEnv(file.env, process.env, process.env.HOME ?? '/tmp')
  if (built.problems.length > 0) throw new Error(built.problems.join('; '))
  // The direct-session override would move the session (and the run's lock) off the file's DATABASE_URL: this command connects directly or not at all.
  if (Object.prototype.hasOwnProperty.call(built.env, SESSION_LOCK_DATABASE_URL_ENV)) throw new Error(`the env file sets ${SESSION_LOCK_DATABASE_URL_ENV}; this command uses the file's DATABASE_URL as a direct session only: run it with a direct (non-pooled) DATABASE_URL in a copy of the file without that variable`)
  let connection
  try {
    connection = await openArchiveTargetConnection({ databaseUrl: built.env.DATABASE_URL! }, APPLICATION_NAME)
  } catch {
    throw new Error('the database named by the env file could not be reached on a direct session')
  }
  return { port: { query: connection.query }, env: built.env, tryLock: connection.tryLock, unlock: connection.unlock, close: connection.close }
}

// The credentials file is parsed once, for both the census and the writer.
const mintsoft = createMintsoftArchiveWiring()

runWmsArchiveCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}, mintsoft.reader, 'first-load-mintsoft-archive', {
  switchKey: ARCHIVE_SWITCH_KEY,
  openWriter: mintsoft.openWriter,
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
