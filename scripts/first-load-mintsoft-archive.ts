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
 * woo-mintsoft plugin's product sync is retired) with the target's own evidence of it (its newest bridge-units-masked attestation, judged as writers:check
 * judges it); the producer hold is judged on the target's env file too, never the operator's shell. Each write is
 * recorded in the target's activity log; one run at a time per target (an advisory lock).
 *
 * The IMS target is hardened as first-load:apply's: named by an env file (a regular file you own, mode 600), never an argument; the database URL is the
 * file's DATABASE_URL, never an inherited one; the target is confirmed by what the server says about itself (--expect-db, --expect-system-id).
 *
 * This wrapper is the only place that names the WMS connector (lib/first-load is connector-agnostic). Exit codes: run with --help.
 */
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { runWmsArchiveCli } from '../lib/first-load/wms-discontinue/cli'
import { ARCHIVE_RETIREMENT_ATTESTATION_KIND, createMintsoftArchiveWiring } from '../lib/connectors/mintsoft/first-load-archive-write'
import { openArchiveTarget } from './lib/first-load-archive-open-target'

const APPLICATION_NAME = 'first-load-mintsoft-archive'
/** A literal, not an import of lib/domain/settings/system-switches.ts (it loads the settings store); tests/first-load/mintsoft-archive-write.test.ts holds it equal. */
export const ARCHIVE_SWITCH_KEY = 'first_load_mintsoft_archive_enabled'

// The credentials file is parsed once, for both the census and the writer.
const mintsoft = createMintsoftArchiveWiring()

runWmsArchiveCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}, mintsoft.reader, 'first-load-mintsoft-archive', {
  switchKey: ARCHIVE_SWITCH_KEY,
  openWriter: mintsoft.openWriter,
  retirementEvidenceKind: ARCHIVE_RETIREMENT_ATTESTATION_KIND,
  openTarget: (envFile) => openArchiveTarget(envFile, APPLICATION_NAME),
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
