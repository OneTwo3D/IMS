#!/usr/bin/env tsx
/**
 * WOOCOMMERCE INITIAL-IMPORT REHEARSAL (npm run rehearse:woo-import).
 *
 * Runs the REAL WooCommerce initial order import (lib/connectors/woocommerce/sync/initial-import.ts,
 * through importWcOrder and the allocation service) end to end against a LOCAL FAKE WooCommerce REST
 * server serving synthetic orders, into a throwaway PostgreSQL cluster of its own, and writes a report
 * (JSON and Markdown): orders fetched / imported / skipped with reason, the orders that imported but
 * cannot be allocated, R9 and R4 tallies, idempotency of a second pass, whether stock that lands later
 * is allocated to the waiting orders (OD-4), and the behaviour of the one-shot irreversible stamp.
 *
 * Usage:   npm run rehearse:woo-import -- [--root <dir>] [--report-dir <dir>]
 *   --root <dir>        parent directory for the throwaway cluster (default /var/tmp; refused on a
 *                       RAM-backed file system).
 *   --report-dir <dir>  where the report is written (default /var/tmp/ims-rehearsal-reports).
 *
 * Exit codes (documented once: docs/installation.md, "WooCommerce initial-import rehearsal"; the table
 * is WOO_IMPORT_EXIT in lib/ops/woo-import-rehearsal.ts and a test compares the two):
 *   0 GREEN   1 RED   2 refused to start   3 teardown incomplete
 *
 * SAFETY. The fake binds 127.0.0.1 on an ephemeral port and the connector reaches it through the
 * ordinary settings (wc_url and the two credential rows) in the throwaway database, with E2E_TEST_MODE=1
 * and no NODE_ENV=production, the only condition under which the connector's read path accepts a
 * loopback http URL. No real WooCommerce, Mintsoft or Xero host is ever named. The import is read-only:
 * no outbound-write grant exists in any environment this script builds, and the report proves that
 * no request other than GET reached the fake and that the outbound-write hold refused nothing. Every
 * child gets a whitelisted environment built from the throwaway cluster's own env file (mode 600, shredded
 * in the teardown, never on a command line); no webhook is registered (that is a POST, and the fake
 * records any).
 *
 * THE TEARDOWN RUNS IN A `finally`. It reuses the fresh-install rehearsal's (scripts/rehearse-first-install.ts).
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  writeSync,
  lstatSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type pg from 'pg'

import {
  type Assessment,
  type StepResult,
  RehearsalGuardError,
  assertNoConnectorEnv,
  assertThrowawayDatabaseUrl,
  assessOutboundStatus,
  redactSecrets,
} from '../lib/ops/first-install-rehearsal.ts'
import {
  ABANDONED_STATUSES,
  DECIDED_IMPORT_STATUSES,
  R4_QUANTITY_TOLERANCE,
  R9_VALUE_TOLERANCE,
  WOO_IMPORT_EXIT,
  WOO_IMPORT_EXIT_MEANING,
  WOO_STEP_CATALOGUE,
  type AllocationFact,
  type ImportedOrderFact,
  type LandingFacts,
  type OrderRow,
  type PassFacts,
  type R4Result,
  type SideEffects,
  type R9Result,
  type StampFacts,
  type StockRowFact,
  type StoreOrderFact,
  type WooImportReport,
  type WooStepDefinition,
  type WooStepId,
  assessIdempotency,
  assessLanding,
  assessNoStampAfterRehearsal,
  assessPassComplete,
  assessR4,
  assessR9,
  assessReadOnly,
  assessRealStamp,
  assessStatusSelection,
  buildWooImportReport,
  renderWooImportMarkdown,
} from '../lib/ops/woo-import-rehearsal.ts'
import {
  type ChildResult,
  type FileIdentity,
  type RunState,
  DirectoryReplacedError,
  RAM_BACKED,
  RUN_DIR_PREFIX,
  capturePostmaster,
  checkAncestors,
  databaseUrl,
  filesystemType,
  fsyncDirectory,
  getCurrentChild,
  ident,
  inheritedEnv,
  parseEnvFile,
  randomHex,
  runChild,
  socketPsql,
  tail,
  teardownRun,
  withClient,
  writeExclusive,
} from './rehearse-first-install.ts'
import { startFakeWooCommerce, type FakeWooCommerce } from '../tests/helpers/fake-woocommerce.ts'
import { SKU_STOCKED, SKU_UNSTOCKED, SKU_PLENTY, wooFixtureOrders, type FixtureOrder } from '../tests/fixtures/woo-import/orders.ts'
import { freePort, pgBinDir, startCluster } from '../tests/scripts/real-postgres-cluster.ts'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DEFAULT_PARENT = '/var/tmp'
const DEFAULT_REPORT_DIR = '/var/tmp/ims-rehearsal-reports'
const WOO_RUN_DIR_PREFIX = `${RUN_DIR_PREFIX}woo-`
const DATABASE = 'ims_woo_rehearsal'
const DRIVER = 'scripts/lib/woo-import-driver.ts'

/** Stock that lands AFTER the import, per SKU: B had none, C had 100 and the bulk orders ask for more. */
const LANDING = [
  { sku: SKU_STOCKED, qty: 100, unitCost: 4 },
  { sku: SKU_UNSTOCKED, qty: 10, unitCost: 4 },
  { sku: SKU_PLENTY, qty: 60, unitCost: 5 },
]

/** Seams for the rehearsal's own tests. The command line reaches none of them. */
export type WooRehearsalHooks = {
  beforeStep?: (id: WooStepId) => void | Promise<void>
  /** Runs once the cluster is up and before any step; throwing aborts the run. */
  afterClusterStart?: () => void | Promise<void>
  /** Runs after the first import pass, with a client on the throwaway database; a test tampers with the imported data here. */
  afterFirstPass?: (client: pg.Client) => Promise<void>
  /** Replaces the child step environment, so a test can plant a forbidden variable. */
  tamperStepEnv?: (id: WooStepId, env: Record<string, string>) => void
  /** Called with the fake store as soon as it is up, so a test can aim a rogue request at it. */
  onFakeStore?: (fake: FakeWooCommerce) => void | Promise<void>
  /** Runs just before the report is published. */
  beforePublish?: (outDir: string) => void
}

export type WooRehearsalOptions = {
  repoRoot?: string
  parentDir?: string
  reportDir?: string
  /** The store's orders. Default: the synthetic fixtures. */
  orders?: readonly FixtureOrder[]
  /** Fake-store fault injection (a test models a store that fails a page). */
  storeFaults?: { failPages?: readonly number[]; pastEnd?: 'empty' | 'error'; omitPaginationHeaders?: boolean }
  /** Run only these steps (tests); the rest are omitted from the report. */
  only?: ReadonlySet<WooStepId>
  hooks?: WooRehearsalHooks
  log?: (line: string) => void
}

