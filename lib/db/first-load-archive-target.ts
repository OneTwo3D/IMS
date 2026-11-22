/**
 * THE FIRST-LOAD WMS ARCHIVE COMMAND'S CONNECTION TO ITS TARGET (scripts/first-load-<wms>-archive.ts --execute): ONE session, built by the session-lock
 * factory (createSessionAdvisoryLockClient), so the run's advisory lock is held on a connection shown to reach the backend directly. Behind a transaction
 * pooler a session lock would exclude nobody (tests/db/guarded-pool-routing.test.ts). The import proof, the switch reads and the activity-log records go
 * over the same session; the statements are lib/first-load/wms-discontinue/target.ts's.
 *
 * The factory reads DATABASE_URL from the process environment. The command names its target by an env file, never by an inherited value, so the caller
 * passes the file's DATABASE_URL and it is put in place of whatever the process held, before the client is built. The factory's direct-session override is
 * read where the factory reads it (one place for every lock); the script refuses an env file that sets one, so the target is the file's DATABASE_URL.
 */
import { FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY } from './advisory-locks'
import { createSessionAdvisoryLockClient } from './session-lock-pool'

export const ARCHIVE_TARGET_LOCK_STATEMENTS = {
  lock: 'select pg_try_advisory_lock($1::bigint) as locked',
  unlock: 'select pg_advisory_unlock($1::bigint) as unlocked',
} as const

export interface ArchiveTargetConnection {
  query: <T>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>
  /** Takes the run's session lock; false when another run holds it. */
  tryLock: () => Promise<boolean>
  unlock: () => Promise<void>
  close: () => Promise<void>
}

export async function openArchiveTargetConnection(target: { databaseUrl: string }, applicationName: string): Promise<ArchiveTargetConnection> {
  process.env.DATABASE_URL = target.databaseUrl
  const client = createSessionAdvisoryLockClient('the first-load archive run lock', { connectionTimeoutMillis: 10_000, application_name: applicationName })
  await client.connect()
  const query = async <T>(sql: string, values?: unknown[]) => ({ rows: (await client.query(sql, values)).rows as T[] })
  return {
    query,
    tryLock: async () => {
      const rows = (await query<{ locked: boolean }>(ARCHIVE_TARGET_LOCK_STATEMENTS.lock, [FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY])).rows
      return rows.length === 1 && rows[0]!.locked === true
    },
    unlock: async () => { await query(ARCHIVE_TARGET_LOCK_STATEMENTS.unlock, [FIRST_LOAD_WMS_ARCHIVE_LOCK_KEY]) },
    close: () => client.end(),
  }
}
