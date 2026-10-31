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


// WHY HOLDS EXIST. CI runs the whole concurrency tier on ONE shared scratch database, so a Xero token, a first-load run record and Xero sync-log
// rows left by other files are visible to a run, and each is a row a test needing its own must not delete or collide with (one token per connector;
// one first-load record, whose singleton flag a check constraint pins to true; R10 reads every write-shaped sync row). The command reads on OTHER
// connections, so a hold must be COMMITTED. A committed hold that nothing can undo strands foreign rows if the test fails or the process is killed,
// so every hold is SELF-DESCRIBING AND DURABLE: in the SAME transaction as the rename or delete, the row's full original goes into the test-owned
// table `_test_held_rows` (run_id, kind, table_name, row_id, payload jsonb, held_at). There is never a committed change without its recovery record.
// Restore reads that table, not a value held in memory, and every hold first sweeps the entries of any EARLIER run (run_id other than its own), so
// a killed run heals on the next. The table is created only here, only after scratch-database-setup has refused a non-scratch database, so it only
// ever exists in scratch/CI databases.
type Held = string
const NOTHING_HELD: Held = ''
let holdCounter = 0
const HELD_DDL = `CREATE TABLE IF NOT EXISTS _test_held_rows (run_id text NOT NULL, kind text NOT NULL, table_name text NOT NULL, row_id text NOT NULL, payload jsonb NOT NULL, held_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, table_name, row_id))`

