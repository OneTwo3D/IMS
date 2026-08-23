#!/usr/bin/env node
// =============================================================================
// Refuse to migrate while anything else is still connected to the database.
// =============================================================================
// scripts/deploy.sh stops the writers it knows about — the web server, the stray
// next/npm processes in the app directory, the app-managed cron entries. This script
// is the part that does not depend on that list being complete.
//
// "Drained" means STOPPED, not idle. An enumeration of writers is a guess about the
// box; pg_stat_activity is the database's own answer. It is the check that catches
// the writer nobody wrote down: an ad-hoc `next dev` in one of the sibling
// worktrees, a psql session left open in a tmux pane, a one-off tsx script.
//
// Exit 0 when this process is the only client backend on the target database;
// exit 1 (with the offenders listed) otherwise.
//
// The connection this script itself opens is excluded via pg_backend_pid().
// Non-client backends (autovacuum, walwriter, the checkpointer) are excluded via
// backend_type: they are Postgres's own workers, not application writers.
// =============================================================================

import { config as loadDotenv } from 'dotenv'
import pg from 'pg'
import { pathToFileURL } from 'node:url'

export const WRITER_QUERY = `
  SELECT pid,
         COALESCE(application_name, '')          AS application_name,
         COALESCE(usename, '')                   AS usename,
         COALESCE(host(client_addr), 'local')    AS client_addr,
         COALESCE(state, '')                     AS state,
         COALESCE(to_char(backend_start, 'YYYY-MM-DD"T"HH24:MI:SS'), '') AS backend_start,
         COALESCE(LEFT(query, 120), '')          AS query
    FROM pg_stat_activity
   WHERE datname = current_database()
     AND pid <> pg_backend_pid()
     AND backend_type = 'client backend'
   ORDER BY backend_start
`

/**
 * Pure: turn pg_stat_activity rows into a verdict plus operator-readable lines.
 * Kept separate from the connection so the decision can be unit tested.
 */
export function summariseWriters(rows) {
  const writers = Array.isArray(rows) ? rows : []
  return {
    quiescent: writers.length === 0,
    count: writers.length,
    lines: writers.map(
      (row) =>
        `pid ${row.pid}  ${row.client_addr ?? '?'}  user=${row.usename ?? '?'}  ` +
        `app=${row.application_name || '(unnamed)'}  state=${row.state || '?'}  ` +
        `since=${row.backend_start || '?'}\n      query: ${(row.query || '').trim() || '(none)'}`,
    ),
  }
}

async function main() {
  loadDotenv({ path: '.env.local', override: false, quiet: true })
  loadDotenv({ path: '.env', override: false, quiet: true })

  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is not set — cannot check who is connected. Refusing to migrate.')
    process.exit(1)
  }

  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    const result = await client.query(WRITER_QUERY)
    const summary = summariseWriters(result.rows)

    if (summary.quiescent) {
      console.log('Database is quiescent: no other client backends are connected.')
      return
    }

    console.error(
      `Refusing to migrate: ${summary.count} other client backend(s) are still connected to the target database.`,
    )
    console.error('Stop them and re-run the deploy. Every one of these can write while the migration runs.\n')
    for (const line of summary.lines) console.error(`  - ${line}`)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`Failed to check for connected writers: ${error instanceof Error ? error.message : String(error)}`)
    console.error('Treating that as "not proven quiescent" — refusing to migrate.')
    process.exit(1)
  })
}
