/**
 * THE FIRST-LOAD WMS ARCHIVE COMMAND'S IMS TARGET, opened from its env file (scripts/first-load-<wms>-archive.ts --execute). A module of its own so a
 * test drives it (#1128 R2 LOW-E): the target's environment handed to the command is the env file's (`built.env`), never the operator's shell; an env
 * file that sets DATABASE_SESSION_LOCK_URL is refused, and so is a shell that exports it (lib/db/first-load-archive-target.ts, #1128 R2 LOW-A).
 */
import process from 'node:process'
import type { ArchiveTarget } from '../../lib/first-load/wms-discontinue/cli'
import { ArchiveTargetRefused, openArchiveTargetConnection, type ArchiveTargetConnection } from '../../lib/db/first-load-archive-target'
import { SESSION_LOCK_DATABASE_URL_ENV } from '../../lib/db/database-url-schema.mjs'
import { buildExportEnv } from '../../lib/first-load/export-fx-rates'
import { readEnvFile } from './first-load-apply-files'

export interface OpenArchiveTargetSeams {
  /** Absent = lib/db/first-load-archive-target.ts's connection. */
  open?: (target: { databaseUrl: string }, applicationName: string) => Promise<ArchiveTargetConnection>
  /** The process environment the inherited whitelist is taken from. Absent = process.env. */
  parentEnv?: Readonly<Record<string, string | undefined>>
}

/**
 * The target: its env file's DATABASE_URL (never an inherited one), on one session built by the session-lock factory (the run's advisory lock lives on
 * it), and its variables (the installation's own rules for the write: grant, live-from, producer hold). Throws with a short message, never a credential.
 */
export async function openArchiveTarget(envFile: string, applicationName: string, seams: OpenArchiveTargetSeams = {}): Promise<ArchiveTarget> {
  const file = readEnvFile(envFile)
  if (!file.ok) throw new Error(file.problem)
  const parentEnv = seams.parentEnv ?? process.env
  const built = buildExportEnv(file.env, parentEnv, parentEnv.HOME ?? '/tmp')
  if (built.problems.length > 0) throw new Error(built.problems.join('; '))
  // The direct-session override would move the session (and the run's lock) off the file's DATABASE_URL: this command connects directly or not at all.
  if (Object.prototype.hasOwnProperty.call(built.env, SESSION_LOCK_DATABASE_URL_ENV)) throw new Error(`the env file sets ${SESSION_LOCK_DATABASE_URL_ENV}; this command uses the file's DATABASE_URL as a direct session only: run it with a direct (non-pooled) DATABASE_URL in a copy of the file without that variable`)
  let connection: ArchiveTargetConnection
  try {
    connection = await (seams.open ?? openArchiveTargetConnection)({ databaseUrl: built.env.DATABASE_URL! }, applicationName)
  } catch (error) {
    if (error instanceof ArchiveTargetRefused) throw new Error(error.message)
    throw new Error('the database named by the env file could not be reached on a direct session')
  }
  return { port: { query: connection.query }, env: built.env, tryLock: connection.tryLock, unlock: connection.unlock, close: connection.close }
}