export type WooRehearsalOutcome = {
  exitCode: number
  report: WooImportReport | null
  refusal?: string
  reportPaths?: { json: string; markdown: string }
  reportWriteError?: string
  runRoot?: string
}

/** What a driver phase prints on its REHEARSAL_DRIVER line (scripts/lib/woo-import-driver.ts); every field optional because each phase prints its own. */
type DriverPayload = {
  outcome?: string
  stamped?: boolean
  statuses?: string[]
  unrecordedRefusals?: number
  progress?: { activeOrdersImported?: number; activeOrdersSkipped?: number; errors?: string[] }
  stampBefore?: StampFacts
  stampAfter?: StampFacts
  openingStock?: unknown
  externalOrderIds?: number[]
  beforeLanding?: string[]
  afterLandingBeforeTrigger?: string[]
  afterBackorderAllocator?: string[]
  afterSweep?: string[]
  statusByOrder?: Record<string, string>
  backorders?: { allocated?: number; skipped?: number; errors?: number }
  sweep?: unknown
  threw?: string | null
  progressBefore?: string
  progressAfter?: string
}

type StepOutcome = { status: 'passed' | 'failed'; reason?: string; detail?: Record<string, unknown>; required?: boolean; skipped?: boolean }

function refuse(message: string): WooRehearsalOutcome {
  return { exitCode: WOO_IMPORT_EXIT.REFUSED, report: null, refusal: message }
}

const num = (value: unknown): number => Number(value ?? 0)

/** A field a driver phase must have printed: its absence is a failure of the step (it throws), never a default. */
function need<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) throw new Error(`the driver did not report ${name}`)
  return value
}