type Q = import('pg').Client
/** Put back every entry matching `where` (a run id filter), delete the entries, all in one transaction; returns how many entries were restored. */
async function restoreHeld(client: Q, runFilter: { run: string } | { notRun: string }): Promise<number> {
  const [clause, value] = 'run' in runFilter ? ['run_id = $1', runFilter.run] : ['run_id <> $1', runFilter.notRun]
  await client.query('BEGIN')
  try {
    await client.query(HELD_DDL)
    const entries = (await client.query(`SELECT run_id, kind, table_name, row_id, payload FROM _test_held_rows WHERE ${clause} ORDER BY held_at, row_id FOR UPDATE`, [value])).rows as Array<{ run_id: string; kind: string; table_name: string; row_id: string; payload: Record<string, unknown> }>
    for (const e of entries) {
      if (e.kind === 'token') await client.query(`UPDATE accounting_tokens SET connector = $2 WHERE id = $1 AND connector = 'held-' || id`, [e.row_id, e.payload.connector])
      else if (e.kind === 'sync_row') await client.query(`UPDATE accounting_sync_logs SET connector = $2 WHERE id = $1 AND connector = 'held-xero'`, [e.row_id, e.payload.connector])
      else if (e.kind === 'first_load') await client.query(`INSERT INTO first_load_apply_runs SELECT * FROM jsonb_populate_record(NULL::first_load_apply_runs, $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(e.payload)])
      else throw new Error(`unknown held kind ${e.kind}`)
    }
    await client.query(`DELETE FROM _test_held_rows WHERE ${clause}`, [value])
    await client.query('COMMIT')
    return entries.length
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

/** Heal whatever an earlier (failed or killed) run left held. Called at the start of every hold. */
async function sweepEarlierHolds(except: string): Promise<number> {
  return withClient((client) => restoreHeld(client, { notRun: except }))
}

/**
 * Hold every foreign Xero token, first-load record and write-shaped Xero sync row aside, recording each original in `_test_held_rows` in the SAME
 * single transaction. `injectFailureAfter` (tests of this helper only) throws inside the transaction after that many holds, which rolls ALL of it back.
 */
async function holdForeignEstate(injectFailureAfter?: number): Promise<Held> {
  const runId = `${process.pid}-${++holdCounter}-${Date.now()}`
  await sweepEarlierHolds(runId)
  await withClient(async (client) => {
    await client.query('BEGIN')
    try {
      await client.query(HELD_DDL)
      let held = 0
      const step = () => { held += 1; if (injectFailureAfter !== undefined && held >= injectFailureAfter) throw new Error('injected failure after hold') }
      const record = (kind: string, table: string, id: string, payload: unknown) => client.query(`INSERT INTO _test_held_rows (run_id, kind, table_name, row_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`, [runId, kind, table, id, JSON.stringify(payload)])
      for (const row of (await client.query(`SELECT id, to_jsonb(t) AS j FROM accounting_tokens t WHERE connector = 'xero' ORDER BY id FOR UPDATE`)).rows as Array<{ id: string; j: unknown }>) {
        await record('token', 'accounting_tokens', row.id, row.j)
        await client.query(`UPDATE accounting_tokens SET connector = 'held-' || id WHERE id = $1 AND connector = 'xero'`, [row.id])
        step()
      }
      for (const row of (await client.query(`SELECT id, to_jsonb(t) AS j FROM accounting_sync_logs t WHERE connector = 'xero' AND (status::text IN ('SYNCED', 'PROCESSING') OR "externalTransactionId" IS NOT NULL) ORDER BY id FOR UPDATE`)).rows as Array<{ id: string; j: unknown }>) {
        await record('sync_row', 'accounting_sync_logs', row.id, row.j)
        await client.query(`UPDATE accounting_sync_logs SET connector = 'held-xero' WHERE id = $1 AND connector = 'xero'`, [row.id])
        step()
      }
      for (const row of (await client.query(`SELECT id, to_jsonb(t) AS j FROM first_load_apply_runs t ORDER BY id FOR UPDATE`)).rows as Array<{ id: string; j: unknown }>) {
        await record('first_load', 'first_load_apply_runs', row.id, row.j)
        await client.query(`DELETE FROM first_load_apply_runs WHERE id = $1`, [row.id])
        step()
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
  const visible = (await withClient((c) => c.query(`SELECT (SELECT count(*) FROM accounting_tokens WHERE connector = 'xero')::int AS t, (SELECT count(*) FROM first_load_apply_runs)::int AS f`))).rows[0]
  assert.deepEqual([visible.t, visible.f], [0, 0], 'precondition: no foreign Xero token or first-load record is visible to the run')
  return runId
}

/** Put this run's holds back from the table (never from memory) and assert every one was. */
async function restoreForeignEstate(runId: Held): Promise<void> {
  if (runId === NOTHING_HELD) return
  const { restored, expected } = await withClient(async (client) => {
    await client.query(HELD_DDL)
    const expected = (await client.query(`SELECT count(*)::int AS n FROM _test_held_rows WHERE run_id = $1`, [runId])).rows[0].n as number
    return { restored: await restoreHeld(client, { run: runId }), expected }
  })
  assert.equal(restored, expected, 'every foreign Xero token, first-load record and write-shaped sync row was put back')
  assert.equal((await withClient((c) => c.query(`SELECT count(*)::int AS n FROM _test_held_rows WHERE run_id = $1`, [runId]))).rows[0].n, 0, 'no entry of this run is left')
}

/** A digest of every row a hold touches, as stored, for before/after comparison in the arms below. */
async function heldKindsDigest(): Promise<string> {
  return (await withClient((c) => c.query(`SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS d FROM (
    SELECT 't:' || to_jsonb(t)::text AS x FROM accounting_tokens t WHERE connector IN ('xero') OR connector LIKE 'held-%'
    UNION ALL SELECT 's:' || to_jsonb(t)::text FROM accounting_sync_logs t WHERE connector IN ('xero', 'held-xero') AND (status::text IN ('SYNCED', 'PROCESSING') OR "externalTransactionId" IS NOT NULL)
    UNION ALL SELECT 'f:' || to_jsonb(t)::text FROM first_load_apply_runs t) q`))).rows[0].d as string
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
  const { healthyLiveness } = await import('../reconciliation-pack/basis-fixtures.ts')
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
    // The liveness reader is a double here (a scratch database has no healthy read-sync estate); the next test runs the real child.
    const code = await runPackCli({ argv: ['--phase', 'P0', '--report-dir', dir], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(), deps: { liveness: healthyLiveness() }, stdout: (t) => out.push(t), stderr: (t) => out.push(t) })
    const seen = [...targets]
    net.Socket.prototype.connect = original
    assert.ok(code === 0 || code === 1, `exit ${code}: ${out.join('\n')}`)
    assert.ok(out.some((line) => line.startsWith('R3 ')) && out.some((line) => line.startsWith('R15 ')), 'precondition: the items ran')
    // The invariant run read ONE snapshot through the application client (lib/reconciliation-pack/invariant-snapshot.ts): without
    // the proof every one of these would be inconclusive, which is how a binding broken by import order shows up.
    for (const id of ['R3', 'R4', 'R15']) assert.ok(out.some((line) => line.startsWith(`${id} pass`) || line.startsWith(`${id} fail`)), `${id} decided on one snapshot: ${out.join('\n')}`)
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


test('[reconciliation pack] the REAL liveness reader (the status command as a child) on a scratch estate is never healthy: nothing passes, and nothing is written', { skip: !RUN }, async () => {
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const dir = mkdtempSync('/var/tmp/recon-pack-nw-')
  chmodSync(dir, 0o700)
  try {
    const out: string[] = []
    const start = await census()
    const code = await runPackCli({ argv: ['--phase', 'P0', '--report-dir', dir], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(), stdout: (t) => out.push(t), stderr: (t) => out.push(t) })
    // A scratch database has no scheduled estate: the status report is either not healthy or cannot be read. Either way every item is
    // inconclusive, so the run exits 5, and the invariant report was not even needed.
    assert.equal(code, 5, out.join('\n'))
    assert.ok(!out.some((line) => /^R\d+ pass\b/.test(line)), out.join('\n'))
    assert.ok(out.some((line) => /^R3 inconclusive (STALE_BASIS|SOURCE_UNREADABLE)$/.test(line)), out.join('\n'))
    const end = await census()
    assert.deepEqual(end.counts, start.counts)
    assert.deepEqual(end.stats, start.stats)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- R6 and R10 end to end: the real basis (a client of its own), the real IMS reads, the real invariant run -------------------

const LD = '2026-03-05' // the cycle date of the ledger items' data
const LTAG = `RCLG${process.pid}`
const SETTINGS = ['integration_xero_enabled', 'xero_inventory_account', 'xero_allocated_inventory_account', 'xero_transit_account', 'xero_cogs_account', 'xero_unearned_revenue_account', 'transit_ledger_coverage_start_date']

test('[reconciliation pack] R6 and R10 on a seeded estate: decided from stored snapshots, a post-load write fails R10 by id, and the run writes nothing', { skip: !RUN }, async () => {
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const { healthyLiveness } = await import('../reconciliation-pack/basis-fixtures.ts')
  const { INTEGRATION_PLUGIN_SETTING_KEYS } = await import('../../lib/integration-plugin-keys.ts')
  const keys = { xero: INTEGRATION_PLUGIN_SETTING_KEYS.xero }
  const codes = { inventory: `${LTAG}1`, allocated: `${LTAG}2`, transit: `${LTAG}3`, cogs: `${LTAG}4`, unearned: `${LTAG}5` }
  const dir = mkdtempSync('/var/tmp/recon-pack-nw-')
  chmodSync(dir, 0o700)
  const saved = await withClient(async (client) => (await client.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [[...SETTINGS, keys.xero]])).rows as Array<{ key: string; value: string }>)
  const sql = (text: string, values: unknown[] = []) => withClient((client) => client.query(text, values))
  const setting = (key: string, value: string) => sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value])
  let estate: Held = NOTHING_HELD
  try {
    estate = await holdForeignEstate()
    for (const [key, value] of [[keys.xero, 'true'], ['xero_inventory_account', codes.inventory], ['xero_allocated_inventory_account', codes.allocated], ['xero_transit_account', codes.transit], ['xero_cogs_account', codes.cogs], ['xero_unearned_revenue_account', codes.unearned], ['transit_ledger_coverage_start_date', '2026-01-01']] as const) await setting(key, value)
    await sql(`INSERT INTO accounting_tokens (id, connector, "accessToken", "expiresAt", "tenantId", "updatedAt") VALUES ($1, 'xero', 'x', '2031-01-01', $2, now())`, [`${LTAG}-tok`, `${LTAG}-tenant`])
    const amounts: Record<string, [string, string]> = { inventory: ['100.50', '100.50'], allocated: ['20.25', '20.25'], transit: ['50', '50'], cogs: ['7', '7'], unearned: ['-30', '-30'] }
    for (const [kind, code] of Object.entries(codes)) {
      await sql(`INSERT INTO accounting_accounts (id, connector, "externalAccountId", code, name, type, active) VALUES ($1, 'xero', $2, $3, 'x', 'ASSET', true)`, [`${LTAG}-ca-${kind}`, `${LTAG}-${kind}`, code])
    }
    for (const [kind, code] of Object.entries(codes)) {
      await sql(`INSERT INTO accounting_account_balance_snapshots (id, connector, "externalAccountId", "accountCode", "accountName", "balanceDate", currency, "amountForeign", "amountBase", "sourcePayloadRef", "tenantId", "parserVersion", "updatedAt") VALUES ($1, 'xero', $2, $3, 'x', $4, 'GBP', $5, $5, $6, $7, 2, now())`, [`${LTAG}-b-${kind}`, `${LTAG}-${kind}`, code, LD, amounts[kind]![0], `xero:trial-balance:${LD}`, `${LTAG}-tenant`])
    }
    await sql(`INSERT INTO accounting_account_balance_snapshots (id, connector, "externalAccountId", "accountCode", "accountName", "balanceDate", currency, "amountForeign", "amountBase", "sourcePayloadRef", "tenantId", "parserVersion", "updatedAt") VALUES ($1, 'xero', $2, $3, 'x', '2026-03-04', 'GBP', 40, 40, 'xero:trial-balance:2026-03-04', $4, 2, now())`, [`${LTAG}-b-open`, `${LTAG}-transit`, codes.transit, `${LTAG}-tenant`])
    await sql(`INSERT INTO transit_subledger_movements (id, source_type, source_ref, idempotency_key, base_delta, journal_date) VALUES ($1, 'STOCK_RECEIPT', $2, $3, 10, $4)`, [`${LTAG}-mv`, LTAG, `${LTAG}-mv`, LD])
    await sql(`INSERT INTO inventory_snapshot_runs (id, "snapshotDate", "stockLevelCount", "snapshotCount", "updatedAt") VALUES ($1, $2, 0, 0, now())`, [`${LTAG}-run`, LD])
    // The estate is a sub-ledger of nothing against a GL of 120.75: R6 fails, which is the point (a gap beyond GBP 1 is a finding).
    await sql(`INSERT INTO first_load_apply_runs (id, singleton, version, manifest_digest, run_id, status, steps, facts, created_at, updated_at) VALUES ($1, true, 1, 'd', 'r', 'VERIFIED', '{}', '{}', '2026-03-01 09:00:00', '2026-03-02 09:00:00')`, [`${LTAG}-fl`])
    await sql(`INSERT INTO accounting_sync_logs (id, connector, type, status, "referenceType", "referenceId", "externalTransactionId", "syncedAt", "createdAt") VALUES ($1, 'xero', 'COGS_JOURNAL', 'SYNCED', 'CogsEntry', 'ref', 'doc', '2026-03-03 10:00:00', '2026-03-03 10:00:00')`, [`${LTAG}-post`])
    await sql(`INSERT INTO accounting_sync_logs (id, connector, type, status, "referenceType", "referenceId", "externalTransactionId", "syncedAt", "createdAt") VALUES ($1, 'xero', 'COGS_JOURNAL', 'SYNCED', 'CogsEntry', 'ref2', 'doc2', '2026-02-20 10:00:00', '2026-02-20 10:00:00')`, [`${LTAG}-old`])

    const run = async () => {
      const out: string[] = []
      const before = await census()
      const code = await runPackCli({ argv: ['--phase', 'P1', '--as-of', LD, '--items', 'R6,R10', '--report-dir', dir], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(), deps: { liveness: healthyLiveness() }, stdout: (t) => out.push(t), stderr: (t) => out.push(t) })
      const after = await census()
      assert.deepEqual(after.counts, before.counts, 'every table has the rows it had')
      assert.deepEqual(after.stats, before.stats, 'no table saw an insert, update or delete')
      return { code, out }
    }

    // 1. Sub-ledger empty against a GL of 120.75: R6 fails. A write since the first load began (and one before it) are in the IMS data: R10 fails.
    const first = await run()
    assert.equal(first.code, 1, first.out.join('\n'))
    assert.ok(first.out.includes('R6 fail DIFFERENCES'), first.out.join('\n'))
    assert.ok(first.out.includes('R10 fail DIFFERENCES'), first.out.join('\n'))

    // 2. Stock appears in the snapshot (value 120.75), the post-load write goes: R6 passes; R10 passes on its two ledger legs and an empty postings leg.
    await sql(`DELETE FROM accounting_sync_logs WHERE id = $1`, [`${LTAG}-post`])
    await sql(`DELETE FROM inventory_snapshot_runs WHERE id = $1`, [`${LTAG}-run`])
    await sql(`INSERT INTO products (id, sku, name, "updatedAt") VALUES ($1, $2, 'x', now())`, [`${LTAG}-p`, `${LTAG}-SKU`])
    await sql(`INSERT INTO warehouses (id, code, name, "updatedAt") VALUES ($1, $2, 'x', now())`, [`${LTAG}-w`, `${LTAG}W`])
    await sql(`INSERT INTO inventory_snapshot_runs (id, "snapshotDate", "stockLevelCount", "snapshotCount", "updatedAt") VALUES ($1, $2, 1, 1, now())`, [`${LTAG}-run`, LD])
    await sql(`INSERT INTO inventory_snapshots (id, "snapshotDate", "productId", "warehouseId", qty, "valueBase", "unitCostBase") VALUES ($1, $2, $3, $4, 1, 120.75, 120.75)`, [`${LTAG}-snap`, LD, `${LTAG}-p`, `${LTAG}-w`])
    const second = await run()
    assert.equal(second.code, 5, second.out.join('\n'))
    assert.ok(second.out.includes('R6 pass -'), second.out.join('\n'))
    assert.ok(second.out.includes('R10 pass -'), second.out.join('\n'))
  } finally {
    await sql(`DELETE FROM inventory_snapshots WHERE id LIKE '${LTAG}%'`)
    await sql(`DELETE FROM inventory_snapshot_runs WHERE id LIKE '${LTAG}%'`)
    await sql(`DELETE FROM products WHERE id LIKE '${LTAG}%'`)
    await sql(`DELETE FROM warehouses WHERE id LIKE '${LTAG}%'`)
    await sql(`DELETE FROM accounting_sync_logs WHERE id LIKE '${LTAG}%'`)
    await sql(`DELETE FROM first_load_apply_runs WHERE id LIKE '${LTAG}%'`)
    await sql(`DELETE FROM transit_subledger_movements WHERE id LIKE '${LTAG}%'`)
    await sql(`DELETE FROM accounting_account_balance_snapshots WHERE id LIKE '${LTAG}%'`)
    await sql(`DELETE FROM accounting_accounts WHERE id LIKE '${LTAG}%'`)
    await sql(`DELETE FROM accounting_tokens WHERE id LIKE '${LTAG}%'`)
    await restoreForeignEstate(estate)
    for (const key of [...SETTINGS, keys.xero]) {
      const prior = saved.find((row) => row.key === key)
      if (prior) await setting(key, prior.value)
      else await sql(`DELETE FROM settings WHERE key = $1`, [key])
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- R9 and R13 end to end: the real IMS reads, the real credentials read, the real GET-only transport, a LOOPBACK store -------

const VTAG = `RCVN${process.pid}`
const VENDOR_SETTINGS = ['wc_url', 'wc_consumer_key', 'wc_consumer_secret', 'wc_initial_import_completed', 'wc_sync_order_statuses']

test('[reconciliation pack] R9 and R13 with --vendor-reads-only: stored credentials, GET requests to the loopback store only, the IMS side compared, and not one row written', { skip: !RUN }, async () => {
  const http = await import('node:http')
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const { healthyLiveness } = await import('../reconciliation-pack/basis-fixtures.ts')
  const { goodReport, withStamp } = await import('../reconciliation-pack/liveness-fixtures.ts')
  const { reduceStatusReport } = await import('../../lib/reconciliation-pack/liveness.ts')
  let sweepStamp: string | null = null
  const { encryptSettingValue } = await import('../../lib/security/encrypted-settings.ts')
  const seen: Array<{ method: string; url: string; authorization: string | undefined }> = []
  const row = (id: number) => ({ id, status: 'processing', currency: 'GBP', total: '12.50', date_created_gmt: '2026-10-10T09:30:00', billing: { email: 'customer@example.com' } })
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization })
    const url = new URL(req.url ?? '/', 'http://x')
    const first = url.searchParams.get('page') === '1'
    const json = (body: unknown, total: number) => { res.writeHead(200, { 'content-type': 'application/json', 'x-wp-total': String(total), 'x-wp-totalpages': String(total ? 1 : 0) }); res.end(JSON.stringify(body)) }
    // The store honours `_fields` (only the listed top-level fields of a row are sent), as WordPress does; the transport refuses a store that does not.
    const wanted = (url.searchParams.get('_fields') ?? '').split(',')
    const only = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([name]) => wanted.includes(name)))
    if (url.pathname === '/wp-json/wc/v3/orders') return url.searchParams.get('status') === 'processing' ? json(first ? [row(9001), row(9002)].map(only) : [], 2) : json([], 0)
    if (url.pathname === '/wp-json/wc/v3/taxes') return json(first ? [only({ id: 7001, name: 'x', rate: '20.0000', country: '', state: '', postcode: '', city: '', class: '', shipping: true, compound: false })] : [], 1)
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const storePort = (server.address() as import('node:net').AddressInfo).port
  const dir = mkdtempSync('/var/tmp/recon-pack-nw-')
  chmodSync(dir, 0o700)
  const saved = await withClient(async (client) => (await client.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [VENDOR_SETTINGS])).rows as Array<{ key: string; value: string }>)
  const sql = (text: string, values: unknown[] = []) => withClient((client) => client.query(text, values))
  const setting = (key: string, value: string) => sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"`, [key, value, '2026-09-01 00:00:00'])
  const targets: string[] = []
  const original = net.Socket.prototype.connect
  const previousMode = process.env.E2E_TEST_MODE
  // The test brings its own settings key (a fresh random one), so it does not depend on the environment providing one; it is never logged.
  const { randomBytes } = await import('node:crypto')
  const previousKeys = { SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  try {
    process.env.E2E_TEST_MODE = '1'
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    delete process.env.ENCRYPTION_KEY
    await sql(`DELETE FROM settings WHERE key = ANY($1)`, [VENDOR_SETTINGS])
    await setting('wc_url', `http://127.0.0.1:${storePort}`)
    await setting('wc_consumer_key', encryptSettingValue('wc_consumer_key', `ck_${VTAG}`))
    await setting('wc_consumer_secret', encryptSettingValue('wc_consumer_secret', `cs_${VTAG}`))
    await setting('wc_initial_import_completed', 'true')
    for (const [n, status, wooId] of [[1, 'PROCESSING', '9001'], [2, 'PICKING', '9002']] as const) {
      await sql(`INSERT INTO sales_orders (id, status, currency, "subtotalForeign", "totalForeign", "subtotalBase", "totalBase", "externalCreatedAt", "updatedAt") VALUES ($1, $2::"SalesOrderStatus", 'GBP', 10, 12.50, 10, 12.50, '2026-10-10 09:30:00', now())`, [`${VTAG}-o${n}`, status])
      await sql(`INSERT INTO shopping_order_links (id, "orderId", connector, "externalOrderId", "updatedAt") VALUES ($1, $2, 'woocommerce', $3, now())`, [`${VTAG}-l${n}`, `${VTAG}-o${n}`, wooId])
    }
    await sql(`INSERT INTO tax_rates (id, name, rate, "updatedAt") VALUES ($1, 'x', 0.2, now())`, [`${VTAG}-t`])
    await sql(`INSERT INTO shopping_tax_rate_mappings (id, connector, "externalTaxRateId", "externalName", "externalRatePct", "taxRateId", "updatedAt") VALUES ($1, 'woocommerce', '7001', 'x', 20, $2, now())`, [`${VTAG}-m`, `${VTAG}-t`])

    const run = async (extra: string[]) => {
      const out: string[] = []
      const before = await census()
      seen.length = 0
      targets.length = 0
      net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
        const raw = args[0] as unknown
        const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string
        targets.push(typeof first === 'object' && first !== null ? (first.path ? `unix:${first.path}` : `${first.host ?? 'localhost'}:${first.port}`) : `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`)
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      } as typeof original
      const code = await runPackCli({ argv: ['--phase', 'P1', '--as-of', LD, '--items', 'R9,R13', '--report-dir', dir, ...extra], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(), deps: { liveness: sweepStamp === null ? healthyLiveness() : { read: async () => reduceStatusReport(withStamp(goodReport(), 'woocommerce-order-sweep', sweepStamp!)) } }, stdout: (t) => out.push(t), stderr: (t) => out.push(t) })
      net.Socket.prototype.connect = original
      const after = await census()
      assert.deepEqual(after.counts, before.counts, 'every table has the rows it had')
      assert.deepEqual(after.stats, before.stats, 'no table saw an insert, update or delete')
      return { code, out, targets: [...targets] }
    }

    // Without the flag: no request to the store, no connection to anything but the database.
    const off = await run([])
    assert.equal(off.code, 5, off.out.join('\n'))
    assert.ok(off.out.includes('R9 inconclusive VENDOR_READS_OFF') && off.out.includes('R13 inconclusive VENDOR_READS_OFF'), off.out.join('\n'))
    assert.equal(seen.length, 0)
    assert.ok(off.targets.every((target) => !target.endsWith(`:${storePort}`)), off.targets.join(','))

    // With it: GET only, to the store, with the stored (and decrypted) credentials; the IMS side equals the store.
    const on = await run(['--vendor-reads-only'])
    assert.equal(on.code, 5, on.out.join('\n'))
    assert.ok(on.out.includes('R9 pass -'), on.out.join('\n'))
    assert.ok(on.out.includes('R13 inconclusive VENDOR_LIST_UNPROVEN'), on.out.join('\n'))
    assert.equal(seen.length, 6, "processing (the importer's default), the withdrawal-submitted status and the tax rates: one page each, read twice")
    assert.deepEqual([...new Set(seen.map((s) => s.method))], ['GET'])
    assert.ok(seen.every((s) => s.authorization === `Basic ${Buffer.from(`ck_${VTAG}:cs_${VTAG}`).toString('base64')}`))
    const url = new URL(process.env.DATABASE_URL!)
    for (const target of on.targets) assert.ok(target === `${url.hostname}:${url.port}` || target === `127.0.0.1:${url.port}` || target === `localhost:${url.port}` || target === `127.0.0.1:${storePort}`, `unexpected connection to ${target}`)
    assert.ok(on.targets.some((target) => target === `127.0.0.1:${storePort}`), 'precondition: the store was contacted')
    assert.ok(!on.out.join('\n').includes(`cs_${VTAG}`) && !on.out.join('\n').includes('customer@example.com'))

    // R13's Xero leg from the STORED list: a connected organisation and a proven list of its tax rates turn the item into a PASS, with no
    // request to Xero (the only connections are the database and the loopback store) and not one row written.
    const { digestTaxRateList } = await import('../../lib/connectors/xero/tax-rate-list.ts')
    const xeroRows = [
      { taxType: 'OUTPUT2', name: 'x', status: 'ACTIVE' as const, reportTaxType: 'OUTPUT', effectiveRate: '20.000000', displayTaxRate: '20.000000', components: [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: false }], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true } },
      { taxType: 'OLD1', name: 'Retired', status: 'ARCHIVED' as const, reportTaxType: null, effectiveRate: null, displayTaxRate: null, components: [], canApply: { assets: null, equity: null, expenses: null, liabilities: null, revenue: null } },
    ]
    const tenant = `${VTAG}-tenant`
    let estate: Held = NOTHING_HELD
    try {
      estate = await holdForeignEstate()
      await sql(`UPDATE tax_rates SET accounting_tax_type = 'OUTPUT2' WHERE id = $1`, [`${VTAG}-t`])
      await sql(`INSERT INTO accounting_tokens (id, connector, "accessToken", "expiresAt", "tenantId", "updatedAt") VALUES ($1, 'xero', 'not-a-token', now(), $2, now())`, [`${VTAG}-tok`, tenant])
      for (const row of xeroRows) {
        await sql(`INSERT INTO xero_tax_rates (id, connector, "tenantId", "taxType", name, status, "reportTaxType", "effectiveRate", "displayTaxRate", components, "canApplyToAssets", "canApplyToEquity", "canApplyToExpenses", "canApplyToLiabilities", "canApplyToRevenue", "fetchedAt") VALUES ($1, 'xero', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, '2026-10-23 08:00:00')`,
          [`${VTAG}-x-${row.taxType}`, tenant, row.taxType, row.name, row.status, row.reportTaxType, row.effectiveRate, row.displayTaxRate, JSON.stringify(row.components), row.canApply.assets, row.canApply.equity, row.canApply.expenses, row.canApply.liabilities, row.canApply.revenue])
      }
      await sql(`INSERT INTO xero_tax_rate_lists (id, connector, "tenantId", "fetchedAt", "rowCount", digest) VALUES ($1, 'xero', $2, '2026-10-23 08:00:00', 2, $3)`, [`${VTAG}-xl`, tenant, digestTaxRateList(tenant, xeroRows)])
      const proven = await run(['--vendor-reads-only'])
      assert.ok(proven.out.includes('R13 pass -'), proven.out.join('\n'))
      for (const target of proven.targets) assert.ok(target === `${url.hostname}:${url.port}` || target === `127.0.0.1:${url.port}` || target === `localhost:${url.port}` || target === `127.0.0.1:${storePort}`, `unexpected connection to ${target} (no request to Xero)`)
      // An ACTIVE Xero type that no IMS rate, component or reverse-charge setting names is out of the population, not a finding.
      await sql(`UPDATE xero_tax_rates SET status = 'ACTIVE' WHERE id = $1`, [`${VTAG}-x-OLD1`])
      await sql(`UPDATE xero_tax_rate_lists SET digest = $2 WHERE id = $1`, [`${VTAG}-xl`, digestTaxRateList(tenant, [xeroRows[0]!, { ...xeroRows[1]!, status: 'ACTIVE' as const }])])
      const unreferenced = await run(['--vendor-reads-only'])
      assert.ok(unreferenced.out.includes('R13 pass -'), unreferenced.out.join('\n'))
      // SET IDENTITY: the rate IMS charges at differing from the store's and Xero's (exact decimals) is a finding, and restoring it is a pass again.
      await sql(`UPDATE tax_rates SET rate = 0.21 WHERE id = $1`, [`${VTAG}-t`])
      const percent = await run(['--vendor-reads-only'])
      assert.ok(percent.out.includes('R13 fail DIFFERENCES'), percent.out.join('\n'))
      await sql(`UPDATE tax_rates SET rate = 0.2 WHERE id = $1`, [`${VTAG}-t`])
      // ...and an ACTIVE custom Xero sales type that no IMS rate carries is a finding (XERO_NOT_IN_IMS), where an unreferenced type that cannot be applied to revenue is not.
      await sql(`UPDATE xero_tax_rates SET "canApplyToRevenue" = true WHERE id = $1`, [`${VTAG}-x-OLD1`])
      await sql(`UPDATE xero_tax_rate_lists SET digest = $2 WHERE id = $1`, [`${VTAG}-xl`, digestTaxRateList(tenant, [xeroRows[0]!, { ...xeroRows[1]!, status: 'ACTIVE' as const, canApply: { ...xeroRows[1]!.canApply, revenue: true } }])])
      const orphan = await run(['--vendor-reads-only'])
      assert.ok(orphan.out.includes('R13 fail DIFFERENCES'), orphan.out.join('\n'))
      await sql(`UPDATE xero_tax_rates SET "canApplyToRevenue" = NULL WHERE id = $1`, [`${VTAG}-x-OLD1`])
      await sql(`UPDATE xero_tax_rate_lists SET digest = $2 WHERE id = $1`, [`${VTAG}-xl`, digestTaxRateList(tenant, [xeroRows[0]!, { ...xeroRows[1]!, status: 'ACTIVE' as const }])])
      // A type IMS names that the stored list does not hold as ACTIVE is a finding (R13 fails, by type code).
      await sql(`UPDATE tax_rates SET accounting_tax_type = 'MISSING9' WHERE id = $1`, [`${VTAG}-t`])
      const unmapped = await run(['--vendor-reads-only'])
      assert.ok(unmapped.out.includes('R13 fail DIFFERENCES'), unmapped.out.join('\n'))
      await sql(`UPDATE tax_rates SET accounting_tax_type = 'OUTPUT2' WHERE id = $1`, [`${VTAG}-t`])
      // A reverse-charge setting naming a type the list lacks is a finding too.
      await sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ('accounting_reverse_charge_sales_tax_type', 'NOSUCHTYPE', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
      const reverse = await run(['--vendor-reads-only'])
      assert.ok(reverse.out.includes('R13 fail DIFFERENCES'), reverse.out.join('\n'))
      await sql(`DELETE FROM settings WHERE key = 'accounting_reverse_charge_sales_tax_type'`)
      // A stored row edited behind the header's back is not a proof: the item is inconclusive, never a pass.
      await sql(`UPDATE xero_tax_rates SET name = 'edited' WHERE id = $1`, [`${VTAG}-x-OUTPUT2`])
      const tampered = await run(['--vendor-reads-only'])
      assert.ok(tampered.out.includes('R13 inconclusive VENDOR_LIST_UNPROVEN'), tampered.out.join('\n'))
    } finally {
      await sql(`DELETE FROM xero_tax_rate_lists WHERE id LIKE '${VTAG}%'`)
      await sql(`DELETE FROM xero_tax_rates WHERE id LIKE '${VTAG}%'`)
      await sql(`DELETE FROM accounting_tokens WHERE id LIKE '${VTAG}%'`)
      await restoreForeignEstate(estate)
      await sql(`DELETE FROM settings WHERE key = 'accounting_reverse_charge_sales_tax_type'`)
    }

    // An order the store has and IMS lacks is a finding (the identity swap, with equal counts): R9 fails by id.
    await sql(`DELETE FROM shopping_order_links WHERE id = $1`, [`${VTAG}-l2`])
    await sql(`INSERT INTO shopping_order_links (id, "orderId", connector, "externalOrderId", "updatedAt") VALUES ($1, $2, 'woocommerce', '9003', now())`, [`${VTAG}-l2`, `${VTAG}-o2`])
    const swapped = await run(['--vendor-reads-only'])
    // D7: a difference first seen is UNSETTLED (the previous report is a usable pass, so nothing says the state was unusable) ...
    assert.equal(swapped.code, 5, swapped.out.join('\n'))
    assert.ok(swapped.out.includes('R9 inconclusive UNSETTLED_PENDING'), swapped.out.join('\n'))
    // ... still unsettled after one further run of the order sweep, and a failure after two (nothing is written by any of them).
    sweepStamp = '2026-10-20T01:30:00.000Z'
    const again = await run(['--vendor-reads-only'])
    assert.ok(again.out.includes('R9 inconclusive UNSETTLED_PENDING'), again.out.join('\n'))
    sweepStamp = '2026-10-20T02:30:00.000Z'
    const settled = await run(['--vendor-reads-only'])
    assert.equal(settled.code, 1, settled.out.join('\n'))
    assert.ok(settled.out.includes('R9 fail DIFFERENCES'), settled.out.join('\n'))
  } finally {
    net.Socket.prototype.connect = original
    if (previousMode === undefined) delete process.env.E2E_TEST_MODE; else process.env.E2E_TEST_MODE = previousMode
    for (const [name, value] of Object.entries(previousKeys)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    await sql(`DELETE FROM shopping_tax_rate_mappings WHERE id LIKE '${VTAG}%'`)
    await sql(`DELETE FROM tax_rates WHERE id LIKE '${VTAG}%'`)
    await sql(`DELETE FROM shopping_order_links WHERE id LIKE '${VTAG}%'`)
    await sql(`DELETE FROM sales_orders WHERE id LIKE '${VTAG}%'`)
    await sql(`DELETE FROM settings WHERE key = ANY($1)`, [VENDOR_SETTINGS])
    for (const prior of saved) await setting(prior.key, prior.value)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- R12 end to end: the real IMS reads, the real stored Xero connection, the real GET-only transports, LOOPBACK Xero and store ------

const XTAG = `RCVT${process.pid}`
const XTENANT = 'b2c3d4e5-0000-4000-8000-000000000012'
const X_SETTINGS = ['wc_url', 'wc_consumer_key', 'wc_consumer_secret', 'wc_initial_import_completed', 'wc_sync_order_statuses', 'xero_expected_tenant_id', 'xero_shipping_account', 'xero_sales_account', 'xero_discount_account']

test('[reconciliation pack] R12 with --vendor-reads-only: the stored (never refreshed) Xero token, GET requests to loopback Xero and store only, three systems compared, and not one row written', { skip: !RUN }, async () => {
  const http = await import('node:http')
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const { healthyLiveness } = await import('../reconciliation-pack/basis-fixtures.ts')
  const { encryptSettingValue } = await import('../../lib/security/encrypted-settings.ts')
  const { createXeroGetPort } = await import('../../lib/reconciliation-pack/xero-transport.ts')
  const { readXeroAccess, readXeroBinding } = await import('../../lib/reconciliation-pack/xero-credentials.ts')
  const { digestTaxRateList } = await import('../../lib/connectors/xero/tax-rate-list.ts')
  const { randomBytes } = await import('node:crypto')
  const TOKEN = `xero_tok_${XTAG}`
  const xeroSeen: Array<{ method: string; url: string; authorization: string | undefined; tenant: string | undefined }> = []
  const wooSeen: Array<{ method: string; url: string }> = []
  let xeroTax = [60, 40]
  const invoice = (n: number, date: string, tax: number) => ({ InvoiceID: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, Type: 'ACCREC', Status: 'AUTHORISED', DateString: `${date}T00:00:00`, CurrencyCode: 'GBP', CurrencyRate: 1, LineAmountTypes: 'Exclusive', TotalTax: tax, SubTotal: 100, Total: Math.round((100 + tax) * 100) / 100, LineItems: [{ TaxType: 'OUTPUT2', TaxAmount: tax, LineAmount: 100, AccountCode: '200' }] })
  const send = (res: import('node:http').ServerResponse, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
  const xeroServer = http.createServer((req, res) => {
    xeroSeen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, tenant: req.headers['xero-tenant-id'] as string | undefined })
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/api.xro/2.0/Organisation') return send(res, { Organisations: [{ BaseCurrency: 'GBP' }] })
    if (url.pathname === '/api.xro/2.0/Invoices') {
      const rows = url.searchParams.get('page') === '1' ? [invoice(1, '2026-09-05', xeroTax[0]!), invoice(2, '2026-09-20', xeroTax[1]!)] : []
      return send(res, { Invoices: rows, pagination: { page: Number(url.searchParams.get('page')), pageSize: 100, pageCount: 1, itemCount: 2 } })
    }
    res.writeHead(404); res.end('{}')
  })
  const order = (id: number, created: string, tax: string) => ({ id, status: 'processing', currency: 'GBP', date_created_gmt: created, fee_lines: [], total_tax: (Number(tax) + 1).toFixed(2), tax_lines: [{ id: 1, rate_id: 7001, tax_total: tax, shipping_tax_total: '1.00' }] })
  const wooServer = http.createServer((req, res) => {
    wooSeen.push({ method: req.method ?? '', url: req.url ?? '' })
    const url = new URL(req.url ?? '/', 'http://x')
    const first = url.searchParams.get('page') === '1'
    const json = (body: unknown, total: number) => send(res, body, { 'x-wp-total': String(total), 'x-wp-totalpages': String(total ? 1 : 0) })
    if (url.pathname === '/wp-json/wc/v3/orders') return url.searchParams.get('status') === 'processing' ? json(first ? [order(9101, '2026-09-10T09:30:00', '60.00'), order(9102, '2026-09-21T10:00:00', '40.00')] : [], 2) : json([], 0)
    res.writeHead(404); res.end('{}')
  })
  await Promise.all([xeroServer, wooServer].map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))))
  const xeroPort = (xeroServer.address() as import('node:net').AddressInfo).port
  const wooPort = (wooServer.address() as import('node:net').AddressInfo).port
  const dir = mkdtempSync('/var/tmp/recon-pack-nw-')
  chmodSync(dir, 0o700)
  const saved = await withClient(async (client) => (await client.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [X_SETTINGS])).rows as Array<{ key: string; value: string }>)
  let estate: Held = NOTHING_HELD
  const sql = (text: string, values: unknown[] = []) => withClient((client) => client.query(text, values))
  const setting = (key: string, value: string, at = '2026-01-01 00:00:00') => sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"`, [key, value, at])
  const targets: string[] = []
  const original = net.Socket.prototype.connect
  const previous = { E2E_TEST_MODE: process.env.E2E_TEST_MODE, SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, XERO_ALLOWED_TENANT_IDS: process.env.XERO_ALLOWED_TENANT_IDS }
  const xeroRows = [{ taxType: 'OUTPUT2', name: 'Standard', status: 'ACTIVE' as const, reportTaxType: 'OUTPUT', effectiveRate: '20.000000', displayTaxRate: '20.000000', components: [{ name: 'VAT', rate: '20.000000', compound: false, nonRecoverable: false }], canApply: { assets: null, equity: null, expenses: null, liabilities: null, revenue: true } }]
  try {
    process.env.E2E_TEST_MODE = '1'
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    delete process.env.ENCRYPTION_KEY
    process.env.XERO_ALLOWED_TENANT_IDS = XTENANT
    await sql(`DELETE FROM settings WHERE key = ANY($1)`, [X_SETTINGS])
    await setting('wc_url', `http://127.0.0.1:${wooPort}`)
    await setting('wc_consumer_key', encryptSettingValue('wc_consumer_key', `ck_${XTAG}`))
    await setting('wc_consumer_secret', encryptSettingValue('wc_consumer_secret', `cs_${XTAG}`))
    await setting('wc_initial_import_completed', 'true')
    await setting('xero_expected_tenant_id', XTENANT)
    await setting('xero_shipping_account', '260')
    await setting('xero_sales_account', '200')
    await sql(`INSERT INTO accounting_accounts (id, connector, "externalAccountId", code, name, type, active) VALUES ($1, 'xero', $2, '260', 'Shipping', 'REVENUE', true)`, [`${XTAG}-acc`, `${XTAG}-acc-ext`])
    estate = await holdForeignEstate()
    await sql(`INSERT INTO accounting_tokens (id, connector, "accessToken", "expiresAt", "tenantId", "connectionGeneration", "updatedAt") VALUES ($1, 'xero', $2, '2031-01-01', $3, 'gen-e2e', now())`, [`${XTAG}-tok`, TOKEN, XTENANT])
    await sql(`INSERT INTO first_load_apply_runs (id, singleton, version, manifest_digest, run_id, status, steps, facts, created_at, updated_at) VALUES ($1, true, 1, 'd', 'r', 'VERIFIED', '{}', '{}', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`, [`${XTAG}-fl`])
    await sql(`INSERT INTO tax_rates (id, name, rate, accounting_tax_type, "countryCode", reporting_category, "updatedAt") VALUES ($1, 'UK Standard', 0.2, 'OUTPUT2', 'GB', 'DOMESTIC', now())`, [`${XTAG}-t`])
    await sql(`INSERT INTO shopping_tax_rate_mappings (id, connector, "externalTaxRateId", "externalName", "externalRatePct", "taxRateId", "updatedAt") VALUES ($1, 'woocommerce', '7001', 'x', 20, $2, now())`, [`${XTAG}-m`, `${XTAG}-t`])
    for (const [n, invoiced, tax] of [[1, '2026-09-05 10:00:00', '60'], [2, '2026-09-20 10:00:00', '40'], [3, '2026-10-02 10:00:00', '777']] as const) {
      await sql(`INSERT INTO sales_orders (id, status, currency, "subtotalForeign", "totalForeign", "subtotalBase", "totalBase", "invoicedAt", "updatedAt") VALUES ($1, 'PROCESSING'::"SalesOrderStatus", 'GBP', 100, 120, 100, 120, $2, now())`, [`${XTAG}-o${n}`, invoiced])
      await sql(`INSERT INTO sales_order_lines (id, "orderId", description, qty, "unitPriceForeign", "unitPriceBase", "taxRateId", "taxBase", "totalForeign", "totalBase") VALUES ($1, $2, 'x', 1, 100, 100, $3, $4, 120, 120)`, [`${XTAG}-l${n}`, `${XTAG}-o${n}`, `${XTAG}-t`, tax])
    }
    await sql(`INSERT INTO sales_orders (id, status, currency, "subtotalForeign", "totalForeign", "subtotalBase", "totalBase", "invoicedAt", archived, "updatedAt") VALUES ($1, 'CANCELLED'::"SalesOrderStatus", 'GBP', 100, 120, 100, 120, '2026-09-06 10:00:00', false, now())`, [`${XTAG}-o4`])
    await sql(`INSERT INTO sales_order_lines (id, "orderId", description, qty, "unitPriceForeign", "unitPriceBase", "taxRateId", "taxBase", "totalForeign", "totalBase") VALUES ($1, $2, 'x', 1, 100, 100, $3, 555, 120, 120)`, [`${XTAG}-l4`, `${XTAG}-o4`, `${XTAG}-t`])
    for (const row of xeroRows) {
      await sql(`INSERT INTO xero_tax_rates (id, connector, "tenantId", "taxType", name, status, "reportTaxType", "effectiveRate", "displayTaxRate", components, "canApplyToAssets", "canApplyToEquity", "canApplyToExpenses", "canApplyToLiabilities", "canApplyToRevenue", "fetchedAt") VALUES ($1, 'xero', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, '2026-10-23 08:00:00')`,
        [`${XTAG}-x-${row.taxType}`, XTENANT, row.taxType, row.name, row.status, row.reportTaxType, row.effectiveRate, row.displayTaxRate, JSON.stringify(row.components), row.canApply.assets, row.canApply.equity, row.canApply.expenses, row.canApply.liabilities, row.canApply.revenue])
    }
    await sql(`INSERT INTO xero_tax_rate_lists (id, connector, "tenantId", "fetchedAt", "rowCount", digest) VALUES ($1, 'xero', $2, '2026-10-23 08:00:00', 1, $3)`, [`${XTAG}-xl`, XTENANT, digestTaxRateList(XTENANT, xeroRows)])

    const run = async (extra: string[]) => {
      const out: string[] = []
      const before = await census()
      xeroSeen.length = 0; wooSeen.length = 0; targets.length = 0
      net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
        const raw = args[0] as unknown
        const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string
        targets.push(typeof first === 'object' && first !== null ? (first.path ? `unix:${first.path}` : `${first.host ?? 'localhost'}:${first.port}`) : `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`)
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      } as typeof original
      // The Xero loopback double: the same transport and the same stored-connection reader the command uses, aimed at the double. The
      // grant in the seam's environment is what lets the fetch seam's outbound hold reach a non-Xero host; the command itself never sets it.
      const xero = {
        port: createXeroGetPort({ readAccess: () => withClient((client) => readXeroAccess(client as never, { now: new Date() })), baseUrl: `http://127.0.0.1:${xeroPort}/api.xro/2.0`, env: { E2E_TEST_MODE: '1', NODE_ENV: 'test', XERO_WRITE_ALLOWED_TENANT: XTENANT } }),
        binding: () => withClient((client) => readXeroBinding(client as never)),
      }
      const code = await runPackCli({ argv: ['--phase', 'P1', '--as-of', '2026-10-19', '--items', 'R12', '--report-dir', dir, ...extra], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(), deps: { liveness: healthyLiveness(), xero }, stdout: (t) => out.push(t), stderr: (t) => out.push(t) })
      net.Socket.prototype.connect = original
      const after = await census()
      assert.deepEqual(after.counts, before.counts, 'every table has the rows it had')
      assert.deepEqual(after.stats, before.stats, 'no table saw an insert, update or delete')
      return { code, out, targets: [...targets] }
    }
    const url = new URL(process.env.DATABASE_URL!)
    const allowed = (target: string) => target === `${url.hostname}:${url.port}` || target === `127.0.0.1:${url.port}` || target === `localhost:${url.port}` || target === `127.0.0.1:${wooPort}` || target === `127.0.0.1:${xeroPort}`

    // Without the flag: no request to either double, no connection to anything but the database.
    const off = await run([])
    assert.ok(off.out.includes('R12 inconclusive VENDOR_READS_OFF'), off.out.join('\n'))
    assert.deepEqual([xeroSeen.length, wooSeen.length], [0, 0])
    assert.ok(off.targets.every((target) => !target.endsWith(`:${xeroPort}`) && !target.endsWith(`:${wooPort}`)), off.targets.join(','))

    // With it: the three systems agree (IMS 100.00 in September from two orders; the cancelled order and the October order are not in it).
    const on = await run(['--vendor-reads-only'])
    assert.ok(on.out.includes('R12 pass -'), on.out.join('\n'))
    assert.deepEqual([...new Set(xeroSeen.map((s) => s.method)), ...new Set(wooSeen.map((s) => s.method))], ['GET', 'GET'])
    assert.equal(xeroSeen.length, 3, 'the organisation, then one page of invoices read twice')
    assert.ok(xeroSeen.every((s) => s.authorization === `Bearer ${TOKEN}` && s.tenant === XTENANT && !s.url.includes(TOKEN)))
    for (const target of on.targets) assert.ok(allowed(target), `unexpected connection to ${target}`)
    assert.ok(on.targets.some((target) => target === `127.0.0.1:${xeroPort}`) && on.targets.some((target) => target === `127.0.0.1:${wooPort}`), 'precondition: both doubles were contacted')
    assert.ok(!on.out.join('\n').includes(TOKEN) && !on.out.join('\n').includes(`cs_${XTAG}`))

    // A VAT difference beyond GBP 0.05 in Xero is a finding: the run fails (exit 1) and names the item.
    xeroTax = [60.06, 40]
    const differ = await run(['--vendor-reads-only'])
    assert.equal(differ.code, 1, differ.out.join('\n'))
    assert.ok(differ.out.includes('R12 fail DIFFERENCES'), differ.out.join('\n'))
    xeroTax = [60.05, 40]
    assert.ok((await run(['--vendor-reads-only'])).out.includes('R12 pass -'), 'exactly GBP 0.05 agrees')
    xeroTax = [60, 40]

    // U8: a non-domestic rate carrying VAT is VAT_MAPPING_UNVERIFIED, decided from IMS alone: no request to either double.
    await sql(`UPDATE tax_rates SET reporting_category = 'OSS' WHERE id = $1`, [`${XTAG}-t`])
    const oss = await run(['--vendor-reads-only'])
    assert.ok(oss.out.includes('R12 inconclusive VAT_MAPPING_UNVERIFIED'), oss.out.join('\n'))
    assert.deepEqual([xeroSeen.length, wooSeen.length], [0, 0])
    await sql(`UPDATE tax_rates SET reporting_category = 'DOMESTIC' WHERE id = $1`, [`${XTAG}-t`])

    // Shipping must be separable: with the shipping account gone from the chart, nothing is requested and the item is unverified.
    await sql(`UPDATE accounting_accounts SET active = false WHERE id = $1`, [`${XTAG}-acc`])
    const noChart = await run(['--vendor-reads-only'])
    assert.ok(noChart.out.includes('R12 inconclusive VAT_MAPPING_UNVERIFIED'), noChart.out.join('\n'))
    assert.deepEqual([xeroSeen.length, wooSeen.length], [0, 0])
    await sql(`UPDATE accounting_accounts SET active = true WHERE id = $1`, [`${XTAG}-acc`])

    // A token the read-sync has not renewed is never refreshed by the pack: no request to Xero, the token row untouched.
    await sql(`UPDATE accounting_tokens SET "expiresAt" = now() + interval '1 minute' WHERE id = $1`, [`${XTAG}-tok`])
    const before = (await sql(`SELECT "accessToken", "refreshToken", "expiresAt", "updatedAt" FROM accounting_tokens WHERE id = $1`, [`${XTAG}-tok`])).rows[0]
    const expired = await run(['--vendor-reads-only'])
    assert.ok(expired.out.includes('R12 inconclusive XERO_CONNECTION_UNUSABLE'), expired.out.join('\n'))
    assert.equal(xeroSeen.length, 0)
    assert.deepEqual((await sql(`SELECT "accessToken", "refreshToken", "expiresAt", "updatedAt" FROM accounting_tokens WHERE id = $1`, [`${XTAG}-tok`])).rows[0], before)
    await sql(`UPDATE accounting_tokens SET "expiresAt" = '2031-01-01' WHERE id = $1`, [`${XTAG}-tok`])
    assert.ok((await run(['--vendor-reads-only'])).out.includes('R12 pass -'))
  } finally {
    net.Socket.prototype.connect = original
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await Promise.all([xeroServer, wooServer].map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })))
    await sql(`DELETE FROM accounting_accounts WHERE id LIKE '${XTAG}%'`)
    await sql(`DELETE FROM xero_tax_rate_lists WHERE id LIKE '${XTAG}%'`)
    await sql(`DELETE FROM xero_tax_rates WHERE id LIKE '${XTAG}%'`)
    await sql(`DELETE FROM sales_order_lines WHERE id LIKE '${XTAG}%'`)
    await sql(`DELETE FROM sales_orders WHERE id LIKE '${XTAG}%'`)
    await sql(`DELETE FROM shopping_tax_rate_mappings WHERE id LIKE '${XTAG}%'`)
    await sql(`DELETE FROM tax_rates WHERE id LIKE '${XTAG}%'`)
    await sql(`DELETE FROM first_load_apply_runs WHERE id LIKE '${XTAG}%'`)
    await sql(`DELETE FROM accounting_tokens WHERE id LIKE '${XTAG}%'`)
    await restoreForeignEstate(estate)
    await sql(`DELETE FROM settings WHERE key = ANY($1)`, [X_SETTINGS])
    for (const prior of saved) await setting(prior.key, prior.value, '2026-09-01 00:00:00')
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- R16 end to end: the real IMS reads (fx_rates), the real stored Xero connection, the real GET-only transport, a LOOPBACK Xero ------

