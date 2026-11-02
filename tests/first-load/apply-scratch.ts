/**
 * A scratch PostgreSQL cluster of its own (loopback, private port, under the scratch root, /var/tmp unless IMS_SCRATCH_ROOT names a RAM disk), migrated and seeded, with the target configuration a first load needs: the warehouses the synthetic
 * manifest declares, a purchase tax rate, a stored EUR rate, and WooCommerce configured and enabled (so an effect the system actor fails to suppress would leave an outbox row).
 *
 * Shared by the verification and command-line tests. Not a `.test.ts` file. It touches no other cluster and no role of one.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { freePort, startCluster, type Cluster } from '../scripts/real-postgres-cluster'
import { databaseUrl, ident, inheritedEnv, randomHex, runChild, socketPsql, tail, withClient } from '../../scripts/rehearse-first-install'
import { RUNNER_APPLICATION_NAME } from '../../lib/first-load/apply/constants'
import { WAREHOUSES } from './apply-helpers'
import { seedXeroList } from './apply-xero-list'
import { scratchRoot } from '../helpers/scratch-root'

export const SETTINGS_KEY = 'prod_readiness_ci_settings_key__'
export const VAT_NAME = 'ZQSCR VAT 20'
const CHILD_TIMEOUT_MS = 6 * 60 * 1000

export interface Scratch {
  root: string
  cluster: Cluster
  port: number
  role: string
  password: string
  database: string
  url: string
  /** The environment a child process of the application gets for this database. */
  childEnv: Record<string, string>
  db: typeof import('@/lib/db')['db']
  sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  count(table: string): Promise<number>
  stop(): Promise<void>
}

export async function startScratch(prefix: string, database = 'ims_scratch'): Promise<Scratch> {
  // Every connection of the runner carries this application_name; the quiesce rail tells them from anybody else's by it. The command sets it before its first connection.
  process.env.PGAPPNAME = RUNNER_APPLICATION_NAME
  const repo = process.cwd()
  const root = mkdtempSync(join(scratchRoot(), `${prefix}-`))
  for (const dir of ['home', 'npm-cache', 'tmp']) mkdirSync(join(root, dir))
  writeFileSync(join(root, 'empty.env'), '')
  const port = await freePort()
  const cluster = startCluster(root, 'pg', port, '127.0.0.1')
  const role = `scratch_${randomHex(4)}`
  const password = randomHex(16)
  socketPsql(cluster, `create role ${ident(role)} superuser login password '${password}';\ncreate database ${ident(database)} owner ${ident(role)};\n`)
  const url = databaseUrl(role, password, port, database)
  const verified = await withClient(url, async (client) => (await client.query<{ db: string; port: number }>('select current_database() as db, inet_server_port() as port')).rows[0]!)
  assert.deepEqual(verified, { db: database, port }, 'precondition: connected to the throwaway database')
  console.log(`precondition: current_database()=${verified.db}, port=${verified.port}`)

  const childEnv: Record<string, string> = {
    ...inheritedEnv(root),
    DATABASE_URL: url,
    TMPDIR: join(root, 'tmp'),
    AUTH_SECRET: randomHex(16),
    CRON_SECRET: randomHex(16),
    SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY,
    NEXT_PUBLIC_APP_URL: 'https://ims-scratch.test',
    AUTH_URL: 'https://ims-scratch.test',
    PUBLIC_APP_URL: 'https://ims-scratch.test',
    IMS_SKIP_ENV_FILE: '1',
    DOTENV_CONFIG_PATH: join(root, 'empty.env'),
    DOTENV_CONFIG_QUIET: 'true',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    CHECKPOINT_DISABLE: '1',
    FILE_SCAN_MODE: 'disabled',
    E2E_TEST_MODE: '1',
  }
  const migrate = await runChild({ cmd: join(repo, 'node_modules/.bin/prisma'), args: ['migrate', 'deploy'], env: childEnv, cwd: repo, timeoutMs: CHILD_TIMEOUT_MS })
  assert.equal(migrate.exitCode, 0, `migrate failed: ${tail(migrate.stdout + migrate.stderr, 1500)}`)
  const seed = await runChild({ cmd: join(repo, 'node_modules/.bin/tsx'), args: ['prisma/seed.ts'], env: childEnv, cwd: repo, timeoutMs: CHILD_TIMEOUT_MS })
  assert.equal(seed.exitCode, 0, `seed failed: ${tail(seed.stdout + seed.stderr, 1500)}`)

  // This process uses the application's own client against the same throwaway database.
  Object.assign(process.env, { DATABASE_URL: url, SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY, AUTH_SECRET: childEnv.AUTH_SECRET, E2E_TEST_MODE: '1', IMS_SKIP_ENV_FILE: '1' })
  const db = (await import('@/lib/db')).db
  assert.equal((await db.$queryRaw<Array<{ d: string }>>`select current_database() as d`)[0]!.d, database, 'precondition: the application client points at the scratch database')

  for (const [code, profile] of Object.entries(WAREHOUSES)) {
    await db.warehouse.create({ data: { code, name: code, type: profile.type, availableForSale: profile.availableForSale, syncToStore: profile.syncToStore } })
  }
  await db.taxRate.create({ data: { name: VAT_NAME, rate: '0.2', usedFor: 'PURCHASE', active: true } })
  // The one rate the suppliers' purchaseTaxType NONE resolves to (exactly one active purchase-capable rate carries it).
  await db.taxRate.create({ data: { name: 'ZQSCR No VAT', rate: '0', usedFor: 'BOTH', accountingTaxType: 'NONE', active: true } })
  // Xero is the tax-rate master: the supplier tax rail holds the rates above to its stored list.
  await seedXeroList(db)
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.25', fetchedAt: new Date(Date.now() - 3_600_000) } })
  // The same rate as the synthetic ims-fx-rates list (tests/first-load/apply-helpers.ts), at its instant: the rail reads a rate as of the END OF THE ORDER'S CREATED DAY (the synthetic orders are created 2026-09-15).
  await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.25', fetchedAt: new Date('2026-09-10T06:00:00Z') } })
  const { serializeSettingValue } = await import('@/lib/settings-store')
  const { INTEGRATION_PLUGIN_SETTING_KEYS } = await import('@/lib/integration-plugin-keys')
  for (const [key, value] of [[INTEGRATION_PLUGIN_SETTING_KEYS.woocommerce, 'true'], ['wc_url', 'http://127.0.0.1:9'], ['wc_consumer_key', 'ck_scratch'], ['wc_consumer_secret', 'cs_scratch']] as const) {
    const stored = serializeSettingValue(key, value)
    await db.setting.upsert({ where: { key }, create: { key, value: stored }, update: { value: stored } })
  }

  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => withClient(url, async (client) => (await client.query(text, params)).rows as T[])
  return {
    root, cluster, port, role, password, database, url, childEnv, db, sql,
    count: async (table) => Number((await sql<{ n: string }>(`select count(*)::text as n from ${ident(table)}`))[0]!.n),
    stop: async () => {
      try { await db.$disconnect() } catch { /* the pool may already be closed */ }
      try { cluster.stop() } finally { rmSync(root, { recursive: true, force: true }) }
    },
  }
}

/** Empty every table the runner writes; warehouses, the organisation, tax and FX rows stay (they are the target's configuration). */
export async function resetLoadedData(s: Scratch): Promise<void> {
  await s.sql('truncate products, suppliers, product_categories, purchase_orders, stock_movements, first_load_apply_runs, activity_logs, integration_outbox, accounting_sync_logs, email_outbox restart identity cascade')
}