export async function runWooImportRehearsal(options: WooRehearsalOptions = {}): Promise<WooRehearsalOutcome> {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const parentDir = path.resolve(options.parentDir ?? DEFAULT_PARENT)
  const reportDir = path.resolve(options.reportDir ?? DEFAULT_REPORT_DIR)
  const hooks = options.hooks ?? {}
  const log = options.log ?? ((line: string) => console.error(line))
  const fixtures = options.orders ?? wooFixtureOrders()

  // ---- Refusals: nothing has been created yet. ----
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return refuse('refusing to run as root: initdb will not, and the rehearsal must not own an IMS tree. Run it as the account that owns the checkout.')
  }
  try {
    pgBinDir()
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) return refuse(`--root ${parentDir} is not a directory`)
  const rootAncestors = checkAncestors(parentDir, '--root')
  if (rootAncestors !== null) return refuse(rootAncestors)
  try {
    const parentType = filesystemType(parentDir)
    if (RAM_BACKED.has(parentType)) return refuse(`${parentDir} is on ${parentType}: a cluster there is held in RAM. Use a disk-backed directory such as /var/tmp.`)
  } catch (error) {
    return refuse(`cannot determine the file-system type of ${parentDir}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let reportDirId: FileIdentity | null = null
  try {
    mkdirSync(reportDir, { recursive: true, mode: 0o700 })
    accessSync(reportDir, fsConstants.W_OK)
    const info = lstatSync(reportDir)
    if (!info.isDirectory()) throw new Error('it is not a real directory (a symlink is refused)')
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('it is not owned by the account running the rehearsal')
    if ((info.mode & 0o022) !== 0) throw new Error('it is writable by group or others')
    reportDirId = { dev: info.dev, ino: info.ino }
  } catch (error) {
    return refuse(`--report-dir ${reportDir} cannot be created or written: ${error instanceof Error ? error.message : String(error)}`)
  }
  const reportAncestors = checkAncestors(reportDir, '--report-dir')
  if (reportAncestors !== null) return refuse(reportAncestors)
  for (const needed of ['prisma/schema.prisma', 'node_modules/.bin/prisma', 'node_modules/.bin/tsx', DRIVER]) {
    if (!existsSync(path.join(repoRoot, needed))) return refuse(`${needed} not found under ${repoRoot}: run from an IMS checkout with its dependencies installed and prisma generated`)
  }

  // ---- State ----
  const startedAt = new Date()
  const root = mkdtempSync(path.join(parentDir, WOO_RUN_DIR_PREFIX))
  chmodSync(root, 0o700)
  const runId = path.basename(root)
  const password = randomHex(24)
  const authSecret = randomHex(32)
  const cronSecret = randomHex(32)
  const settingsKey = randomHex(32)
  const storeKey = `ck_${randomHex(16)}`
  const storeSecret = `cs_${randomHex(16)}`
  const state: RunState = {
    root,
    envFile: path.join(root, 'rehearsal.env'),
    envFileId: null,
    cluster: null,
    postmasterPid: null,
    postmaster: null,
    role: null,
    password,
    secrets: [password, authSecret, cronSecret, settingsKey, storeKey, storeSecret],
    teardown: null,
  }
  const notes: string[] = []
  const results: StepResult[] = []
  let abortReason: string | null = null
  let postgresServer: string | null = null
  let scramVerified = false
  let port: number | null = null
  let fake: FakeWooCommerce | null = null

  // ---- Facts the steps hand to each other ----
  const storeFacts: StoreOrderFact[] = fixtures.map(({ order, expectation }) => ({
    id: order.id,
    status: order.status,
    currency: order.currency,
    total: order.total,
    fxPerGbp: order.currency === 'EUR' ? 1.25 : 1,
    expectation,
  }))
  const knownBadIds = storeFacts.filter((o) => o.expectation === 'fails-to-import' && (DECIDED_IMPORT_STATUSES as readonly string[]).includes(o.status)).map((o) => o.id)
  let firstPass = null as (PassFacts & { stampBefore: StampFacts; stampAfter: StampFacts; stamped: boolean }) | null
  let secondPass = null as PassFacts | null
  let importedFacts: ImportedOrderFact[] = []
  let r9 = null as R9Result | null
  let r4 = null as R4Result | null
  let r4AfterLanding = null as R4Result | null
  let landing = null as LandingFacts | null
  let allocationAtImport = new Map<number, AllocationFact>()
  const findings: WooImportReport['findings'] = []
  let stampAfterRealPass = null as StampFacts | null
  let readOnly = null as ReturnType<typeof assessReadOnly> | null
  let unallocatable: WooImportReport['unallocatable'] = []
  let counts = { ordersFirst: 0, linesFirst: 0 }
  let fetchedFirstPass = null as number | null
  let sideEffects = null as SideEffects | null
  let abortedRows: OrderRow[] = []

  let interrupted: string | null = null
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted === null) {
      interrupted = signal
      notes.push(`The rehearsal was interrupted by ${signal}: the running step was stopped and the remaining steps were not run.`)
      log(`[woo-rehearsal] ${signal}: stopping the running step; the report and teardown will still complete`)
      const child = getCurrentChild()
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
      }
      return
    }
    log(`[woo-rehearsal] second ${signal}: tearing down now, without a report`)
    teardownRun(state)
    process.exit(WOO_IMPORT_EXIT.TEARDOWN_INCOMPLETE)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const redact = (text: string) => redactSecrets(text, state.secrets)
  const included = (def: WooStepDefinition) => (options.only ? options.only.has(def.id) : true)

  try {
    // ---- Cluster: its own directory, port, superuser role and scram password auth. ----
    port = await freePort()
    state.cluster = startCluster(root, 'pg', port, '127.0.0.1')
    const cluster = state.cluster
    state.postmaster = capturePostmaster(cluster.data)
    if (state.postmaster === null) throw new Error('the postmaster could not be identified from its data directory')
    state.postmasterPid = state.postmaster.pid
    log(`[woo-rehearsal] cluster up: port ${port}, postmaster pid ${state.postmasterPid}, directory ${root}`)
    await hooks.afterClusterStart?.()

    const role = `rehearsal_${randomHex(4)}`
    state.role = role
    socketPsql(cluster, `create role ${ident(role)} superuser login password '${password}';\n`)
    socketPsql(cluster, `create database ${ident(DATABASE)} owner ${ident(role)};\n`)
    postgresServer = socketPsql(cluster, 'show server_version;')
    const encryption = socketPsql(cluster, 'show password_encryption;')
    const stored = socketPsql(cluster, `select rolpassword like 'SCRAM-SHA-256$%' from pg_authid where rolname = '${role}';`)
    const hostRules = socketPsql(cluster, `select string_agg(distinct auth_method, ',') from pg_hba_file_rules where type like 'host%';`)
    scramVerified = encryption === 'scram-sha-256' && stored === 't' && hostRules === 'scram-sha-256'
    if (!scramVerified) throw new Error(`the throwaway cluster is not scram-only: password_encryption=${encryption}, stored scram=${stored}, host auth methods=${hostRules}`)

    const target = { host: '127.0.0.1', port, user: role, databases: [DATABASE] as const }
    const sourceUrl = databaseUrl(role, password, port, DATABASE)

    // ---- The fake store: loopback, ephemeral port, nothing else. ----
    fake = await startFakeWooCommerce({ orders: fixtures.map((f) => f.order), key: storeKey, secret: storeSecret, ...options.storeFaults })
    if (!fake.url.startsWith('http://127.0.0.1:')) throw new Error(`the fake store is not on loopback: ${fake.url}`)
    log(`[woo-rehearsal] fake WooCommerce on ${fake.url} serving ${fixtures.length} order(s)`)
    await hooks.onFakeStore?.(fake)

    // ---- The mode-600 env file: created with the mode, never on a command line. ----
    const stateDir = path.join(root, 'state')
    mkdirSync(path.join(root, 'tmp'), { recursive: true })
    mkdirSync(path.join(root, 'home'), { recursive: true })
    mkdirSync(path.join(root, 'npm-cache'), { recursive: true })
    for (const sub of ['public/avatars', 'public/branding', 'private/invoices', 'private/quarantine/invoices', 'invoices', 'backups']) {
      mkdirSync(path.join(stateDir, sub), { recursive: true })
    }
    // No NODE_ENV: the connector accepts a loopback http URL only when it is not 'production', and
    // E2E_TEST_MODE=1. The store's own address and credentials are named REHEARSAL_STORE_*, which the
    // forbidden-environment guard (WC_*, WOO*, MINTSOFT*, XERO*, ...) does not match: they reach the
    // driver, which writes them into the throwaway database as the ordinary connection settings.
    const envEntries: Record<string, string> = {
      DATABASE_URL: sourceUrl,
      TMPDIR: path.join(root, 'tmp'),
      AUTH_SECRET: authSecret,
      CRON_SECRET: cronSecret,
      SETTINGS_ENCRYPTION_KEY: settingsKey,
      NEXT_PUBLIC_APP_URL: 'https://ims-rehearsal.test',
      AUTH_URL: 'https://ims-rehearsal.test',
      PUBLIC_APP_URL: 'https://ims-rehearsal.test',
      UPLOAD_STORAGE_DIR: path.join(stateDir, 'private'),
      PUBLIC_UPLOAD_STORAGE_DIR: path.join(stateDir, 'public'),
      INVOICE_PDF_STORAGE_DIR: path.join(stateDir, 'invoices'),
      BACKUP_DIR: path.join(stateDir, 'backups'),
      FILE_SCAN_MODE: 'disabled',
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      IMS_SKIP_ENV_FILE: '1',
      DOTENV_CONFIG_PATH: path.join(root, 'empty.env'),
      DOTENV_CONFIG_QUIET: 'true',
      E2E_TEST_MODE: '1',
      REHEARSAL_STORE_URL: fake.url,
      REHEARSAL_STORE_KEY: storeKey,
      REHEARSAL_STORE_SECRET: storeSecret,
      REHEARSAL_STORE_STATUSES: JSON.stringify([...DECIDED_IMPORT_STATUSES]),
      REHEARSAL_LANDING: JSON.stringify(LANDING),
    }
    writeFileSync(path.join(root, 'empty.env'), '', { flag: 'wx' })
    {
      const fd = openSync(state.envFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      try {
        writeSync(fd, `${Object.entries(envEntries).map(([k, v]) => `${k}=${v}`).join('\n')}\n`)
        fsyncSync(fd)
        const info = fstatSync(fd)
        if ((info.mode & 0o777) !== 0o600) throw new Error('the env file is not mode 600')
        state.envFileId = { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs }
      } finally {
        closeSync(fd)
      }
    }
    const fileEnv = parseEnvFile(state.envFile)
    if (process.env.DATABASE_URL) notes.push("An inherited DATABASE_URL was present and was IGNORED: every step used the throwaway cluster's own URL.")

    assertThrowawayDatabaseUrl(fileEnv.DATABASE_URL, target)
    const identity = await withClient(fileEnv.DATABASE_URL!, async (client) => {
      const row = await client.query<{ db: string; port: number; dir: string }>(`select current_database() as db, inet_server_port() as port, current_setting('data_directory') as dir`)
      return row.rows[0]!
    })
    if (identity.db !== DATABASE || identity.port !== port || realpathSync(identity.dir) !== realpathSync(cluster.data)) {
      throw new Error(`connected to the wrong server: database ${identity.db}, port ${identity.port}, data directory ${identity.dir}`)
    }
    log(`[woo-rehearsal] verified: current_database()=${identity.db}, inet_server_port()=${identity.port}, data_directory=${identity.dir}`)

    // ---- Steps ----
    const stepEnv = (id: WooStepId): Record<string, string> => {
      const env = { ...inheritedEnv(root), ...fileEnv }
      hooks.tamperStepEnv?.(id, env)
      assertThrowawayDatabaseUrl(env.DATABASE_URL, target)
      assertNoConnectorEnv(env)
      return env
    }
    const bin = (name: string) => path.join(repoRoot, 'node_modules', '.bin', name)
    const childIn = async (id: WooStepId, cmd: string, args: string[]): Promise<ChildResult> => {
      const result = await runChild({ cmd, args, env: stepEnv(id), cwd: repoRoot })
      return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) }
    }
    const outputTail = (result: ChildResult) => tail(`${result.stdout}\n${result.stderr}`.trim(), 1500)
    const db = <T>(fn: (client: pg.Client) => Promise<T>) => {
      assertThrowawayDatabaseUrl(sourceUrl, target)
      return withClient(sourceUrl, fn)
    }
    const driver = async (id: WooStepId, phase: string): Promise<{ run: ChildResult; payload: DriverPayload | null }> => {
      const run = await childIn(id, bin('tsx'), [DRIVER, phase])
      const line = run.stdout.split('\n').find((candidate) => candidate.startsWith('REHEARSAL_DRIVER '))
      let payload: DriverPayload | null = null
      if (line) {
        try { payload = JSON.parse(line.slice('REHEARSAL_DRIVER '.length)) } catch { payload = null }
      }
      return { run, payload }
    }
    const asPass = (payload: DriverPayload): PassFacts => ({
      outcome: String(payload.outcome),
      imported: num(payload.progress?.activeOrdersImported),
      skipped: num(payload.progress?.activeOrdersSkipped),
      errors: (payload.progress?.errors ?? []) as string[],
      unrecordedRefusals: num(payload.unrecordedRefusals),
      statuses: (payload.statuses ?? []) as string[],
    })

    const readImported = (client: pg.Client): Promise<ImportedOrderFact[]> =>
      client.query(`
        select l."externalOrderId", so.id as "salesOrderId", so.status::text as status, so.currency, so."totalForeign"::float8 as "totalForeign",
               so."totalBase"::float8 as "totalBase", so."subtotalForeign"::float8 as "subtotalForeign", so."taxForeign"::float8 as "taxForeign",
               so."shippingForeign"::float8 as "shippingForeign", coalesce(so."discountAmount", 0)::float8 as "orderLevelDiscountForeign",
               (so."customerId" is not null) as "hasCustomer",
               (select coalesce(sum(sol."totalForeign"), 0)::float8 from sales_order_lines sol where sol."orderId" = so.id) as "lineTotalForeignSum",
               (select count(*)::int from sales_order_lines sol where sol."orderId" = so.id) as "lineCount",
               (select count(*)::int from sales_order_lines sol where sol."orderId" = so.id and sol."productId" is null) as "linesWithoutProduct"
          from shopping_order_links l join sales_orders so on so.id = l."orderId"
         where l.connector = 'woocommerce' order by l."externalOrderId"::bigint`)
        .then((r) => r.rows.map((row) => ({ ...row, externalOrderId: Number(row.externalOrderId) }) as ImportedOrderFact))

    const readStockRows = (client: pg.Client): Promise<StockRowFact[]> =>
      client.query(`
        select sl."productId", p.sku, sl."warehouseId", sl."reservedQty"::float8 as "reservedQty",
               coalesce((select sum(oa.qty) from order_allocations oa where oa."productId" = sl."productId" and oa."warehouseId" = sl."warehouseId"), 0)::float8 as "allocationSum"
          from stock_levels sl join products p on p.id = sl."productId" order by p.sku`)
        .then((r) => r.rows as StockRowFact[])

    const countOrders = (client: pg.Client) =>
      client.query(`select (select count(*)::int from sales_orders) as orders, (select count(*)::int from sales_order_lines) as lines`).then((r) => ({ orders: num(r.rows[0].orders), lines: num(r.rows[0].lines) }))

    const readAllocation = (client: pg.Client): Promise<Map<number, AllocationFact>> =>
      client.query(`
        select l."externalOrderId", so.status::text as "imsStatus", so."orderNumber",
               (select count(*)::int from sales_order_lines sol where sol."orderId" = so.id and sol."productId" is null) as "noProductLines",
               (select count(*)::int from sales_order_lines sol where sol."orderId" = so.id and sol."productId" is not null
                   and sol.qty > coalesce((select sum(oa.qty) from order_allocations oa where oa."lineId" = sol.id), 0) + 0.0001) as "shortLines",
               (select coalesce(sum(sol.qty - coalesce((select sum(oa.qty) from order_allocations oa where oa."lineId" = sol.id), 0)), 0)::float8
                  from sales_order_lines sol where sol."orderId" = so.id and sol."productId" is not null
                   and sol.qty > coalesce((select sum(oa.qty) from order_allocations oa where oa."lineId" = sol.id), 0) + 0.0001) as "shortQty"
          from shopping_order_links l join sales_orders so on so.id = l."orderId" where l.connector = 'woocommerce'`)
        .then((r) => new Map(r.rows.map((row) => [Number(row.externalOrderId), { imsStatus: String(row.imsStatus), orderNumber: String(row.orderNumber), noProductLines: num(row.noProductLines), shortLines: num(row.shortLines), shortQty: Math.round(num(row.shortQty) * 10_000) / 10_000 }])))

    const runStep = async (def: WooStepDefinition, body: () => Promise<StepOutcome>): Promise<boolean> => {
      if (!included(def)) return true
      const began = Date.now()
      let outcome: StepOutcome
      try {
        await hooks.beforeStep?.(def.id)
        outcome = await body()
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error))
        outcome = { status: 'failed', reason: `${error instanceof RehearsalGuardError ? 'GUARD: ' : 'threw: '}${message}` }
      }
      const result: StepResult = {
        id: def.id as unknown as StepResult['id'],
        item: 0,
        title: def.title,
        required: outcome.required ?? true,
        status: outcome.skipped ? 'skipped' : outcome.status,
        reason: outcome.reason,
        detail: outcome.detail ?? {},
        durationMs: Date.now() - began,
      }
      results.push(result)
      log(`[woo-rehearsal] ${def.id}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`)
      return result.status === 'passed' || !def.prerequisite
    }
    const verdictOf = (assessment: Assessment, detail: Record<string, unknown> = {}): StepOutcome => ({
      status: assessment.ok ? 'passed' : 'failed',
      reason: assessment.ok ? undefined : assessment.failures.join('; '),
      detail,
    })

    const stepBodies: Record<WooStepId, () => Promise<StepOutcome>> = {
      'migrate-deploy': async () => {
        const run = await childIn('migrate-deploy', bin('prisma'), ['migrate', 'deploy'])
        const applied = await db(async (client) => num((await client.query('select count(*)::int as n from _prisma_migrations where finished_at is not null and rolled_back_at is null')).rows[0].n))
        const ok = run.exitCode === 0 && applied > 0
        return { status: ok ? 'passed' : 'failed', reason: ok ? undefined : `exit ${run.exitCode}; ${applied} migration(s) applied. ${outputTail(run)}`, detail: { migrationsApplied: applied } }
      },
      seed: async () => {
        const run = await childIn('seed', bin('tsx'), ['prisma/seed.ts'])
        return { status: run.exitCode === 0 ? 'passed' : 'failed', reason: run.exitCode === 0 ? undefined : `exit ${run.exitCode}. ${outputTail(run)}` }
      },
      prepare: async () => {
        const { run, payload } = await driver('prepare', 'prepare')
        if (run.exitCode !== 0 || payload === null) return { status: 'failed', reason: `the driver did not report (exit ${run.exitCode}). ${outputTail(run)}` }
        // Precondition for "no allocation was hand-seeded": nothing is reserved or allocated yet.
        const pre = await db((client) => client.query(`select (select count(*)::int from order_allocations) as allocations, (select count(*)::int from sales_orders) as orders, (select coalesce(sum("reservedQty"), 0)::float8 from stock_levels) as reserved`).then((r) => r.rows[0]))
        const clean = num(pre.allocations) === 0 && num(pre.orders) === 0 && num(pre.reserved) === 0
        return { status: clean ? 'passed' : 'failed', reason: clean ? undefined : `fixtures left allocations=${pre.allocations}, orders=${pre.orders}, reserved=${pre.reserved}`, detail: { openingStock: payload.openingStock, allocationsBeforeImport: num(pre.allocations), ordersBeforeImport: num(pre.orders) } }
      },
      'outbound-held-before': async () => {
        const run = await childIn('outbound-held-before', 'npm', ['run', 'outbound:status', '--', '--json', '--expect-held'])
        return verdictOf(assessOutboundStatus(run), { output: tail(run.stdout, 800) })
      },
      'rehearsal-import': async () => {
        const { run, payload } = await driver('rehearsal-import', 'import-rehearsal')
        if (run.exitCode !== 0 || payload === null) return { status: 'failed', reason: `the driver did not report (exit ${run.exitCode}). ${outputTail(run)}` }
        const parsed = { ...asPass(payload), stampBefore: need(payload.stampBefore, 'stampBefore'), stampAfter: need(payload.stampAfter, 'stampAfter'), stamped: payload.stamped === true }
        firstPass = parsed
        await db(async (client) => {
          await hooks.afterFirstPass?.(client)
          importedFacts = await readImported(client)
          const c = await countOrders(client)
          counts = { ordersFirst: c.orders, linesFirst: c.lines }
        })
        sideEffects = await db(async (client): Promise<SideEffects> => {
          const one = async (sql: string): Promise<number> => { try { return num((await client.query(sql)).rows[0].n) } catch { return -1 } }
          const queue = await client.query(`select type::text || '/' || status::text as k, count(*)::int as n from accounting_sync_logs group by 1 order by 1`).catch(() => ({ rows: [] as Array<{ k: string; n: number }> }))
          return {
            customersCreated: await one('select count(*)::int as n from customers'),
            customerLinksCreated: await one(`select count(*)::int as n from shopping_customer_links where connector = 'woocommerce'`),
            ordersWithoutCustomer: await one('select count(*)::int as n from sales_orders where "customerId" is null'),
            linesLinkedToProduct: await one('select count(*)::int as n from sales_order_lines where "productId" is not null'),
            linesWithoutProduct: await one('select count(*)::int as n from sales_order_lines where "productId" is null'),
            ordersWithTaxRateFallback: await one(`select count(distinct "entityId")::int as n from activity_logs where action = 'tax_rate_fallback'`),
            accountingQueue: Object.fromEntries(queue.rows.map((row) => [row.k, row.n])),
            stockSyncJobs: await one('select count(*)::int as n from stock_sync_jobs'),
            integrationOutbox: await one('select count(*)::int as n from integration_outbox'),
            emailOutbox: await one('select count(*)::int as n from email_outbox'),
          }
        })
        fetchedFirstPass = fake!.requests.filter((r) => r.path.endsWith('/orders')).reduce((sum, r) => sum + (r.returned ?? 0), 0)
        const dbOrders = importedFacts.length
        return { status: 'passed', detail: { outcome: parsed.outcome, imported: parsed.imported, skipped: parsed.skipped, errors: parsed.errors.length, ordersInIms: dbOrders, requestsSoFar: fake!.requests.length } }
      },
      'status-selection': async () => verdictOf(assessStatusSelection(firstPass?.statuses ?? []), { resolved: firstPass?.statuses ?? [] }),
      'pass-complete': async () => {
        if (firstPass!.outcome === 'complete' && firstPass!.errors.length > 0) {
          findings.push({
            code: 'pass-complete-with-orders-that-did-not-import',
            text: `The pass ended COMPLETE although ${firstPass!.errors.length} order(s) did not import (${firstPass!.errors.map((e) => tail(e, 160)).join(' | ')}). A real pass would stamp completion and move the sync cursor past them; only an order with a durable retry row (the pending-FX queue) is recoverable afterwards. R9 checks that each such order has one.`,
            orders: knownBadIds.map(String),
          })
        }
        return verdictOf(assessPassComplete(firstPass!, knownBadIds), { outcome: firstPass!.outcome, errors: firstPass!.errors.map((e) => tail(e, 300)) })
      },
      'no-stamp-on-rehearsal': async () => verdictOf(assessNoStampAfterRehearsal({ before: firstPass!.stampBefore, after: firstPass!.stampAfter, stampedFlag: firstPass!.stamped }), { before: firstPass!.stampBefore, after: firstPass!.stampAfter }),
      'r9-orders': async () => {
        const allocation = await db(readAllocation)
        const retryRun = await driver('r9-orders', 'retry-rows')
        if (retryRun.payload === null) return { status: 'failed', reason: `the driver did not report the retry rows (exit ${retryRun.run.exitCode}). ${outputTail(retryRun.run)}` }
        const retry = new Set<number>(retryRun.payload.externalOrderIds as number[])
        allocationAtImport = allocation
        r9 = assessR9({ store: storeFacts, imported: importedFacts, selectedStatuses: firstPass!.statuses, allocation, retryRecorded: retry })
        abortedRows = r9.rows
        return verdictOf(r9.assessment, { expected: r9.expectedCount, imported: r9.importedCount, knownBad: r9.knownBadCount, maxValueDiffForeign: r9.maxValueDiffForeign, maxValueDiffBase: r9.maxValueDiffBase, maxComponentsDiff: r9.maxComponentsDiff, tolerance: R9_VALUE_TOLERANCE })
      },
      'r4-reservations': async () => {
        r4 = assessR4(await db(readStockRows))
        return verdictOf(r4.assessment, { rowsChecked: r4.rowsChecked, rowsWithReservations: r4.rowsWithReservations, worstDiff: r4.worstDiff, tolerance: R4_QUANTITY_TOLERANCE })
      },
      'allocations-derived': async () => {
        // Nothing in this harness writes an allocation row: the driver only creates products, stock levels
        // (through the opening-stock path), settings, tax mappings and an FX rate. The check that matters
        // is therefore that every allocation row that exists carries the product's CURRENT fulfilment graph
        // version (dispatch refuses any row whose version differs) and belongs to an order and line of the
        // import, i.e. the allocation service stamped it.
        const facts = await db((client) => client.query(`
          select count(*)::int as total,
                 count(*) filter (where oa.fulfillment_graph_version <> p.fulfillment_graph_version)::int as stale,
                 count(*) filter (where l."externalOrderId" is null)::int as "notFromImport"
            from order_allocations oa join products p on p.id = oa."productId"
            left join shopping_order_links l on l."orderId" = oa."orderId" and l.connector = 'woocommerce'`).then((r) => r.rows[0]))
        const ok = num(facts.total) > 0 && num(facts.stale) === 0 && num(facts.notFromImport) === 0
        return { status: ok ? 'passed' : 'failed', reason: ok ? undefined : `allocation rows: ${facts.total}, with a stale graph version: ${facts.stale}, not from an imported order: ${facts.notFromImport}`, detail: { allocationRows: num(facts.total), staleGraphVersion: num(facts.stale), notFromImport: num(facts.notFromImport) } }
      },
      'unallocatable-list': async () => {
        unallocatable = [...allocationAtImport.entries()]
          .filter(([, fact]) => fact.noProductLines > 0 || fact.shortLines > 0)
          .sort(([x], [y]) => x - y)
          .map(([externalOrderId, fact]) => ({ externalOrderId, orderNumber: fact.orderNumber, imsStatus: fact.imsStatus, noProductLines: fact.noProductLines, shortLines: fact.shortLines, shortQty: fact.shortQty, afterLanding: 'not-run' as const }))
        // The list is recorded whatever it holds; this step fails only if the fixtures promised some
        // and the list is empty (the rehearsal would then be examining nothing).
        const promised = fixtures.filter((f) => f.expectation === 'imports-with-unallocatable-lines').length
        const ok = promised === 0 || unallocatable.length > 0
        return { status: ok ? 'passed' : 'failed', reason: ok ? undefined : `the fixtures promise ${promised} order(s) with unallocatable lines and none was found`, detail: { listed: unallocatable.length, withNoProductLine: unallocatable.filter((r) => r.noProductLines > 0).length, shortOfStock: unallocatable.filter((r) => r.shortLines > 0).length, promisedByFixtures: promised } }
      },
      'idempotent-second-pass': async () => {
        const { run, payload } = await driver('idempotent-second-pass', 'import-rehearsal')
        if (run.exitCode !== 0 || payload === null) return { status: 'failed', reason: `the driver did not report (exit ${run.exitCode}). ${outputTail(run)}` }
        secondPass = asPass(payload)
        const after = await db(countOrders)
        return verdictOf(assessIdempotency({ first: firstPass!, second: secondPass, ordersAfterFirst: counts.ordersFirst, ordersAfterSecond: after.orders, linesAfterFirst: counts.linesFirst, linesAfterSecond: after.lines, knownBadCount: knownBadIds.length }), { secondImported: secondPass.imported, secondSkipped: secondPass.skipped, secondErrors: secondPass.errors.length, ordersAfterSecond: after.orders })
      },
      'stock-lands-later': async () => {
        const { run, payload } = await driver('stock-lands-later', 'land-stock')
        if (run.exitCode !== 0 || payload === null) return { status: 'failed', reason: `the driver did not report (exit ${run.exitCode}). ${outputTail(run)}` }
        const facts: LandingFacts = { beforeLanding: need(payload.beforeLanding, 'beforeLanding'), afterLandingBeforeTrigger: need(payload.afterLandingBeforeTrigger, 'afterLandingBeforeTrigger'), afterBackorderAllocator: need(payload.afterBackorderAllocator, 'afterBackorderAllocator'), afterSweep: need(payload.afterSweep, 'afterSweep'), statusByOrder: need(payload.statusByOrder, 'statusByOrder') }
        landing = facts
        const after = await db(async (client) => ({ stock: await readStockRows(client), allocation: await readAllocation(client) }))
        r4AfterLanding = assessR4(after.stock)
        const landed = assessLanding(facts)
        const failures = [...landed.assessment.failures, ...r4AfterLanding.assessment.failures.map((f) => `R4 after landing: ${f}`)]
        unallocatable = unallocatable.map((row) => {
          const now = after.allocation.get(row.externalOrderId)
          const stillShort = (now?.shortLines ?? 0) > 0
          return { ...row, afterLanding: stillShort ? ('still-waiting' as const) : row.shortLines > 0 ? ('allocated-when-stock-landed' as const) : ('never-allocatable-lines-without-product' as const) }
        })
        if (landed.notPickedUp.length > 0) {
          findings.push({
            code: 'imported-short-orders-outside-processing-are-not-allocated-when-stock-lands',
            text: `${landed.notPickedUp.length} imported order(s) were short of stock at import and are still unallocated after stock landed and both the backorder allocator and the reallocation sweep ran, because both act only on PROCESSING and ALLOCATED orders (${[...new Set(landed.notPickedUp.map((o) => o.imsStatus))].join(', ')} here). An open WooCommerce order in on-hold or pending status that imports short of stock waits until something moves it.`,
            orders: landed.notPickedUp.map((o) => o.orderNumber),
          })
        }
        const withoutProduct = unallocatable.filter((row) => row.noProductLines > 0)
        if (withoutProduct.length > 0) {
          findings.push({ code: 'lines-without-product-are-never-allocatable', text: `${withoutProduct.length} imported order(s) carry a line with no product link (a SKU IMS does not hold, a line with no SKU, or a fee). No stock landing allocates such a line; the SKU must exist in IMS (and the line be re-linked) before it can.`, orders: withoutProduct.map((r) => String(r.externalOrderId)) })
        }
        return { status: failures.length === 0 ? 'passed' : 'failed', reason: failures.length === 0 ? undefined : failures.join('; '), detail: { waitingBefore: facts.beforeLanding.length, afterBareLanding: facts.afterLandingBeforeTrigger.length, afterBackorderAllocator: facts.afterBackorderAllocator.length, afterSweep: facts.afterSweep.length, pickedUp: landed.pickedUp.length, notPickedUp: landed.notPickedUp, backorders: { allocated: payload.backorders?.allocated, skipped: payload.backorders?.skipped, errors: payload.backorders?.errors }, sweep: payload.sweep } }
      },
      'real-pass-stamps': async () => {
        const { run, payload } = await driver('real-pass-stamps', 'import-real')
        if (run.exitCode !== 0 || payload === null) return { status: 'failed', reason: `the driver did not report (exit ${run.exitCode}). ${outputTail(run)}` }
        const pass = asPass(payload)
        const stampBefore = need(payload.stampBefore, 'stampBefore')
        const stampAfter = need(payload.stampAfter, 'stampAfter')
        stampAfterRealPass = stampAfter
        const stamp = assessRealStamp({ before: stampBefore, after: stampAfter, stampedFlag: payload.stamped === true, outcome: pass.outcome })
        const failures = [...stamp.failures]
        // The real pass runs on top of the imported set: it must create no order.
        if (pass.imported !== 0) failures.push(`the real pass imported ${pass.imported} order(s) on top of an already imported set`)
        return { status: failures.length === 0 ? 'passed' : 'failed', reason: failures.length === 0 ? undefined : failures.join('; '), detail: { stampBefore, stampAfter, outcome: pass.outcome } }
      },
      'start-declines-after-stamp': async () => {
        const { run, payload } = await driver('start-declines-after-stamp', 'try-start')
        if (run.exitCode !== 0 || payload === null) return { status: 'failed', reason: `the driver did not report (exit ${run.exitCode}). ${outputTail(run)}` }
        const failures: string[] = []
        if (payload.threw !== null) failures.push(`the button's entry point threw after the stamp: ${tail(String(payload.threw), 200)} (it should return without scheduling anything)`)
        if (payload.progressAfter === 'running') failures.push('the button scheduled a pass although the stamp was set')
        if (payload.progressAfter !== payload.progressBefore) failures.push(`the progress row changed from ${payload.progressBefore} to ${payload.progressAfter}`)
        return { status: failures.length === 0 ? 'passed' : 'failed', reason: failures.length === 0 ? undefined : failures.join('; '), detail: { progressBefore: payload.progressBefore, progressAfter: payload.progressAfter } }
      },
      'read-only-proof': async () => {
        const run = await childIn('read-only-proof', 'npm', ['run', 'outbound:status', '--', '--json'])
        const held = assessOutboundStatus(run)
        let refusals: Record<string, number | null> = {}
        try {
          const lines = run.stdout.split('\n')
          const start = lines.findIndex((line) => line === '{')
          const end = lines.findIndex((line, index) => index > start && line === '}')
          const parsed = JSON.parse(lines.slice(start, end + 1).join('\n')) as { connectors: Array<{ connector: string; refusalsInWindow: number | null }> }
          refusals = Object.fromEntries(parsed.connectors.map((c) => [c.connector, c.refusalsInWindow]))
        } catch {
          refusals = { unreadable: null }
        }
        readOnly = assessReadOnly({
          requests: fake!.requests.map((r) => ({ method: r.method, path: r.path, modelled: r.modelled, status: r.status, authenticated: r.authenticated })),
          holdRefusals: refusals,
        })
        const failures = [...readOnly.assessment.failures, ...held.failures.map((f) => `outbound status after the import: ${f}`)]
        if (sideEffects !== null && sideEffects.emailOutbox !== 0) failures.push(`the import queued ${sideEffects.emailOutbox} email(s) (email_outbox must stay empty)`)
        return { status: failures.length === 0 ? 'passed' : 'failed', reason: failures.length === 0 ? undefined : failures.join('; '), detail: { totalRequests: readOnly.totalRequests, nonGet: readOnly.nonGet.length, unmodelled: readOnly.unmodelled.length, byRoute: readOnly.byRoute, holdRefusals: refusals } }
      },
      'invariant-preflight': async () => {
        const run = await childIn('invariant-preflight', 'npm', ['run', 'invariant-check:preflight'])
        const summary = run.stdout.split('\n').find((line) => line.startsWith('Invariant preflight summary:'))
        const ok = run.exitCode === 0
        return { status: ok ? 'passed' : 'failed', reason: ok ? undefined : `exit ${run.exitCode}. ${outputTail(run)}`, detail: { summary } }
      },
    }

    let prerequisiteFailed: string | null = null
    for (const definition of WOO_STEP_CATALOGUE) {
      if (!included(definition)) continue
      const skipWith = interrupted !== null
        ? `not run: interrupted by ${interrupted}`
        : prerequisiteFailed ? `not run: prerequisite step ${prerequisiteFailed} failed, so there is nothing to inspect` : null
      if (skipWith !== null) {
        results.push({ id: definition.id as unknown as StepResult['id'], item: 0, title: definition.title, required: true, status: 'skipped', reason: skipWith, detail: {}, durationMs: 0 })
        continue
      }
      const proceed = await runStep(definition, stepBodies[definition.id])
      if (!proceed) prerequisiteFailed = definition.id
    }
  } catch (error) {
    abortReason = redact(error instanceof Error ? error.message : String(error))
    notes.push(`The rehearsal aborted before or between steps: ${abortReason}`)
    log(`[woo-rehearsal] aborted: ${abortReason}`)
  } finally {
    for (const definition of WOO_STEP_CATALOGUE) {
      if (!included(definition) || results.some((result) => (result.id as string) === definition.id)) continue
      results.push({ id: definition.id as unknown as StepResult['id'], item: 0, title: definition.title, required: true, status: 'skipped', reason: `not run: ${abortReason ?? 'the rehearsal aborted'}`, detail: {}, durationMs: 0 })
    }
    try {
      if (fake) await fake.close()
    } catch (error) {
      notes.push(`closing the fake store failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      state.teardown = teardownRun(state)
    } catch (error) {
      state.teardown = { clusterStopped: false, postmasterPid: state.postmasterPid, envFileShredded: false, rootRemoved: !existsSync(root), orphanPids: [], errors: [`teardown threw: ${error instanceof Error ? error.message : String(error)}`] }
    }
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }

  const order = new Map(WOO_STEP_CATALOGUE.map((definition, index) => [definition.id as string, index]))
  results.sort((a, b) => order.get(a.id as string)! - order.get(b.id as string)!)

  const stampAfterRehearsal: StampFacts | null = firstPass ? firstPass.stampAfter : null
  const ordersByStatus: Record<string, number> = {}
  for (const o of storeFacts) ordersByStatus[o.status] = (ordersByStatus[o.status] ?? 0) + 1
  const importedFirst = firstPass
  const r9Final = r9
  const r4Final = r4
  const readOnlyFinal = readOnly
  const orderListRequests = fake ? fake.requests.filter((r) => r.path.endsWith('/orders') && r.status === 200).length : null
  const report = buildWooImportReport({
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    host: { node: process.version, postgresServer },
    cluster: { root, port, role: state.role, scramVerified, database: DATABASE },
    store: { kind: 'synthetic-fake', bind: fake ? fake.url : '(never started)', ordersTotal: storeFacts.length, ordersByStatus },
    statuses: { resolved: importedFirst?.statuses ?? [], decided: [...DECIDED_IMPORT_STATUSES], abandoned: [...ABANDONED_STATUSES] },
    tallies: {
      fetchedFromStore: fetchedFirstPass,
      importedFirstPass: importedFirst?.imported ?? null,
      skippedFirstPass: importedFirst?.skipped ?? null,
      errorsFirstPass: importedFirst?.errors.length ?? null,
      importedSecondPass: secondPass?.imported ?? null,
      ordersInIms: r9Final ? r9Final.importedCount : null,
      abandonedByStatus: storeFacts.filter((o) => !(DECIDED_IMPORT_STATUSES as readonly string[]).includes(o.status)).length,
      knownBadProbes: knownBadIds.length,
    },
    r9: r9Final ? { expectedCount: r9Final.expectedCount, importedCount: r9Final.importedCount, knownBadCount: r9Final.knownBadCount, missing: r9Final.missing, maxValueDiffForeign: r9Final.maxValueDiffForeign, maxValueDiffBase: r9Final.maxValueDiffBase, maxComponentsDiff: r9Final.maxComponentsDiff, tolerance: R9_VALUE_TOLERANCE } : null,
    r4: r4Final ? { rowsChecked: r4Final.rowsChecked, rowsWithReservations: r4Final.rowsWithReservations, worstDiff: r4Final.worstDiff, tolerance: R4_QUANTITY_TOLERANCE, afterLanding: r4AfterLanding ? { rowsChecked: r4AfterLanding.rowsChecked, worstDiff: r4AfterLanding.worstDiff } : null } : null,
    orders: r9Final ? r9Final.rows : abortedRows,
    skippedWithReason: (r9Final ? r9Final.rows : []).filter((row) => row.outcome === 'not-imported').map((row) => ({ externalOrderId: row.externalOrderId, reason: row.reason ?? '' })),
    unallocatable,
    sideEffects,
    findings,
    landing,
    stamp: { afterRehearsal: stampAfterRehearsal, afterRealPass: stampAfterRealPass },
    readOnly: readOnlyFinal ? { totalRequests: readOnlyFinal.totalRequests, byRoute: readOnlyFinal.byRoute, nonGetRequests: readOnlyFinal.nonGet.length, unmodelledRequests: readOnlyFinal.unmodelled.length, holdRefusals: readOnlyFinal.holdRefusals } : null,
    steps: results,
    teardown: state.teardown,
    notes: [...notes, ...(orderListRequests === null ? [] : [`The fake store answered ${orderListRequests} order-list request(s) with HTTP 200 over the whole run (two rehearsal passes and one real pass).`])],
    interrupted: interrupted as string | null,
  })

  // ---- Publication: identical discipline to the fresh-install rehearsal. ----
  const outDir = path.join(reportDir, runId)
  const json = path.join(outDir, 'woo-import-report.json')
  const markdown = path.join(outDir, 'woo-import-report.md')
  const write = writeExclusive
  let outDirCreated = false
  let outDirId: FileIdentity | null = null
  const created: string[] = []
  const assertDirectories = (): void => {
    for (const [dir, id] of [[reportDir, reportDirId], [outDir, outDirId]] as const) {
      if (id === null) continue
      const now = lstatSync(dir)
      if (now.isSymbolicLink() || now.dev !== id.dev || now.ino !== id.ino) throw new DirectoryReplacedError(`${dir} is no longer the directory that was validated (device/inode changed)`)
    }
  }
  const publish = (toPublish: WooImportReport): void => {
    const suffix = randomBytes(6).toString('hex')
    const tmpJson = path.join(outDir, `.woo-import-report.json.${suffix}.tmp`)
    const tmpMarkdown = path.join(outDir, `.woo-import-report.md.${suffix}.tmp`)
    try {
      assertDirectories()
      const markdownText = renderWooImportMarkdown(toPublish)
      const record = { ...toPublish, companionMarkdownSha256: createHash('sha256').update(markdownText).digest('hex') }
      created.push(tmpMarkdown)
      write(tmpMarkdown, markdownText)
      created.push(tmpJson)
      write(tmpJson, `${JSON.stringify(record, null, 2)}\n`)
      assertDirectories()
      created.push(markdown)
      renameSync(tmpMarkdown, markdown)
      assertDirectories()
      created.push(json)
      renameSync(tmpJson, json)
      fsyncDirectory(outDir)
      assertDirectories()
    } catch (error) {
      if (!(error instanceof DirectoryReplacedError)) for (const file of created.splice(0)) rmSync(file, { force: true })
      throw error
    }
  }
  hooks.beforePublish?.(outDir)
  try {
    assertDirectories()
    mkdirSync(outDir, { mode: 0o700 })
    outDirCreated = true
    const outInfo = lstatSync(outDir)
    outDirId = { dev: outInfo.dev, ino: outInfo.ino }
    publish(report)
  } catch (error) {
    const reportWriteError = error instanceof Error ? error.message : String(error)
    const exitCode = report.exitCode === WOO_IMPORT_EXIT.OK ? WOO_IMPORT_EXIT.RED : report.exitCode
    const amended: WooImportReport = { ...report, verdict: 'RED', exitCode, notes: [...report.notes, `The report could not be written (${reportWriteError}); this copy is the only record.`] }
    if (!outDirCreated) return { exitCode, report: amended, runRoot: root, reportWriteError }
    try {
      publish(amended)
      return { exitCode, report: amended, reportPaths: { json, markdown }, runRoot: root, reportWriteError }
    } catch {
      return { exitCode, report: amended, runRoot: root, reportWriteError }
    }
  }
  return { exitCode: report.exitCode, report, reportPaths: { json, markdown }, runRoot: root }
}

// ---------------------------------------------------------------------------------------------
// Command line.
// ---------------------------------------------------------------------------------------------

export const WOO_IMPORT_USAGE = `Usage: npm run rehearse:woo-import -- [--root <dir>] [--report-dir <dir>]

Exit codes:
${Object.entries(WOO_IMPORT_EXIT_MEANING).map(([code, meaning]) => `  ${code}  ${meaning}`).join('\n')}
`

export function parseWooImportArgs(argv: readonly string[]): { root?: string; reportDir?: string; help: boolean } | { error: string } {
  const out: { root?: string; reportDir?: string; help: boolean } = { help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--root' || arg === '--report-dir') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) return { error: `${arg} needs a value` }
      if (arg === '--root') out.root = value
      else out.reportDir = value
      i += 1
    } else return { error: `unknown argument ${arg}` }
  }
  return out
}

async function main(): Promise<number> {
  const parsed = parseWooImportArgs(process.argv.slice(2))
  if ('error' in parsed) {
    console.error(`${parsed.error}\n\n${WOO_IMPORT_USAGE}`)
    return WOO_IMPORT_EXIT.REFUSED
  }
  if (parsed.help) {
    console.log(WOO_IMPORT_USAGE)
    return WOO_IMPORT_EXIT.OK
  }
  const outcome = await runWooImportRehearsal({ parentDir: parsed.root, reportDir: parsed.reportDir })
  if (outcome.report === null) {
    console.error(`Refused: ${outcome.refusal}`)
    return outcome.exitCode
  }
  console.log(renderWooImportMarkdown(outcome.report))
  if (outcome.reportPaths) {
    console.log(`Report: ${outcome.reportPaths.json}`)
    console.log(`Report: ${outcome.reportPaths.markdown}`)
  } else {
    console.error(`The report could not be written (${outcome.reportWriteError}); it is printed above.`)
  }
  return outcome.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error))
      process.exitCode = WOO_IMPORT_EXIT.RED
    },
  )
}

// The three SKUs are re-exported so a test can name the same products the fixtures do.
export { SKU_STOCKED, SKU_UNSTOCKED, SKU_PLENTY }
