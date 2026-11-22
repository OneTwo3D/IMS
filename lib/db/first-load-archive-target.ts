/**
 * THE FIRST-LOAD WMS ARCHIVE COMMAND'S CONNECTION TO ITS TARGET (scripts/first-load-<wms>-archive.ts --execute): ONE session, built by the session-lock
 * factory (createSessionAdvisoryLockClient), so the run's advisory lock is held on a connection shown to reach the backend directly. Behind a transaction
 * pooler a session lock would exclude nobody (tests/db/guarded-pool-routing.test.ts). The import proof, the switch reads and the activity-log records go
 * over the same session; the statements are lib/first-load/wms-discontinue/target.ts's.
 *
 * The factory reads DATABASE_URL from the process environment. The command names its target by an env file, never by an inherited value, so the caller
 * passes the file's DATABASE_URL and it is put in place of whatever the process held, before the client is built. The factory also reads the
 * direct-session override DATABASE_SESSION_LOCK_URL from the process environment (one place for every lock), which would move the session, and the
 * run's lock, off the file's DATABASE_URL: so a process that carries it (exported in the operator's shell) is REFUSED here before anything connects
 * (#1128 R2 LOW-A), and the script refuses an env file that sets it.
 */
import { FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY } from './advisory-locks'
import { SESSION_LOCK_DATABASE_URL_ENV } from './database-url-schema.mjs'
import { createSessionAdvisoryLockClient } from './session-lock-pool'

export const ARCHIVE_TARGET_LOCK_STATEMENTS = {
  lock: 'select pg_try_advisory_lock($1::bigint) as locked',
  unlock: 'select pg_advisory_unlock($1::bigint) as unlocked',
} as const

/** A refusal before anything connected; its message carries no credential and is shown to the operator as it is. */
export class ArchiveTargetRefused extends Error {}

export interface ArchiveTargetConnection {
  query: <T>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>
  /** Takes the run's session lock; false when another run holds it. */
  tryLock: () => Promise<boolean>
  unlock: () => Promise<void>
  close: () => Promise<void>
}

/** The session client as this module uses it (a pg.Client). */
export interface ArchiveSessionClient {
  connect(): Promise<unknown>
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>
  end(): Promise<unknown>
}

/** Test seams: the factory and the process environment it reads. Absent = the real ones. */
export interface ArchiveTargetSeams {
  createClient?: (purpose: string, extra: Record<string, unknown>) => ArchiveSessionClient
  processEnv?: Record<string, string | undefined>
}

export async function openArchiveTargetConnection(target: { databaseUrl: string }, applicationName: string, seams: ArchiveTargetSeams = {}): Promise<ArchiveTargetConnection> {
  const env = seams.processEnv ?? process.env
  if (Object.prototype.hasOwnProperty.call(env, SESSION_LOCK_DATABASE_URL_ENV) && env[SESSION_LOCK_DATABASE_URL_ENV] !== undefined) {
    throw new ArchiveTargetRefused(`the process environment carries ${SESSION_LOCK_DATABASE_URL_ENV} (exported in the shell?), which would move the run's session and lock off the env file's DATABASE_URL: unset it and run again`)
  }
  env.DATABASE_URL = target.databaseUrl
  // Written as a call so the DB-path census (tests/accounting/plugin-selection-lock.test.ts) sees this file build a session-lock client.
  const createClient = seams.createClient ?? ((purpose: string, extra: Record<string, unknown>) => createSessionAdvisoryLockClient(purpose, extra))
  const client = createClient('the first-load archive run lock', { connectionTimeoutMillis: 10_000, application_name: applicationName })
  await client.connect()
  const query = async <T>(sql: string, values?: unknown[]) => ({ rows: (await client.query(sql, values)).rows as T[] })
  return {
    query,
    tryLock: async () => {
      const rows = (await query<{ locked: boolean }>(ARCHIVE_TARGET_LOCK_STATEMENTS.lock, [FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY])).rows
      return rows.length === 1 && rows[0]!.locked === true
    },
    unlock: async () => { await query(ARCHIVE_TARGET_LOCK_STATEMENTS.unlock, [FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY]) },
    close: async () => { await client.end() },
  }
}
