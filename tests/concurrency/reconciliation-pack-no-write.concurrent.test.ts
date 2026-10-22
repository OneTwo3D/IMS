import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import test from 'node:test'
import { config } from 'dotenv'

/**
 * NO-WRITE AND NO-NETWORK PROOF for `npm run reconcile:pack`, against a real, migrated PostgreSQL.
 *
 * A whole run of the command (the real invariant report included, read through the application's own client) leaves every table
 * with the rows it had and every table's insert, update and delete statistics unchanged, and the only network connection it opens
 * is to the database's own host and port. The rig can fail: a control write over a short-lived connection moves both censuses.
 *
 * Statistics are flushed by a backend when it goes idle or exits, so each census is taken over a fresh connection after a pause,
 * and the command disconnects the application's client before the second one. This file is alone in its process on purpose: the
 * writes of another test file would otherwise arrive in the window.
 *
 * Gated behind RUN_DB_CONCURRENCY_TESTS=1: `npm run test:concurrency`.
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const TAG = `RCPKNW${process.pid}`

async function withClient<T>(fn: (client: import('pg').Client) => Promise<T>): Promise<T> {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

type Census = { counts: Record<string, string>; stats: Record<string, string> }
async function census(): Promise<Census> {
  await new Promise((resolve) => setTimeout(resolve, 2000)) // statistics are flushed asynchronously
  return withClient(async (client) => {
    const tables = (await client.query(`SELECT quote_ident(table_schema) || '.' || quote_ident(table_name) AS t FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`)).rows.map((r) => r.t as string)
    const counts: Record<string, string> = {}
    for (const t of tables) counts[t] = (await client.query(`SELECT count(*)::text AS n FROM ${t}`)).rows[0].n
    const stats: Record<string, string> = {}
    for (const r of (await client.query(`SELECT relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables ORDER BY relname`)).rows) stats[r.relname] = `${r.n_tup_ins}/${r.n_tup_upd}/${r.n_tup_del}`
    assert.ok(tables.length > 100, 'precondition: the census covers the whole schema')
    return { counts, stats }
  })
}

test('[reconciliation pack] the rig can fail: a control write moves the row counts and the statistics', { skip: !RUN }, async () => {
  const before = await census()
  await withClient(async (client) => { await client.query(`INSERT INTO settings (key, value, "updatedAt") VALUES ('${TAG}', 'x', now())`) })
  const during = await census()
  await withClient(async (client) => { await client.query(`DELETE FROM settings WHERE key = '${TAG}'`) })
  assert.notDeepEqual(during.counts, before.counts)
  assert.notDeepEqual(during.stats, before.stats)
})

test('[reconciliation pack] a whole run of the command writes nothing and connects only to the database', { skip: !RUN }, async () => {
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const dir = mkdtempSync('/var/tmp/recon-pack-nw-')
  chmodSync(dir, 0o700)
  const url = new URL(process.env.DATABASE_URL!)
  const targets: string[] = []
  const original = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    // net.Socket.connect is called with (options), ([options]) or (port, host).
    const raw = args[0] as unknown
    const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string
    targets.push(typeof first === 'object' && first !== null ? (first.path ? `unix:${first.path}` : `${first.host ?? 'localhost'}:${first.port}`) : `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`)
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  } as typeof original
  try {
    const out: string[] = []
    const start = await census()
    targets.length = 0
    const code = await runPackCli({ argv: ['--phase', 'P0', '--report-dir', dir], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(), stdout: (t) => out.push(t), stderr: (t) => out.push(t) })
    const seen = [...targets]
    net.Socket.prototype.connect = original
    assert.ok(code === 0 || code === 1, `exit ${code}: ${out.join('\n')}`)
    assert.ok(out.some((line) => line.startsWith('R3 ')) && out.some((line) => line.startsWith('R15 ')), 'precondition: the items ran')
    const end = await census()
    assert.deepEqual(end.counts, start.counts, 'every table has the rows it had')
    assert.deepEqual(end.stats, start.stats, 'no table saw an insert, update or delete')
    assert.ok(seen.length > 0, 'precondition: the run did connect (to the database)')
    const host = url.hostname
    for (const target of seen) assert.ok(target === `${host}:${url.port}` || target === `127.0.0.1:${url.port}` || target === `localhost:${url.port}`, `unexpected connection to ${target}`)
  } finally {
    net.Socket.prototype.connect = original
    rmSync(dir, { recursive: true, force: true })
  }
})
