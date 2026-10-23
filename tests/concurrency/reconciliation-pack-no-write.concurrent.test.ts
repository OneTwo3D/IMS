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
  try {
    for (const [key, value] of [[keys.xero, 'true'], ['xero_inventory_account', codes.inventory], ['xero_allocated_inventory_account', codes.allocated], ['xero_transit_account', codes.transit], ['xero_cogs_account', codes.cogs], ['xero_unearned_revenue_account', codes.unearned], ['transit_ledger_coverage_start_date', '2026-01-01']] as const) await setting(key, value)
    await sql(`DELETE FROM accounting_tokens WHERE connector = 'xero'`)
    await sql(`INSERT INTO accounting_tokens (id, connector, "accessToken", "expiresAt", "tenantId", "updatedAt") VALUES ($1, 'xero', 'x', '2031-01-01', $2, now())`, [`${LTAG}-tok`, `${LTAG}-tenant`])
    const amounts: Record<string, [string, string]> = { inventory: ['100.50', '100.50'], allocated: ['20.25', '20.25'], transit: ['50', '50'], cogs: ['7', '7'], unearned: ['-30', '-30'] }
    for (const [kind, code] of Object.entries(codes)) {
      await sql(`INSERT INTO accounting_account_balance_snapshots (id, connector, "externalAccountId", "accountCode", "accountName", "balanceDate", currency, "amountForeign", "amountBase", "sourcePayloadRef", "tenantId", "updatedAt") VALUES ($1, 'xero', $2, $3, 'x', $4, 'GBP', $5, $5, $6, $7, now())`, [`${LTAG}-b-${kind}`, `${LTAG}-${kind}`, code, LD, amounts[kind]![0], `xero:trial-balance:${LD}`, `${LTAG}-tenant`])
    }
    await sql(`INSERT INTO accounting_account_balance_snapshots (id, connector, "externalAccountId", "accountCode", "accountName", "balanceDate", currency, "amountForeign", "amountBase", "sourcePayloadRef", "tenantId", "updatedAt") VALUES ($1, 'xero', $2, $3, 'x', '2026-03-04', 'GBP', 40, 40, 'xero:trial-balance:2026-03-04', $4, now())`, [`${LTAG}-b-open`, `${LTAG}-transit-open`, codes.transit, `${LTAG}-tenant`])
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
    await sql(`DELETE FROM accounting_tokens WHERE id LIKE '${LTAG}%'`)
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
  const { encryptSettingValue } = await import('../../lib/security/encrypted-settings.ts')
  const seen: Array<{ method: string; url: string; authorization: string | undefined }> = []
  const row = (id: number) => ({ id, status: 'processing', currency: 'GBP', total: '12.50', date_created_gmt: '2026-10-10T09:30:00', billing: { email: 'customer@example.com' } })
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization })
    const url = new URL(req.url ?? '/', 'http://x')
    const first = url.searchParams.get('page') === '1'
    const json = (body: unknown, total: number) => { res.writeHead(200, { 'content-type': 'application/json', 'x-wp-total': String(total), 'x-wp-totalpages': String(total ? 1 : 0) }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/wp-json/wc/v3/orders') return url.searchParams.get('status') === 'processing' ? json(first ? [row(9001), row(9002)] : [], 2) : json([], 0)
    if (url.pathname === '/wp-json/wc/v3/taxes') return json(first ? [{ id: 7001 }] : [], 1)
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
      const code = await runPackCli({ argv: ['--phase', 'P1', '--as-of', LD, '--items', 'R9,R13', '--report-dir', dir, ...extra], env: { DATABASE_URL: process.env.DATABASE_URL }, keepProcessEnv: true, uid: 0, checkoutOwnerUid: 0, repoRoot: process.cwd(), deps: { liveness: healthyLiveness() }, stdout: (t) => out.push(t), stderr: (t) => out.push(t) })
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

    // An order the store has and IMS lacks is a finding (the identity swap, with equal counts): R9 fails by id.
    await sql(`DELETE FROM shopping_order_links WHERE id = $1`, [`${VTAG}-l2`])
    await sql(`INSERT INTO shopping_order_links (id, "orderId", connector, "externalOrderId", "updatedAt") VALUES ($1, $2, 'woocommerce', '9003', now())`, [`${VTAG}-l2`, `${VTAG}-o2`])
    const swapped = await run(['--vendor-reads-only'])
    assert.equal(swapped.code, 1, swapped.out.join('\n'))
    assert.ok(swapped.out.includes('R9 fail DIFFERENCES'), swapped.out.join('\n'))
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