const RTAG = `RCXR${process.pid}`
const RTENANT = 'c3d4e5f6-0000-4000-8000-000000000016'

test('[reconciliation pack] R16 with --vendor-reads-only: the stored (never refreshed) Xero token, GET requests to the loopback Xero only, the fx_rates rate against Xero\'s CurrencyRate, and not one row written', { skip: !RUN }, async () => {
  const http = await import('node:http')
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const { healthyLiveness } = await import('../reconciliation-pack/basis-fixtures.ts')
  const { createXeroGetPort } = await import('../../lib/reconciliation-pack/xero-transport.ts')
  const { readXeroAccess, readXeroBinding } = await import('../../lib/reconciliation-pack/xero-credentials.ts')
  const { randomBytes } = await import('node:crypto')
  const TOKEN = `xero_tok_${RTAG}`
  const xeroSeen: Array<{ method: string; url: string; authorization: string | undefined; tenant: string | undefined }> = []
  // 1 GBP = 2 NZD from 2026-09-01, so Xero's CurrencyRate on a NZD document dated later in the closed months must be 0.5.
  let invoiceRate = 0.5
  let paymentRate = 0.5
  let breakCreditNotes = false
  const uuid = (n: number) => `00000000-0000-4000-8000-0000000016${String(n).padStart(2, '0')}`
  const send = (res: import('node:http').ServerResponse, body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const xeroServer = http.createServer((req, res) => {
    xeroSeen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, tenant: req.headers['xero-tenant-id'] as string | undefined })
    const url = new URL(req.url ?? '/', 'http://x')
    const page = Number(url.searchParams.get('page'))
    const list = (key: string, rows: unknown[]) => send(res, { [key]: page === 1 ? rows : [], pagination: { page, pageSize: 100, pageCount: rows.length === 0 ? 0 : 1, itemCount: rows.length } })
    if (url.pathname === '/api.xro/2.0/Organisation') return send(res, { Organisations: [{ BaseCurrency: 'GBP' }] })
    if (url.pathname === '/api.xro/2.0/Invoices') return list('Invoices', [
      { InvoiceID: uuid(1), Type: 'ACCREC', Status: 'AUTHORISED', DateString: '2026-09-05T00:00:00', CurrencyCode: 'NZD', CurrencyRate: invoiceRate },
      { InvoiceID: uuid(2), Type: 'ACCPAY', Status: 'PAID', DateString: '2026-09-20T00:00:00', CurrencyCode: 'GBP', CurrencyRate: 1 },
    ])
    if (url.pathname === '/api.xro/2.0/CreditNotes') {
      const rows = [{ CreditNoteID: uuid(3), Type: 'ACCRECCREDIT', Status: 'AUTHORISED', DateString: '2026-09-06T00:00:00', CurrencyCode: 'NZD', CurrencyRate: 0.5 }]
      // The broken list reports two items and sends one: a count that does not match the rows proves nothing.
      return send(res, { CreditNotes: page === 1 ? rows : [], pagination: { page, pageSize: 100, pageCount: 1, itemCount: breakCreditNotes ? 2 : 1 } })
    }
    if (url.pathname === '/api.xro/2.0/Payments') return list('Payments', [{ PaymentID: uuid(4), Status: 'AUTHORISED', DateString: '2026-09-07T00:00:00', CurrencyRate: paymentRate, Invoice: { InvoiceID: uuid(1), CurrencyCode: 'NZD' } }])
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>((resolve) => xeroServer.listen(0, '127.0.0.1', resolve))
  const xeroPort = (xeroServer.address() as import('node:net').AddressInfo).port
  const dir = mkdtempSync('/var/tmp/recon-pack-nw-')
  chmodSync(dir, 0o700)
  let estate: Held = NOTHING_HELD
  const sql = (text: string, values: unknown[] = []) => withClient((client) => client.query(text, values))
  const targets: string[] = []
  const original = net.Socket.prototype.connect
  const previous = { E2E_TEST_MODE: process.env.E2E_TEST_MODE, SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY, XERO_ALLOWED_TENANT_IDS: process.env.XERO_ALLOWED_TENANT_IDS }
  let insertedCurrency = false
  const savedSettings = await sql(`SELECT key, value FROM settings WHERE key = 'xero_expected_tenant_id'`).then((r) => r.rows as Array<{ key: string; value: string }>)
  const setting = (key: string, value: string, at = '2026-01-01 00:00:00') => sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"`, [key, value, at])
  try {
    process.env.E2E_TEST_MODE = '1'
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    delete process.env.ENCRYPTION_KEY
    process.env.XERO_ALLOWED_TENANT_IDS = RTENANT
    await setting('xero_expected_tenant_id', RTENANT)
    estate = await holdForeignEstate()
    await sql(`INSERT INTO accounting_tokens (id, connector, "accessToken", "expiresAt", "tenantId", "connectionGeneration", "updatedAt") VALUES ($1, 'xero', $2, '2031-01-01', $3, 'gen-e2e', now())`, [`${RTAG}-tok`, TOKEN, RTENANT])
    insertedCurrency = (await sql(`INSERT INTO currencies (code, name, symbol) VALUES ('NZD', 'New Zealand Dollar', '$') ON CONFLICT (code) DO NOTHING RETURNING code`)).rows.length === 1
    await sql(`INSERT INTO fx_rates (id, "fromCurrency", "toCurrency", rate, "fetchedAt", source, "manualOverride") VALUES ($1, 'GBP', 'NZD', 2, '2026-09-01 06:00:00', 'frankfurter', false)`, [`${RTAG}-fx`])

    const run = async (extra: string[]) => {
      const out: string[] = []
      const before = await census()
      xeroSeen.length = 0; targets.length = 0
      net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
        const raw = args[0] as unknown
        const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string
        targets.push(typeof first === 'object' && first !== null ? (first.path ? `unix:${first.path}` : `${first.host ?? 'localhost'}:${first.port}`) : `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`)
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      } as typeof original
      // The loopback double: the same transport and stored-connection reader the command uses, aimed at the double. The grant in the seam's
      // environment is what lets the fetch seam's outbound hold reach a non-Xero host; the command itself never sets it.
      const xero = {
        port: createXeroGetPort({ readAccess: () => withClient((client) => readXeroAccess(client as never, { now: new Date() })), baseUrl: `http://127.0.0.1:${xeroPort}/api.xro/2.0`, env: { E2E_TEST_MODE: '1', NODE_ENV: 'test', XERO_WRITE_ALLOWED_TENANT: RTENANT } }),
        binding: () => withClient((client) => readXeroBinding(client as never)),
      }
      const code = await runPackCli({ argv: ['--phase', 'P1', '--as-of', '2026-10-19', '--items', 'R16', '--report-dir', dir, ...extra], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(), deps: { liveness: healthyLiveness(), xero, xeroOptions: { sleep: async () => undefined } }, stdout: (t) => out.push(t), stderr: (t) => out.push(t) })
      net.Socket.prototype.connect = original
      const after = await census()
      assert.deepEqual(after.counts, before.counts, 'every table has the rows it had')
      assert.deepEqual(after.stats, before.stats, 'no table saw an insert, update or delete')
      return { code, out, targets: [...targets] }
    }
    const url = new URL(process.env.DATABASE_URL!)
    const allowed = (target: string) => target === `${url.hostname}:${url.port}` || target === `127.0.0.1:${url.port}` || target === `localhost:${url.port}` || target === `127.0.0.1:${xeroPort}`

    // Without the flag: no request to the double, no connection to anything but the database.
    const off = await run([])
    assert.ok(off.out.includes('R16 inconclusive VENDOR_READS_OFF'), off.out.join('\n'))
    assert.equal(xeroSeen.length, 0)
    assert.ok(off.targets.every((target) => !target.endsWith(`:${xeroPort}`)), off.targets.join(','))

    // With it: the invoice, the credit note and the payment agree with the table (the sterling bill is out of scope); GET only, to the three lists.
    const on = await run(['--vendor-reads-only'])
    assert.ok(on.out.includes('R16 pass -'), on.out.join('\n'))
    assert.deepEqual([...new Set(xeroSeen.map((s) => s.method))], ['GET'])
    assert.deepEqual(xeroSeen.map((s) => new URL(s.url, 'http://x').pathname.replace('/api.xro/2.0/', '')), ['Organisation', 'Invoices', 'Invoices', 'CreditNotes', 'CreditNotes', 'Payments', 'Payments'])
    assert.ok(xeroSeen.every((s) => s.authorization === `Bearer ${TOKEN}` && s.tenant === RTENANT && !s.url.includes(TOKEN)))
    for (const target of on.targets) assert.ok(allowed(target), `unexpected connection to ${target}`)
    assert.ok(on.targets.some((target) => target === `127.0.0.1:${xeroPort}`), 'precondition: the double was contacted')
    assert.ok(!on.out.join('\n').includes(TOKEN))

    // A rate that differs by one millionth is a finding: the run fails (exit 1) and names the reason.
    invoiceRate = 0.500001
    const differ = await run(['--vendor-reads-only'])
    assert.equal(differ.code, 1, differ.out.join('\n'))
    assert.ok(differ.out.includes('R16 fail DIFFERENCES,XERO_RATE_DIFFERS'), differ.out.join('\n'))
    invoiceRate = 0.5000004
    assert.ok((await run(['--vendor-reads-only'])).out.includes('R16 pass -'), 'within half a millionth agrees at six places')
    invoiceRate = 0.5
    paymentRate = 0.49
    assert.ok((await run(['--vendor-reads-only'])).out.includes('R16 fail DIFFERENCES,XERO_RATE_DIFFERS'), 'a payment is judged on its own rate')
    paymentRate = 0.5

    // A record IMS POSTED is held to the rate its posting carried (the real sync-log reader, in the pack's read-only snapshot): the log says IMS sent 1/1.9,
    // Xero holds 0.5, which agrees with the table but not with the posting. Removed again so the other cases are unchanged.
    await sql(`INSERT INTO accounting_sync_logs (id, connector, type, status, "referenceType", "referenceId", "externalTransactionId", payload) VALUES ($1, 'xero', 'SALES_INVOICE', 'SYNCED', 'SalesOrder', $2, $3, $4::jsonb)`, [`${RTAG}-log`, `${RTAG}-so`, uuid(1), JSON.stringify({ currency: 'NZD', date: '2026-09-05', currencyRateToBase: 1.9 })])
    try {
      const posted = await run(['--vendor-reads-only'])
      assert.ok(posted.out.includes('R16 fail DIFFERENCES,XERO_RATE_DIFFERS'), posted.out.join('\n'))
      await sql(`UPDATE accounting_sync_logs SET payload = NULL WHERE id = $1`, [`${RTAG}-log`])
      assert.ok((await run(['--vendor-reads-only'])).out.includes('R16 fail DIFFERENCES,IMS_POSTING_UNREADABLE'), 'a link whose payload is gone is a finding')
    } finally {
      await sql(`DELETE FROM accounting_sync_logs WHERE id = $1`, [`${RTAG}-log`])
    }

    // No IMS rate on or before the document date: IMS_RATE_MISSING, and the table is untouched by the run.
    await sql(`UPDATE fx_rates SET "fetchedAt" = '2026-09-06 06:00:00' WHERE id = $1`, [`${RTAG}-fx`])
    const missing = await run(['--vendor-reads-only'])
    assert.ok(missing.out.includes('R16 fail DIFFERENCES,IMS_RATE_MISSING'), missing.out.join('\n'))
    await sql(`UPDATE fx_rates SET "fetchedAt" = '2026-09-01 06:00:00' WHERE id = $1`, [`${RTAG}-fx`])

    // An unproven Xero list (the count it reports is not the rows it sent) is inconclusive, never a pass.
    breakCreditNotes = true
    const unstable = await run(['--vendor-reads-only'])
    assert.ok(unstable.out.includes('R16 inconclusive VENDOR_READ_UNSTABLE'), unstable.out.join('\n'))
    breakCreditNotes = false

    // A token the read-sync has not renewed is never refreshed by the pack: no request to Xero, the token row untouched.
    await sql(`UPDATE accounting_tokens SET "expiresAt" = now() + interval '1 minute' WHERE id = $1`, [`${RTAG}-tok`])
    const before = (await sql(`SELECT "accessToken", "refreshToken", "expiresAt", "updatedAt" FROM accounting_tokens WHERE id = $1`, [`${RTAG}-tok`])).rows[0]
    const expired = await run(['--vendor-reads-only'])
    assert.ok(expired.out.includes('R16 inconclusive XERO_CONNECTION_UNUSABLE'), expired.out.join('\n'))
    assert.equal(xeroSeen.length, 0)
    assert.deepEqual((await sql(`SELECT "accessToken", "refreshToken", "expiresAt", "updatedAt" FROM accounting_tokens WHERE id = $1`, [`${RTAG}-tok`])).rows[0], before)
    await sql(`UPDATE accounting_tokens SET "expiresAt" = '2031-01-01' WHERE id = $1`, [`${RTAG}-tok`])
    assert.ok((await run(['--vendor-reads-only'])).out.includes('R16 pass -'))
  } finally {
    net.Socket.prototype.connect = original
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await new Promise<void>((resolve) => { xeroServer.close(() => resolve()); xeroServer.closeAllConnections() })
    await sql(`DELETE FROM fx_rates WHERE id LIKE '${RTAG}%'`)
    if (insertedCurrency) await sql(`DELETE FROM currencies WHERE code = 'NZD'`)
    await sql(`DELETE FROM accounting_tokens WHERE id LIKE '${RTAG}%'`)
    await restoreForeignEstate(estate)
    await sql(`DELETE FROM settings WHERE key = 'xero_expected_tenant_id'`)
    for (const prior of savedSettings) await setting(prior.key, prior.value, '2026-09-01 00:00:00')
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- R1 end to end: the real IMS reads, the real stored-credential read, the real GET-only reader, a LOOPBACK Mintsoft ---------------

const MTAG = `RCMS${process.pid}`
const MINTSOFT_SETTINGS = ['mintsoft_auth_mode', 'mintsoft_static_api_key', 'mintsoft_client_id']

test('[reconciliation pack] R1 with --vendor-reads-only: the stored fixed key, GET requests to the loopback Mintsoft only (never /api/Auth), the IMS stock compared, a refused auth mode makes no request, and not one row is written', { skip: !RUN }, async () => {
  const http = await import('node:http')
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const { goodReport, withStamp } = await import('../reconciliation-pack/liveness-fixtures.ts')
  const { reduceStatusReport } = await import('../../lib/reconciliation-pack/liveness.ts')
  const { encryptSettingValue } = await import('../../lib/security/encrypted-settings.ts')
  const { PROBE_WH5, PROBE_WH6 } = await import('../reconciliation-pack/wms-fixtures.ts')
  const { readFileSync, readdirSync } = await import('node:fs')
  const { randomBytes } = await import('node:crypto')
  const KEY = `ms_${MTAG}_fixed_key_value_0123456789`
  // The probe rows with the SKUs made this test's own (the product ids, warehouses, client and figures are the live tenant's).
  const plain = PROBE_WH6.filter((r) => !r.Bundle)
  const sku = (r: { SKU: string }) => `${MTAG}-${r.SKU}`
  const wireRows = (rows: typeof PROBE_WH5) => rows.map((r) => ({ ...r, SKU: sku(r) }))
  const seen: Array<{ method: string; url: string; apikey: string | undefined }> = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', apikey: req.headers['ms-apikey'] as string | undefined })
    const url = new URL(req.url ?? '/', 'http://x')
    const headers = { 'content-type': 'application/json' }
    if (req.method !== 'GET' || url.pathname === '/api/Auth') { res.writeHead(500, headers); res.end('{}'); return }
    if (url.pathname === '/api/Product/StockLevels') { res.writeHead(200, headers); res.end(JSON.stringify(wireRows(url.searchParams.get('WarehouseId') === '5' ? PROBE_WH5 : url.searchParams.get('WarehouseId') === '6' ? PROBE_WH6 : []))); return }
    if (url.pathname === '/api/Product/List') {
      const limit = Number(url.searchParams.get('Limit')); const page = Number(url.searchParams.get('PageNo'))
      res.writeHead(limit > 100 ? 400 : 200, headers); res.end(JSON.stringify(limit > 100 ? {} : wireRows(PROBE_WH6).slice((page - 1) * limit, page * limit).map((r) => ({ ID: r.ProductId, SKU: r.SKU, ClientId: r.ClientId, Bundle: r.Bundle })))); return
    }
    res.writeHead(404, headers); res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  const dir = mkdtempSync('/var/tmp/recon-pack-nw-')
  chmodSync(dir, 0o700)
  const saved = await withClient(async (client) => (await client.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [MINTSOFT_SETTINGS])).rows as Array<{ key: string; value: string }>)
  const sql = (text: string, values: unknown[] = []) => withClient((client) => client.query(text, values))
  const setting = (key: string, value: string) => sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"`, [key, value])
  const targets: string[] = []
  const original = net.Socket.prototype.connect
  const previousMode = process.env.E2E_TEST_MODE
  const previousKeys = { SETTINGS_ENCRYPTION_KEY: process.env.SETTINGS_ENCRYPTION_KEY, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  let stockStamp: string | null = null
  let heldRows: { connections: string[]; bindings: string[]; links: string[] } | null = null
  try {
    // R1 reads EVERY Mintsoft binding and link, and the tier shares one database across files, so rows other files left behind would be part
    // of this estate. Hold them aside for the duration (their connector name is changed, nothing is deleted, so no cascade can fire) and put
    // them back exactly in the finally block. This is setup and teardown: the no-write census below is taken around the COMMAND only.
    const held = {
      connections: (await sql(`UPDATE wms_connections SET connector = 'held-' || connector WHERE connector = 'mintsoft' RETURNING id`)).rows.map((r) => r.id as string),
      bindings: (await sql(`UPDATE external_wms_bindings SET connector = 'held-' || connector WHERE connector = 'mintsoft' RETURNING id`)).rows.map((r) => r.id as string),
      links: (await sql(`UPDATE wms_product_links SET connector = 'held-' || connector WHERE connector = 'mintsoft' RETURNING id`)).rows.map((r) => r.id as string),
    }
    heldRows = held
    const remaining = await sql(`SELECT (SELECT count(*) FROM wms_connections WHERE connector = 'mintsoft')::int AS connections, (SELECT count(*) FROM external_wms_bindings WHERE connector = 'mintsoft')::int AS bindings, (SELECT count(*) FROM wms_product_links WHERE connector = 'mintsoft')::int AS links`)
    assert.deepEqual([remaining.rows[0].connections, remaining.rows[0].bindings, remaining.rows[0].links], [0, 0, 0], 'precondition: no foreign Mintsoft row is visible to the run')
    process.env.E2E_TEST_MODE = '1'
    process.env.SETTINGS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    delete process.env.ENCRYPTION_KEY
    await sql(`DELETE FROM settings WHERE key = ANY($1)`, [MINTSOFT_SETTINGS])
    await setting('mintsoft_auth_mode', 'api_key')
    await setting('mintsoft_static_api_key', encryptSettingValue('mintsoft_static_api_key', KEY))
    await setting('mintsoft_client_id', '89')
    await sql(`INSERT INTO wms_connections (id, connector, label, "baseUrl", "updatedAt") VALUES ($1, 'mintsoft', $2, $3, now())`, [`${MTAG}-c`, MTAG, `http://127.0.0.1:${port}`])
    for (const [n, wh] of [[5, 'EAR2'], [6, 'MIL1']] as const) {
      await sql(`INSERT INTO warehouses (id, code, name, "updatedAt") VALUES ($1, $2, 'x', now())`, [`${MTAG}-w${n}`, `${MTAG}${wh}`])
      await sql(`INSERT INTO external_wms_bindings (id, "connectionId", "warehouseId", connector, "externalWarehouseId", "stockSyncMode", "updatedAt") VALUES ($1, $2, $3, 'mintsoft', $4, 'NOTIFICATION_ONLY', now())`, [`${MTAG}-b${n}`, `${MTAG}-c`, `${MTAG}-w${n}`, String(n)])
    }
    for (const [i, r] of plain.entries()) {
      await sql(`INSERT INTO products (id, sku, name, "updatedAt") VALUES ($1, $2, 'x', now())`, [`${MTAG}-p${i}`, sku(r)])
      await sql(`INSERT INTO wms_product_links (id, "productId", connector, "externalProductId", "updatedAt") VALUES ($1, $2, 'mintsoft', $3, now())`, [`${MTAG}-l${i}`, `${MTAG}-p${i}`, String(r.ProductId)])
      for (const [n, rows] of [[5, PROBE_WH5], [6, PROBE_WH6]] as const) {
        const figure = rows.find((x) => x.SKU === r.SKU)!.TotalStockLevel
        await sql(`INSERT INTO stock_levels (id, "productId", "warehouseId", quantity, "reservedQty", "updatedAt") VALUES ($1, $2, $3, $4, 0, now())`, [`${MTAG}-s${i}-${n}`, `${MTAG}-p${i}`, `${MTAG}-w${n}`, figure])
      }
    }

    const run = async (extra: string[]) => {
      const out: string[] = []
      const err: string[] = []
      const before = await census()
      seen.length = 0
      targets.length = 0
      net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
        const raw = args[0] as unknown
        const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string
        targets.push(typeof first === 'object' && first !== null ? (first.path ? `unix:${first.path}` : `${first.host ?? 'localhost'}:${first.port}`) : `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`)
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      } as typeof original
      const liveness = { read: async () => reduceStatusReport(withStamp(goodReport(), 'mintsoft-stock-sync', stockStamp ?? '2026-10-20T00:30:00.000Z')) }
      const code = await runPackCli({ argv: ['--phase', 'P1', '--as-of', LD, '--items', 'R1', '--report-dir', dir, ...extra], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(), deps: { liveness }, stdout: (t) => out.push(t), stderr: (t) => err.push(t) })
      net.Socket.prototype.connect = original
      const after = await census()
      assert.deepEqual(after.counts, before.counts, 'every table has the rows it had')
      assert.deepEqual(after.stats, before.stats, 'no table saw an insert, update or delete')
      return { code, out, err, targets: [...targets] }
    }
    const url = new URL(process.env.DATABASE_URL!)
    const onlyDatabaseAndMintsoft = (list: string[]) => { for (const target of list) assert.ok(target === `${url.hostname}:${url.port}` || target === `127.0.0.1:${url.port}` || target === `localhost:${url.port}` || target === `127.0.0.1:${port}`, `unexpected connection to ${target}`) }

    // Without the flag: no request to Mintsoft, no connection to anything but the database.
    const off = await run([])
    assert.equal(off.code, 5, off.out.join('\n'))
    assert.ok(off.out.includes('R1 inconclusive VENDOR_READS_OFF'), off.out.join('\n'))
    assert.equal(seen.length, 0)
    assert.ok(off.targets.every((target) => !target.endsWith(`:${port}`)), off.targets.join(','))

    // With it: the stored fixed key, GET only, the two read paths, and the IMS stock equals Mintsoft's on-hand figure.
    const on = await run(['--vendor-reads-only'])
    assert.equal(on.code, 5, on.out.join('\n'))
    assert.ok(on.out.includes('R1 pass -'), on.out.join('\n'))
    assert.equal(seen.length, 8, '2 warehouses read twice, and the 12 products in one page with its end proof, read twice')
    assert.deepEqual([...new Set(seen.map((s) => s.method))], ['GET'])
    assert.ok(seen.every((s) => /^\/api\/Product\/(StockLevels|List)\?/.test(s.url) && s.apikey === KEY && !s.url.includes(KEY)))
    assert.ok(!seen.some((s) => /\/api\/Auth/i.test(s.url)))
    onlyDatabaseAndMintsoft(on.targets)
    assert.ok(on.targets.some((target) => target === `127.0.0.1:${port}`), 'precondition: Mintsoft was contacted')
    // THE SECRETS-ABSENCE SCAN over every output: stdout, stderr and every published file.
    const published = (function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [readFileSync(`${d}/${e.name}`, 'utf8')])) })(dir).join('\n')
    const everything = `${on.out.join('\n')}\n${on.err.join('\n')}\n${published}`
    for (const secret of [KEY, `127.0.0.1:${port}`, 'ms-apikey', 'mintsoft_static_api_key']) assert.ok(!everything.includes(secret), `output contains ${secret}`)

    // D7: a difference (IMS holds one unit fewer than Mintsoft in MIL1) is UNSETTLED, still unsettled after one further stream run, a failure after two.
    await sql(`UPDATE stock_levels SET quantity = 35 WHERE id = $1`, [`${MTAG}-s0-6`])
    const first = await run(['--vendor-reads-only'])
    assert.equal(first.code, 5, first.out.join('\n'))
    assert.ok(first.out.includes('R1 inconclusive UNSETTLED_PENDING'), first.out.join('\n'))
    stockStamp = '2026-10-20T01:30:00.000Z'
    assert.ok((await run(['--vendor-reads-only'])).out.includes('R1 inconclusive UNSETTLED_PENDING'))
    stockStamp = '2026-10-20T02:30:00.000Z'
    const settled = await run(['--vendor-reads-only'])
    assert.equal(settled.code, 1, settled.out.join('\n'))
    assert.ok(settled.out.includes('R1 fail DIFFERENCES'), settled.out.join('\n'))
    onlyDatabaseAndMintsoft(settled.targets)

    // An auth mode that would log in is refused before any request: the loopback sees NOTHING, /api/Auth included.
    await setting('mintsoft_auth_mode', 'credentials')
    const refused = await run(['--vendor-reads-only'])
    assert.ok(refused.out.includes('R1 inconclusive VENDOR_AUTH_REFUSED'), refused.out.join('\n'))
    assert.equal(seen.length, 0, 'no request of any kind')
    assert.ok(refused.targets.every((target) => !target.endsWith(`:${port}`)), refused.targets.join(','))
  } finally {
    net.Socket.prototype.connect = original
    if (previousMode === undefined) delete process.env.E2E_TEST_MODE; else process.env.E2E_TEST_MODE = previousMode
    for (const [name, value] of Object.entries(previousKeys)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    await sql(`DELETE FROM stock_levels WHERE id LIKE '${MTAG}%'`)
    await sql(`DELETE FROM wms_product_links WHERE id LIKE '${MTAG}%'`)
    await sql(`DELETE FROM products WHERE id LIKE '${MTAG}%'`)
    await sql(`DELETE FROM external_wms_bindings WHERE id LIKE '${MTAG}%'`)
    await sql(`DELETE FROM warehouses WHERE id LIKE '${MTAG}%'`)
    await sql(`DELETE FROM wms_connections WHERE id LIKE '${MTAG}%'`)
    if (heldRows !== null) {
      await sql(`UPDATE wms_connections SET connector = 'mintsoft' WHERE id = ANY($1) AND connector = 'held-mintsoft'`, [heldRows.connections])
      await sql(`UPDATE external_wms_bindings SET connector = 'mintsoft' WHERE id = ANY($1) AND connector = 'held-mintsoft'`, [heldRows.bindings])
      await sql(`UPDATE wms_product_links SET connector = 'mintsoft' WHERE id = ANY($1) AND connector = 'held-mintsoft'`, [heldRows.links])
    }
    await sql(`DELETE FROM settings WHERE key = ANY($1)`, [MINTSOFT_SETTINGS])
    for (const prior of saved) await setting(prior.key, prior.value)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- R2, R5 and R14 end to end: a real export directory, the real IMS reads, doubles for the storefront and Mintsoft (no network) -------

const QTAG = `RCQX${process.pid}`
const QD = '2026-03-07'

test('[reconciliation pack] R2, R5 and R14 with --qoblex-export: the export compared with the real snapshot, nothing read without the flag, no connection but the database, and not one row written', { skip: !RUN }, async () => {
  const { createHash } = await import('node:crypto')
  const { writeFileSync } = await import('node:fs')
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const { healthyLiveness } = await import('../reconciliation-pack/basis-fixtures.ts')
  const { fakeStore, noSleep } = await import('../reconciliation-pack/woo-fixtures.ts')
  const { stockCsv, productsCsv } = await import('../reconciliation-pack/qoblex-fixtures.ts')
  void noSleep
  const sql = (text: string, values: unknown[] = []) => withClient((client) => client.query(text, values))
  const dir = mkdtempSync('/var/tmp/recon-pack-nw-')
  const exportDir = mkdtempSync('/var/tmp/recon-pack-qx-')
  chmodSync(dir, 0o700)
  chmodSync(exportDir, 0o700)
  const skus = [`${QTAG}-A`, `${QTAG}-B`]
  const codes = [`${QTAG}W1`, `${QTAG}W2`]
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const writeExport = (qtyA: string) => {
    const stock = stockCsv([{ sku: skus[0]!, location: codes[0]!, qty: qtyA, unitCost: '2.5' }, { sku: skus[1]!, location: codes[1]!, qty: '4', unitCost: '10' }])
    const products = productsCsv(catalogue.map((sku) => ({ sku })))
    writeFileSync(`${exportDir}/stock.csv`, stock, { mode: 0o644 })
    writeFileSync(`${exportDir}/products.csv`, products, { mode: 0o644 })
    writeFileSync(`${exportDir}/manifest.json`, JSON.stringify({
      formatVersion: 1, exportedAt: '2026-03-08T08:00:00Z', asOf: QD, baseCurrency: 'GBP',
      locations: codes.map((code) => ({ code, company: 'ACME', threePl: false })),
      stock: { file: 'stock.csv', sha256: sha(stock) }, products: { file: 'products.csv', sha256: sha(products) },
    }), { mode: 0o644 })
  }
  const targets: string[] = []
  const original = net.Socket.prototype.connect
  // THE TIER SHARES ONE DATABASE: warehouses, products and snapshot rows left by other files are visible to a run, and the population is IMS's.
  // Foreign rows are held aside by RECORDED ids with reversible updates (no delete) and restored exactly in finally; the ids are recorded after
  // EACH update so a partial setup is restored too. Foreign PRODUCTS cannot be held aside (R14 reads every product), so the export, the storefront
  // and the warehouse-system list carry them too.
  const held = { warehouses: [] as string[], runs: [] as string[], snapshots: [] as string[] }
  let catalogue: string[] = [...skus]
  try {
    held.warehouses = (await sql(`UPDATE warehouses SET active = false WHERE active = true RETURNING id`)).rows.map((r: { id: string }) => r.id)
    held.runs = (await sql(`UPDATE inventory_snapshot_runs SET "snapshotDate" = '2020-01-01' WHERE "snapshotDate" = $1 RETURNING id`, [QD])).rows.map((r: { id: string }) => r.id)
    held.snapshots = (await sql(`UPDATE inventory_snapshots SET "snapshotDate" = '2020-01-01' WHERE "snapshotDate" = $1 RETURNING id`, [QD])).rows.map((r: { id: string }) => r.id)
    const visible = await sql(`SELECT (SELECT count(*) FROM warehouses WHERE active)::int AS w, (SELECT count(*) FROM inventory_snapshots WHERE "snapshotDate" = $1)::int AS s, (SELECT count(*) FROM inventory_snapshot_runs WHERE "snapshotDate" = $1)::int AS r`, [QD])
    assert.deepEqual([visible.rows[0].w, visible.rows[0].s, visible.rows[0].r], [0, 0, 0], 'precondition: no foreign warehouse or snapshot row is visible to the run')
    await sql(`INSERT INTO products (id, sku, name, "updatedAt") VALUES ($1, $2, 'x', now()), ($3, $4, 'x', now())`, [`${QTAG}-p1`, skus[0], `${QTAG}-p2`, skus[1]])
    await sql(`INSERT INTO warehouses (id, code, name, "updatedAt") VALUES ($1, $2, 'x', now()), ($3, $4, 'x', now())`, [`${QTAG}-w1`, codes[0], `${QTAG}-w2`, codes[1]])
    await sql(`INSERT INTO inventory_snapshot_runs (id, "snapshotDate", "stockLevelCount", "snapshotCount", "updatedAt") VALUES ($1, $2, 2, 2, now())`, [`${QTAG}-run`, QD])
    await sql(`INSERT INTO inventory_snapshots (id, "snapshotDate", "productId", "warehouseId", qty, "valueBase", "unitCostBase") VALUES ($1, $2, $3, $4, 10, 25, 2.5), ($5, $2, $6, $7, 4, 40, 10)`, [`${QTAG}-s1`, QD, `${QTAG}-p1`, `${QTAG}-w1`, `${QTAG}-s2`, `${QTAG}-p2`, `${QTAG}-w2`])
    const everySku = (await sql(`SELECT sku FROM products ORDER BY sku`)).rows.map((r: { sku: string }) => r.sku)
    catalogue = everySku
    // Foreign SKUs that the export cannot carry as written (outer space, non-NFC, control characters) make the export refuse itself: then R14 is only
    // required not to fail internally.
    const canonical = everySku.every((sku: string) => sku !== '' && sku === sku.trim() && sku === sku.normalize('NFC') && !/[\u0000-\u001f\u007f\u00a0\u200b-\u200d\u2060\ufeff]/.test(sku) && !sku.startsWith('#'))
    const run = async (extra: string[]) => {
      const out: string[] = []
      const before = await census()
      targets.length = 0
      net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
        const raw = args[0] as unknown
        const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string
        targets.push(typeof first === 'object' && first !== null ? (first.path ? `unix:${first.path}` : `${first.host ?? 'localhost'}:${first.port}`) : `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`)
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      } as typeof original
      const store = fakeStore({ products: everySku.map((sku: string, i: number) => ({ id: i + 1, sku, status: 'publish', type: 'simple' })) })
      const code = await runPackCli({
        argv: ['--phase', 'P1', '--as-of', QD, '--items', 'R2,R5,R14', '--report-dir', dir, ...extra], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(),
        deps: { liveness: healthyLiveness(), now: () => new Date('2026-03-08T12:00:00Z'), woo: store, wmsSkus: async () => ({ ok: true, skus: everySku }) },
        stdout: (t) => out.push(t), stderr: (t) => out.push(t),
      })
      net.Socket.prototype.connect = original
      const after = await census()
      assert.deepEqual(after.counts, before.counts, 'every table has the rows it had')
      assert.deepEqual(after.stats, before.stats, 'no table saw an insert, update or delete')
      return { code, out, targets: [...targets] }
    }
    writeExport('10')
    // Without the flag: nothing is read for the Qoblex items.
    const off = await run(['--vendor-reads-only'])
    assert.ok(off.out.includes('R2 inconclusive QOBLEX_EXPORT_OFF') && off.out.includes('R5 inconclusive QOBLEX_EXPORT_OFF') && off.out.includes('R14 inconclusive QOBLEX_EXPORT_OFF'), off.out.join('\n'))
    // With it: the export is compared with the snapshot of the cycle date.
    const on = await run(['--vendor-reads-only', '--qoblex-export', exportDir])
    assert.equal(on.code, 5, on.out.join('\n'))
    assert.ok(on.out.includes('R2 pass -') && on.out.includes('R5 pass -'), on.out.join('\n'))
    assert.ok(!on.out.some((line) => /^R14 .*INTERNAL_ERROR/.test(line)), on.out.join('\n'))
    if (canonical) assert.ok(on.out.includes('R14 pass -'), on.out.join('\n'))
    const url = new URL(process.env.DATABASE_URL!)
    assert.ok(on.targets.length > 0)
    for (const target of on.targets) assert.ok(target === `${url.hostname}:${url.port}` || target === `127.0.0.1:${url.port}` || target === `localhost:${url.port}`, `unexpected connection to ${target}`)
    // A quantity that differs by one in the export is a finding by identity; the snapshot is not touched.
    writeExport('11')
    const differs = await run(['--vendor-reads-only', '--qoblex-export', exportDir])
    assert.ok(differs.out.includes('R2 fail DIFFERENCES'), differs.out.join('\n'))
    // 11 x 2.5 = 27.5 against 25: 2.5 apart on a total of 67.5, beyond max(GBP 1, 0.05%): R5 fails too.
    assert.ok(differs.out.includes('R5 fail DIFFERENCES'), differs.out.join('\n'))
    // A stale export (another cycle date) is inconclusive and the snapshot is not read.
    writeFileSync(`${exportDir}/manifest.json`, (await import('node:fs')).readFileSync(`${exportDir}/manifest.json`, 'utf8').replace(`"asOf":"${QD}"`, '"asOf":"2026-03-06"'), { mode: 0o644 })
    const stale = await run(['--vendor-reads-only', '--qoblex-export', exportDir])
    assert.ok(stale.out.includes('R2 inconclusive QOBLEX_EXPORT_STALE'), stale.out.join('\n'))
  } finally {
    net.Socket.prototype.connect = original
    await sql(`DELETE FROM inventory_snapshots WHERE id LIKE '${QTAG}%'`)
    await sql(`DELETE FROM inventory_snapshot_runs WHERE id LIKE '${QTAG}%'`)
    await sql(`DELETE FROM products WHERE id LIKE '${QTAG}%'`)
    await sql(`DELETE FROM warehouses WHERE id LIKE '${QTAG}%'`)
    // Put every held row back exactly as it was, and say so if one cannot be.
    const restored = {
      warehouses: (await sql(`UPDATE warehouses SET active = true WHERE id = ANY($1) AND active = false`, [held.warehouses])).rowCount,
      runs: (await sql(`UPDATE inventory_snapshot_runs SET "snapshotDate" = $2 WHERE id = ANY($1) AND "snapshotDate" = '2020-01-01'`, [held.runs, QD])).rowCount,
      snapshots: (await sql(`UPDATE inventory_snapshots SET "snapshotDate" = $2 WHERE id = ANY($1) AND "snapshotDate" = '2020-01-01'`, [held.snapshots, QD])).rowCount,
    }
    rmSync(dir, { recursive: true, force: true })
    rmSync(exportDir, { recursive: true, force: true })
    assert.deepEqual(restored, { warehouses: held.warehouses.length, runs: held.runs.length, snapshots: held.snapshots.length }, 'every held foreign row was restored')
  }
})

// ---- R7, R8 and R11 end to end at P2: the real IMS reads, the real basis, an export on disk ----------------------------------------

const OTAG = `RCPO${process.pid}`
const OD = '2026-03-12'
const OPREFIX = `${OTAG}-`

test('[reconciliation pack] R7, R8 and R11 at P2: nothing read at P1, nothing of the export read without the flag, the open orders and the transit schedule compared with real rows, and not one row written', { skip: !RUN }, async () => {
  const { createHash } = await import('node:crypto')
  const { writeFileSync } = await import('node:fs')
  const { runPackCli } = await import('../../scripts/reconciliation-pack.ts')
  const { healthyLiveness } = await import('../reconciliation-pack/basis-fixtures.ts')
  const { incomingCsv } = await import('../reconciliation-pack/qoblex-fixtures.ts')
  const { QOBLEX_NATIVE_PO_COLUMN_MAP } = await import('../../lib/reconciliation-pack/qoblex-native-map.ts')
  const { INTEGRATION_PLUGIN_SETTING_KEYS } = await import('../../lib/integration-plugin-keys.ts')
  const sql = (text: string, values: unknown[] = []) => withClient((client) => client.query(text, values))
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const dir = mkdtempSync('/var/tmp/recon-pack-nw-')
  const exportDir = mkdtempSync('/var/tmp/recon-pack-po-')
  chmodSync(dir, 0o700)
  chmodSync(exportDir, 0o700)
  const codes = { inventory: `${OTAG}1`, allocated: `${OTAG}2`, transit: `${OTAG}3`, cogs: `${OTAG}4`, unearned: `${OTAG}5` }
  const SET = ['integration_xero_enabled', 'xero_inventory_account', 'xero_allocated_inventory_account', 'xero_transit_account', 'xero_cogs_account', 'xero_unearned_revenue_account', 'transit_ledger_coverage_start_date']
  const settingKeys = [...SET, INTEGRATION_PLUGIN_SETTING_KEYS.xero]
  const incoming = ['PO_SENT', 'SHIPPED', 'PARTIALLY_RECEIVED']
  // THE TIER SHARES ONE DATABASE: incoming purchase orders, transit rows, snapshot rows, the first-load record and the Xero token left by
  // other files are visible to a run, and both populations are IMS's. Foreign rows are held aside by RECORDED ids with reversible updates (a
  // status, a journal date, a snapshot date; never a delete of a foreign row except the token, which is saved whole and put back) and restored
  // exactly in finally with the counts asserted; ids are recorded BEFORE each update so a partial setup is restored too.
  const held = { orders: [] as Array<{ id: string; status: string }>, movements: [] as Array<{ id: string; at: string }>, runs: [] as string[], snapshots: [] as string[], settings: [] as Array<{ key: string; value: string }> }
  let estate: Held = NOTHING_HELD
  const targets: string[] = []
  const original = net.Socket.prototype.connect
  const writeExport = (qty: string) => {
    const csv = incomingCsv([{ po: 'PO1', sku: `${OTAG}-A`, ordered: qty, received: '4', price: '2.5' }, { po: 'PO1', sku: `${OTAG}-B`, ordered: '3', received: '0', price: '10' }])
    writeFileSync(`${exportDir}/incoming.csv`, csv, { mode: 0o644 })
    writeFileSync(`${exportDir}/incoming-map.json`, QOBLEX_NATIVE_PO_COLUMN_MAP, { mode: 0o644 })
    writeFileSync(`${exportDir}/manifest.json`, JSON.stringify({
      formatVersion: 1, exportedAt: '2026-03-13T08:00:00Z', asOf: OD, baseCurrency: 'GBP',
      locations: [{ code: `${OTAG}W`, company: 'ACME', threePl: false }],
      purchaseOrders: { file: 'incoming.csv', sha256: sha(csv), keyPrefix: OPREFIX, columnMap: { file: 'incoming-map.json', sha256: sha(QOBLEX_NATIVE_PO_COLUMN_MAP) } },
    }), { mode: 0o644 })
  }
  try {
    held.settings = (await sql(`SELECT key, value FROM settings WHERE key = ANY($1)`, [settingKeys])).rows as Array<{ key: string; value: string }>
    estate = await holdForeignEstate()
    held.orders = (await sql(`SELECT id, status::text AS status FROM purchase_orders WHERE status::text = ANY($1)`, [incoming])).rows as Array<{ id: string; status: string }>
    await sql(`UPDATE purchase_orders SET status = 'DRAFT' WHERE id = ANY($1)`, [held.orders.map((o) => o.id)])
    held.movements = (await sql(`SELECT id, to_char(journal_date, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS at FROM transit_subledger_movements WHERE journal_date <= $1`, [OD])).rows as Array<{ id: string; at: string }>
    await sql(`UPDATE transit_subledger_movements SET journal_date = '2099-01-01' WHERE id = ANY($1)`, [held.movements.map((m) => m.id)])
    held.runs = (await sql(`UPDATE inventory_snapshot_runs SET "snapshotDate" = '2020-01-02' WHERE "snapshotDate" = $1 RETURNING id`, [OD])).rows.map((r: { id: string }) => r.id)
    held.snapshots = (await sql(`UPDATE inventory_snapshots SET "snapshotDate" = '2020-01-02' WHERE "snapshotDate" = $1 RETURNING id`, [OD])).rows.map((r: { id: string }) => r.id)
    const visible = await sql(`SELECT (SELECT count(*) FROM purchase_orders WHERE status::text = ANY($2))::int AS o, (SELECT count(*) FROM transit_subledger_movements WHERE journal_date <= $1)::int AS m, (SELECT count(*) FROM inventory_snapshot_runs WHERE "snapshotDate" = $1)::int AS r`, [OD, incoming])
    assert.deepEqual([visible.rows[0].o, visible.rows[0].m, visible.rows[0].r], [0, 0, 0], 'precondition: no foreign incoming order, transit row or snapshot run is visible to the run')

    // The estate: Xero on, five tagged accounts with stored balances for the cycle date, a coverage watermark, a verified first load.
    const setting = (key: string, value: string) => sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value])
    for (const [key, value] of [[INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true'], ['xero_inventory_account', codes.inventory], ['xero_allocated_inventory_account', codes.allocated], ['xero_transit_account', codes.transit], ['xero_cogs_account', codes.cogs], ['xero_unearned_revenue_account', codes.unearned], ['transit_ledger_coverage_start_date', '2000-01-01']] as const) await setting(key, value)
    await sql(`INSERT INTO accounting_tokens (id, connector, "accessToken", "expiresAt", "tenantId", "updatedAt") VALUES ($1, 'xero', 'x', '2031-01-01', $2, now())`, [`${OTAG}-tok`, `${OTAG}-tenant`])
    const amounts: Record<string, string> = { inventory: '0', allocated: '0', transit: '50', cogs: '0', unearned: '0' }
    for (const [kind, code] of Object.entries(codes)) {
      await sql(`INSERT INTO accounting_accounts (id, connector, "externalAccountId", code, name, type, active) VALUES ($1, 'xero', $2, $3, 'x', 'ASSET', true)`, [`${OTAG}-ca-${kind}`, `${OTAG}-acc-${kind}`, code])
    }
    for (const [kind, code] of Object.entries(codes)) {
      await sql(`INSERT INTO accounting_account_balance_snapshots (id, connector, "externalAccountId", "accountCode", "accountName", "balanceDate", currency, "amountForeign", "amountBase", "sourcePayloadRef", "tenantId", "parserVersion", "updatedAt") VALUES ($1, 'xero', $2, $3, 'x', $4, 'GBP', $5, $5, $6, $7, 2, now())`, [`${OTAG}-b-${kind}`, `${OTAG}-acc-${kind}`, code, OD, amounts[kind], `xero:trial-balance:${OD}`, `${OTAG}-tenant`])
    }
    await sql(`INSERT INTO inventory_snapshot_runs (id, "snapshotDate", "stockLevelCount", "snapshotCount", "updatedAt") VALUES ($1, $2, 0, 0, now())`, [`${OTAG}-run`, OD])
    await sql(`INSERT INTO first_load_apply_runs (id, singleton, version, manifest_digest, run_id, status, steps, facts, created_at, updated_at) VALUES ($1, true, 1, 'd', 'r', 'VERIFIED', '{"purchase-orders": {"emitted": 1, "created": 1, "failed": 0}}', '{}', '2026-03-01 09:00:00', '2026-03-02 09:00:00')`, [`${OTAG}-fl`])
    // One supplier, one open order with two lines (A part-received: 10 ordered of which 4 received in IMS terms is 6 outstanding), the transit rows of its bill and its receipt.
    await sql(`INSERT INTO suppliers (id, name, "updatedAt") VALUES ($1, 'x', now())`, [`${OTAG}-sup`])
    await sql(`INSERT INTO products (id, sku, name, "updatedAt") VALUES ($1, $2, 'x', now()), ($3, $4, 'x', now())`, [`${OTAG}-pa`, `${OTAG}-A`, `${OTAG}-pb`, `${OTAG}-B`])
    await sql(`INSERT INTO purchase_orders (id, reference, "supplierId", status, currency, "fxRateToBase", "subtotalForeign", "subtotalBase", "totalForeign", "totalBase", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'PO_SENT', 'GBP', 1, 45, 45, 45, 45, '2026-03-05 09:00:00', now())`, [`${OTAG}-po`, `${OPREFIX}PO1`, `${OTAG}-sup`])
    await sql(`INSERT INTO purchase_order_lines (id, "poId", "productId", qty, "qtyReceived", "unitCostForeign", "unitCostBase", "totalForeign", "totalBase") VALUES ($1, $2, $3, 10, 4, 2.5, 2.5, 25, 25), ($4, $2, $5, 3, 0, 10, 10, 30, 30)`, [`${OTAG}-la`, `${OTAG}-po`, `${OTAG}-pa`, `${OTAG}-lb`, `${OTAG}-pb`])
    // The first load's RECORDED provenance of the order (the system-actor creation row the apply runner's createPurchaseOrder writes), and a NATIVE incoming order
    // with the prefix but no such row: it must be listed out of the population and never judged.
    await sql(`INSERT INTO activity_logs (id, "entityType", "entityId", action, tag, description, metadata, "createdAt") VALUES ($1, 'PURCHASE_ORDER', $2, 'created', 'purchase', 'Created PO', $3::jsonb, now())`, [`${OTAG}-act`, `${OTAG}-po`, JSON.stringify({ actor: { kind: 'system', runId: 'r', operator: 'op' } })])
    await sql(`INSERT INTO purchase_orders (id, reference, "supplierId", status, currency, "fxRateToBase", "subtotalForeign", "subtotalBase", "totalForeign", "totalBase", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'PO_SENT', 'GBP', 1, 1, 1, 1, 1, '2026-03-05 09:00:00', now())`, [`${OTAG}-nat`, `${OPREFIX}PONAT`, `${OTAG}-sup`])
    await sql(`INSERT INTO purchase_order_lines (id, "poId", "productId", qty, "qtyReceived", "unitCostForeign", "unitCostBase", "totalForeign", "totalBase") VALUES ($1, $2, $3, 1, 0, 1, 1, 1, 1)`, [`${OTAG}-lnat`, `${OTAG}-nat`, `${OTAG}-pa`])
    await sql(`INSERT INTO transit_subledger_movements (id, source_type, source_ref, idempotency_key, base_delta, journal_date) VALUES ($1, 'PURCHASE_BILL', $3, $1, 80, '2026-03-10'), ($2, 'STOCK_RECEIPT', $3, $2, -30, '2026-03-11')`, [`${OTAG}-m1`, `${OTAG}-m2`, `${OTAG}-po`])

    const run = async (phase: string, extra: string[]) => {
      const out: string[] = []
      const before = await census()
      targets.length = 0
      net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
        const raw = args[0] as unknown
        const first = (Array.isArray(raw) ? raw[0] : raw) as { host?: string; port?: number; path?: string } | number | string
        targets.push(typeof first === 'object' && first !== null ? (first.path ? `unix:${first.path}` : `${first.host ?? 'localhost'}:${first.port}`) : `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${String(first)}`)
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      } as typeof original
      const code = await runPackCli({
        argv: ['--phase', phase, '--as-of', OD, '--items', 'R7,R8,R11', '--report-dir', dir, ...extra], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(),
        deps: { liveness: healthyLiveness(), now: () => new Date('2026-03-14T12:00:00Z') }, stdout: (t) => out.push(t), stderr: (t) => out.push(t),
      })
      net.Socket.prototype.connect = original
      const after = await census()
      assert.deepEqual(after.counts, before.counts, 'every table has the rows it had')
      assert.deepEqual(after.stats, before.stats, 'no table saw an insert, update or delete')
      return { code, out, targets: [...targets] }
    }
    writeExport('10')
    // P1: not applicable, and the run reads none of the three items' inputs (the export is not even opened).
    const p1 = await run('P1', ['--qoblex-export', exportDir])
    for (const id of ['R7', 'R8', 'R11']) assert.ok(p1.out.includes(`${id} not-applicable PHASE_NOT_APPLICABLE`), p1.out.join('\n'))
    // P2 without the flag: R7 and R8 read nothing; R11 needs no export.
    const off = await run('P2', [])
    assert.ok(off.out.includes('R7 inconclusive QOBLEX_EXPORT_OFF') && off.out.includes('R8 inconclusive QOBLEX_EXPORT_OFF'), off.out.join('\n'))
    assert.ok(off.out.includes('R11 pass -'), off.out.join('\n'))
    // P2 with it: the open order (6 outstanding of A at 2.5, 3 of B at 10 = 45 GBP) equals the export's, and 80 - 30 equals the stored balance of 50.
    const on = await run('P2', ['--qoblex-export', exportDir])
    assert.equal(on.code, 5, on.out.join('\n'))
    assert.ok(on.out.includes('R7 pass -') && on.out.includes('R8 pass -') && on.out.includes('R11 pass -'), on.out.join('\n'))
    // the native order (prefix, no recorded first-load creation) was not judged: it is listed out of the population. A creation row that moves to the native order makes
    // THAT order the first load's (one attributed order, as the run record says) and PO1 the unattributed one: the export's PO1 is then onlyVendor, so both fail.
    await sql(`UPDATE activity_logs SET "entityId" = $2 WHERE id = $1`, [`${OTAG}-act`, `${OTAG}-nat`])
    const swapped = await run('P2', ['--qoblex-export', exportDir])
    assert.ok(swapped.out.includes('R7 fail DIFFERENCES') && swapped.out.includes('R8 fail DIFFERENCES'), swapped.out.join('\n'))
    // a creation row pruned (the retention sweep): 0 attributed orders against 1 emitted is not a population - NO_POPULATION_RECORD, never a pass
    await sql(`UPDATE activity_logs SET "entityId" = NULL WHERE id = $1`, [`${OTAG}-act`])
    const pruned = await run('P2', ['--qoblex-export', exportDir])
    assert.ok(pruned.out.includes('R7 inconclusive NO_POPULATION_RECORD') && pruned.out.includes('R8 inconclusive NO_POPULATION_RECORD'), pruned.out.join('\n'))
    await sql(`UPDATE activity_logs SET "entityId" = $2 WHERE id = $1`, [`${OTAG}-act`, `${OTAG}-po`])
    const url = new URL(process.env.DATABASE_URL!)
    assert.ok(on.targets.length > 0)
    for (const target of on.targets) assert.ok(target === `${url.hostname}:${url.port}` || target === `127.0.0.1:${url.port}` || target === `localhost:${url.port}`, `unexpected connection to ${target}`)
    // A quantity that differs by one in the export is a finding by identity, in value and in quantity; nothing in IMS is touched.
    writeExport('11')
    const differs = await run('P2', ['--qoblex-export', exportDir])
    assert.ok(differs.out.includes('R7 fail DIFFERENCES') && differs.out.includes('R8 fail DIFFERENCES'), differs.out.join('\n'))
    // The coverage watermark is the proof the sub-ledger holds every posting: with it AFTER the order's creation (2026-03-05) the order may carry history the ledger has
    // no record of, and R11 is NO_POPULATION_RECORD (every purchase order, whatever its status, must postdate the watermark); the watermark of 2000-01-01 is restored after.
    await sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ('transit_ledger_coverage_start_date', '2026-03-06', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
    const late = await run('P2', ['--qoblex-export', exportDir])
    assert.ok(late.out.includes('R11 inconclusive NO_POPULATION_RECORD'), late.out.join('\n'))
    await sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ('transit_ledger_coverage_start_date', '2000-01-01', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
    // A transit row the schedule does not explain moves R11: another bill on the order (+5) is 55 against the stored 50, beyond GBP 1.
    writeExport('10')
    await sql(`INSERT INTO transit_subledger_movements (id, source_type, source_ref, idempotency_key, base_delta, journal_date) VALUES ($1, 'PURCHASE_BILL_UPDATE', $2, $1, 5, '2026-03-11')`, [`${OTAG}-m3`, `${OTAG}-po`])
    const moved = await run('P2', ['--qoblex-export', exportDir])
    assert.ok(moved.out.includes('R11 fail DIFFERENCES'), moved.out.join('\n'))
    assert.ok(moved.out.includes('R7 pass -') && moved.out.includes('R8 pass -'), moved.out.join('\n'))
  } finally {
    net.Socket.prototype.connect = original
    await sql(`DELETE FROM transit_subledger_movements WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM activity_logs WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM purchase_order_lines WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM purchase_orders WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM suppliers WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM products WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM inventory_snapshot_runs WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM accounting_account_balance_snapshots WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM accounting_accounts WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM accounting_tokens WHERE id LIKE '${OTAG}%'`)
    await sql(`DELETE FROM first_load_apply_runs WHERE id LIKE '${OTAG}%'`)
    // Put every held row back exactly as it was, and say so if one cannot be.
    const restored = {
      orders: held.orders.length === 0 ? 0 : (await sql(`UPDATE purchase_orders po SET status = v.status::"PurchaseOrderStatus" FROM unnest($1::text[], $2::text[]) AS v(id, status) WHERE po.id = v.id AND po.status = 'DRAFT'`, [held.orders.map((o) => o.id), held.orders.map((o) => o.status)])).rowCount,
      movements: held.movements.length === 0 ? 0 : (await sql(`UPDATE transit_subledger_movements m SET journal_date = v.at::timestamp FROM unnest($1::text[], $2::text[]) AS v(id, at) WHERE m.id = v.id AND m.journal_date = '2099-01-01'`, [held.movements.map((m) => m.id), held.movements.map((m) => m.at)])).rowCount,
      runs: (await sql(`UPDATE inventory_snapshot_runs SET "snapshotDate" = $2 WHERE id = ANY($1) AND "snapshotDate" = '2020-01-02'`, [held.runs, OD])).rowCount,
      snapshots: (await sql(`UPDATE inventory_snapshots SET "snapshotDate" = $2 WHERE id = ANY($1) AND "snapshotDate" = '2020-01-02'`, [held.snapshots, OD])).rowCount,
    }
    for (const key of settingKeys) {
      const prior = held.settings.find((row) => row.key === key)
      if (prior) await sql(`INSERT INTO settings (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, prior.value])
      else await sql(`DELETE FROM settings WHERE key = $1`, [key])
    }
    await restoreForeignEstate(estate)
    rmSync(dir, { recursive: true, force: true })
    rmSync(exportDir, { recursive: true, force: true })
    assert.deepEqual(restored, { orders: held.orders.length, movements: held.movements.length, runs: held.runs.length, snapshots: held.snapshots.length }, 'every held foreign row was restored')
  }
})

// ---- the holds themselves --------------------------------------------------------------------------------------------------------

// [mutation: the recovery record written outside the hold's transaction / the sweep removed / restore taken from memory]
test('[reconciliation pack] the holds are durable: a failure after the first hold rolls ALL of it back, a failure after the commit is healed by the restore, and a killed run is healed by the next hold\'s sweep; foreign rows are identical each time', { skip: !RUN }, async () => {
  const sql = (text: string, values: unknown[] = []) => withClient((client) => client.query(text, values))
  const tag = `RCHOLD${process.pid}`
  // Foreign rows other files left are simply part of what the holds take and give back: they are counted, not avoided (holds do not nest: each hold
  // sweeps every other run's entries first).
  try {
    // Holds do not nest, so foreign rows are not avoided: the unique rows (one token, one first-load record) are seeded only when a foreign one is not already there.
    await sql(`INSERT INTO accounting_tokens (id, connector, "accessToken", "expiresAt", "tenantId", "updatedAt") SELECT $1, 'xero', 'y', '2031-01-01', 'hold-tenant', now() WHERE NOT EXISTS (SELECT 1 FROM accounting_tokens WHERE connector = 'xero')`, [`${tag}-tok`])
    await sql(`INSERT INTO first_load_apply_runs (id, singleton, version, manifest_digest, run_id, status, steps, facts, created_at, updated_at) SELECT $1, true, 1, 'd', 'r', 'APPLIED', '{}', '{}', '2026-01-01 09:00:00', '2026-01-02 09:00:00' WHERE NOT EXISTS (SELECT 1 FROM first_load_apply_runs)`, [`${tag}-fl`])
    await sql(`INSERT INTO accounting_sync_logs (id, connector, type, status, "referenceType", "referenceId", "createdAt") VALUES ($1, 'xero', 'COGS_JOURNAL', 'PROCESSING', 'CogsEntry', 'hold', now())`, [`${tag}-sync`])
    const before = await heldKindsDigest()
    const baseVisible = (await sql(`SELECT (SELECT count(*) FROM accounting_tokens WHERE connector = 'xero')::int + (SELECT count(*) FROM first_load_apply_runs)::int AS n`)).rows[0].n as number
    const tables = async () => (await sql(`SELECT (SELECT count(*) FROM accounting_tokens WHERE connector = 'xero')::int AS t, (SELECT count(*) FROM first_load_apply_runs)::int AS f, (SELECT count(*) FROM _test_held_rows)::int AS h`)).rows[0] as { t: number; f: number; h: number }
    const entries = (await sql(`SELECT (SELECT count(*) FROM accounting_tokens WHERE connector = 'xero')::int + (SELECT count(*) FROM first_load_apply_runs)::int + (SELECT count(*) FROM accounting_sync_logs WHERE connector = 'xero' AND (status::text IN ('SYNCED', 'PROCESSING') OR "externalTransactionId" IS NOT NULL))::int AS n`)).rows[0].n as number
    const visibleMine = async () => (await sql(`SELECT (SELECT count(*) FROM accounting_tokens WHERE connector = 'xero')::int + (SELECT count(*) FROM first_load_apply_runs)::int AS n`)).rows[0].n as number

    // (a) a failure injected after the FIRST hold: the single transaction rolls everything back; nothing is stranded and no entry is committed.
    await assert.rejects(holdForeignEstate(1), /injected failure after hold/)
    assert.equal(await heldKindsDigest(), before, 'a failed hold changed nothing')
    assert.equal((await tables()).h, 0); assert.equal(await visibleMine(), baseVisible)
    // (a2) a failure AFTER the commit (the test body throws): the finally restores from the table.
    let held: Held = NOTHING_HELD
    await assert.rejects((async () => { try { held = await holdForeignEstate(); assert.deepEqual(await tables(), { t: 0, f: 0, h: entries }); throw new Error('the test body failed') } finally { await restoreForeignEstate(held) } })(), /the test body failed/)
    assert.equal(await heldKindsDigest(), before, 'the finally put everything back')
    assert.equal((await tables()).h, 0); assert.equal(await visibleMine(), baseVisible)

    // (b) a KILLED run: holds committed, restore never reached, the run id is gone. The next hold sweeps it BEFORE holding, so the rows are back and held again under the new run.
    const killed = await holdForeignEstate()
    assert.deepEqual(await tables(), { t: 0, f: 0, h: entries })
    void killed // the id is forgotten, as a killed process forgets it
    assert.equal(await sweepEarlierHolds('some-other-run'), entries, 'the sweep restored the dead run\'s entries')
    assert.equal(await heldKindsDigest(), before, 'the dead run\'s rows are back exactly')
    assert.equal((await tables()).h, 0); assert.equal(await visibleMine(), baseVisible)
    const dead = await holdForeignEstate() // killed again
    const next = await holdForeignEstate() // the next run: its own sweep heals `dead` first, then holds
    assert.notEqual(next, dead)
    assert.deepEqual(await tables(), { t: 0, f: 0, h: entries })
    assert.equal((await sql(`SELECT count(*)::int AS n FROM _test_held_rows WHERE run_id = $1`, [dead])).rows[0].n, 0, 'nothing of the dead run is left')
    await restoreForeignEstate(next)
    assert.equal(await heldKindsDigest(), before, 'foreign rows identical after the next run restored')
  } finally {
    await sql(`DELETE FROM accounting_sync_logs WHERE id LIKE '${tag}%'`)
    await sql(`DELETE FROM accounting_tokens WHERE id LIKE '${tag}%'`)
    await sql(`DELETE FROM first_load_apply_runs WHERE id LIKE '${tag}%'`)
  }
})
