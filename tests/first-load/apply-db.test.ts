import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { spawn } from 'node:child_process'

import { freePort, startCluster, type Cluster } from '../scripts/real-postgres-cluster'
import { databaseUrl, ident, inheritedEnv, randomHex, runChild, socketPsql, tail, withClient } from '../../scripts/rehearse-first-install'
import { OPENING_STOCK_IMPORT_HEADERS, PRODUCTS_IMPORT_HEADERS, PURCHASE_ORDERS_IMPORT_HEADERS, SUPPLIERS_IMPORT_HEADERS } from '../../lib/first-load/spec'
import { APPLY_STEP_IDS, PRECONDITION_IDS, PRELOAD_RAIL_IDS, RUN_STATUSES, REHEARSAL_RECORD_FORMAT_VERSION, RUNNER_APPLICATION_NAME, type ApplyStepId } from '../../lib/first-load/apply/constants'
import { FINGERPRINT_SPECS, keyStep, type StepRows } from '../../lib/first-load/apply/keys'
import { StaleJournalError, StepLockError, runLoad, type ApplyOptions, type ApplyPorts, type RunRecord } from '../../lib/first-load/apply/orchestrate'
import { buildPreconditions } from '../../lib/first-load/apply/report'
import { planImportCalls } from '../../lib/first-load/apply/import-calls'
import { buildResidual, classifyStep, listConflicts, ObservationError } from '../../lib/first-load/apply/residual'
import type { PreparedRun } from '../../lib/first-load/apply/prepared'
import { CLEAN_PRELOAD, CLEAN_SNAPSHOT } from './apply-preload'
import { loadOk, NO_LOCK, prepareSynthetic, preparedFiles, WAREHOUSES } from './apply-helpers'
import { precondition } from './helpers'
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys'

/**
 * THE DATABASE SIDE OF THE FIRST-LOAD APPLY RUNNER, on a real throwaway PostgreSQL cluster with the migrations applied.
 *
 *   1. FINGERPRINTS. Rows are loaded through the REAL importers (as the system actor), read back by `observe`, and every fingerprinted column of every
 *      unit is compared with the file side's. The file cells are written in deliberately awkward forms (trailing zeros, odd case, yes/1 booleans, blank
 *      cells that take a default, a percentage written as 20, a date without a time, a discount and VAT-inclusive prices on purchase orders).
 *   2. THE PORTS. Journal compare-and-swap under real contention; the advisory lock observed in pg_locks; rails; a crash mid-step and its resume; conflicts;
 *      an unreadable database; chunking.
 *
 * Each arm names, in a comment, the one change to the subject that makes it red; the change was made, the arm went red and the change was reverted
 * (the pull request body has the table). Controls come first: an arm that cannot fail proves nothing.
 */

// Every connection of the runner (the application's pool, the lock pool) carries this application_name; the quiesce rail tells them from anybody else's by it. The command sets it before its first connection.
process.env.PGAPPNAME = RUNNER_APPLICATION_NAME

const REPO = process.cwd()
const TAG = 'ZQDB'
const CHILD_TIMEOUT_MS = 6 * 60 * 1000
const SETTINGS_KEY = 'prod_readiness_ci_settings_key__'
const LOCK_NAMESPACE = 411_220_875
const VAT_NAME = 'ZQDB VAT 20'
const OUTBOUND_TABLES = ['integration_outbox', 'wms_sync_jobs', 'email_outbox', 'accounting_sync_logs'] as const

let root = ''
let cluster: Cluster
let url = ''
type Modules = {
  db: typeof import('@/lib/db')['db']
  ports: typeof import('../../lib/first-load/apply/db/ports')
  observe: typeof import('../../lib/first-load/apply/db/observe')
  journal: typeof import('../../lib/first-load/apply/db/journal')
  lock: typeof import('../../lib/first-load/apply/db/lock')
  execute: typeof import('../../lib/first-load/apply/db/execute')
  rails: typeof import('../../lib/first-load/apply/db/rails')
  preload: typeof import('../../lib/first-load/apply/db/preload-rails')
}
let m: Modules
/** The rails over a quiet installation (see apply-preload.ts); the pre-load rails have their own tests. */
const evaluateRails = (...args: Parameters<Modules['rails']['evaluateRails']>) => m.rails.evaluateRails(args[0], args[1], args[2] ?? CLEAN_PRELOAD)

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return withClient(url, async (client) => (await client.query(text, params)).rows as T[])
}

async function count(table: string): Promise<number> {
  return Number((await sql<{ n: string }>(`select count(*)::text as n from ${ident(table)}`))[0]!.n)
}

/** Empty every table the runner writes; warehouses, the organisation, tax and FX rows stay (they are the target's configuration). */
async function resetData(): Promise<void> {
  await sql('truncate products, suppliers, product_categories, purchase_orders, stock_movements, first_load_apply_runs, activity_logs, integration_outbox, accounting_sync_logs, email_outbox restart identity cascade')
}

const held = () => sql<{ objid: number; granted: boolean }>('select objid, granted from pg_locks where locktype = $1 and classid = $2 and objsubid = 2 order by objid', ['advisory', LOCK_NAMESPACE])
const cellsOf = (header: readonly string[], row: Record<string, string>): string[] => header.map((c) => row[c] ?? '')
const stepRows = (header: readonly string[], rows: Array<Record<string, string>>): StepRows => ({ header: [...header], rows: rows.map((row, i) => ({ chunk: 1, line: i + 2, cells: cellsOf(header, row) })) })

// ---------------------------------------------------------------------------------------------------------------------------------
// Hand-written files in awkward but valid forms. Every value is one the importer accepts.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Order references (named constants: an inline `orderKey: '...'` literal reads as a credential to the secret scanner). */
const PO_ONE = `${TAG}-PO-1`
const PO_TWO = `${TAG}-PO-2`
const PO_THREE = `${TAG}-PO-3`
const PO_FOUR = `${TAG}-PO-4`
const PO_FIVE = `${TAG}-PO-5`
const PO_SIX = `${TAG}-PO-6`
const PO_SEVEN = `${TAG}-PO-7`
const PO_EIGHT = `${TAG}-PO-8`
const PO_NINE = `${TAG}-PO-9`
const PO_TEN = `${TAG}-PO-10`
const PO_ELEVEN = `${TAG}-PO-11`
const PO_TWELVE = `${TAG}-PO-12`
const PO_THIRTEEN = `${TAG}-PO-13`
const PO_TIE_A = `${TAG}-PO-TIE-A`
const PO_TIE_B = `${TAG}-PO-TIE-B`
const PO_FOURTEEN = `${TAG}-PO-14`
const PO_FIFTEEN = `${TAG}-PO-15`
const SUPPLIER_A = `${TAG} Odd Supplier`
const SUPPLIER_B = `${TAG} Euro Supplier`
const ODD_FILES: Record<ApplyStepId, StepRows> = {
  suppliers: stepRows(SUPPLIERS_IMPORT_HEADERS, [
    { name: SUPPLIER_A, contactName: ' Pat Buyer ', email: 'pat@example.test', phone: '01234 567890', currency: 'gbp', purchaseTaxType: 'NONE', vatNumber: 'GB123456789', accountNumber: 'A-1', paymentTermsDays: '030', addressLine1: '1 High Street', city: 'Cambridge', postcode: 'CB1 1AA', country: 'United Kingdom', notes: 'first' },
    { name: SUPPLIER_B, currency: 'eur', purchaseTaxType: 'NONE', paymentTermsDays: '45', country: 'gb' },
  ]),
  products: stepRows(PRODUCTS_IMPORT_HEADERS, [
    { sku: `${TAG}-VAR`, name: 'Variable parent', type: 'VARIABLE', description: ' a parent ', category: 'Tools > Hand tools', weight: '1.50', salesPriceBase: '10.50', salePriceBase: '9.0', widthCm: '10.00', heightCm: '5', depthCm: '2.50', salesPriceTaxInclusive: 'TRUE', oversellAllowed: 'false', stockUnit: 'm', imageUrl: 'https://example.test/p.png', countryOfOrigin: 'china', lifecycleStatus: 'ACTIVE' },
    { sku: `${TAG}-SIMPLE`, name: 'Simple', type: '', category: 'tools > HAND TOOLS', barcode: '0123456789012', mpn: 'MPN-1', preferredSupplierName: SUPPLIER_A.toUpperCase(), preferredSupplierLocked: '1', weight: '0.1000', salesPriceBase: '0010.50', salesPriceTaxInclusive: 'yes' },
    { sku: `${TAG}-VARIANT`, name: 'Variant', type: 'VARIANT', parentSku: `${TAG}-VAR`, lifecycleStatus: 'DRAFT', salesPriceBase: '12' },
    { sku: `${TAG}-EOL`, name: 'End of life by the legacy flag', type: 'SIMPLE', active: 'FALSE' },
    { sku: `${TAG}-ARCH`, name: 'Archived', type: 'SIMPLE', lifecycleStatus: 'ARCHIVED', active: 'TRUE' },
    { sku: `${TAG}-KIT`, name: 'Kit', type: 'KIT', components: `${TAG}-SIMPLE:2;${TAG}-EOL:1.5000`, category: 'Kits' },
    { sku: `${TAG}-BOM`, name: 'Bom', type: 'BOM', components: `${TAG}-SIMPLE:0.5`, category: 'Kits' },
  ]),
  'opening-stock': stepRows(OPENING_STOCK_IMPORT_HEADERS, [
    { sku: `${TAG}-SIMPLE`, warehouseCode: 'ZQSENT-MAIN', qty: '10.0', unitCostBase: '2.50' },
    { sku: `${TAG.toLowerCase()}-bom`, warehouseCode: 'zqsent-over', qty: '3', unitCostBase: '0.000000' },
    { sku: `${TAG}-VARIANT`, warehouseCode: 'ZQSENT-MAIN', qty: '1.250000', unitCostBase: '0.123456' },
  ]),
  'purchase-orders': stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [
    { orderKey: PO_ONE, supplierName: SUPPLIER_A.toLowerCase(), currency: '', destinationWarehouseCode: 'zqsent-main', sku: `${TAG}-SIMPLE`, qty: '3', unitCostForeign: '1.10', lineDiscountForeign: '0.30', lineDiscountStr: '10%', taxRateName: VAT_NAME.toLowerCase(), orderTaxRateName: VAT_NAME, orderTaxRateValue: '20', pricesIncludeVat: 'yes', supplierRef: ' REF-1 ', expectedDelivery: '2027-03-01', orderDiscountForeign: '0.50', notes: 'note' },
    { orderKey: PO_ONE, supplierName: SUPPLIER_A.toLowerCase(), currency: '', destinationWarehouseCode: 'zqsent-main', sku: `${TAG}-BOM`, qty: '1.5', unitCostForeign: '2.333333', taxRateValue: '20', orderTaxRateName: VAT_NAME, orderTaxRateValue: '20', pricesIncludeVat: 'yes', supplierRef: ' REF-1 ', expectedDelivery: '2027-03-01', orderDiscountForeign: '0.50', notes: 'note' },
    { orderKey: PO_TWO, supplierName: SUPPLIER_B, currency: 'EUR', fxRateToBase: '1.25', destinationWarehouseCode: 'ZQSENT-OVER', sku: `${TAG}-VARIANT`, qty: '20', unitCostForeign: '0.5' },
    // PO_THREE: the order names a tax; one line names none (the importer gives it the order's), one names it.
    { orderKey: PO_THREE, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '2', unitCostForeign: '3', orderTaxRateName: VAT_NAME, orderTaxRateValue: '20' },
    { orderKey: PO_THREE, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-BOM`, qty: '1', unitCostForeign: '4', taxRateName: VAT_NAME, orderTaxRateName: VAT_NAME, orderTaxRateValue: '20' },
    // PO_FOUR: the order names no tax and neither does its line. (A line that names a tax while the order names none cannot be loaded: the importer\n    // takes the order's tax from the rows and refuses a group whose rows disagree, so that cell of the table is unreachable.)
    { orderKey: PO_FOUR, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '2', unitCostForeign: '3' },

  ]),
}

/** Differences between two fingerprints as `column` names (lines are compared as a set). */
function differingColumns(a: string, b: string): string[] {
  const left = JSON.parse(a) as Record<string, unknown>
  const right = JSON.parse(b) as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((k) => JSON.stringify(left[k]) !== JSON.stringify(right[k])).sort()
}

/** A difference in the order's lines. Changing the tax RATE a line holds also changes the tax amount that rate implies, so the header amounts may differ with it: both are accepted, nothing else. */
function assertLinesDiffer(actual: string[], label: string): void {
  assert.ok(actual.includes('lines') && actual.every((c) => c === 'lines' || c === 'headerAmounts'), `${label}: ${JSON.stringify(actual)}`)
}

const OK_REHEARSAL = (digest: string, systemId: string) => ({ formatVersion: REHEARSAL_RECORD_FORMAT_VERSION, manifestDigest: digest, verdict: 'OK', systemId, finishedAt: new Date().toISOString() })
const SYSTEM_ID = 'rehearsal-system'
const apply = (prepared: PreparedRun, extra: Partial<ApplyOptions> = {}): ApplyOptions => ({
  mode: 'apply', resume: false, rehearsal: OK_REHEARSAL(prepared.manifestDigest, SYSTEM_ID), systemId: SYSTEM_ID, now: new Date(), maxRehearsalAgeHours: 24, ...extra,
})
const plan = (): ApplyOptions => ({ mode: 'plan', resume: false, rehearsal: null, systemId: null, now: new Date(), maxRehearsalAgeHours: 24 })

let prepared: PreparedRun
const ports = (p: PreparedRun = prepared, overrides: Partial<ApplyPorts> = {}): ApplyPorts => ({ ...m.ports.createDbPorts(p, { preload: CLEAN_PRELOAD, operator: 'Apply Test' }), ...overrides })

describe('the first-load apply runner, database side', { timeout: 30 * 60 * 1000 }, () => {
  before(async () => {
    root = mkdtempSync('/var/tmp/ims-apply-db-')
    for (const dir of ['home', 'npm-cache', 'tmp']) mkdirSync(join(root, dir))
    writeFileSync(join(root, 'empty.env'), '')
    const port = await freePort()
    cluster = startCluster(root, 'pg', port, '127.0.0.1')
    const role = `apply_${randomHex(4)}`
    const password = randomHex(16)
    socketPsql(cluster, `create role ${ident(role)} superuser login password '${password}';\ncreate database ims_apply owner ${ident(role)};\n`)
    url = databaseUrl(role, password, port, 'ims_apply')
    const verified = await withClient(url, async (client) => (await client.query<{ db: string; port: number }>('select current_database() as db, inet_server_port() as port')).rows[0]!)
    assert.deepEqual(verified, { db: 'ims_apply', port }, 'precondition: connected to the throwaway database')
    console.log(`precondition: current_database()=${verified.db}, port=${verified.port}`)

    const childEnv = {
      ...inheritedEnv(root),
      DATABASE_URL: url,
      TMPDIR: join(root, 'tmp'),
      AUTH_SECRET: randomHex(16),
      CRON_SECRET: randomHex(16),
      SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY,
      NEXT_PUBLIC_APP_URL: 'https://ims-apply.test',
      AUTH_URL: 'https://ims-apply.test',
      PUBLIC_APP_URL: 'https://ims-apply.test',
      IMS_SKIP_ENV_FILE: '1',
      DOTENV_CONFIG_PATH: join(root, 'empty.env'),
      DOTENV_CONFIG_QUIET: 'true',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      CHECKPOINT_DISABLE: '1',
      FILE_SCAN_MODE: 'disabled',
      E2E_TEST_MODE: '1',
    }
    const migrate = await runChild({ cmd: join(REPO, 'node_modules/.bin/prisma'), args: ['migrate', 'deploy'], env: childEnv, cwd: REPO, timeoutMs: CHILD_TIMEOUT_MS })
    assert.equal(migrate.exitCode, 0, `migrate failed: ${tail(migrate.stdout + migrate.stderr, 1500)}`)
    const seed = await runChild({ cmd: join(REPO, 'node_modules/.bin/tsx'), args: ['prisma/seed.ts'], env: childEnv, cwd: REPO, timeoutMs: CHILD_TIMEOUT_MS })
    assert.equal(seed.exitCode, 0, `seed failed: ${tail(seed.stdout + seed.stderr, 1500)}`)

    // This process uses the application's own client against the same throwaway database.
    Object.assign(process.env, { DATABASE_URL: url, SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY, AUTH_SECRET: childEnv.AUTH_SECRET, E2E_TEST_MODE: '1', IMS_SKIP_ENV_FILE: '1' })
    const db = (await import('@/lib/db')).db
    assert.equal((await db.$queryRaw<Array<{ d: string }>>`select current_database() as d`)[0]!.d, 'ims_apply', 'precondition: the application client points at the scratch database')
    m = {
      db,
      ports: await import('../../lib/first-load/apply/db/ports'),
      observe: await import('../../lib/first-load/apply/db/observe'),
      journal: await import('../../lib/first-load/apply/db/journal'),
      lock: await import('../../lib/first-load/apply/db/lock'),
      execute: await import('../../lib/first-load/apply/db/execute'),
      rails: await import('../../lib/first-load/apply/db/rails'),
      preload: await import('../../lib/first-load/apply/db/preload-rails'),
    }

    // The target's configuration: the warehouses the manifest declares, a purchase tax rate, and a stored EUR rate.
    for (const [code, profile] of Object.entries(WAREHOUSES)) {
      await db.warehouse.create({ data: { code, name: code, type: profile.type, availableForSale: profile.availableForSale, syncToStore: profile.syncToStore } })
    }
    await db.taxRate.create({ data: { name: VAT_NAME, rate: '0.2', usedFor: 'PURCHASE', active: true } })
    // The one rate the suppliers' purchaseTaxType NONE resolves to (exactly one active purchase-capable rate carries it).
    await db.taxRate.create({ data: { name: 'ZQDB No VAT', rate: '0', usedFor: 'BOTH', accountingTaxType: 'NONE', active: true } })
    await db.fxRate.create({ data: { fromCurrency: 'GBP', toCurrency: 'EUR', rate: '1.25', fetchedAt: new Date(Date.now() - 3_600_000) } })

    // WooCommerce configured and enabled, so that an effect that is NOT suppressed leaves an outbox row behind; the control below proves it would.
    const { serializeSettingValue } = await import('@/lib/settings-store')
    const { INTEGRATION_PLUGIN_SETTING_KEYS } = await import('@/lib/integration-plugin-keys')
    for (const [key, value] of [[INTEGRATION_PLUGIN_SETTING_KEYS.woocommerce, 'true'], ['wc_url', 'http://127.0.0.1:9'], ['wc_consumer_key', 'ck_apply'], ['wc_consumer_secret', 'cs_apply']] as const) {
      const stored = serializeSettingValue(key, value)
      await db.setting.upsert({ where: { key }, create: { key, value: stored }, update: { value: stored } })
    }

    prepared = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore' })
  })

  after(async () => {
    try { await m?.db.$disconnect() } catch { /* the pool may already be closed */ }
    try { cluster?.stop() } finally { if (root) rmSync(root, { recursive: true, force: true }) }
  })

  // ------------------------------------------------------------------------------------------------------------------
  // 1. FINGERPRINTS FROM DATABASE ROWS EQUAL THOSE FROM FILES
  // ------------------------------------------------------------------------------------------------------------------

  describe('fingerprints', () => {
    let units: Record<ApplyStepId, ReturnType<typeof keyStep>['units']>

    before(async () => {
      await resetData()
      units = {} as typeof units
      const execute = m.execute.createExecutor({ runId: 'fingerprints', operator: 'Fingerprint Test' })
      const outboxBefore = await count('integration_outbox')
      for (const step of APPLY_STEP_IDS) {
        const keyed = keyStep(step, ODD_FILES[step])
        assert.deepEqual(keyed.problems, [], `${step}: the hand-written file keys cleanly`)
        units[step] = keyed.units
        const classified = classifyStep(step, keyed.units, { entries: [] })
        const files = buildResidual(step, ODD_FILES[step], classified)
        assert.ok(files.length > 0, `${step}: there is something to load`)
        for (const file of files) {
          const answer = await execute(step, file, NO_LOCK)
          assert.deepEqual(answer.errors.filter((e) => !/already exists/.test(e)), [], `${step}: the real importer accepted every row`)
        }
      }
      assert.equal(await count('integration_outbox'), outboxBefore, 'the system-actor import queued nothing outbound')
      cacheSnapshot = await m.db.supplierProduct.findMany()
    })

    // Orders that a test loads and then deletes leave their price cache behind (the cache is written by every order); put it back so each test sees the loaded state.
    let cacheSnapshot: Awaited<ReturnType<typeof m.db.supplierProduct.findMany>> = []
    afterEach(async () => {
      if (cacheSnapshot.length === 0) return
      await m.db.supplierProduct.deleteMany({})
      await m.db.supplierProduct.createMany({ data: cacheSnapshot })
    })

    it('every unit of every step is observed in the database with the file side\'s exact fingerprint', async (t) => {
      let units_ = 0
      const failures: string[] = []
      for (const step of APPLY_STEP_IDS) {
        const stub = { steps: [{ step: 'purchase-orders', units: units['purchase-orders'] }] } as unknown as PreparedRun
        const observed = await m.observe.observeStep(stub, step)
        const byKey = new Map(observed.entries.map((e) => [e.key, e]))
        assert.equal(observed.entries.length, units[step].length, `${step}: the database holds exactly the emitted units (nothing foreign, nothing missing)`)
        for (const unit of units[step]) {
          units_++
          const entry = byKey.get(unit.key)
          if (!entry) { failures.push(`${step}: ${unit.key} is not observed`); continue }
          if (entry.fingerprint !== unit.fingerprint) failures.push(`${step}.${differingColumns(unit.fingerprint, entry.fingerprint).join(',')}`)
          if (entry.recipe !== unit.recipe) failures.push(`${step}: recipe differs`)
          if (entry.collisionKey !== unit.collisionKey) failures.push(`${step}: collision key differs`)
        }
      }
      precondition(t, 'units compared', units_)
      assert.deepEqual(failures, [])
    })

    it('every fingerprinted column and every purchase-order line column was actually compared (the comparison covers the whole spec)', (t) => {
      let columns = 0
      for (const step of APPLY_STEP_IDS) {
        const spec = FINGERPRINT_SPECS[step]
        const present = new Set(Object.keys(JSON.parse(units[step][0]!.fingerprint) as Record<string, unknown>))
        if (step === 'opening-stock') { for (const c of ['sku', 'warehouseCode', 'qty', 'unitCostBase']) { assert.ok(present.has(c), `${step}.${c}`); columns++ } continue }
        for (const c of spec.fingerprinted) {
          // A purchase-order line column is folded into the `lines` entries; the header columns are keys.
          assert.ok(present.has(c), `${step}.${c} is part of the fingerprint`)
          columns++
        }
        if (step === 'purchase-orders') {
          const lines = (JSON.parse(units[step][0]!.fingerprint) as { lines: string[] }).lines
          assert.ok(lines.every((l) => l.split('|').length === 6), 'a line string carries sku, qty, amount, discount, discount text and tax')
          columns += (spec.lineLevel ?? []).length
        }
      }
      precondition(t, 'columns covered', columns)
    })

    it('the awkward formats really were awkward: the file cells differ from the stored forms for at least these columns, and the normal form settles them', async (t) => {
      // Control against a vacuous pass: if the file cells already equalled the stored text, equality would prove nothing.
      const rawSupplier = ODD_FILES.suppliers.rows[0]!.cells
      assert.equal(rawSupplier[ODD_FILES.suppliers.header.indexOf('paymentTermsDays')], '030')
      assert.equal(rawSupplier[ODD_FILES.suppliers.header.indexOf('currency')], 'gbp')
      const stored = await m.db.supplier.findFirstOrThrow({ where: { name: SUPPLIER_A }, select: { paymentTermsDays: true, currency: true, country: true, contactName: true } })
      assert.deepEqual(stored, { paymentTermsDays: 30, currency: 'GBP', country: 'GB', contactName: 'Pat Buyer' })
      const product = await m.db.product.findFirstOrThrow({ where: { sku: `${TAG}-SIMPLE` }, select: { salesPriceBase: true, weight: true, stockUnit: true, oversellAllowed: true, lifecycleStatus: true, active: true, salesPriceTaxInclusive: true, category: { select: { nameNormalized: true } } } })
      assert.equal(product.salesPriceBase!.toFixed(), '10.5')
      assert.equal(product.stockUnit, 'pcs')
      assert.equal(product.oversellAllowed, true)
      assert.equal(product.salesPriceTaxInclusive, true)
      assert.equal(product.category!.nameNormalized, 'tools>hand tools')
      const eol = await m.db.product.findFirstOrThrow({ where: { sku: `${TAG}-EOL` }, select: { lifecycleStatus: true, active: true } })
      assert.deepEqual(eol, { lifecycleStatus: 'EOL', active: true })
      const po = await m.db.purchaseOrder.findFirstOrThrow({ where: { reference: PO_ONE }, select: { currency: true, taxRatePercent: true, taxRateName: true, expectedDelivery: true, discountAmount: true, lines: { select: { unitCostForeign: true, taxRate: { select: { rate: true } } } } } })
      assert.equal(po.currency, 'GBP')
      assert.equal(po.expectedDelivery!.toISOString(), '2027-03-01T00:00:00.000Z')
      assert.ok(po.lines.every((l) => l.taxRate?.rate.toFixed() === '0.2'), 'both lines carry the 20% tax (one named it, one gave the value)')
      // The stored unit cost is NOT what the file said (VAT-inclusive and discounted), which is why the fingerprint carries the entered amount.
      assert.ok(po.lines.some((l) => l.unitCostForeign.toFixed() !== '1.1' && l.unitCostForeign.toFixed() !== '2.333333'))
      precondition(t, 'awkward columns checked', 12)
    })

    it('a stored value that differs from the file is a difference in exactly that column (the comparison can fail)', async () => {
      // Mutation named: make the database side ignore a column -> this arm is green when it must be red; make it compare a different column -> red here.
      await m.db.product.update({ where: { sku: `${TAG}-SIMPLE` }, data: { weight: '0.2' } })
      await m.db.supplier.updateMany({ where: { name: SUPPLIER_A }, data: { paymentTermsDays: 31 } })
      const stub = { steps: [{ step: 'purchase-orders', units: units['purchase-orders'] }] } as unknown as PreparedRun
      const products = await m.observe.observeStep(stub, 'products')
      const suppliers = await m.observe.observeStep(stub, 'suppliers')
      const simple = units.products.find((u) => u.key === `${TAG}-SIMPLE`)!
      assert.deepEqual(differingColumns(simple.fingerprint, products.entries.find((e) => e.key === simple.key)!.fingerprint), ['weight'])
      const supplier = units.suppliers.find((u) => u.key === SUPPLIER_A.toLowerCase())!
      assert.deepEqual(differingColumns(supplier.fingerprint, suppliers.entries.find((e) => e.key === supplier.key)!.fingerprint), ['paymentTermsDays'])
      await m.db.product.update({ where: { sku: `${TAG}-SIMPLE` }, data: { weight: '0.1' } })
      await m.db.supplier.updateMany({ where: { name: SUPPLIER_A }, data: { paymentTermsDays: 30 } })
    })

    it('a stored order currency changed away from the supplier\'s is a CONFLICT in the currency column although the file left it blank; a line tax changed likewise', async () => {
      // Mutation named: blank the database currency whenever the file's is blank (the old code) -> the currency arm is green when it must be red.
      const stub = { steps: [{ step: 'purchase-orders', units: units['purchase-orders'] }] } as unknown as PreparedRun
      const unit = units['purchase-orders'].find((u) => u.key === PO_ONE)!
      assert.equal((JSON.parse(unit.fingerprint) as { currency: string }).currency, '', 'precondition: the file leaves this order\'s currency blank')
      const entry = async (key: string) => (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === key)!
      assert.deepEqual(differingColumns(unit.fingerprint, (await entry(PO_ONE)).fingerprint), [], 'control: as loaded, the blank currency is the supplier\'s and matches')
      await m.db.purchaseOrder.update({ where: { reference: PO_ONE }, data: { currency: 'EUR' } })
      try {
        assert.deepEqual(differingColumns(unit.fingerprint, (await entry(PO_ONE)).fingerprint), ['currency'])
        const result = classifyStep('purchase-orders', [unit], { entries: [await entry(PO_ONE)] })
        assert.equal(result.units[0]!.conflict?.code, 'FIELDS_DIFFER')
      } finally {
        await m.db.purchaseOrder.update({ where: { reference: PO_ONE }, data: { currency: 'GBP' } })
      }
      // The same for a line that named no tax: its stored tax must be the order's or the supplier's default.
      const unitTwo = units['purchase-orders'].find((u) => u.key === PO_TWO)!
      assert.deepEqual(differingColumns(unitTwo.fingerprint, (await entry(PO_TWO)).fingerprint), [], 'control')
      const line = await m.db.purchaseOrderLine.findFirstOrThrow({ where: { po: { reference: PO_TWO } }, select: { id: true } })
      const rate = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME }, select: { id: true } })
      await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: { taxRateId: rate.id } })
      try {
        assertLinesDiffer(differingColumns(unitTwo.fingerprint, (await entry(PO_TWO)).fingerprint), 'a rate stored on a line that names none')
      } finally {
        await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: { taxRateId: null } })
      }
    })

    it('every cell of the line-tax table: (line names a tax?) x (order names a tax?) -> what the importer stores, and any other stored tax is a difference in `lines`', async () => {
      // Mutation named: treat a missing stored tax as "inherited" whatever the order says (the old rule) -> the order-names-a-tax null arm is green when it must be red.
      const stub = { steps: [{ step: 'purchase-orders', units: units['purchase-orders'] }] } as unknown as PreparedRun
      const observed = async (key: string) => (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === key)!
      const unitOf = (key: string) => units['purchase-orders'].find((u) => u.key === key)!
      const diff = async (key: string) => differingColumns(unitOf(key).fingerprint, (await observed(key)).fingerprint)
      const other = await m.db.taxRate.create({ data: { name: `${VAT_NAME} other`, rate: '0.05', usedFor: 'PURCHASE', active: true } })
      const vat = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME }, select: { id: true } })
      const lineOf = async (key: string, sku: string) => m.db.purchaseOrderLine.findFirstOrThrow({ where: { po: { reference: key }, product: { sku } }, select: { id: true, taxRateId: true } })
      const setTax = async (lineId: string, taxRateId: string | null) => { await m.db.purchaseOrderLine.update({ where: { id: lineId }, data: { taxRateId } }) }
      let arms = 0
      try {
        // Stored as the importer stores them: all four orders match.
        for (const key of [PO_ONE, PO_TWO, PO_THREE, PO_FOUR]) assert.deepEqual(await diff(key), [], `control ${key}`)
        const stored = async (key: string, sku: string) => (await lineOf(key, sku)).taxRateId
        assert.equal(await stored(PO_THREE, `${TAG}-SIMPLE`), vat.id, 'precondition: an unnamed line under a named order tax was given the order\'s')
        assert.equal(await stored(PO_FOUR, `${TAG}-SIMPLE`), null, 'precondition: an unnamed line under an order with no tax has none')
        // For each cell: the line, and every other value its stored tax could hold, must differ.
        const cells: Array<[string, string, string | null, Array<string | null>]> = [
          // [order, sku, what the importer stored, alternatives that must each be a difference]
          [PO_THREE, `${TAG}-SIMPLE`, vat.id, [null, other.id]], // line names none, order names one
          [PO_THREE, `${TAG}-BOM`, vat.id, [null, other.id]], // line names it, order names it
          [PO_FOUR, `${TAG}-SIMPLE`, null, [vat.id, other.id]], // line names none, order names none
        ]
        for (const [key, sku, original, alternatives] of cells) {
          const line = await lineOf(key, sku)
          for (const alternative of alternatives) {
            await setTax(line.id, alternative)
            try { assertLinesDiffer(await diff(key), `${key} ${sku}: stored ${alternative === null ? 'none' : alternative === other.id ? 'another rate' : 'the order rate'} instead of ${original === null ? 'none' : 'the order rate'}`) } finally { await setTax(line.id, original) }
            arms++
          }
          assert.deepEqual(await diff(key), [], `${key} ${sku}: restored`)
        }
        assert.equal(arms, 6)
      } finally {
        await m.db.taxRate.delete({ where: { id: other.id } }).catch(() => undefined)
      }
    })

    it('a line that names a tax AND states its value: the named rate\'s value is what is stored and compared, so a rate of another value, now or later, is a difference', async () => {
      // Mutation named: drop the "@value" from the line token (the old fingerprint) -> the changed-later arm and the stored-at-10% arm are green when they must be red.
      const execute = m.execute.createExecutor({ runId: 'tax-value', operator: 'Tax Value Test' })
      const loaded: Array<(typeof units)['purchase-orders'][number]> = []
      const stub = { steps: [{ step: 'purchase-orders', get units() { return [...units['purchase-orders'], ...loaded] } }] } as unknown as PreparedRun
      const rate = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME }, select: { id: true } })
      const orderRows = (key: string) => stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: key, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '10', unitCostForeign: '10', taxRateName: VAT_NAME, taxRateValue: '20', orderTaxRateName: VAT_NAME, orderTaxRateValue: '20' }])
      const load = async (key: string) => {
        const data = orderRows(key)
        const keyed = keyStep('purchase-orders', data)
        assert.deepEqual(keyed.problems, [])
        const file = buildResidual('purchase-orders', data, classifyStep('purchase-orders', keyed.units, { entries: [] }))[0]!
        const answer = await execute('purchase-orders', file, NO_LOCK)
        assert.deepEqual(answer.errors, [], 'the importer accepted the order')
        loaded.push(keyed.units[0]!)
        return keyed.units[0]!
      }
      const entry = async (key: string) => (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === key)!
      const storedTax = async (key: string) => (await sql<{ tax: string }>(`select l."taxForeign"::text as tax from purchase_order_lines l join purchase_orders p on p.id = l."poId" where p.reference = $1`, [key]))[0]!.tax
      const cleanup = async (...keys: string[]) => { for (const key of keys) { await sql(`delete from purchase_order_lines where "poId" in (select id from purchase_orders where reference = $1)`, [key]); await sql('delete from purchase_orders where reference = $1', [key]) } }
      try {
        // (a) loaded while the rate IS 20%: matches; the rate then changes to 10%: that surfaces.
        const five = await load(PO_FIVE)
        assert.equal(Number(await storedTax(PO_FIVE)), 20, 'control: 20% of 100')
        assert.deepEqual(differingColumns(five.fingerprint, (await entry(PO_FIVE)).fingerprint), [], 'control: matches as loaded')
        await m.db.taxRate.update({ where: { id: rate.id }, data: { rate: '0.1' } })
        try {
          assertLinesDiffer(differingColumns(five.fingerprint, (await entry(PO_FIVE)).fingerprint), 'a later change of the named rate\'s value surfaces')
          // (b) loaded while the rate is 10% although the file states 20: the importer takes the NAME, stores 10%, and the load is reported as different.
          const six = await load(PO_SIX)
          assert.equal(Number(await storedTax(PO_SIX)), 10, 'the importer applied the named rate (10%), not the stated 20')
          assert.deepEqual(differingColumns(six.fingerprint, (await entry(PO_SIX)).fingerprint), ['lines'])
          assert.equal(classifyStep('purchase-orders', [six], { entries: [await entry(PO_SIX)] }).units[0]!.conflict?.code, 'FIELDS_DIFFER')
        } finally { await m.db.taxRate.update({ where: { id: rate.id }, data: { rate: '0.2' } }) }
      } finally { await cleanup(PO_FIVE, PO_SIX) }
    })

    it('two lines identical except for their tax (one names a tax, one inherits the order\'s different tax) are matched as a multiset, in either order, and are not a false conflict', async () => {
      // The old greedy pairing took the first file line with the same prefix for the first stored line and derived the tax from THAT one; with the lines the other way round it
      // reported a valid order as different for ever.
      const execute = m.execute.createExecutor({ runId: 'multiset', operator: 'Multiset Test' })
      const orderTax = await m.db.taxRate.create({ data: { name: `${VAT_NAME} multiset`, rate: '0.05', usedFor: 'PURCHASE', active: true } })
      const loaded: Array<(typeof units)['purchase-orders'][number]> = []
      const stub = { steps: [{ step: 'purchase-orders', get units() { return [...units['purchase-orders'], ...loaded] } }] } as unknown as PreparedRun
      try {
        for (const rowsInOrder of [['explicit', 'inherit'], ['inherit', 'explicit']] as const) {
          const key = rowsInOrder[0] === 'explicit' ? PO_SEVEN : `${PO_SEVEN}-B`
          const common = { orderKey: key, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '2', unitCostForeign: '3', orderTaxRateName: orderTax.name, orderTaxRateValue: '5' }
          const data = stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, rowsInOrder.map((kind) => (kind === 'explicit' ? { ...common, taxRateName: VAT_NAME } : common)))
          const keyed = keyStep('purchase-orders', data)
          assert.deepEqual(keyed.problems, [])
          const answer = await execute('purchase-orders', buildResidual('purchase-orders', data, classifyStep('purchase-orders', keyed.units, { entries: [] }))[0]!, NO_LOCK)
          assert.deepEqual(answer.errors, [])
          loaded.push(keyed.units[0]!)
          const entry = (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === key)!
          assert.deepEqual(differingColumns(keyed.units[0]!.fingerprint, entry.fingerprint), [], `rows ${rowsInOrder.join(' then ')}: matches`)
          // And a real difference is still seen: the inheriting line stored with the explicit rate instead.
          const lines = await m.db.purchaseOrderLine.findMany({ where: { po: { reference: key } }, select: { id: true, taxRateId: true } })
          const vat = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME }, select: { id: true } })
          const inheriting = lines.find((l) => l.taxRateId === orderTax.id)!
          await m.db.purchaseOrderLine.update({ where: { id: inheriting.id }, data: { taxRateId: vat.id } })
          try {
            const changed = (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === key)!
            assertLinesDiffer(differingColumns(keyed.units[0]!.fingerprint, changed.fingerprint), 'the inheriting line stored with the explicit rate')
          } finally { await m.db.purchaseOrderLine.update({ where: { id: inheriting.id }, data: { taxRateId: orderTax.id } }) }
        }
      } finally {
        for (const key of [PO_SEVEN, `${PO_SEVEN}-B`]) {
          await sql(`delete from purchase_order_lines where "poId" in (select id from purchase_orders where reference = $1)`, [key])
          await sql('delete from purchase_orders where reference = $1', [key])
        }
        await m.db.taxRate.delete({ where: { id: orderTax.id } }).catch(() => undefined)
      }
    })

    it('the accounting profile of a stored line\'s rate is read back: a later change of its tax type, reverse charge, reporting category or components surfaces; and a zero-value line is neither a conflict nor a tax', async () => {
      // Mutation named: leave the profile digest out of the satisfaction test -> the changed-settings arms are green when they must be red.
      const execute = m.execute.createExecutor({ runId: 'profile', operator: 'Profile Test' })
      const rate = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME } })
      const five = await m.db.taxRate.create({ data: { name: `${VAT_NAME} profile`, rate: '0.05', usedFor: 'PURCHASE', active: true } })
      const loaded: Array<(typeof units)['purchase-orders'][number]> = []
      const stub = { steps: [{ step: 'purchase-orders', get units() { return [...units['purchase-orders'], ...loaded] } }] } as unknown as PreparedRun
      const rowsFor = (key: string, line: Record<string, string>) => stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: key, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '10', unitCostForeign: '10', ...line }])
      const prepStub = (data: ReturnType<typeof rowsFor>) => ({ ...prepared, steps: [{ step: 'purchase-orders', target: 'purchase-orders', files: [], data, units: keyStep('purchase-orders', data).units }] }) as unknown as PreparedRun
      const load = async (data: ReturnType<typeof rowsFor>) => {
        const keyed = keyStep('purchase-orders', data)
        assert.deepEqual(keyed.problems, [])
        const answer = await execute('purchase-orders', buildResidual('purchase-orders', data, classifyStep('purchase-orders', keyed.units, { entries: [] }))[0]!, NO_LOCK)
        assert.deepEqual(answer.errors, [])
        loaded.push(keyed.units[0]!)
        return keyed.units[0]!
      }
      const entry = async (key: string) => (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === key)!
      const journal = m.journal.createJournal()
      const cleanup = async () => {
        for (const key of [PO_EIGHT, PO_NINE, PO_TEN]) { await sql(`delete from purchase_order_lines where "poId" in (select id from purchase_orders where reference = $1)`, [key]); await sql('delete from purchase_orders where reference = $1', [key]) }
        await sql('delete from first_load_apply_runs')
      }
      try {
        // The run record exists, and the profile of each tax lookup is recorded just before the first write (as the ports do).
        await journal.save({ version: 1, manifestDigest: 'f'.repeat(64), runId: 'profile-run', status: 'RUNNING', currentStep: null, steps: {} }, null)
        const named = rowsFor(PO_EIGHT, { taxRateName: VAT_NAME, orderTaxRateName: VAT_NAME, orderTaxRateValue: '20' })
        const inherits = rowsFor(PO_NINE, { orderTaxRateName: VAT_NAME, orderTaxRateValue: '20' })
        assert.equal(await m.journal.setFactOnce('taxProfiles', await m.rails.currentTaxProfiles(prepStub(named))), true)
        assert.equal(await m.journal.setFactOnce('taxProfiles', { overwritten: 'no' }), false, 'a fact is recorded once and never rewritten')
        const eight = await load(named)
        const nine = await load(inherits)
        assert.deepEqual(differingColumns(eight.fingerprint, (await entry(PO_EIGHT)).fingerprint), [], 'control: matches as loaded')
        assert.deepEqual(differingColumns(nine.fingerprint, (await entry(PO_NINE)).fingerprint), [], 'control: the inheriting order matches as loaded')
        const changes: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
          ['tax type', { accountingTaxType: 'INPUT9' }, { accountingTaxType: rate.accountingTaxType }],
          ['reverse charge', { reverseCharge: !rate.reverseCharge }, { reverseCharge: rate.reverseCharge }],
          ['reporting category', { reportingCategory: 'OSS' }, { reportingCategory: rate.reportingCategory }],
          ['compound flag', { isCompound: !rate.isCompound }, { isCompound: rate.isCompound }],
        ]
        for (const [label, change, restore] of changes) {
          await m.db.taxRate.update({ where: { id: rate.id }, data: change })
          try {
            assert.deepEqual(differingColumns(eight.fingerprint, (await entry(PO_EIGHT)).fingerprint), ['lines'], `${label}: the named line differs`)
            assert.deepEqual(differingColumns(nine.fingerprint, (await entry(PO_NINE)).fingerprint), ['lines'], `${label}: the inheriting line differs`)
          } finally { await m.db.taxRate.update({ where: { id: rate.id }, data: restore }) }
          assert.deepEqual(differingColumns(eight.fingerprint, (await entry(PO_EIGHT)).fingerprint), [], `${label}: restored`)
        }
        // The stored tax AMOUNT is checked against the stored rate too: an amount edited by hand (or computed under a rate that has since changed) is a difference.
        // Mutation named: drop the exact per-line comparison with the file's arithmetic -> this arm is green when it must be red.
        const eightLine = await m.db.purchaseOrderLine.findFirstOrThrow({ where: { po: { reference: PO_EIGHT } }, select: { id: true, taxForeign: true } })
        await m.db.purchaseOrderLine.update({ where: { id: eightLine.id }, data: { taxForeign: '21' } })
        try { assert.deepEqual(differingColumns(eight.fingerprint, (await entry(PO_EIGHT)).fingerprint), ['headerAmounts'], 'a hand-edited tax amount') } finally { await m.db.purchaseOrderLine.update({ where: { id: eightLine.id }, data: { taxForeign: eightLine.taxForeign } }) }
        assert.deepEqual(differingColumns(eight.fingerprint, (await entry(PO_EIGHT)).fingerprint), [], 'restored')
        const component = await m.db.taxRateComponent.create({ data: { taxRateId: rate.id, name: 'part', rate: '0.2', sortOrder: 0 } })
        try { assert.deepEqual(differingColumns(eight.fingerprint, (await entry(PO_EIGHT)).fingerprint), ['lines'], 'a component added later') } finally { await m.db.taxRateComponent.delete({ where: { id: component.id } }) }
        // ZERO: a line whose only tax cell is 0 states nothing. With no order tax it stores none; under a named order tax it takes the order\'s. Both match as loaded.
        const zeroPlain = await load(rowsFor(PO_TEN, { taxRateValue: '0' }))
        const stored = await m.db.purchaseOrderLine.findFirstOrThrow({ where: { po: { reference: PO_TEN } }, select: { taxRateId: true, taxForeign: true } })
        assert.deepEqual({ rate: stored.taxRateId, tax: stored.taxForeign.toFixed() }, { rate: null, tax: '0' }, 'the importer stored no tax for a zero value under no order tax')
        assert.deepEqual(differingColumns(zeroPlain.fingerprint, (await entry(PO_TEN)).fingerprint), [], 'the zero-value line matches')
        const zeroUnder = (await m.db.purchaseOrderLine.findFirstOrThrow({ where: { po: { reference: PO_NINE } }, select: { taxRateId: true } })).taxRateId
        assert.equal(zeroUnder, rate.id, 'precondition: an unnamed line under a named order tax takes the order\'s')
        void five
      } finally {
        await cleanup()
        await m.db.taxRate.delete({ where: { id: five.id } }).catch(() => undefined)
      }
    })

    it('every stored header amount and every column the importer never sets is read back: tamper each separately -> a difference in that column, restore -> a match', async (t) => {
      // Mutation named: leave headerAmounts out of the observation (the old code read none of these) -> every arm below is green when it must be red.
      const stub = { steps: [{ step: 'purchase-orders', units: units['purchase-orders'] }] } as unknown as PreparedRun
      const diff = async (key: string) => differingColumns(units['purchase-orders'].find((u) => u.key === key)!.fingerprint, (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === key)!.fingerprint)
      assert.deepEqual(await diff(PO_ONE), [], 'control: the inclusive, discounted, taxed order matches')
      assert.deepEqual(await diff(PO_TWO), [], 'control: the EUR order matches')
      const po = async (key: string) => m.db.purchaseOrder.findUniqueOrThrow({ where: { reference: key } })
      const lineOf = async (key: string) => m.db.purchaseOrderLine.findFirstOrThrow({ where: { po: { reference: key } }, orderBy: { sortOrder: 'asc' } })
      let arms = 0
      // header amounts, both orders (one has VAT, a discount and VAT-inclusive prices; one is in EUR at 1.25)
      for (const key of [PO_ONE, PO_TWO]) {
        for (const column of ['subtotalForeign', 'subtotalBase', 'taxForeign', 'taxBase', 'totalForeign', 'totalBase'] as const) {
          const original = (await po(key))[column]
          await m.db.purchaseOrder.update({ where: { reference: key }, data: { [column]: original.plus(1) } })
          try { assert.deepEqual(await diff(key), ['headerAmounts'], `${key}.${column}`) } finally { await m.db.purchaseOrder.update({ where: { reference: key }, data: { [column]: original } }) }
          assert.deepEqual(await diff(key), [], `${key}.${column}: restored`)
          arms++
        }
      }
      // the FX rate and the order discount (each is also a header fingerprint column)
      const two = await po(PO_TWO)
      await m.db.purchaseOrder.update({ where: { reference: PO_TWO }, data: { fxRateToBase: '1.26' } })
      try { assert.ok((await diff(PO_TWO)).includes('fxRateToBase'), 'fx rate'); arms++ } finally { await m.db.purchaseOrder.update({ where: { reference: PO_TWO }, data: { fxRateToBase: two.fxRateToBase } }) }
      await m.db.purchaseOrder.update({ where: { reference: PO_TWO }, data: { discountAmount: '1' } })
      try { assert.ok((await diff(PO_TWO)).includes('orderDiscountForeign'), 'order discount'); arms++ } finally { await m.db.purchaseOrder.update({ where: { reference: PO_TWO }, data: { discountAmount: two.discountAmount } }) }
      // columns the importer never sets
      for (const [label, data, restore] of [
        ['directFreight', { directFreightForeign: '5' }, { directFreightForeign: '0' }],
        ['discountStr', { discountStr: '10%' }, { discountStr: null }],
        ['internalNotes', { internalNotes: 'x' }, { internalNotes: null }],
        ['archived', { archived: true }, { archived: false }],
        ['landedCostMethod', { landedCostMethod: 'BY_QUANTITY' }, { landedCostMethod: 'BY_VALUE' }],
        ['lifecycleDates', { rfqSentAt: new Date() }, { rfqSentAt: null }],
      ] as const) {
        await m.db.purchaseOrder.update({ where: { reference: PO_TWO }, data: data as never })
        try { assert.deepEqual(await diff(PO_TWO), ['headerAmounts'], label) } finally { await m.db.purchaseOrder.update({ where: { reference: PO_TWO }, data: restore as never }) }
        arms++
      }
      // line-level base amounts and defaults
      const line = await lineOf(PO_TWO)
      // The NET UNIT COST in both currencies altered consistently (the base one follows the foreign one at the order's rate) while the file-pinned totals stay put: the unit cost no longer
      // gives the stored total. Mutation named: drop the derived-total check -> this arm is green when it must be red (the old code compared the base unit cost with the foreign one only).
      {
        const rate = Number((await po(PO_TWO)).fxRateToBase.toFixed())
        const bumpedUnit = line.unitCostForeign.plus(1)
        await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: bumpedUnit, unitCostBase: bumpedUnit.div(rate).toDecimalPlaces(6) } })
        try { assert.deepEqual(await diff(PO_TWO), ['headerAmounts'], 'both unit costs altered consistently, totals fixed') } finally { await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: line.unitCostForeign, unitCostBase: line.unitCostBase } }) }
        assert.deepEqual(await diff(PO_TWO), [], 'restored')
        arms++
      }
      // The price cache the order creation keeps per supplier and product
      {
        const sp = await m.db.supplierProduct.findFirstOrThrow({ where: { supplier: { name: SUPPLIER_B }, product: { sku: `${TAG}-VARIANT` } } })
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { lastUnitCost: sp.lastUnitCost.plus(7) } })
        try { assert.deepEqual(await diff(PO_TWO), ['headerAmounts'], 'supplier product cost') } finally { await m.db.supplierProduct.update({ where: { id: sp.id }, data: { lastUnitCost: sp.lastUnitCost } }) }
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { currency: 'USD' } })
        try { assert.deepEqual(await diff(PO_TWO), ['headerAmounts'], 'supplier product currency') } finally { await m.db.supplierProduct.update({ where: { id: sp.id }, data: { currency: sp.currency } }) }
        // The upsert never sets the supplier's own SKU or the lead time: a value there is a foreign row the upsert merged into.
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { supplierSku: 'THEIRS' } })
        try { assert.deepEqual(await diff(PO_TWO), ['headerAmounts'], 'supplier product supplierSku') } finally { await m.db.supplierProduct.update({ where: { id: sp.id }, data: { supplierSku: null } }) }
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { leadTimeDays: 9 } })
        try { assert.deepEqual(await diff(PO_TWO), ['headerAmounts'], 'supplier product leadTimeDays') } finally { await m.db.supplierProduct.update({ where: { id: sp.id }, data: { leadTimeDays: null } }) }
        arms++
      }
      for (const [label, data, restore] of [
        ['line.totalBase', { totalBase: line.totalBase.plus(1) }, { totalBase: line.totalBase }],
        ['line.taxBase', { taxBase: line.taxBase.plus(1) }, { taxBase: line.taxBase }],
        ['line.unitCostBase', { unitCostBase: line.unitCostBase.plus(1) }, { unitCostBase: line.unitCostBase }],
        ['line.defaults', { qtyReceived: '1' }, { qtyReceived: '0' }],
      ] as const) {
        await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: data as never })
        try { assert.deepEqual(await diff(PO_TWO), ['headerAmounts'], label) } finally { await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: restore as never }) }
        arms++
      }
      assert.deepEqual(await diff(PO_TWO), [], 'all restored')
      // The lines AND the header edited consistently with each other, but not the file's: the lines themselves differ from the file (quantity/amount are in the fingerprint).
      const beforeLine = await lineOf(PO_TWO)
      const beforeHeader = await po(PO_TWO)
      const rate = 1.25
      const newTotalForeign = beforeLine.totalForeign.plus(10)
      const newTotalBase = newTotalForeign.div(rate)
      await m.db.purchaseOrderLine.update({ where: { id: beforeLine.id }, data: { totalForeign: newTotalForeign, totalBase: newTotalBase.toDecimalPlaces(4) } })
      await m.db.purchaseOrder.update({ where: { reference: PO_TWO }, data: { subtotalForeign: newTotalForeign, subtotalBase: newTotalBase.toDecimalPlaces(4), totalForeign: newTotalForeign, totalBase: newTotalBase.toDecimalPlaces(4) } })
      try { assert.deepEqual(await diff(PO_TWO), ['headerAmounts', 'lines'], 'a line and its header edited together still differ from the file (and the unit cost no longer gives the total)') } finally {
        await m.db.purchaseOrderLine.update({ where: { id: beforeLine.id }, data: { totalForeign: beforeLine.totalForeign, totalBase: beforeLine.totalBase } })
        await m.db.purchaseOrder.update({ where: { reference: PO_TWO }, data: { subtotalForeign: beforeHeader.subtotalForeign, subtotalBase: beforeHeader.subtotalBase, totalForeign: beforeHeader.totalForeign, totalBase: beforeHeader.totalBase } })
      }
      arms++
      assert.deepEqual(await diff(PO_TWO), [], 'restored')
      precondition(t, 'arms', arms)
    })

    it('columns the importers never set on suppliers, products and the manufacturing BOM, and the opening-stock movement\'s value, are read back too', async (t) => {
      // Mutation named: drop the defaults entries / the movement value check -> the arms are green when they must be red.
      const stub = { steps: [{ step: 'purchase-orders', units: units['purchase-orders'] }] } as unknown as PreparedRun
      const diffOf = async (step: ApplyStepId, key: string) => differingColumns(units[step].find((u) => u.key === key)!.fingerprint, (await m.observe.observeStep(stub, step)).entries.find((e) => e.key === key)!.fingerprint)
      let arms = 0
      const supplierKey = SUPPLIER_A.toLowerCase()
      assert.deepEqual(await diffOf('suppliers', supplierKey), [], 'control')
      const tax = await m.db.taxRate.findFirstOrThrow({ select: { id: true } })
      for (const [label, data, restore] of [
        ['active', { active: false }, { active: true }],
        ['prepaid', { prepaid: true }, { prepaid: false }],
        ['default VAT rate', { taxRateId: tax.id }, { taxRateId: null }],
        ['delivery days', { manualDeliveryDays: 9 }, { manualDeliveryDays: null }],
      ] as const) {
        await m.db.supplier.updateMany({ where: { name: SUPPLIER_A }, data: data as never })
        try { assert.deepEqual(await diffOf('suppliers', supplierKey), ['importerDefaults'], label) } finally { await m.db.supplier.updateMany({ where: { name: SUPPLIER_A }, data: restore as never }) }
        arms++
      }
      assert.deepEqual(await diffOf('products', `${TAG}-SIMPLE`), [], 'control')
      for (const [label, data, restore] of [
        ['taxCategory', { taxCategory: 'ZERO' }, { taxCategory: 'STANDARD' }],
        ['hsCode', { hsCode: '123456' }, { hsCode: null }],
        ['externalProductId', { externalProductId: BigInt(99) }, { externalProductId: null }],
        ['reorderPoint', { reorderPoint: '5' }, { reorderPoint: null }],
      ] as const) {
        await m.db.product.update({ where: { sku: `${TAG}-SIMPLE` }, data: data as never })
        try { assert.deepEqual(await diffOf('products', `${TAG}-SIMPLE`), ['importerDefaults'], label) } finally { await m.db.product.update({ where: { sku: `${TAG}-SIMPLE` }, data: restore as never }) }
        arms++
      }
      // an INACTIVE manufacturing BOM: planning reads only active ones
      const bom = await m.db.bom.findFirstOrThrow({ where: { product: { sku: `${TAG}-BOM` } }, select: { id: true } })
      await m.db.bom.update({ where: { id: bom.id }, data: { active: false } })
      try {
        const observed = (await m.observe.observeStep(stub, 'products')).entries.find((e) => e.key === `${TAG}-BOM`)!
        assert.notEqual(observed.recipe, units.products.find((u) => u.key === `${TAG}-BOM`)!.recipe)
        arms++
      } finally { await m.db.bom.update({ where: { id: bom.id }, data: { active: true } }) }
      // the opening movement's unit cost and value
      assert.deepEqual((await m.observe.observeStep(stub, 'opening-stock')).foreignHistoryKeys, [], 'control: clean')
      const movement = await m.db.stockMovement.findFirstOrThrow({ where: { type: 'OPENING_STOCK', product: { sku: `${TAG}-SIMPLE` } }, select: { id: true, unitCostBase: true, totalValueBase: true } })
      // The table's own check keeps the movement's value consistent with its quantity and unit cost, so the two are moved TOGETHER (a movement that agrees with itself but not with its layer).
      const qty = (await m.db.stockMovement.findUniqueOrThrow({ where: { id: movement.id }, select: { qty: true } })).qty
      await m.db.$executeRawUnsafe(`ALTER TABLE stock_movements DISABLE TRIGGER USER`)
      try {
        await m.db.stockMovement.update({ where: { id: movement.id }, data: { unitCostBase: movement.unitCostBase!.plus(1), totalValueBase: movement.totalValueBase!.plus(qty) } })
        try { assert.deepEqual((await m.observe.observeStep(stub, 'opening-stock')).foreignHistoryKeys, [`${TAG}-SIMPLE|ZQSENT-MAIN`], 'movement value') } finally { await m.db.stockMovement.update({ where: { id: movement.id }, data: { unitCostBase: movement.unitCostBase!, totalValueBase: movement.totalValueBase! } }) }
      } finally { await m.db.$executeRawUnsafe(`ALTER TABLE stock_movements ENABLE TRIGGER USER`) }
      arms++
      assert.deepEqual((await m.observe.observeStep(stub, 'opening-stock')).foreignHistoryKeys, [], 'restored')
      precondition(t, 'arms', arms)
    })

    it('a stock movement that names NO warehouse (a historical sales import writes these) is foreign history, on a resume as much as on a fresh run', async () => {
      // Mutation named: skip movements with no warehouse (the old pair loop) -> the movement is invisible and the opening stock would load beside it: red.
      const stub = { steps: [{ step: 'purchase-orders', units: units['purchase-orders'] }] } as unknown as PreparedRun
      const product = await m.db.product.findUniqueOrThrow({ where: { sku: `${TAG}-SIMPLE` }, select: { id: true } })
      const conflicts = async () => {
        const observed = await m.observe.observeStep(stub, 'opening-stock')
        const classified = classifyStep('opening-stock', units['opening-stock'], observed)
        return { observed, classified }
      }
      const clean = await conflicts()
      assert.deepEqual(clean.observed.foreignHistoryKeys, [], 'control: nothing foreign')
      assert.equal(clean.classified.counts.foreign, 0)
      const movement = await m.db.stockMovement.create({ data: { type: 'SALE_DISPATCH', productId: product.id, qty: '1', referenceType: 'WcHistorical', referenceId: 'hist-1', unitCostBase: '0', totalValueBase: '0' } })
      try {
        const dirty = await conflicts()
        assert.deepEqual(dirty.observed.foreignHistoryKeys, [`${TAG}-SIMPLE|(NO WAREHOUSE)`])
        assert.equal(dirty.classified.counts.foreign, 1, 'it is a foreign row of the step')
        assert.deepEqual(listConflicts(dirty.classified).map((c) => c.code), ['FOREIGN_ROW'])
      } finally { await m.db.stockMovement.delete({ where: { id: movement.id } }) }
      assert.equal((await conflicts()).classified.counts.foreign, 0, 'restored')
    })

    it('the supplier price cache must hold the cost of the LAST line written for the pair: after orders at 10 and then 20, a cache reset to 10 is a difference', async () => {
      // Mutation named: accept the cost of ANY stored line for the pair (the old rule) -> the reset-to-10 arm is green when it must be red.
      const execute = m.execute.createExecutor({ runId: 'cache', operator: 'Cache Test' })
      const loaded: Array<(typeof units)['purchase-orders'][number]> = []
      const stub = { steps: [{ step: 'purchase-orders', get units() { return [...units['purchase-orders'], ...loaded] } }] } as unknown as PreparedRun
      const load = async (key: string, cost: string) => {
        const data = stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: key, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '1', unitCostForeign: cost }])
        const keyed = keyStep('purchase-orders', data)
        assert.deepEqual(keyed.problems, [])
        assert.deepEqual((await execute('purchase-orders', buildResidual('purchase-orders', data, classifyStep('purchase-orders', keyed.units, { entries: [] }))[0]!, NO_LOCK)).errors, [])
        loaded.push(keyed.units[0]!)
        return keyed.units[0]!
      }
      const diff = async (unit: (typeof loaded)[number]) => differingColumns(unit.fingerprint, (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === unit.key)!.fingerprint)
      try {
        const first = await load(PO_ELEVEN, '10')
        await new Promise((r) => setTimeout(r, 15)) // distinct creation times: the importer's calls are far apart in practice
        const second = await load(PO_TWELVE, '20')
        const sp = await m.db.supplierProduct.findFirstOrThrow({ where: { supplier: { name: SUPPLIER_A }, product: { sku: `${TAG}-SIMPLE` } } })
        assert.equal(Number(sp.lastUnitCost.toFixed()), 20, 'precondition: the importer left the cache at the last order\'s cost')
        assert.deepEqual([await diff(first), await diff(second)], [[], []], 'control: matches as written')
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { lastUnitCost: '10' } })
        assert.deepEqual([await diff(first), await diff(second)], [['headerAmounts'], ['headerAmounts']], 'reset to the FIRST order\'s cost')
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { lastUnitCost: '15' } })
        assert.deepEqual(await diff(second), ['headerAmounts'], 'a cost no line has')
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { lastUnitCost: '20' } })
        assert.deepEqual([await diff(first), await diff(second)], [[], []], 'restored')
      } finally {
        for (const key of [PO_ELEVEN, PO_TWELVE]) {
          await sql(`delete from purchase_order_lines where "poId" in (select id from purchase_orders where reference = $1)`, [key])
          await sql('delete from purchase_orders where reference = $1', [key])
        }
      }
    })

    it('two orders of one call created in the SAME millisecond for one supplier and product: the cache must hold the one the file lists LAST (a tie accepts neither value by guess)', async () => {
      // Mutation named: accept the cost of either tied order (the old same-millisecond rule) -> the reset-to-the-earlier-order arm is green when it must be red.
      const execute = m.execute.createExecutor({ runId: 'tie', operator: 'Tie Test' })
      const data = stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [
        { orderKey: PO_TIE_A, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '1', unitCostForeign: '31' },
        { orderKey: PO_TIE_B, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '1', unitCostForeign: '32' },
      ])
      const keyed = keyStep('purchase-orders', data)
      assert.deepEqual(keyed.problems, [])
      const stub = { steps: [{ step: 'purchase-orders', get units() { return [...units['purchase-orders'], ...keyed.units] } }] } as unknown as PreparedRun
      const diff = async (unit: (typeof keyed.units)[number]) => differingColumns(unit.fingerprint, (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === unit.key)!.fingerprint)
      try {
        assert.deepEqual((await execute('purchase-orders', buildResidual('purchase-orders', data, classifyStep('purchase-orders', keyed.units, { entries: [] }))[0]!, NO_LOCK)).errors, [])
        await sql(`update purchase_orders set "createdAt" = date_trunc('milliseconds', now() + interval '1 hour') where reference in ($1, $2)`, [PO_TIE_A, PO_TIE_B])
        const [a, b] = keyed.units
        const sp = await m.db.supplierProduct.findFirstOrThrow({ where: { supplier: { name: SUPPLIER_A }, product: { sku: `${TAG}-SIMPLE` } } })
        assert.equal(Number(sp.lastUnitCost.toFixed()), 32, 'precondition: the importer left the cache at the order it created last')
        assert.deepEqual([await diff(a!), await diff(b!)], [[], []], 'control: as written, the two orders have the same stored time')
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { lastUnitCost: '31' } })
        assert.deepEqual([await diff(a!), await diff(b!)], [['headerAmounts'], ['headerAmounts']], 'reset to the EARLIER tied order\'s cost')
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { lastUnitCost: '32' } })
        assert.deepEqual([await diff(a!), await diff(b!)], [[], []], 'restored')
      } finally {
        for (const key of [PO_TIE_A, PO_TIE_B]) {
          await sql(`delete from purchase_order_lines where "poId" in (select id from purchase_orders where reference = $1)`, [key])
          await sql('delete from purchase_orders where reference = $1', [key])
        }
      }
    })

    it('the stored amounts are compared EXACTLY with the importer\'s arithmetic on the FILE\'s numbers: a unit cost of 1.000040 where the file gives 1.000000 is a difference although both give a 4 dp total of 1.0000', async () => {
      // Mutation named: compare the stored unit cost only with the stored total (the old tolerance) -> the 1.000040 arm is green when it must be red.
      const execute = m.execute.createExecutor({ runId: 'exact', operator: 'Exact Test' })
      const loaded: Array<(typeof units)['purchase-orders'][number]> = []
      const stub = { steps: [{ step: 'purchase-orders', get units() { return [...units['purchase-orders'], ...loaded] } }] } as unknown as PreparedRun
      const load = async (key: string, line: Record<string, string>) => {
        const data = stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: key, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, ...line }])
        const keyed = keyStep('purchase-orders', data)
        assert.deepEqual(keyed.problems, [])
        assert.deepEqual((await execute('purchase-orders', buildResidual('purchase-orders', data, classifyStep('purchase-orders', keyed.units, { entries: [] }))[0]!, NO_LOCK)).errors, [])
        loaded.push(keyed.units[0]!)
        return keyed.units[0]!
      }
      const diff = async (unit: (typeof loaded)[number]) => differingColumns(unit.fingerprint, (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === unit.key)!.fingerprint)
      try {
        const one = await load(PO_THIRTEEN, { qty: '1', unitCostForeign: '1.000000' })
        assert.deepEqual(await diff(one), [], 'control: as written')
        const line = await m.db.purchaseOrderLine.findFirstOrThrow({ where: { po: { reference: PO_THIRTEEN } } })
        // fx is 1, so the base twin is the same number; the TOTALS stay at 1.0000.
        await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: '1.00004', unitCostBase: '1.00004' } })
        assert.deepEqual(await diff(one), ['headerAmounts'], 'both unit costs at 1.000040, totals unchanged')
        await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: '1', unitCostBase: '1.00004' } })
        assert.deepEqual(await diff(one), ['headerAmounts'], 'only the base unit cost')
        // The price cache follows the unit cost here, so that only the unit cost itself can be what differs.
        const cache = await m.db.supplierProduct.findFirstOrThrow({ where: { supplier: { name: SUPPLIER_A }, product: { sku: `${TAG}-SIMPLE` } } })
        await m.db.supplierProduct.update({ where: { id: cache.id }, data: { lastUnitCost: '1.00004' } })
        await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: '1.00004', unitCostBase: '1' } })
        assert.deepEqual(await diff(one), ['headerAmounts'], 'only the foreign unit cost')
        await m.db.supplierProduct.update({ where: { id: cache.id }, data: { lastUnitCost: cache.lastUnitCost } })
        await m.db.purchaseOrderLine.update({ where: { id: line.id }, data: { unitCostForeign: line.unitCostForeign, unitCostBase: line.unitCostBase } })
        assert.deepEqual(await diff(one), [], 'restored')
        // An order whose only tax statement is an order-level PERCENT (no name): the importer taxes the lines at it although no line holds a rate row.
        const percent = await load(PO_FOURTEEN, { qty: '3', unitCostForeign: '2.5', orderTaxRateValue: '20' })
        assert.deepEqual(await diff(percent), [], 'an order-level percent with no named rate matches as written')
        const stored = await m.db.purchaseOrderLine.findFirstOrThrow({ where: { po: { reference: PO_FOURTEEN } }, select: { taxForeign: true, taxRateId: true } })
        assert.deepEqual({ rate: stored.taxRateId, tax: stored.taxForeign.toFixed() }, { rate: null, tax: '1.5' }, 'precondition: taxed at 20% without a rate row')
      } finally {
        for (const key of [PO_THIRTEEN, PO_FOURTEEN]) {
          await sql(`delete from purchase_order_lines where "poId" in (select id from purchase_orders where reference = $1)`, [key])
          await sql('delete from purchase_orders where reference = $1', [key])
        }
      }
    })

    it('two orders for one supplier and product in different currencies both match as written: only the LAST write is compared with the price cache', async () => {
      // Mutation named: require the cache currency to equal EVERY order\'s (the old rule) -> the earlier order is a false conflict: red.
      const execute = m.execute.createExecutor({ runId: 'currencies', operator: 'Currency Test' })
      const loaded: Array<(typeof units)['purchase-orders'][number]> = []
      const stub = { steps: [{ step: 'purchase-orders', get units() { return [...units['purchase-orders'], ...loaded] } }] } as unknown as PreparedRun
      const load = async (key: string, currency: string, fx: string) => {
        const data = stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: key, supplierName: SUPPLIER_B, currency, fxRateToBase: fx, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-BOM`, qty: '2', unitCostForeign: '4' }])
        const keyed = keyStep('purchase-orders', data)
        assert.deepEqual(keyed.problems, [])
        assert.deepEqual((await execute('purchase-orders', buildResidual('purchase-orders', data, classifyStep('purchase-orders', keyed.units, { entries: [] }))[0]!, NO_LOCK)).errors, [])
        loaded.push(keyed.units[0]!)
        return keyed.units[0]!
      }
      const diff = async (unit: (typeof loaded)[number]) => differingColumns(unit.fingerprint, (await m.observe.observeStep(stub, 'purchase-orders')).entries.find((e) => e.key === unit.key)!.fingerprint)
      try {
        const eur = await load(PO_FIFTEEN, 'EUR', '1.25')
        await new Promise((r) => setTimeout(r, 15))
        const gbp = await load(`${PO_FIFTEEN}-B`, 'GBP', '1')
        const sp = await m.db.supplierProduct.findFirstOrThrow({ where: { supplier: { name: SUPPLIER_B }, product: { sku: `${TAG}-BOM` } } })
        assert.equal(sp.currency, 'GBP', 'precondition: the cache holds the last write\'s currency')
        assert.deepEqual([await diff(eur), await diff(gbp)], [[], []], 'both match as written')
        await m.db.supplierProduct.update({ where: { id: sp.id }, data: { currency: 'EUR' } })
        assert.deepEqual([await diff(eur), await diff(gbp)], [['headerAmounts'], ['headerAmounts']], 'a cache currency that is not the last write\'s')
      } finally {
        for (const key of [PO_FIFTEEN, `${PO_FIFTEEN}-B`]) {
          await sql(`delete from purchase_order_lines where "poId" in (select id from purchase_orders where reference = $1)`, [key])
          await sql('delete from purchase_orders where reference = $1', [key])
        }
      }
    })

    it('a BOM whose manufacturing recipe is missing is NOT matching, although its component list is there', async () => {
      // Mutation named: drop the BOM branch in observeProducts -> the recipe equals the file's and this arm is green when it must be red.
      const bom = await m.db.product.findUniqueOrThrow({ where: { sku: `${TAG}-BOM` }, select: { id: true, manufacturingBom: { select: { id: true } } } })
      assert.ok(bom.manufacturingBom, 'control: the importer wrote the manufacturing BOM')
      const items = await m.db.bomItem.findMany({ where: { bomId: bom.manufacturingBom!.id } })
      assert.equal(items.length, 1)
      await m.db.bomItem.deleteMany({ where: { bomId: bom.manufacturingBom!.id } })
      try {
        const stub = { steps: [] } as unknown as PreparedRun
        const observed = (await m.observe.observeStep(stub, 'products')).entries.find((e) => e.key === `${TAG}-BOM`)!
        const unit = units.products.find((u) => u.key === `${TAG}-BOM`)!
        assert.notEqual(observed.recipe, unit.recipe)
        const result = classifyStep('products', [unit], { entries: [observed] })
        assert.equal(result.units[0]!.conflict?.code, 'RECIPE_DIFFERS')
      } finally {
        await m.db.bomItem.createMany({ data: items.map((i) => ({ bomId: i.bomId, parentProductId: i.parentProductId, componentProductId: i.componentProductId, qty: i.qty, sortOrder: i.sortOrder })) })
      }
    })

    it('stock history that is not exactly one opening layer is observed as unclean, and a clean pair is not', async () => {
      const stub = { steps: [] } as unknown as PreparedRun
      const clean = await m.observe.observeStep(stub, 'opening-stock')
      assert.deepEqual(clean.foreignHistoryKeys, [], 'control: the loaded pairs are clean')
      const product = await m.db.product.findUniqueOrThrow({ where: { sku: `${TAG}-SIMPLE` }, select: { id: true } })
      const warehouse = await m.db.warehouse.findUniqueOrThrow({ where: { code: 'ZQSENT-MAIN' }, select: { id: true } })
      await m.db.stockLevel.update({ where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } }, data: { reservedQty: '1' } })
      try {
        const dirty = await m.observe.observeStep(stub, 'opening-stock')
        assert.deepEqual(dirty.foreignHistoryKeys, [`${TAG}-SIMPLE|ZQSENT-MAIN`])
        const unit = units['opening-stock'].find((u) => u.key === `${TAG}-SIMPLE|ZQSENT-MAIN`)!
        const result = classifyStep('opening-stock', [unit], dirty)
        assert.equal(result.units[0]!.conflict?.code, 'FOREIGN_HISTORY')
      } finally {
        await m.db.stockLevel.update({ where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } }, data: { reservedQty: '0' } })
      }
    })
  })

  // ------------------------------------------------------------------------------------------------------------------
  // 2. APPLY THROUGH THE REAL PORTS
  // ------------------------------------------------------------------------------------------------------------------

  describe('apply through the database ports', () => {
    it('CONTROL: the effect the system actor suppresses really does produce outbox rows here', async () => {
      const probe = await m.db.product.create({ data: { sku: `${TAG}-PROBE`, name: 'probe' }, select: { id: true } })
      const { enqueueStockSync } = await import('@/lib/shopping')
      const before = await count('integration_outbox')
      try { await enqueueStockSync([probe.id], 'IMS_CHANGE') } catch { /* delivery may fail; the queued row is what is measured */ }
      const queued = (await count('integration_outbox')) - before
      console.log(`precondition (control): enqueueStockSync with WooCommerce configured queued ${queued} outbox row(s)`)
      assert.ok(queued > 0)
      await m.db.product.delete({ where: { id: probe.id } })
    })

    it('a fresh load runs every step to completion, accounts every unit from the database, and queues nothing outbound', async (t) => {
      await resetData()
      const outbound = new Map<string, number>()
      for (const table of OUTBOUND_TABLES) outbound.set(table, await count(table))
      const result = await runLoad(prepared, ports(), apply(prepared))
      // No verification port exists yet, so a completed load is NOT reported as OK.
      assert.equal(result.exit, 'APPLIED_UNVERIFIED')
      assert.deepEqual(result.problems, ['no post-run verification was run: this runner has no verification port'])
      let units = 0
      for (const step of result.steps) {
        assert.equal(step.status, 'DONE', step.step)
        assert.equal(step.emitted, step.created + step.updated + step.skippedExisting + step.failed, `${step.step}: the identity reconciles`)
        assert.equal(step.created, step.emitted, `${step.step}: every unit was created`)
        assert.deepEqual(step.counterFindings, [], `${step.step}: the importer's counters agree with the database`)
        units += step.emitted
      }
      precondition(t, 'units created', units)
      assert.equal(result.steps.length, prepared.steps.length)
      for (const table of OUTBOUND_TABLES) assert.equal(await count(table), outbound.get(table), `${table} did not grow`)
      // Owner ruling: a product that is not stock tracked is loaded as a product and carries no stock, no layer and no movement.
      const fee = await m.db.product.findUniqueOrThrow({ where: { sku: 'ZQSENT-LICENCE-FEE' }, select: { type: true, stockLevels: { select: { id: true } }, costLayers: { select: { id: true } }, stockMovements: { select: { id: true } } } })
      assert.deepEqual({ type: fee.type, stock: fee.stockLevels.length, layers: fee.costLayers.length, movements: fee.stockMovements.length }, { type: 'NON_INVENTORY', stock: 0, layers: 0, movements: 0 })
      // Owner ruling: the zero-cost pair the manifest accepted is a real zero-cost opening layer.
      assert.equal(await count('cost_layers'), prepared.steps.find((s) => s.step === 'opening-stock')!.units.length)
      assert.equal(Number((await sql<{ n: string }>(`select count(*)::text as n from cost_layers where "unitCostBase" = 0`))[0]!.n), prepared.zeroCostPairs.length)
      assert.equal(await count('first_load_apply_runs'), 1)
      const record = await m.journal.createJournal().load()
      assert.equal(record!.status, 'APPLIED')
      assert.equal(record!.manifestDigest, prepared.manifestDigest)
      // The actor is recorded.
      const imports = await sql<{ metadata: { actor?: { kind: string; runId: string } } }>(`select metadata from activity_logs where "entityType" = 'IMPORT'`)
      assert.ok(imports.length >= 4 && imports.every((r) => r.metadata?.actor?.kind === 'system' && r.metadata.actor.runId === prepared.manifest.runId))
    })

    it('a plan over the loaded database finds every unit present and matching, and sends nothing', async () => {
      const result = await runLoad(prepared, ports(), plan())
      assert.equal(result.exit, 'OK')
      for (const step of result.steps) {
        assert.equal(step.toLoad, 0, `${step.step}: nothing left to load`)
        assert.equal(step.skippedExisting, step.emitted)
        assert.ok(step.rows.every((r) => r.outcome === 'would-skip-existing'))
      }
    })

    it('resume on the APPLIED run (no verification port) writes nothing: no importer call, no log row, the record untouched, and it is still not OK', async () => {
      const before = { logs: await count('activity_logs'), version: (await m.journal.createJournal().load())!.version }
      const result = await runLoad(prepared, ports(), apply(prepared, { resume: true }))
      assert.equal(result.exit, 'APPLIED_UNVERIFIED')
      assert.deepEqual({ logs: await count('activity_logs'), version: (await m.journal.createJournal().load())!.version }, before)
    })

    it('a run record exists, so a second apply without --resume is refused, and writes nothing', async () => {
      const before = await count('activity_logs')
      const result = await runLoad(prepared, ports(), apply(prepared))
      assert.equal(result.exit, 'PRECONDITION_REFUSED')
      assert.match(result.problems.join(' '), /run record already exists/)
      assert.equal(await count('activity_logs'), before)
    })

    it('a data conflict stops the plan; the offending key is named by a closed code, not by its value', async () => {
      await m.db.supplier.updateMany({ where: { name: 'ZQSENT Timber Co' }, data: { email: 'someone-else@example.test' } })
      try {
        const result = await runLoad(prepared, ports(), plan())
        assert.equal(result.exit, 'PRECONDITION_REFUSED')
        const conflicts = result.steps.flatMap((s) => s.conflicts)
        assert.deepEqual(conflicts.map((c) => c.code), ['FIELDS_DIFFER'])
      } finally {
        await m.db.supplier.updateMany({ where: { name: 'ZQSENT Timber Co' }, data: { email: null } })
      }
    })

    describe('the pre-load rails', () => {
      const readers = (over: Partial<import('../../lib/first-load/apply/db/preload-rails').PreloadReaders> = {}) => ({ ...CLEAN_PRELOAD, ...over })
      const clearSettings = async (...keys: string[]) => { for (const key of keys) await m.db.setting.deleteMany({ where: { key } }) }

      it('CONTROL: over a quiet installation every pre-load rail is evaluated and none refuses', async () => {
        await resetData()
        const results = await m.rails.evaluateRailResults(prepared, { phase: 'preflight', resuming: false, step: null }, readers())
        for (const id of PRELOAD_RAIL_IDS) assert.deepEqual(results.find((r) => r.id === id)?.problems, [], id)
        assert.deepEqual(results.flatMap((r) => r.problems), [])
      })

      it('the REAL connector reader sees this installation\'s configured storefront and refuses it [mutation: ignore the storefront in connectorFinding]', async () => {
        // The suite seeds WooCommerce enabled with a URL and keys (to prove effects are suppressed). That is exactly the installation the rail must refuse.
        const real = await m.preload.readConnectorSnapshot({})
        assert.equal(real.pluginEnabled.woocommerce, true)
        assert.ok(real.credentialPresent['wc_url'] && real.credentialPresent['wc_consumer_key'] && real.credentialPresent['wc_consumer_secret'])
        const problems = (await m.rails.evaluateRailResults(prepared, { phase: 'preflight', resuming: false, step: null }, { ...CLEAN_PRELOAD, connectors: m.preload.readConnectorSnapshot })).flatMap((r) => r.problems)
        assert.match(problems.join(' | '), /connectors: the WooCommerce connector is enabled with store credentials/)
        assert.ok(!/ck_apply|cs_apply|127\.0\.0\.1/.test(problems.join(' ')), 'no credential or URL in the text')
        // The refusal reaches the command: an apply is refused before anything is written.
        const result = await runLoad(prepared, m.ports.createDbPorts(prepared, { operator: 'Apply Test', preload: { ...CLEAN_PRELOAD, connectors: m.preload.readConnectorSnapshot } }), apply(prepared))
        assert.equal(result.exit, 'PRECONDITION_REFUSED')
        assert.equal(await count('first_load_apply_runs'), 0)
        assert.equal(await count('suppliers'), 0)
        assert.equal(await count('products'), 0)
      })

      it('the real reader reads each connector: enabled with a credential refuses, switched off does not, a credential from the environment counts [mutation: skip the environment fallback / the enabled flag]', async () => {
        const wooKeys = [INTEGRATION_PLUGIN_SETTING_KEYS.woocommerce]
        const original = await m.db.setting.findUnique({ where: { key: wooKeys[0]! } })
        try {
          await m.db.setting.update({ where: { key: wooKeys[0]! }, data: { value: 'false' } })
          const off = await m.preload.readConnectorSnapshot({})
          assert.equal(off.pluginEnabled.woocommerce, false)
          assert.deepEqual(m.preload.connectorFinding(off).problems, [], 'credentials without the connector enabled')
          // Mintsoft: enabled, a key in the ENVIRONMENT only.
          await m.db.setting.upsert({ where: { key: INTEGRATION_PLUGIN_SETTING_KEYS.mintsoft }, create: { key: INTEGRATION_PLUGIN_SETTING_KEYS.mintsoft, value: 'true' }, update: { value: 'true' } })
          assert.deepEqual(m.preload.connectorFinding(await m.preload.readConnectorSnapshot({})).problems, [], 'enabled, nothing configured')
          assert.equal(m.preload.connectorFinding(await m.preload.readConnectorSnapshot({ MINTSOFT_API_KEY: 'k' })).problems.length, 1, 'a key from the environment')
          assert.equal(m.preload.connectorFinding(await m.preload.readConnectorSnapshot({ MINTSOFT_API_KEY: '   ' })).problems.length, 0, 'a blank one is nothing')
          await m.db.setting.upsert({ where: { key: 'mintsoft_api_key' }, create: { key: 'mintsoft_api_key', value: 'stored' }, update: { value: 'stored' } })
          assert.equal(m.preload.connectorFinding(await m.preload.readConnectorSnapshot({})).problems.length, 1, 'a stored key')
          await m.db.setting.update({ where: { key: 'mintsoft_api_key' }, data: { value: '' } })
          assert.equal(m.preload.connectorFinding(await m.preload.readConnectorSnapshot({})).problems.length, 0, 'an emptied one is nothing')
          // A plugin switch with a value the application does not understand is read as ENABLED (refuse), not as off.
          for (const odd of ['yes', '1', 'TRUE', 'enabled']) {
            await m.db.setting.update({ where: { key: INTEGRATION_PLUGIN_SETTING_KEYS.mintsoft }, data: { value: odd } })
            await m.db.setting.upsert({ where: { key: 'mintsoft_api_key' }, create: { key: 'mintsoft_api_key', value: 'stored' }, update: { value: 'stored' } })
            assert.equal(m.preload.connectorFinding(await m.preload.readConnectorSnapshot({})).problems.length, 1, `plugin value ${odd}`)
          }
          await m.db.setting.update({ where: { key: INTEGRATION_PLUGIN_SETTING_KEYS.mintsoft }, data: { value: 'false' } })
          assert.equal(m.preload.connectorFinding(await m.preload.readConnectorSnapshot({})).problems.length, 0, 'exactly false is off')
          await m.db.setting.update({ where: { key: INTEGRATION_PLUGIN_SETTING_KEYS.mintsoft }, data: { value: 'true' } })
          await m.db.setting.update({ where: { key: 'mintsoft_api_key' }, data: { value: '' } })
          // Xero: enabled with a stored token.
          await m.db.setting.upsert({ where: { key: INTEGRATION_PLUGIN_SETTING_KEYS.xero }, create: { key: INTEGRATION_PLUGIN_SETTING_KEYS.xero, value: 'true' }, update: { value: 'true' } })
          assert.equal(m.preload.connectorFinding(await m.preload.readConnectorSnapshot({})).problems.length, 0)
          await m.db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3_600_000), tenantId: 't' } })
          assert.equal(m.preload.connectorFinding(await m.preload.readConnectorSnapshot({})).problems.length, 1, 'a stored accounting token')
        } finally {
          await m.db.accountingToken.deleteMany({})
          await clearSettings(INTEGRATION_PLUGIN_SETTING_KEYS.mintsoft, INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'mintsoft_api_key')
          if (original) await m.db.setting.update({ where: { key: wooKeys[0]! }, data: { value: original.value } })
        }
      })

      it('an unreadable settings table is a refusal, never a quiet installation [mutation: return an empty snapshot on error]', async () => {
        await sql('alter table settings rename to settings_hidden')
        try {
          await assert.rejects(m.preload.readConnectorSnapshot({}), (e: unknown) => e instanceof ObservationError && e.message === m.observe.DATABASE_READ_FAILED)
          const result = await runLoad(prepared, m.ports.createDbPorts(prepared, { operator: 'Apply Test', preload: { ...CLEAN_PRELOAD, connectors: m.preload.readConnectorSnapshot } }), apply(prepared))
          assert.equal(result.exit, 'PRECONDITION_REFUSED')
          assert.match(result.problems.join(' '), /could not be read/)
          assert.equal(await count('first_load_apply_runs'), 0)
        } finally {
          await sql('alter table settings_hidden rename to settings')
        }
      })

      it('a grant, a live-from instant or an armed cron refuses a whole load before the run record, the first row or a lock (nothing written)', async () => {
        await resetData()
        const before = { runs: await count('first_load_apply_runs'), logs: await count('activity_logs'), suppliers: await count('suppliers'), products: await count('products') }
        const arms: Array<[string, Partial<import('../../lib/first-load/apply/db/preload-rails').PreloadReaders>, RegExp]> = [
          ['an outbound grant', { env: { WC_WRITEBACK_ALLOWED_ORIGIN: 'https://shop.example.test' } }, /outbound grants: a write grant for WooCommerce/],
          ['a live-from instant', { env: { XERO_WRITES_LIVE_FROM: '2026-10-30T00:00:00Z' } }, /producer hold: a live-from instant is set for Xero/],
          ['an unreadable enforcement value', { env: { PRODUCER_HOLD_ENFORCED_DESTINATIONS: 'nope' } }, /producer hold: the enforcement variable is set but cannot be read/],
          ['an armed writing cron', { crontab: async () => ({ resolved: true, text: '*/5 * * * * curl -sf -K - "$BASE_URL/accounting-sync"' }) }, /crons: 1 active crontab line\(s\) are not proven/],
          ['an unreadable crontab', { crontab: async () => ({ resolved: false }) }, /crons: the crontab of the account running the load could not be read/],
        ]
        for (const [label, over, expected] of arms) {
          const result = await runLoad(prepared, m.ports.createDbPorts(prepared, { operator: 'Apply Test', preload: readers(over) }), apply(prepared))
          assert.equal(result.exit, 'PRECONDITION_REFUSED', label)
          assert.match(result.problems.join(' | '), expected, label)
          assert.deepEqual({ runs: await count('first_load_apply_runs'), logs: await count('activity_logs'), suppliers: await count('suppliers'), products: await count('products') }, before, `${label}: nothing written`)
          const planned = await runLoad(prepared, m.ports.createDbPorts(prepared, { operator: 'Apply Test', preload: readers(over) }), plan())
          assert.equal(planned.exit, 'PRECONDITION_REFUSED', `${label}: a plan refuses too`)
        }
      })

      it('the rails are evaluated again inside the run: a grant that appears after the preflight stops the first step before it writes [mutation: drop the step-start recheck]', async () => {
        await resetData()
        let reads = 0
        const env: Record<string, string> = {}
        const flipping = readers({ env, connectors: async () => { reads += 1; if (reads === 2) env.MINTSOFT_WRITE_ALLOWED = 'https://api.example.test|89'; return CLEAN_SNAPSHOT } })
        const result = await runLoad(prepared, m.ports.createDbPorts(prepared, { operator: 'Apply Test', preload: flipping }), apply(prepared))
        assert.equal(result.exit, 'STEP_FAILED', result.problems.join(' | '))
        assert.match(result.problems.join(' | '), /a rail no longer holds: outbound grants: a write grant for Mintsoft/)
        assert.equal(await count('suppliers'), 0)
        assert.equal(await count('products'), 0)
        assert.equal(result.steps[0]!.importer.length, 0, 'no importer was called')
      })

      it('the tally is kept for the report: a rail that refused once stays refused, and the rest are listed with their state', async () => {
        await resetData()
        const refusing = m.ports.createDbPorts(prepared, { operator: 'Apply Test', preload: readers({ env: { MINTSOFT_WRITE_ALLOWED: 'https://api.example.test|89' } }) })
        await runLoad(prepared, refusing, apply(prepared))
        const tally = refusing.railTally!()
        assert.ok(tally.find((t) => t.id === 'outbound-grants')!.refusals >= 1)
        const report = buildPreconditions(tally)
        assert.equal(report.find((p) => p.id === 'rail:outbound-grants')!.result, 'refused')
        assert.equal(report.find((p) => p.id === 'rail:producer-hold')!.result, 'refused')
        assert.deepEqual(report.map((p) => p.id), PRECONDITION_IDS)
        assert.match(report.find((p) => p.id === 'rail:producer-hold')!.detail, /refused in/)
      })
    })

    describe('the empty-target rail', () => {
      it('CONTROL: the rail passes on an empty database', async () => {
        await resetData()
        assert.deepEqual(await evaluateRails(prepared, { phase: 'preflight', resuming: false, step: null }), [])
      })

      it('a first run into a database that already holds business data is refused before anything is written, with nothing written', async () => {
        // Mutation named: delete the emptyTarget call -> this arm loads over the foreign data and is red.
        await m.db.supplier.create({ data: { name: 'Somebody Else Ltd' } })
        const writes = { logs: await count('activity_logs'), products: await count('products'), runs: await count('first_load_apply_runs') }
        const result = await runLoad(prepared, ports(), apply(prepared))
        assert.equal(result.exit, 'PRECONDITION_REFUSED')
        assert.match(result.problems.join('; '), /empty target: the suppliers table holds 1 row/)
        assert.deepEqual({ logs: await count('activity_logs'), products: await count('products'), runs: await count('first_load_apply_runs') }, writes)
        const planned = await runLoad(prepared, ports(), plan())
        assert.equal(planned.exit, 'PRECONDITION_REFUSED')
        await resetData()
      })

      it('a locked base currency alone is refused too', async () => {
        await m.db.setting.upsert({ where: { key: 'base_currency_locked' }, create: { key: 'base_currency_locked', value: 'true' }, update: { value: 'true' } })
        try {
          assert.match((await evaluateRails(prepared, { phase: 'preflight', resuming: false, step: null })).join(';'), /base currency is already locked/)
          assert.deepEqual(await evaluateRails(prepared, { phase: 'preflight', resuming: true, step: null }), [], 'a resume is not asked for emptiness')
        } finally {
          await m.db.setting.delete({ where: { key: 'base_currency_locked' } })
        }
      })
    })

    describe('the quiesce rail: no other writer is connected to the database', () => {
      // A session from ANOTHER PROCESS (a child that holds one connection): a client in this process would be this process's own socket, which the rail rightly counts as the runner's.
      const foreignClient = async (applicationName = 'psql'): Promise<{ end(): Promise<void> }> => {
        const script = `const pg = require('pg'); const c = new pg.Client({ connectionString: process.env.FOREIGN_URL, application_name: process.env.FOREIGN_APP }); c.connect().then(() => { console.log('ready'); setInterval(() => {}, 1000) }, (e) => { console.error(e.message); process.exit(2) })`
        const child = spawn(process.execPath, ['-e', script], { cwd: REPO, env: { PATH: process.env.PATH ?? '', FOREIGN_URL: url, FOREIGN_APP: applicationName } as unknown as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
        await new Promise<void>((resolve, reject) => {
          child.stdout!.on('data', (d: Buffer) => { if (String(d).includes('ready')) resolve() })
          child.on('exit', (code) => reject(new Error(`the foreign session process exited (${code})`)))
          setTimeout(() => reject(new Error('the foreign session did not connect')), 20_000)
        })
        return { end: async () => { child.removeAllListeners('exit'); child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r)) } }
      }
      const counts = async () => ({ runs: await count('first_load_apply_runs'), logs: await count('activity_logs'), suppliers: await count('suppliers') })

      it('CONTROL: the runner\'s own sessions (the pool and the lock pool, tagged) are not counted: the rail passes while they are open', async (t) => {
        await resetData()
        await m.lock.withStepLock('suppliers', async () => undefined) // opens a lock-pool connection that stays pooled
        const own = Number((await sql<{ n: string }>(`select count(*)::text as n from pg_stat_activity where datname = current_database() and backend_type = 'client backend' and application_name = $1`, [RUNNER_APPLICATION_NAME]))[0]!.n)
        precondition(t, 'tagged sessions open', own)
        assert.ok(own >= 2, `the pool and the lock pool are both open (${own})`)
        assert.deepEqual((await evaluateRails(prepared, { phase: 'preflight', resuming: false, step: null })).filter((p) => p.startsWith('quiesce:')), [])
      })

      it('another client session on the database (here a psql-like one) refuses the preflight, and nothing is written', async () => {
        // Mutation named: drop the quiesce call from evaluateRails -> the load goes ahead over a connected writer: red.
        await resetData()
        const other = await foreignClient()
        try {
          const before = await counts()
          const problems = await evaluateRails(prepared, { phase: 'preflight', resuming: false, step: null })
          assert.ok(problems.some((p) => /^quiesce: 1 other client session\(s\) are connected to this database/.test(p)), JSON.stringify(problems))
          const planned = await runLoad(prepared, ports(), plan())
          assert.equal(planned.exit, 'PRECONDITION_REFUSED')
          const result = await runLoad(prepared, ports(), apply(prepared))
          assert.equal(result.exit, 'PRECONDITION_REFUSED')
          assert.match(result.problems.join(';'), /quiesce: 1 other client session/)
          assert.deepEqual(await counts(), before, 'nothing was written')
        } finally { await other.end() }
        assert.deepEqual((await evaluateRails(prepared, { phase: 'preflight', resuming: false, step: null })).filter((p) => p.startsWith('quiesce:')), [], 'gone: accepted again')
      })

      it('a foreign session that copies the runner\'s application_name is still another client (the label proves nothing)', async () => {
        // Mutation named: exclude sessions by application_name (the old rule) -> the spoofing session is not counted and the rail passes: red.
        await resetData()
        const spoof = await foreignClient(RUNNER_APPLICATION_NAME)
        try {
          const problems = await evaluateRails(prepared, { phase: 'preflight', resuming: false, step: null })
          assert.ok(problems.some((p) => /^quiesce: 1 other client session\(s\)/.test(p)), JSON.stringify(problems))
          const result = await runLoad(prepared, ports(), apply(prepared))
          assert.equal(result.exit, 'PRECONDITION_REFUSED')
          assert.equal(await count('suppliers'), 0)
        } finally { await spoof.end() }
      })

      it('a session from ANOTHER ADDRESS that uses the very same source port as one of our sockets is still another client', async () => {
        // Mutation named: match on the client port alone (the old rule) -> the session is admitted as ours and the rail passes: red.
        await resetData()
        appendFileSync(join(cluster.data, 'pg_hba.conf'), '\nhost all all 127.0.0.0/8 scram-sha-256\n')
        socketPsql(cluster, 'select pg_reload_conf();')
        await m.lock.withStepLock('suppliers', async () => undefined)
        const server = (await sql<{ addr: string; port: number }>('select host(inet_server_addr()) as addr, inet_server_port() as port'))[0]!
        const { ownEndpoints, normaliseAddress } = await import('../../lib/first-load/apply/db/own-sessions')
        const ours = [...ownEndpoints({ addr: normaliseAddress(server.addr)!, port: Number(server.port) })]
        assert.ok(ours.length > 0, 'precondition: we hold sessions')
        const sharedPort = Number(ours[0]!.split('|')[1])
        const script = `const net = require('net'); const pg = require('pg');
          class S extends net.Socket { connect(port, host) { return super.connect({ port, host, localAddress: '127.0.0.2', localPort: Number(process.env.SHARED_PORT) }) } }
          const c = new pg.Client({ connectionString: process.env.FOREIGN_URL, application_name: 'other-host', stream: () => new S() });
          c.connect().then(() => { console.log('ready'); setInterval(() => {}, 1000) }, (e) => { console.error(e.message); process.exit(2) })`
        const child = spawn(process.execPath, ['-e', script], { cwd: REPO, env: { PATH: process.env.PATH ?? '', FOREIGN_URL: url, SHARED_PORT: String(sharedPort) } as unknown as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
        try {
          await new Promise<void>((resolve, reject) => {
            child.stdout!.on('data', (d: Buffer) => { if (String(d).includes('ready')) resolve() })
            child.stderr!.on('data', (d: Buffer) => reject(new Error(String(d))))
            child.on('exit', (code) => reject(new Error(`exited ${code}`)))
            setTimeout(() => reject(new Error('timed out')), 20_000)
          })
          const seen = await sql<{ addr: string; port: number }>(`select host(client_addr) as addr, client_port as port from pg_stat_activity where application_name = 'other-host'`)
          assert.deepEqual(seen.map((r) => [r.addr, r.port]), [['127.0.0.2', sharedPort]], 'precondition: the session really has the same source port from another address')
          const problems = await m.rails.quiesceProblems()
          assert.ok(problems.some((p) => /^quiesce: 1 other client session/.test(p)), JSON.stringify(problems))
        } finally { child.removeAllListeners('exit'); child.kill('SIGKILL') }
      })

      it('every session of THIS process is recognised by its socket, however many the pools hold', async (t) => {
        await resetData()
        // Open several pool connections at once, plus the lock pool.
        await Promise.all(Array.from({ length: 6 }, () => m.db.$queryRaw`select 1 as one from pg_sleep(0.05)`))
        await m.lock.withStepLock('suppliers', async () => undefined)
        const server = (await sql<{ addr: string; port: number }>('select host(inet_server_addr()) as addr, inet_server_port() as port'))[0]!
        const { ownEndpoints, normaliseAddress, endpointKey } = await import('../../lib/first-load/apply/db/own-sessions')
        const own = ownEndpoints({ addr: normaliseAddress(server.addr)!, port: Number(server.port) })
        const sessions = await sql<{ addr: string | null; port: number | null }>(`select host(client_addr) as addr, client_port as port from pg_stat_activity where datname = current_database() and backend_type = 'client backend' and pid <> pg_backend_pid() and application_name = $1`, [RUNNER_APPLICATION_NAME])
        precondition(t, 'own sessions seen by the server', sessions.length)
        assert.ok(sessions.length >= 3, `the pools hold several connections (${sessions.length})`)
        assert.deepEqual(sessions.filter((r) => r.port === null || r.addr === null || !own.has(endpointKey(normaliseAddress(r.addr)!, r.port))), [], `each of them is a socket of this process (own endpoints: ${[...own].join(',')})`)
        assert.deepEqual(await m.rails.quiesceProblems(), [])
      })

      it('a session that appears in the middle of a step stops the file before its NEXT importer call: at most one bounded call of rows is written', async () => {
        // Mutation named: drop the quiesce check from the per-call guard -> all four opening layers are written by the runner while another session is connected: red.
        await resetData()
        const holder: { client: { end(): Promise<void> } | null } = { client: null }
        const small = m.ports.createDbPorts(prepared, { preload: CLEAN_PRELOAD,
          operator: 'Apply Test',
          maxRowsPerCall: 1,
          afterCall: async (step, call) => { if (step === 'opening-stock' && call === 1 && holder.client === null) holder.client = await foreignClient('late-worker') },
        })
        try {
          const result = await runLoad(prepared, small, apply(prepared))
          assert.equal(result.exit, 'STEP_FAILED')
          const stock = result.steps.find((x) => x.step === 'opening-stock')!
          assert.match(stock.error ?? '', /QuiesceError/)
          assert.equal(await count('cost_layers'), 1, 'exactly the one call that was already made')
          assert.equal(await count('purchase_orders'), 0, 'and no later step ran')
        } finally { await holder.client?.end() }
      })

      it('a session that connects BETWEEN steps refuses the next step (its start rail), and the earlier step stays done', async () => {
        await resetData()
        const holder: { client: { end(): Promise<void> } | null } = { client: null }
        const real = ports()
        const connecting: ApplyPorts = {
          ...real,
          execute: async (step, file, lock) => {
            const answer = await real.execute(step, file, lock)
            if (step === 'suppliers' && holder.client === null) holder.client = await foreignClient('app-server')
            return answer
          },
        }
        try {
          const result = await runLoad(prepared, connecting, apply(prepared))
          assert.equal(result.exit, 'STEP_FAILED')
          assert.match(result.problems.join(';'), /products: a rail no longer holds: quiesce: 1 other client session/)
          assert.equal(result.steps[0]!.step, 'suppliers')
          assert.equal(result.steps[0]!.status, 'DONE')
          assert.equal(await count('products'), 0, 'the next step wrote nothing')
        } finally { await holder.client?.end() }
      })

      it('a session that appears after the step-start check but before the first write refuses the write (the third check)', async () => {
        await resetData()
        const holder: { client: { end(): Promise<void> } | null } = { client: null }
        const real = ports()
        let startChecks = 0
        const connecting: ApplyPorts = {
          ...real,
          recheckRails: async (step, phase) => {
            const problems = await real.recheckRails!(step, phase)
            if (step === 'products' && phase === 'step-start' && ++startChecks === 1 && holder.client === null) holder.client = await foreignClient('cron-worker')
            return problems
          },
        }
        try {
          const result = await runLoad(prepared, connecting, apply(prepared))
          assert.equal(result.exit, 'STEP_FAILED')
          assert.match(result.problems.join(';'), /products: a rail no longer holds: quiesce: 1 other client session/)
          assert.equal(await count('products'), 0)
        } finally { await holder.client?.end() }
      })
    })

    describe('what a failing importer leaves behind carries no file value', () => {
      // Mutation named: drop the description redaction in withSystemActor -> the importers' raw first error lands in activity_logs, readable by every activity-log user: red.
      const logText = async (): Promise<string> => (await sql<{ t: string }>('select row_to_json(a)::text as t from activity_logs a')).map((r) => r.t).join('\n')
      const arms: Array<{ step: ApplyStepId; marker: string; file: () => StepRows; seed?: () => Promise<void> }> = [
        {
          step: 'suppliers', marker: 'zqleaksuppliername',
          file: () => stepRows(SUPPLIERS_IMPORT_HEADERS, [{ name: 'zqleaksuppliername', currency: 'GBP', purchaseTaxType: 'NONE' }]),
          seed: async () => { await m.db.supplier.create({ data: { name: 'ZQLEAKSUPPLIERNAME' } }); await m.db.supplier.create({ data: { name: 'zqleaksuppliername' } }) },
        },
        { step: 'products', marker: 'ZQLEAKPARENTSKU', file: () => stepRows(PRODUCTS_IMPORT_HEADERS, [{ sku: 'ZQLEAK-CHILD', name: 'c', type: 'SIMPLE', parentSku: 'ZQLEAKPARENTSKU' }]) },
        { step: 'opening-stock', marker: 'ZQLEAKSTOCKSKU', file: () => stepRows(OPENING_STOCK_IMPORT_HEADERS, [{ sku: 'ZQLEAKSTOCKSKU', warehouseCode: 'ZQSENT-MAIN', qty: '1', unitCostBase: '1' }]) },
        { step: 'purchase-orders', marker: 'ZQLEAKSUPPLIEROFPO', file: () => stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: 'ZQLEAK-PO', supplierName: 'ZQLEAKSUPPLIEROFPO', destinationWarehouseCode: 'ZQSENT-MAIN', sku: 'ZQLEAKSKU', qty: '1', unitCostForeign: '1' }]) },
      ]
      for (const arm of arms) {
        it(`${arm.step}: the importer's raw error reaches the runner (which reduces it) but not activity_logs`, async () => {
          await resetData()
          try {
            await arm.seed?.()
            const execute = m.execute.createExecutor({ runId: 'leak', operator: 'Leak Test' })
            const keyed = keyStep(arm.step, arm.file())
            const result = await execute(arm.step, buildResidual(arm.step, arm.file(), classifyStep(arm.step, keyed.units, { entries: [] }))[0]!, NO_LOCK)
            assert.ok(result.errors.join(';').includes(arm.marker), 'precondition: the importer echoes the value in its error, so a leak would be visible')
            const logs = await logText()
            assert.ok(/Failed to import|Imported/.test(logs), 'precondition: the importer did write an activity entry')
            assert.ok(!logs.includes(arm.marker), 'no file value in activity_logs')
          } finally { await resetData() }
        })
      }
    })

    const logTextForCatch = async (): Promise<string> => (await sql<{ t: string }>('select description as t from activity_logs')).map((r) => r.t).join('\n')
    describe('the supplier importer\'s catch path', () => {
      it('the real importer\'s catch-all returns an error without the system outcome, and the executor throws instead of returning it', async () => {
        // Mutation named: return normally after a result without the system outcome -> this arm resolves instead of rejecting.
        await resetData()
        const file = stepRows(SUPPLIERS_IMPORT_HEADERS, [{ name: 'ZQ Catch Path Ltd', currency: 'GBP', purchaseTaxType: 'NONE' }])
        const keyed = keyStep('suppliers', file)
        const execute = m.execute.createExecutor({ runId: 'catch', operator: 'Catch Test' })
        const residual = buildResidual('suppliers', file, classifyStep('suppliers', keyed.units, { entries: [] }))[0]!
        await sql('alter table suppliers rename to suppliers_zq_hidden') // the importer\'s first read fails: its own catch-all answers
        try {
          await assert.rejects(execute('suppliers', residual, NO_LOCK), { name: m.execute.IMPORTER_RETURNED_NO_SYSTEM_OUTCOME })
        } finally { await sql('alter table suppliers_zq_hidden rename to suppliers') }
        assert.ok(/Failed to import suppliers/.test(await logTextForCatch()), 'precondition: it was the importer\'s catch path that ran')
        await resetData()
      })
    })

    describe('supplier currency and default tax rate (owner rulings)', () => {
      // Mutations named, one per guard (each was made, the arm went red, and it was reverted):
      //   delete `taxRateId` from the create/update data in importSuppliersCsv -> 'sets the currency and the default tax rate' red;
      //   drop the `.length !== 1` test in importSuppliersCsv (take the first match) -> the ambiguous row is created: red;
      //   drop `usedFor: { in: ['PURCHASE','BOTH'] }` / `active: true` from its rate query -> the decoy rates are chosen: red;
      //   drop the isSystemImport currency/blank-tax refusals -> the blank rows are created with the default currency / no rate: red;
      //   change `matches.length === 1`-style check in rails supplierTaxRates to `=== 0` only -> the several-rates arm is green when it must be red.
      const ids: Record<string, string> = {}
      const addRate = async (key: string, data: { name: string; usedFor: string; active?: boolean; accountingTaxType: string }) => {
        ids[key] = (await m.db.taxRate.create({ data: { rate: '0.2', ...data, active: data.active ?? true }, select: { id: true } })).id
      }
      const load = async (rows: Array<Record<string, string>>) => {
        const file = stepRows(SUPPLIERS_IMPORT_HEADERS, rows)
        const keyed = keyStep('suppliers', file)
        const execute = m.execute.createExecutor({ runId: 'sup-tax', operator: 'Supplier Tax Test' })
        return execute('suppliers', buildResidual('suppliers', file, classifyStep('suppliers', keyed.units, { entries: [] }))[0]!, NO_LOCK)
      }
      const fresh = async () => {
        await resetData()
        await m.db.taxRate.deleteMany({ where: { name: { startsWith: 'ZQST ' } } })
        await addRate('std', { name: 'ZQST Std', usedFor: 'PURCHASE', accountingTaxType: 'INPUT2' })
        await addRate('zero', { name: 'ZQST Zero', usedFor: 'BOTH', accountingTaxType: 'ZERORATEDINPUT' })
        // decoys: never chosen
        await addRate('oldStd', { name: 'ZQST Old Std', usedFor: 'PURCHASE', accountingTaxType: 'INPUT2', active: false })
        await addRate('salesNone', { name: 'ZQST Sales None', usedFor: 'SALES', accountingTaxType: 'NONE' })
        await addRate('salesZero', { name: 'ZQST Sales Zero', usedFor: 'SALES', accountingTaxType: 'ZERORATEDINPUT' })
      }
      const cleanup = async () => { await m.db.taxRate.deleteMany({ where: { name: { startsWith: 'ZQST ' } } }); await resetData() }

      it('sets the currency and the default tax rate of every created supplier, each to its one rate', async (t) => {
        await fresh()
        try {
          const none = await m.db.taxRate.findFirstOrThrow({ where: { name: 'ZQDB No VAT' }, select: { id: true } })
          const result = await load([
            { name: 'ZQST A', currency: 'GBP', purchaseTaxType: 'INPUT2' },
            { name: 'ZQST B', currency: 'EUR', purchaseTaxType: 'ZERORATEDINPUT' },
            { name: 'ZQST C', currency: 'USD', purchaseTaxType: 'NONE' },
          ])
          assert.deepEqual(result.errors, [])
          const stored = await m.db.supplier.findMany({ where: { name: { startsWith: 'ZQST ' } }, select: { name: true, currency: true, taxRateId: true }, orderBy: { name: 'asc' } })
          assert.deepEqual(stored.map((x) => [x.name, x.currency, x.taxRateId]), [['ZQST A', 'GBP', ids.std], ['ZQST B', 'EUR', ids.zero], ['ZQST C', 'USD', none.id]])
          precondition(t, 'suppliers checked', stored.length)
        } finally { await cleanup() }
      })

      it('refuses the row when the rate is not exactly one: none, several, or only a decoy', async (t) => {
        await fresh()
        try {
          await m.db.taxRate.update({ where: { id: ids.zero! }, data: { active: false } })      // ZERORATEDINPUT: only an inactive rate and a sales-only decoy remain
          await addRate('stdTwo', { name: 'ZQST Std Two', usedFor: 'BOTH', accountingTaxType: 'INPUT2' }) // INPUT2: two active purchase-capable rates
          const result = await load([
            { name: 'ZQST Ambiguous', currency: 'GBP', purchaseTaxType: 'INPUT2' },
            { name: 'ZQST Decoys Only', currency: 'GBP', purchaseTaxType: 'ZERORATEDINPUT' },
            { name: 'ZQST Unknown Type', currency: 'GBP', purchaseTaxType: 'EXEMPTINPUT' },
          ])
          assert.equal(result.errors.filter((e) => /purchaseTaxType matches \d+ active purchase tax rates/.test(e)).length, 3)
          assert.equal(await m.db.supplier.count({ where: { name: { startsWith: 'ZQST ' } } }), 0, 'no supplier was created with a guessed rate')
          precondition(t, 'refused rows', 3)
        } finally { await cleanup() }
      })

      it('a system import refuses a blank currency and a blank tax class (the importer\'s silent defaults are not taken)', async (t) => {
        await fresh()
        try {
          const result = await load([
            { name: 'ZQST No Currency', currency: '', purchaseTaxType: 'INPUT2' },
            { name: 'ZQST No Class', currency: 'GBP', purchaseTaxType: '' },
            { name: 'ZQST Good', currency: 'GBP', purchaseTaxType: 'INPUT2' },
          ])
          assert.equal(result.errors.length, 2)
          assert.deepEqual((await m.db.supplier.findMany({ where: { name: { startsWith: 'ZQST ' } }, select: { name: true } })).map((x) => x.name), ['ZQST Good'])
          precondition(t, 'refused rows', 2)
        } finally { await cleanup() }
      })

      it('the tax-rates rail refuses a suppliers file whose type matches no rate, several rates, or is blank, and passes one that matches exactly one', async (t) => {
        await fresh()
        try {
          const prepared = (types: string[]) => ({ steps: [{ step: 'suppliers', data: { header: ['name', 'currency', 'purchaseTaxType'], rows: types.map((type, i) => ({ chunk: 1, line: i + 2, cells: [`S${i}`, 'GBP', type] })) } }] }) as unknown as PreparedRun
          const problems = async (types: string[]) => { const p: string[] = []; await m.rails.supplierTaxRates(prepared(types), p); return p }
          assert.deepEqual(await problems(['INPUT2', 'ZERORATEDINPUT', 'NONE', 'INPUT2']), [], 'one rate each (the decoys do not count)')
          assert.deepEqual(await problems(['EXEMPTINPUT']), ['supplier tax: 1 supplier purchase tax type(s) match no active IMS tax rate usable for purchases'])
          assert.deepEqual(await problems(['']), ['supplier tax: 1 supplier purchase tax type(s) are blank'])
          await addRate('stdTwo', { name: 'ZQST Std Two', usedFor: 'BOTH', accountingTaxType: 'INPUT2' })
          assert.deepEqual(await problems(['INPUT2']), ['supplier tax: 1 supplier purchase tax type(s) match more than one active IMS tax rate usable for purchases'])
          precondition(t, 'rail cases', 4)
        } finally { await cleanup() }
      })
    })

    describe('every table is classified: independent business tables refuse a first run and a resume', () => {
      // Mutation named: go back to counting six tables (and customers/sales orders on a resume) -> the stock-count and transfer arms are green when they must be red.
      const evaluate = (resuming: boolean) => evaluateRails(prepared, resuming ? { phase: 'recheck', resuming: true, step: null } : { phase: 'preflight', resuming: false, step: null })
      const foreignFor = async (resuming: boolean, table: string) => (await evaluate(resuming)).filter((p) => p.includes(`the ${table} table holds`))
      it('CONTROL: a configured, otherwise empty database passes both rails', async () => {
        await resetData()
        assert.deepEqual((await evaluate(false)).filter((p) => /^(empty target|foreign data)/.test(p)), [])
        assert.deepEqual((await evaluate(true)).filter((p) => /^(empty target|foreign data)/.test(p)), [])
      })

      it('a stock count that names only a warehouse, and a stock transfer between two warehouses, each refuse a first run AND a resume', async () => {
        await resetData()
        const main = await m.db.warehouse.findUniqueOrThrow({ where: { code: 'ZQSENT-MAIN' }, select: { id: true } })
        const over = await m.db.warehouse.findUniqueOrThrow({ where: { code: 'ZQSENT-OVER' }, select: { id: true } })
        const stockCount = await m.db.stockCount.create({ data: { reference: 'ZQDB-COUNT-1', warehouseId: main.id } })
        try {
          for (const resuming of [false, true]) assert.equal((await foreignFor(resuming, 'stock_counts')).length, 1, `stock count, resuming=${resuming}`)
        } finally { await m.db.stockCount.delete({ where: { id: stockCount.id } }) }
        const transfer = await m.db.stockTransfer.create({ data: { reference: 'ZQDB-TRANSFER-1', fromWarehouseId: main.id, toWarehouseId: over.id } })
        try {
          for (const resuming of [false, true]) assert.equal((await foreignFor(resuming, 'stock_transfers')).length, 1, `stock transfer, resuming=${resuming}`)
          const result = await runLoad(prepared, ports(), apply(prepared))
          assert.equal(result.exit, 'PRECONDITION_REFUSED')
          assert.equal(await count('suppliers'), 0, 'nothing was written')
        } finally { await m.db.stockTransfer.delete({ where: { id: transfer.id } }) }
        assert.deepEqual((await evaluate(true)).filter((p) => p.startsWith('foreign data')), [], 'gone')
      })

      it('a table the registry has never heard of refuses both, with a count and no name', async () => {
        await resetData()
        await sql('create table zz_unclassified (id int)')
        try {
          for (const resuming of [false, true]) {
            const problems = (await evaluate(resuming)).filter((p) => /not classified/.test(p))
            assert.equal(problems.length, 1)
            assert.match(problems[0]!, /^foreign data: 1 table\(s\) of the database are not classified/)
            assert.ok(!problems[0]!.includes('zz_unclassified'))
          }
        } finally { await sql('drop table zz_unclassified') }
      })

      it('the registry names exactly the tables the migrated database has', async () => {
        const present = (await sql<{ name: string }>(`select table_name as name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'`)).map((r) => r.name).sort()
        const { TABLE_CLASSES } = await import('../../lib/first-load/apply/table-classes')
        assert.deepEqual(present, Object.keys(TABLE_CLASSES).sort())
      })
    })

    describe('tables the runner never writes', () => {
      it('a customer or a sales order that appeared since is refused on a RESUME too (the empty-target rail is for a fresh run only)', async () => {
        // Mutation named: drop the check -> a resume loads beside data of the application: red.
        await resetData()
        const resume = () => evaluateRails(prepared, { phase: 'recheck', resuming: true, step: null })
        assert.deepEqual((await resume()).filter((p) => p.startsWith('foreign data:')), [], 'control')
        const customer = await m.db.customer.create({ data: { firstName: 'A', lastName: 'B' } })
        try {
          assert.ok((await resume()).some((p) => /^foreign data: the customers table holds 1 row\(s\)/.test(p)))
          assert.ok((await evaluateRails(prepared, { phase: 'preflight', resuming: true, step: null })).some((p) => p.startsWith('foreign data:')))
        } finally { await m.db.customer.delete({ where: { id: customer.id } }) }
        assert.deepEqual((await resume()).filter((p) => p.startsWith('foreign data:')), [], 'gone')
      })
    })

    describe('every table the runner writes is attributed to the file on a resume', () => {
      // Mutation named: skip the attribution loop in dataClasses -> a foreign category / price-cache / recipe row between attempts is invisible: red.
      const resume = () => evaluateRails(prepared, { phase: 'recheck', resuming: true, step: null })
      const rows = async (table: string, run: PreparedRun = prepared) => (await evaluateRails(run, { phase: 'recheck', resuming: true, step: null })).filter((p) => p.startsWith('foreign data:') && p.includes(`the ${table} table holds`))
      // The synthetic files carry no categories: the same run with its first two products naming a root and a two-level category.
      const withCategories = (): PreparedRun => ({
        ...prepared,
        steps: prepared.steps.map((st) => {
          if (st.step !== 'products') return st
          const at = st.data.header.indexOf('category')
          return { ...st, data: { ...st.data, rows: st.data.rows.map((r, i) => (i > 1 ? r : { ...r, cells: r.cells.map((c, j) => (j === at ? (i === 0 ? 'Kits' : 'Tools > Hand tools') : c)) })) } }
        }),
      })

      it('every RUNNER_WRITES table has an attribution rule, and no rule is for another table', async () => {
        const { ATTRIBUTION_RULES } = await import('../../lib/first-load/apply/db/attribution')
        const { tablesOfKind } = await import('../../lib/first-load/apply/table-classes')
        assert.deepEqual(Object.keys(ATTRIBUTION_RULES).sort(), tablesOfKind('RUNNER_WRITES'))
      })

      it('CONTROL: an empty target passes every rule', async () => {
        await resetData()
        assert.deepEqual((await resume()).filter((p) => p.startsWith('foreign data:')), [])
      })

      it('a category nothing in the file names, and a price-cache row no file line explains, are refused on a resume (counts only)', async () => {
        await resetData()
        try {
          await m.db.productCategory.create({ data: { name: 'Stray', nameNormalized: 'zq-stray-category' } })
          assert.deepEqual(await rows('product_categories'), ['foreign data: the product_categories table holds 1 row(s) the prepared file does not account for'])
          const supplier = await m.db.supplier.create({ data: { name: 'Stray Supplier Ltd' } })
          const product = await m.db.product.create({ data: { sku: 'ZQ-STRAY-SKU', name: 'stray' } })
          await m.db.supplierProduct.create({ data: { supplierId: supplier.id, productId: product.id, lastUnitCost: '1', currency: 'GBP' } })
          assert.equal((await rows('supplier_products')).length, 1)
          assert.equal((await rows('products')).length, 1)
          assert.equal((await rows('suppliers')).length, 1)
          assert.ok(!(await resume()).join(';').includes('ZQ-STRAY'), 'no key in any message')
        } finally { await resetData() }
        assert.deepEqual((await resume()).filter((p) => p.startsWith('foreign data:')), [], 'gone')
      })

      it('a category the importer would merge into (right path, wrong parent or display name) and a price-cache pair that existed before any order used it are refused on a resume', async () => {
        await resetData()
        try {
          const kits = await m.db.productCategory.create({ data: { name: 'Somebody Elses Name', nameNormalized: 'kits' } })
          assert.equal((await rows('product_categories', withCategories())).length, 1, 'wrong display name')
          await m.db.productCategory.update({ where: { id: kits.id }, data: { name: 'Kits' } })
          assert.equal((await rows('product_categories', withCategories())).length, 0, 'control: the right name')
          const elsewhere = await m.db.productCategory.create({ data: { name: 'Elsewhere', nameNormalized: 'zq-elsewhere' } })
          const tools = await m.db.productCategory.create({ data: { name: 'Tools', nameNormalized: 'tools' } })
          const hand = await m.db.productCategory.create({ data: { name: 'Hand tools', nameNormalized: 'tools>hand tools', parentId: tools.id } })
          assert.equal((await rows('product_categories', withCategories())).length, 1, 'only the elsewhere row is foreign')
          await m.db.productCategory.delete({ where: { id: elsewhere.id } })
          assert.equal((await rows('product_categories', withCategories())).length, 0, 'control: right parent')
          await m.db.productCategory.update({ where: { id: hand.id }, data: { parentId: kits.id } })
          assert.equal((await rows('product_categories', withCategories())).length, 1, 'wrong parent')
        } finally { await resetData() }
      })

      it('a price-cache row for a pair of the file is foreign until a stored order of the file used it', async () => {
        await resetData()
        try {
          const orders = prepared.steps.find((st) => st.step === 'purchase-orders')!.data
          const get = (r: (typeof orders.rows)[number], n: string) => r.cells[orders.header.indexOf(n)] ?? ''
          const first = orders.rows[0]!
          const supplier = await m.db.supplier.create({ data: { name: get(first, 'supplierName').trim() } })
          const product = await m.db.product.create({ data: { sku: get(first, 'sku').trim(), name: 'x' } })
          await m.db.supplierProduct.create({ data: { supplierId: supplier.id, productId: product.id, lastUnitCost: '1', currency: 'GBP' } })
          assert.equal((await rows('supplier_products')).length, 1)
        } finally { await resetData() }
      })

      it('a lone stock level, even at zero quantity and zero reserved, is unclean history of its pair, not "absent"', async () => {
        // Mutation named: treat a zero level with no layer or movement as absent again -> the importer would increment a row somebody else inserted between attempts: red.
        await resetData()
        try {
          const product = await m.db.product.create({ data: { sku: `${TAG}-SIMPLE`, name: 'x' } })
          const main = await m.db.warehouse.findUniqueOrThrow({ where: { code: 'ZQSENT-MAIN' }, select: { id: true } })
          assert.deepEqual((await m.observe.observeStep(prepared, 'opening-stock')).foreignHistoryKeys, [], 'control: no row at all is absent')
          await m.db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: '0', reservedQty: '0' } })
          const observed = await m.observe.observeStep(prepared, 'opening-stock')
          assert.deepEqual(observed.foreignHistoryKeys, [`${TAG}-SIMPLE|ZQSENT-MAIN`.toUpperCase()])
          assert.equal(observed.entries.find((e) => e.key === `${TAG}-SIMPLE|ZQSENT-MAIN`.toUpperCase())?.fingerprint, 'UNCLEAN_STOCK_PAIR')
        } finally { await resetData() }
      })

      it('a recipe, a bill of materials and its items the file does not describe are refused on a resume', async () => {
        await resetData()
        try {
          const parent = await m.db.product.create({ data: { sku: 'ZQ-STRAY-PARENT', name: 'p', type: 'BOM' } })
          const part = await m.db.product.create({ data: { sku: 'ZQ-STRAY-PART', name: 'c' } })
          await m.db.productComponent.create({ data: { productId: parent.id, componentId: part.id, qty: '1' } })
          const bom = await m.db.bom.create({ data: { name: 'stray', productId: parent.id } })
          await m.db.bomItem.create({ data: { bomId: bom.id, parentProductId: parent.id, componentProductId: part.id, qty: '1' } })
          for (const table of ['product_components', 'boms', 'bom_items']) assert.equal((await rows(table)).length, 1, table)
        } finally { await resetData() }
      })

      it('stock the file does not name (a level, a movement, a layer) is refused on a resume', async () => {
        await resetData()
        try {
          const product = await m.db.product.create({ data: { sku: 'ZQ-STRAY-STOCK', name: 's' } })
          const main = await m.db.warehouse.findUniqueOrThrow({ where: { code: 'ZQSENT-MAIN' }, select: { id: true } })
          await m.db.stockLevel.create({ data: { productId: product.id, warehouseId: main.id, quantity: '1' } })
          await m.db.costLayer.create({ data: { productId: product.id, warehouseId: main.id, receivedQty: '1', remainingQty: '1', unitCostBase: '1' } })
          const over = await m.db.warehouse.findUniqueOrThrow({ where: { code: 'ZQSENT-OVER' }, select: { id: true } })
          await m.db.stockMovement.create({ data: { type: 'TRANSFER_OUT', productId: product.id, fromWarehouseId: main.id, toWarehouseId: over.id, qty: '1' } })
          for (const table of ['stock_levels', 'cost_layers', 'stock_movements']) assert.equal((await rows(table)).length, 1, table)
        } finally { await resetData() }
      })
    })

    describe('the other rails', () => {
      const rails = (step: ApplyStepId | null = null) => evaluateRails(prepared, { phase: 'recheck', resuming: true, step })

      it('CONTROL: every rail passes on the configured target', async () => {
        await resetData()
        assert.deepEqual(await rails(), [])
      })

      it('a different base currency is refused', async () => {
        const org = await m.db.organisation.findFirstOrThrow({ select: { id: true, baseCurrency: true } })
        await m.db.organisation.update({ where: { id: org.id }, data: { baseCurrency: 'USD' } })
        try { assert.match((await rails()).join(';'), /base currency: the organisation's base currency is not the manifest's/) } finally { await m.db.organisation.update({ where: { id: org.id }, data: { baseCurrency: org.baseCurrency } }) }
      })

      it('a missing, inactive, duplicated or differently profiled warehouse is refused, by position in the manifest and not by code', async () => {
        const code = 'ZQSENT-OVER'
        const original = await m.db.warehouse.findUniqueOrThrow({ where: { code } })
        const arms: Array<[string, () => Promise<void>, () => Promise<void>, RegExp]> = [
          ['inactive', () => m.db.warehouse.update({ where: { code }, data: { active: false } }).then(() => undefined), () => m.db.warehouse.update({ where: { code }, data: { active: true } }).then(() => undefined), /warehouse 2 of 2 in expectWarehouses: it is not active/],
          ['type', () => m.db.warehouse.update({ where: { code }, data: { type: 'QUARANTINE' } }).then(() => undefined), () => m.db.warehouse.update({ where: { code }, data: { type: original.type } }).then(() => undefined), /its type is not the declared one/],
          ['availableForSale', () => m.db.warehouse.update({ where: { code }, data: { availableForSale: true } }).then(() => undefined), () => m.db.warehouse.update({ where: { code }, data: { availableForSale: false } }).then(() => undefined), /availableForSale/],
          ['syncToStore', () => m.db.warehouse.update({ where: { code }, data: { syncToStore: true } }).then(() => undefined), () => m.db.warehouse.update({ where: { code }, data: { syncToStore: false } }).then(() => undefined), /syncToStore/],
          ['duplicate under upper-casing', () => m.db.warehouse.create({ data: { code: 'zqsent-over', name: 'dup', type: 'RESTOCK', availableForSale: false } }).then(() => undefined), () => m.db.warehouse.delete({ where: { code: 'zqsent-over' } }).then(() => undefined), /share that code under upper-casing/],
          ['missing', () => m.db.warehouse.update({ where: { code }, data: { code: 'RENAMED' } }).then(() => undefined), () => m.db.warehouse.update({ where: { code: 'RENAMED' }, data: { code } }).then(() => undefined), /it does not exist in the database/],
        ]
        for (const [name, mutate, restore, expected] of arms) {
          await mutate()
          try {
            const problems = (await rails('opening-stock')).join(';')
            assert.match(problems, expected, name)
            assert.ok(!problems.includes(code), `${name}: the problem does not carry the code`)
          } finally { await restore() }
          assert.deepEqual(await rails('opening-stock'), [], `${name}: restored`)
        }
      })

      it('a QUARANTINE warehouse is checked against its declared profile like any other (owner ruling: not available for sale, not synced)', async () => {
        const quarantine = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore', expectWarehouses: { ...WAREHOUSES, 'ZQSENT-OVER': { type: 'QUARANTINE', availableForSale: false, syncToStore: false } } })
        const check = () => evaluateRails(quarantine, { phase: 'recheck', resuming: true, step: 'opening-stock' })
        assert.match((await check()).join(';'), /warehouse 2 of 2 in expectWarehouses: its type is not the declared one/, 'the database says RESTOCK')
        await m.db.warehouse.update({ where: { code: 'ZQSENT-OVER' }, data: { type: 'QUARANTINE' } })
        try {
          assert.deepEqual(await check(), [], 'control: QUARANTINE, not for sale, not synced')
          await m.db.warehouse.update({ where: { code: 'ZQSENT-OVER' }, data: { availableForSale: true } })
          assert.match((await check()).join(';'), /availableForSale/, 'a quarantine warehouse that is available for sale is refused')
        } finally {
          await m.db.warehouse.update({ where: { code: 'ZQSENT-OVER' }, data: { type: 'RESTOCK', availableForSale: false } })
        }
      })

      it('a SKU the manifest forbids is refused if the database already holds it, in any case', async () => {
        // Mutation named: drop the forbiddenSkus call -> the ruled-out product is silently built on and this arm is red.
        const forbidding = loadOk(preparedFiles(prepareSynthetic()), { restorePointDir: '/restore', forbidSkus: ['ZQSENT-GHOST'] })
        const check = () => evaluateRails(forbidding, { phase: 'recheck', resuming: true, step: null })
        assert.deepEqual(await check(), [], 'control: no such product')
        await m.db.product.create({ data: { sku: 'zqsent-ghost', name: 'ruled out' } })
        try { assert.match((await check()).join(';'), /forbidden SKUs: 1 product\(s\) the manifest forbids already exist/) } finally { await m.db.product.delete({ where: { sku: 'zqsent-ghost' } }) }
      })

      it('purchase orders: a line that names VAT and states 20 while the active rate of that name is 10% is refused before anything is written', async () => {
        // Mutation named: drop the value comparison from the tax rail -> the run proceeds and stores 10% under a file that says 20: red.
        await resetData()
        const taxRate = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME } })
        const rows = stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: PO_ONE, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '10', unitCostForeign: '10', taxRateName: VAT_NAME, taxRateValue: '20', orderTaxRateName: VAT_NAME, orderTaxRateValue: '20' }])
        const stepOf = { step: 'purchase-orders', target: 'purchase-orders', files: [], data: rows, units: keyStep('purchase-orders', rows).units }
        const stub = { ...prepared, steps: [stepOf] } as unknown as PreparedRun
        const rail = () => evaluateRails(stub, { phase: 'recheck', resuming: true, step: 'purchase-orders' })
        assert.deepEqual(await rail(), [], 'control: the stated 20 is the rate\'s value')
        await m.db.taxRate.update({ where: { id: taxRate.id }, data: { rate: '0.1' } })
        try {
          const problems = (await rail()).join(';')
          assert.match(problems, /1 line\(s\) state a tax value that is not the value of the active rate they name/)
          assert.match(problems, /1 order\(s\) state a tax value that is not the value of the active rate they name/)
          assert.ok(!/20|VAT/.test(problems.replace(/\d+ (line|order)\(s\)/g, '')), 'the sentence carries no value')
          // The preflight refuses the whole run, and nothing is written.
          const before = { runs: await count('first_load_apply_runs'), logs: await count('activity_logs'), orders: await count('purchase_orders') }
          const result = await runLoad(stub, m.ports.createDbPorts(stub, { preload: CLEAN_PRELOAD, operator: 'Apply Test' }), apply(stub))
          assert.equal(result.exit, 'PRECONDITION_REFUSED')
          assert.match(result.problems.join(';'), /state a tax value that is not the value of the active rate they name/)
          assert.deepEqual({ runs: await count('first_load_apply_runs'), logs: await count('activity_logs'), orders: await count('purchase_orders') }, before)
        } finally { await m.db.taxRate.update({ where: { id: taxRate.id }, data: { rate: '0.2' } }) }
        assert.deepEqual(await rail(), [], 'restored')
      })

      it('every cell of the tax-resolution table (name present/absent x named rate eligible/ineligible/inactive/absent x value stated/absent/wrong/matching ANOTHER rate): the rail decides exactly "the importer would resolve to the named rate"', async () => {
        // Mutation named: let a rate matching by VALUE satisfy a line that states a NAME (the old rail, and the importer's own fallback) -> the "another rate matches" arms are green when they must be red.
        await resetData()
        const named = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME } })
        const five = await m.db.taxRate.create({ data: { name: `${VAT_NAME} five`, rate: '0.05', usedFor: 'PURCHASE', active: true } })
        const orderFile = (line: Record<string, string>) => {
          const rows = stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: PO_ONE, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '10', unitCostForeign: '10', ...line }])
          return { ...prepared, steps: [{ step: 'purchase-orders', target: 'purchase-orders', files: [], data: rows, units: keyStep('purchase-orders', rows).units }] } as unknown as PreparedRun
        }
        const problemsFor = (line: Record<string, string>) => evaluateRails(orderFile(line), { phase: 'recheck', resuming: true, step: 'purchase-orders' })
        const setNamed = async (data: { usedFor?: string; active?: boolean }) => { await m.db.taxRate.update({ where: { id: named.id }, data }) }
        const rows: Array<{ label: string; line: Record<string, string>; state?: { usedFor?: string; active?: boolean }; refused: boolean }> = [
          // name present, named rate eligible
          { label: 'name, eligible, no value', line: { taxRateName: VAT_NAME, orderTaxRateName: VAT_NAME }, refused: false },
          { label: 'name, eligible, matching value', line: { taxRateName: VAT_NAME, taxRateValue: '20', orderTaxRateName: VAT_NAME, orderTaxRateValue: '20' }, refused: false },
          { label: 'name, eligible, wrong value', line: { taxRateName: VAT_NAME, taxRateValue: '5', orderTaxRateName: VAT_NAME }, refused: true },
          { label: 'name, eligible (BOTH), matching value', line: { taxRateName: VAT_NAME, taxRateValue: '20', orderTaxRateName: VAT_NAME }, state: { usedFor: 'BOTH' }, refused: false },
          // name present, named rate ineligible: SALES only / inactive
          { label: 'name, SALES-only, no value', line: { taxRateName: VAT_NAME, orderTaxRateName: VAT_NAME }, state: { usedFor: 'SALES' }, refused: true },
          { label: 'name, SALES-only, value of ANOTHER purchase rate', line: { taxRateName: VAT_NAME, taxRateValue: '5', orderTaxRateName: VAT_NAME }, state: { usedFor: 'SALES' }, refused: true },
          { label: 'name, SALES-only, value 20 (the seeded 20% purchase rate matches)', line: { taxRateName: VAT_NAME, taxRateValue: '20', orderTaxRateName: VAT_NAME }, state: { usedFor: 'SALES' }, refused: true },
          { label: 'name, inactive, value of another rate', line: { taxRateName: VAT_NAME, taxRateValue: '5', orderTaxRateName: VAT_NAME }, state: { active: false }, refused: true },
          // name present, no such rate at all
          { label: 'name, absent, no value', line: { taxRateName: 'ZQDB NO SUCH', orderTaxRateName: 'ZQDB NO SUCH' }, refused: true },
          { label: 'name, absent, value of another rate', line: { taxRateName: 'ZQDB NO SUCH', taxRateValue: '5', orderTaxRateName: 'ZQDB NO SUCH' }, refused: true },
          // The order-level tax is VALID in these, so only the line-level decision can refuse them (otherwise the order-level refusal would mask a weak line rule).
          { label: 'name, absent, value of another rate; the order tax is valid', line: { taxRateName: 'ZQDB NO SUCH', taxRateValue: '5', orderTaxRateName: VAT_NAME, orderTaxRateValue: '20' }, refused: true },
          { label: 'name, SALES-only, value of another rate; the order tax is valid', line: { taxRateName: VAT_NAME, taxRateValue: '5', orderTaxRateName: `${VAT_NAME} five`, orderTaxRateValue: '5' }, state: { usedFor: 'SALES' }, refused: true },
          { label: 'name, inactive, value of another rate; the order tax is valid', line: { taxRateName: VAT_NAME, taxRateValue: '5', orderTaxRateName: `${VAT_NAME} five`, orderTaxRateValue: '5' }, state: { active: false }, refused: true },
          // no name: value only
          { label: 'no name, value of a purchase rate', line: { taxRateValue: '5' }, refused: false },
          { label: 'no name, value of NO rate', line: { taxRateValue: '7' }, refused: true },
          { label: 'no name, no value', line: {}, refused: false },
          // order-level name only
          { label: 'order name only, eligible', line: { orderTaxRateName: VAT_NAME }, refused: false },
          { label: 'order name only, SALES-only', line: { orderTaxRateName: VAT_NAME }, state: { usedFor: 'SALES' }, refused: true },
          { label: 'order name only, wrong spelling', line: { orderTaxRateName: VAT_NAME.toLowerCase() }, refused: true },
        ]
        let cells = 0
        try {
          for (const row of rows) {
            if (row.state) await setNamed(row.state)
            try {
              const problems = await problemsFor(row.line)
              if (row.refused) assert.ok(problems.some((p) => p.startsWith('purchase tax:')), `${row.label}: the rail refuses (got ${JSON.stringify(problems)})`)
              else assert.deepEqual(problems, [], `${row.label}: the rail passes`)
              assert.ok(!problems.join(';').includes(VAT_NAME), `${row.label}: the sentence carries no tax name`)
            } finally {
              if (row.state) await setNamed({ usedFor: 'PURCHASE', active: true })
            }
            cells++
          }
          // The refused cells write nothing, whole-run: the preflight stops the run.
          const refusedLine = { taxRateName: VAT_NAME, taxRateValue: '5', orderTaxRateName: VAT_NAME }
          await setNamed({ usedFor: 'SALES' })
          try {
            const stub = orderFile(refusedLine)
            const before = { runs: await count('first_load_apply_runs'), logs: await count('activity_logs'), orders: await count('purchase_orders') }
            const result = await runLoad(stub, m.ports.createDbPorts(stub, { preload: CLEAN_PRELOAD, operator: 'Apply Test' }), apply(stub))
            assert.equal(result.exit, 'PRECONDITION_REFUSED')
            assert.deepEqual({ runs: await count('first_load_apply_runs'), logs: await count('activity_logs'), orders: await count('purchase_orders') }, before)
          } finally { await setNamed({ usedFor: 'PURCHASE', active: true }) }
        } finally {
          await m.db.taxRate.delete({ where: { id: five.id } }).catch(() => undefined)
        }
        assert.equal(cells, rows.length)
      })

      it('same-named rates and the declared ceiling: the name must resolve to one purchase value, and no rate the importer could apply may exceed the prepared report\'s maximum', async () => {
        // Mutations named: ambiguity check off; ceiling check off; "all same-named rates are purchase rates" off -> the matching arms below are green when they must be red.
        await resetData()
        const named = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME } })
        const five = await m.db.taxRate.create({ data: { name: `${VAT_NAME} five`, rate: '0.05', usedFor: 'PURCHASE', active: true } })
        const created: string[] = [five.id]
        const add = async (data: { name: string; rate: string; usedFor: string; active?: boolean }) => { const r = await m.db.taxRate.create({ data: { ...data, active: data.active ?? true } }); created.push(r.id); return r }
        const ceiling = prepared.report.config.maxPurchaseTaxRate
        assert.equal(ceiling, '0.25', 'precondition: the synthetic prepared report declares 0.25')
        const stubFor = (line: Record<string, string>) => {
          const rows = stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: PO_ONE, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '10', unitCostForeign: '10', ...line }])
          return { ...prepared, steps: [{ step: 'purchase-orders', target: 'purchase-orders', files: [], data: rows, units: keyStep('purchase-orders', rows).units }] } as unknown as PreparedRun
        }
        const problemsFor = async (line: Record<string, string>) => (await evaluateRails(stubFor(line), { phase: 'recheck', resuming: true, step: 'purchase-orders' })).filter((p) => p.startsWith('purchase tax:'))
        const setNamed = async (rate: string) => { await m.db.taxRate.update({ where: { id: named.id }, data: { rate } }) }
        const LINE_NAMED = { taxRateName: VAT_NAME, orderTaxRateName: `${VAT_NAME} five`, orderTaxRateValue: '5' } // the order tax is valid, so only the LINE decides
        const ORDER_ONLY = { orderTaxRateName: VAT_NAME } // an unnamed line: the order tax (and what lines inherit) decides
        let cells = 0
        const expect = async (label: string, line: Record<string, string>, refused: RegExp | null) => {
          const problems = await problemsFor(line)
          if (refused) assert.ok(problems.some((p) => refused.test(p)), `${label}: refused as ${refused} (got ${JSON.stringify(problems)})`)
          else assert.deepEqual(problems, [], `${label}: accepted`)
          assert.ok(!problems.join(';').includes(VAT_NAME), `${label}: no tax name in the sentence`)
          cells++
        }
        try {
          // ---- same-name duplicates ----
          await expect('control: one eligible rate', ORDER_ONLY, null)
          const salesDuplicate = await add({ name: VAT_NAME, rate: '0.2', usedFor: 'SALES' })
          await expect('order name shared with a SALES-only rate, no stated value', ORDER_ONLY, /order\(s\) have an order-level tax name shared by active rates/)
          await expect('line name: a SALES-only duplicate is NOT a candidate (the importer\'s line lookup filters it)', LINE_NAMED, null)
          await m.db.taxRate.update({ where: { id: salesDuplicate.id }, data: { usedFor: 'PURCHASE' } })
          await expect('identical eligible duplicates (same value): order', ORDER_ONLY, null)
          await expect('identical eligible duplicates (same value): line', LINE_NAMED, null)
          await m.db.taxRate.update({ where: { id: salesDuplicate.id }, data: { rate: '0.1' } })
          await expect('two eligible same-name rates, different values: order', ORDER_ONLY, /order\(s\) have an order-level tax name shared by active rates/)
          await expect('two eligible same-name rates, different values: line', LINE_NAMED, /line\(s\) resolve to more than one active purchase rate with different values/)
          await m.db.taxRate.update({ where: { id: salesDuplicate.id }, data: { active: false } })
          await expect('the differing duplicate is inactive: accepted', ORDER_ONLY, null)
          // ---- the declared ceiling (0.25) ----
          await setNamed('0.3')
          await expect('named line above the ceiling', LINE_NAMED, /line\(s\) could be taxed above the maximum/)
          await expect('inherited order rate above the ceiling (unnamed line)', ORDER_ONLY, /order\(s\) could be taxed above the maximum/)
          const thirty = await add({ name: `${VAT_NAME} thirty`, rate: '0.3', usedFor: 'PURCHASE' })
          void thirty
          await expect('value-fallback match above the ceiling (a line with no name)', { taxRateValue: '30' }, /line\(s\) could be taxed above the maximum/)
          await setNamed('0.25')
          await expect('named line AT the ceiling', LINE_NAMED, null)
          await expect('inherited order rate AT the ceiling', ORDER_ONLY, null)
          await setNamed('0.2')
          await expect('below the ceiling', LINE_NAMED, null)
          await expect('value-only line below the ceiling', { taxRateValue: '5' }, null)
          // ---- nothing is written on a refusal ----
          await setNamed('0.3')
          const stub = stubFor(LINE_NAMED)
          const before = { runs: await count('first_load_apply_runs'), logs: await count('activity_logs'), orders: await count('purchase_orders') }
          const result = await runLoad(stub, m.ports.createDbPorts(stub, { preload: CLEAN_PRELOAD, operator: 'Apply Test' }), apply(stub))
          assert.equal(result.exit, 'PRECONDITION_REFUSED')
          assert.deepEqual({ runs: await count('first_load_apply_runs'), logs: await count('activity_logs'), orders: await count('purchase_orders') }, before)
        } finally {
          await setNamed('0.2')
          await m.db.taxRate.deleteMany({ where: { id: { in: created } } }).catch(() => undefined)
          await m.db.taxRate.deleteMany({ where: { id: { in: (await m.db.taxRate.findMany({ where: { name: { startsWith: `${VAT_NAME} ` } }, select: { id: true } })).map((r) => r.id) } } }).catch(() => undefined)
        }
        assert.ok(cells >= 14, `cells examined: ${cells}`)
      })

      it('same name, same percentage, different ACCOUNTING settings (tax type, reverse charge, reporting category, a component) are different rates: refused; identical settings are accepted', async () => {
        // Mutation named: compare only name and percentage between same-named rates (the old rule) -> the differing-settings arms are green when they must be red.
        await resetData()
        const named = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME } })
        const five = await m.db.taxRate.create({ data: { name: `${VAT_NAME} five`, rate: '0.05', usedFor: 'PURCHASE', active: true } })
        const dup = await m.db.taxRate.create({ data: { name: VAT_NAME, rate: '0.2', usedFor: 'PURCHASE', active: true, accountingTaxType: named.accountingTaxType, isCompound: named.isCompound, reverseCharge: named.reverseCharge, reportingCategory: named.reportingCategory } })
        const stubFor = (line: Record<string, string>) => {
          const rows = stepRows(PURCHASE_ORDERS_IMPORT_HEADERS, [{ orderKey: PO_ONE, supplierName: SUPPLIER_A, destinationWarehouseCode: 'ZQSENT-MAIN', sku: `${TAG}-SIMPLE`, qty: '10', unitCostForeign: '10', ...line }])
          return { ...prepared, steps: [{ step: 'purchase-orders', target: 'purchase-orders', files: [], data: rows, units: keyStep('purchase-orders', rows).units }] } as unknown as PreparedRun
        }
        const problemsFor = async (line: Record<string, string>) => (await evaluateRails(stubFor(line), { phase: 'recheck', resuming: true, step: 'purchase-orders' })).filter((p) => p.startsWith('purchase tax:'))
        const LINE = { taxRateName: VAT_NAME, orderTaxRateName: `${VAT_NAME} five`, orderTaxRateValue: '5' }
        const ORDER = { orderTaxRateName: VAT_NAME }
        let cells = 0
        try {
          assert.deepEqual(await problemsFor(LINE), [], 'identical settings: line accepted')
          assert.deepEqual(await problemsFor(ORDER), [], 'identical settings: order accepted')
          const arms: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
            ['accounting tax type', () => m.db.taxRate.update({ where: { id: dup.id }, data: { accountingTaxType: 'INPUT2' } }), () => m.db.taxRate.update({ where: { id: dup.id }, data: { accountingTaxType: named.accountingTaxType } })],
            ['reverse charge', () => m.db.taxRate.update({ where: { id: dup.id }, data: { reverseCharge: !named.reverseCharge } }), () => m.db.taxRate.update({ where: { id: dup.id }, data: { reverseCharge: named.reverseCharge } })],
            ['reporting category', () => m.db.taxRate.update({ where: { id: dup.id }, data: { reportingCategory: 'EC_SALES' } }), () => m.db.taxRate.update({ where: { id: dup.id }, data: { reportingCategory: named.reportingCategory } })],
            ['compound flag', () => m.db.taxRate.update({ where: { id: dup.id }, data: { isCompound: !named.isCompound } }), () => m.db.taxRate.update({ where: { id: dup.id }, data: { isCompound: named.isCompound } })],
          ]
          for (const [label, mutate, restore] of arms) {
            await mutate()
            try {
              assert.ok((await problemsFor(LINE)).some((p) => /line\(s\) resolve to more than one active purchase rate with different values or accounting settings/.test(p)), `${label}: line refused`)
              assert.ok((await problemsFor(ORDER)).some((p) => /order\(s\) have an order-level tax name shared by active rates/.test(p)), `${label}: order refused`)
            } finally { await restore() }
            assert.deepEqual(await problemsFor(LINE), [], `${label}: restored`)
            cells++
          }
          // A component on one of them changes what the tax is computed from.
          const component = await m.db.taxRateComponent.create({ data: { taxRateId: dup.id, name: 'part', rate: '0.2', sortOrder: 0 } })
          try {
            assert.ok((await problemsFor(LINE)).some((p) => /more than one active purchase rate/.test(p)), 'a component on one duplicate: refused')
            await m.db.taxRateComponent.update({ where: { id: component.id }, data: { rate: '0.15' } })
            assert.ok((await problemsFor(LINE)).some((p) => /more than one active purchase rate|components do not add up/.test(p)), 'components that do not add up to the rate: refused')
          } finally { await m.db.taxRateComponent.delete({ where: { id: component.id } }) }
          cells++
          // A single rate whose components do not add up to its percentage: the importer matches the column and taxes at the components.
          await m.db.taxRate.update({ where: { id: dup.id }, data: { active: false } })
          const lone = await m.db.taxRateComponent.create({ data: { taxRateId: named.id, name: 'part', rate: '0.15', sortOrder: 0 } })
          try { assert.ok((await problemsFor(LINE)).some((p) => /components do not add up to its rate/.test(p)), 'inconsistent single rate refused') } finally { await m.db.taxRateComponent.delete({ where: { id: lone.id } }) }
          cells++
          // Explicit zero on a line with no name is NOT a stated tax: accepted, with or without an order tax.
          assert.deepEqual(await problemsFor({ taxRateValue: '0' }), [], 'value-only zero, no order tax')
          assert.deepEqual(await problemsFor({ taxRateValue: '0', orderTaxRateName: VAT_NAME }), [], 'value-only zero under a named order tax')
          assert.deepEqual(await problemsFor({ taxRateValue: '0.00' }), [], 'zero written 0.00')
          cells++
        } finally {
          await m.db.taxRate.deleteMany({ where: { id: { in: [five.id, dup.id] } } }).catch(() => undefined)
        }
        assert.ok(cells >= 7)
      })

      it('purchase orders: an FX rate outside the importer\'s 2%, and a currency with no stored rate, are refused', async () => {
        const row = await m.db.fxRate.findFirstOrThrow({ where: { toCurrency: 'EUR' } })
        await m.db.fxRate.update({ where: { id: row.id }, data: { rate: '1.30' } })
        try { assert.match((await rails('purchase-orders')).join(';'), /FX rate 1 of 1 in fxRates: it differs from the stored rate by more than the importer's tolerance/) } finally { await m.db.fxRate.update({ where: { id: row.id }, data: { rate: '1.25' } }) }
        await m.db.fxRate.update({ where: { id: row.id }, data: { toCurrency: 'SEK' } })
        try { assert.match((await rails('purchase-orders')).join(';'), /the database holds no rate for it/) } finally { await m.db.fxRate.update({ where: { id: row.id }, data: { toCurrency: 'EUR' } }) }
        assert.deepEqual(await rails('purchase-orders'), [])
      })

      it('purchase orders: a tax that matches no active purchase rate, and an order-level name spelt differently, are refused', async () => {
        const stub = await loadWithTaxFile()
        const taxRate = await m.db.taxRate.findFirstOrThrow({ where: { name: VAT_NAME } })
        const check = () => evaluateRails(stub, { phase: 'recheck', resuming: true, step: 'purchase-orders' })
        assert.deepEqual(await check(), [], 'control: the odd file\'s taxes resolve (by name in another case, by value as a percentage, and the order-level name exactly)')
        // With the rate no longer a purchase rate, the line that names it resolves nowhere; the line that gives only 20 still finds the seeded 20% rate.
        await m.db.taxRate.update({ where: { id: taxRate.id }, data: { usedFor: 'SALES' } })
        try { assert.match((await check()).join(';'), /purchase tax: 2 line\(s\) name a tax that matches no active purchase rate/) } finally { await m.db.taxRate.update({ where: { id: taxRate.id }, data: { usedFor: 'PURCHASE' } }) }
        await m.db.taxRate.update({ where: { id: taxRate.id }, data: { name: VAT_NAME.toLowerCase() } })
        try {
          const problems = (await check()).join(';')
          assert.match(problems, /order\(s\) have an order-level tax name with no active purchase rate of exactly that spelling/)
          assert.ok(!/matches no active purchase rate/.test(problems), 'the lines still resolve case-insensitively: only the order-level lookup is case-exact')
        } finally { await m.db.taxRate.update({ where: { id: taxRate.id }, data: { name: VAT_NAME } }) }
      })
    })

    describe('the run record', () => {
      const record = (version: number, patch: Partial<RunRecord> = {}): RunRecord => ({ version, manifestDigest: 'a'.repeat(64), runId: 'cas-run', status: 'RUNNING', currentStep: null, steps: {}, ...patch })

      it('CONTROL: a record is created, read back, and advanced one version at a time', async () => {
        await resetData()
        const journal = m.journal.createJournal()
        assert.equal(await journal.load(), null)
        await journal.save(record(1), null)
        await journal.save(record(2, { status: 'STEP_FAILED', currentStep: 'products', steps: { products: { status: 'FAILED', emitted: 3, created: 1, updated: 0, skippedExisting: 0, failed: 2, residualSha256: ['b'.repeat(64)] } } }), 1)
        const stored = await journal.load()
        assert.equal(stored!.version, 2)
        assert.equal(stored!.status, 'STEP_FAILED')
        assert.equal(stored!.currentStep, 'products')
        assert.equal(stored!.steps.products!.failed, 2)
      })

      it('two creators: exactly one wins (the unique singleton), the other is told the record is not theirs', async () => {
        // Mutation named: INSERT without ON CONFLICT DO NOTHING / without the unique index -> two rows or a raw driver error, red here.
        await resetData()
        const journal = m.journal.createJournal()
        const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => journal.save(record(1), null)))
        assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1)
        assert.ok(outcomes.filter((o) => o.status === 'rejected').every((o) => (o as PromiseRejectedResult).reason instanceof StaleJournalError))
        assert.equal(await count('first_load_apply_runs'), 1)
      })

      it('twelve runners that read the same version and each try to advance it: exactly one advances it (true compare-and-swap)', async () => {
        // Mutation named: replace "WHERE ... version = expected" with "WHERE singleton" (a blind overwrite) -> every save succeeds and this arm is red.
        const journal = m.journal.createJournal()
        const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => journal.save(record(2, { runId: 'cas-run', steps: {}, currentStep: i % 2 === 0 ? 'suppliers' : 'products' }), 1)))
        assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1)
        assert.ok(outcomes.filter((o) => o.status === 'rejected').every((o) => (o as PromiseRejectedResult).reason instanceof StaleJournalError))
        assert.equal((await journal.load())!.version, 2)
      })

      it('a stale save, a save for another load and a save that skips a version are all refused', async () => {
        const journal = m.journal.createJournal()
        await assert.rejects(journal.save(record(3), 1), (e: unknown) => e instanceof RangeError)
        await assert.rejects(journal.save(record(2), 1), StaleJournalError) // version 1 is no longer stored
        await assert.rejects(journal.save(record(3, { manifestDigest: 'c'.repeat(64) }), 2), StaleJournalError) // another load's digest
        await assert.rejects(journal.save(record(3, { runId: 'other-run' }), 2), StaleJournalError)
        assert.equal((await journal.load())!.version, 2)
      })

      it('the database refuses a status or step it does not know, and the status list in the migration is the runner\'s own', async () => {
        await assert.rejects(m.journal.createJournal().save(record(3, { status: 'NOT_A_STATUS' as never }), 2), /could not be written/)
        const migration = readFileSync(join(REPO, 'prisma/migrations/20261017090000_first_load_apply_runs/migration.sql'), 'utf8')
        const listed = (re: RegExp) => [...(re.exec(migration)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
        assert.deepEqual(listed(/"status" IN \(([^)]*)\)/), [...RUN_STATUSES].sort())
        assert.deepEqual(listed(/"current_step" IN \(([^)]*)\)/), [...APPLY_STEP_IDS].sort())
      })

      it('a record holding a status this runner does not know is an unreadable state, not an absent one', async () => {
        await sql('alter table first_load_apply_runs drop constraint first_load_apply_runs_status_known')
        try {
          await sql(`update first_load_apply_runs set status = 'SOMETHING_ELSE'`)
          await assert.rejects(m.journal.createJournal().load(), (e: unknown) => e instanceof ObservationError)
        } finally {
          await sql(`update first_load_apply_runs set status = 'RUNNING'`)
          await sql(`alter table first_load_apply_runs add constraint first_load_apply_runs_status_known check (status in ('RUNNING', 'STEP_FAILED', 'CONFLICT', 'APPLIED', 'VERIFIED', 'VERIFY_FAILED'))`)
        }
      })
    })

    describe('the step lock', () => {

      it('CONTROL: a step lock is held in pg_locks while its body runs and gone after, and the lock number is the step\'s position in the load order', async () => {
        assert.deepEqual(await held(), [])
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        let entered!: () => void
        const inside = new Promise<void>((resolve) => { entered = resolve })
        const running = m.lock.withStepLock('products', async () => { entered(); await gate; return 'done' })
        await inside
        assert.deepEqual(await held(), [{ objid: APPLY_STEP_IDS.indexOf('products') + 1, granted: true }])
        release()
        assert.equal(await running, 'done')
        assert.deepEqual(await held(), [])
        assert.deepEqual(APPLY_STEP_IDS.map((s) => m.lock.stepLockNumber(s)), [1, 2, 3, 4])
      })

      it('a second runner for the SAME step is refused while the first holds it; a different step is not blocked; the lock is free again afterwards', async () => {
        // Mutation named: blocking pg_advisory_lock instead of the try form -> the second call hangs; a lock key independent of the step -> the other step is refused.
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        let entered!: () => void
        const inside = new Promise<void>((resolve) => { entered = resolve })
        const first = m.lock.withStepLock('opening-stock', async () => { entered(); await gate })
        await inside
        await assert.rejects(m.lock.withStepLock('opening-stock', async () => 'never'), (e: unknown) => e instanceof StepLockError && e.reason === 'busy')
        assert.equal(await m.lock.withStepLock('suppliers', async () => 'other step'), 'other step')
        assert.deepEqual((await held()).map((r) => r.objid), [3], 'only the first holder remains')
        release()
        await first
        assert.equal(await m.lock.withStepLock('opening-stock', async () => 'again'), 'again')
      })

      it('the lock is released when the body throws', async () => {
        await assert.rejects(m.lock.withStepLock('suppliers', async () => { throw new Error('boom') }), /boom/)
        assert.deepEqual(await held(), [])
      })

      it('two runners in ONE process on the SAME step: the first one\'s dead connection is not vouched for by the second one\'s live lock', async () => {
        // Mutation named: check the lock by namespace and step only (not by this handle\'s own backend) and ignore the handle\'s own lost flag -> A passes on B\'s lock and keeps writing.
        let aHandle!: { assertLive(): Promise<void> }
        let releaseA!: () => void
        const aGate = new Promise<void>((resolve) => { releaseA = resolve })
        let aEntered!: () => void
        const aInside = new Promise<void>((resolve) => { aEntered = resolve })
        const a = m.lock.withStepLock('products', async (lock) => { aHandle = lock; aEntered(); await aGate; return 'a' })
        await aInside
        await aHandle.assertLive() // control: A's lock is live
        // Kill A's connection; wait until the server has released the lock.
        await sql(`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid = $1 and objsubid = 2`, [LOCK_NAMESPACE])
        for (let i = 0; i < 100 && (await held()).length > 0; i++) await new Promise((r) => setTimeout(r, 50))
        // B takes the same step's lock and holds it.
        let releaseB!: () => void
        const bGate = new Promise<void>((resolve) => { releaseB = resolve })
        let bEntered!: () => void
        const bInside = new Promise<void>((resolve) => { bEntered = resolve })
        const b = m.lock.withStepLock('products', async (lock) => { await lock.assertLive(); bEntered(); await bGate; return 'b' })
        await bInside
        assert.deepEqual((await held()).map((r) => r.objid), [2], 'precondition: B holds the products lock')
        await assert.rejects(aHandle.assertLive(), (e: unknown) => e instanceof StepLockError && e.reason === 'lost')
        releaseA()
        await assert.rejects(a, (e: unknown) => e instanceof StepLockError && e.reason === 'lost')
        releaseB()
        assert.equal(await b, 'b')
        assert.deepEqual(await held(), [])
      })

      it('a lock whose connection dies mid-step is reported as LOST, never as a finished step', async () => {
        // Mutation named: drop the assertHeld after the body -> the step reports success although another runner may have started.
        let kill!: () => Promise<void>
        const killed = new Promise<void>((resolve) => {
          kill = async () => {
            await sql(`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid = $1 and objsubid = 2`, [LOCK_NAMESPACE])
            // The server drops the session; wait until the lock is really gone before the body returns.
            for (let i = 0; i < 100 && (await held()).length > 0; i++) await new Promise((r) => setTimeout(r, 50))
            resolve()
          }
        })
        await assert.rejects(m.lock.withStepLock('purchase-orders', async () => { await kill(); await killed; return 'finished' }), (e: unknown) => e instanceof StepLockError && e.reason === 'lost')
        assert.deepEqual(await held(), [])
      })
    })

    describe('losing the step lock stops the writes', () => {
      it('the lock connection is killed after the first importer call: the first runner makes no further call, a resumed runner takes over, and nothing overlaps', async () => {
        // Mutation named: drop the beforeCall guard (the old code verified the lock only before and after the whole step) -> the first runner writes all four layers itself.
        await resetData()
        const stockUnits = prepared.steps.find((s) => s.step === 'opening-stock')!.units.length
        let resumed: Awaited<ReturnType<typeof runLoad>> | null = null
        let layersWhenSecondFinished = -1
        let firstCalls = 0
        const killing = m.ports.createDbPorts(prepared, { preload: CLEAN_PRELOAD,
          operator: 'Apply Test',
          maxRowsPerCall: 1,
          afterCall: async (step, call) => {
            if (step !== 'opening-stock') return
            firstCalls = call
            if (call !== 1) return
            await sql(`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid = $1 and objsubid = 2`, [LOCK_NAMESPACE])
            for (let i = 0; i < 100 && (await held()).length > 0; i++) await new Promise((r) => setTimeout(r, 50))
            // While the first runner is still inside this step, a second runner resumes the same load and finishes it.
            resumed = await runLoad(prepared, ports(), apply(prepared, { resume: true }))
            layersWhenSecondFinished = await count('cost_layers')
          },
        })
        const result = await runLoad(prepared, killing, apply(prepared))
        assert.equal(result.exit, 'STEP_FAILED')
        // The first runner stops either on the lost lock itself or, because the second runner has moved the record meanwhile, on the stale record; both are a stop.
        assert.match(result.problems.join(' '), /step lock was not available \(lost\)|run record changed under this runner/)
        assert.equal(firstCalls, 1, 'the first runner made exactly one importer call, then stopped')
        assert.equal(resumed!.exit, 'APPLIED_UNVERIFIED', resumed!.problems.join('; '))
        assert.equal(layersWhenSecondFinished, stockUnits, 'the second runner completed the step')
        assert.equal(await count('cost_layers'), stockUnits, 'the first runner wrote nothing after losing the lock')
        assert.equal(Number((await sql<{ n: string }>(`select count(*)::text as n from (select 1 from cost_layers group by "productId","warehouseId" having count(*) > 1) d`))[0]!.n), 0, 'no pair was written twice')
      })
    })

    describe('a real run, observed', () => {
      it('during each importer call exactly that step\'s lock is held, the steps run in load order, and nothing is held between or after them', async (t) => {
        await resetData()
        const order: Array<{ step: ApplyStepId; held: number[] }> = []
        const real = ports()
        const spying: ApplyPorts = {
          ...real,
          execute: async (step, file, lock) => {
            const rows = await sql<{ objid: number }>('select objid from pg_locks where locktype = $1 and classid = $2 and objsubid = 2 and granted order by objid', ['advisory', LOCK_NAMESPACE])
            order.push({ step, held: rows.map((r) => r.objid) })
            return real.execute(step, file, lock)
          },
        }
        const result = await runLoad(prepared, spying, apply(prepared))
        assert.equal(result.exit, 'APPLIED_UNVERIFIED', result.problems.join('; '))
        precondition(t, 'importer calls observed', order.length)
        assert.deepEqual(order.map((o) => o.step), prepared.steps.map((s) => s.step))
        for (const o of order) assert.deepEqual(o.held, [APPLY_STEP_IDS.indexOf(o.step) + 1], o.step)
        assert.deepEqual(await sql(`select 1 from pg_locks where locktype = 'advisory' and classid = $1 and objsubid = 2`, [LOCK_NAMESPACE]), [])
      })

      it('a runner that finds its step locked stops with STEP_FAILED and does not touch the run record', async () => {
        await resetData()
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        let entered!: () => void
        const inside = new Promise<void>((resolve) => { entered = resolve })
        const holder = m.lock.withStepLock('suppliers', async () => { entered(); await gate })
        await inside
        try {
          const result = await runLoad(prepared, ports(), apply(prepared))
          assert.equal(result.exit, 'STEP_FAILED')
          assert.match(result.problems.join(' '), /step lock was not available \(busy\)/)
          const stored = await m.journal.createJournal().load()
          assert.equal(stored!.version, 1, 'the record is as the run created it: a runner without the lock moves nothing')
          assert.equal(await count('suppliers'), 0)
        } finally { release(); await holder }
      })

      it('a crash between two importer calls leaves a database the next run reads correctly: only the residual is sent, and the totals are exact', async (t) => {
        // Mutation named: build the residual from every unit instead of the absent ones -> the opening-stock importer refuses the present pairs (it is not repeatable) and this arm is red.
        await resetData()
        let calls = 0
        const real = ports(prepared, {})
        const crashing: ApplyPorts = {
          ...real,
          // One row per importer call, and a crash after the second call of the opening-stock step.
          execute: async (step, file) => {
            const small = m.execute.createExecutor({ runId: prepared.manifest.runId, operator: 'Apply Test', maxRowsPerCall: 1 })
            if (step === 'opening-stock') {
              const calls_ = planImportCalls(step, file.bytes, 1)
              let sent = 0
              for (const call of calls_) {
                if (++calls > 2) throw new Error('simulated crash between importer calls')
                await small(step, { ...file, bytes: call.bytes, rows: call.rows }, NO_LOCK)
                sent++
              }
              return { created: sent, updated: 0, skipped: 0, errors: [] }
            }
            return small(step, file, NO_LOCK)
          },
        }
        const first = await runLoad(prepared, crashing, apply(prepared))
        assert.equal(first.exit, 'STEP_FAILED')
        const loadedBefore = await count('cost_layers')
        assert.equal(loadedBefore, 2, 'two opening layers were written before the crash')
        assert.equal((await m.journal.createJournal().load())!.status, 'STEP_FAILED')

        const sent: Array<{ step: ApplyStepId; rows: number }> = []
        const spyReal = ports()
        const resumed = await runLoad(prepared, { ...spyReal, execute: async (step, file, lock) => { sent.push({ step, rows: file.rows }); return spyReal.execute(step, file, lock) } }, apply(prepared, { resume: true }))
        assert.equal(resumed.exit, 'APPLIED_UNVERIFIED', resumed.problems.join('; '))
        const stock = prepared.steps.find((s) => s.step === 'opening-stock')!
        assert.deepEqual(sent.filter((s) => s.step === 'opening-stock'), [{ step: 'opening-stock', rows: stock.units.length - loadedBefore }], 'only the pairs not yet written were sent')
        assert.deepEqual(sent.filter((s) => s.step === 'suppliers' || s.step === 'products'), [], 'earlier steps found their units present and sent nothing')
        const result = resumed.steps.find((s) => s.step === 'opening-stock')!
        assert.equal(result.skippedExisting, loadedBefore)
        assert.equal(result.created, stock.units.length - loadedBefore)
        precondition(t, 'opening layers in the end', await count('cost_layers'))
        // Exact totals: what is in the layers is what the prepared report says it should be.
        const totals = (await sql<{ qty: string; value: string }>(`select coalesce(sum("receivedQty"),0)::text as qty, coalesce(sum("receivedQty" * "unitCostBase"),0)::text as value from cost_layers where "isOpeningStock"`))[0]!
        assert.equal(Number(totals.qty), Number(prepared.report.stock.totals.openingQty))
        assert.equal(Number(totals.value), Number(prepared.report.stock.totals.openingValueBase))
      })

      it('a product whose recipe is lost after the load is a conflict on the next run, not a success (the importer\'s counters would say created)', async () => {
        const bom = await m.db.product.findFirstOrThrow({ where: { type: 'BOM' }, select: { id: true, sku: true } })
        await m.db.productComponent.deleteMany({ where: { productId: bom.id } })
        const result = await runLoad(prepared, ports(), plan())
        assert.equal(result.exit, 'PRECONDITION_REFUSED')
        assert.deepEqual(result.steps.flatMap((s) => s.conflicts).map((c) => c.code), ['RECIPE_DIFFERS'])
      })
    })

    describe('chunking', () => {
      it('independent rows are cut at the limit, an order is never split, a products file is one call, and the row offsets add up', (t) => {
        const suppliers = new TextEncoder().encode('name\r\n' + Array.from({ length: 5 }, (_, i) => `S${i}`).join('\r\n') + '\r\n')
        const cuts = planImportCalls('suppliers', suppliers, 2)
        assert.deepEqual(cuts.map((c) => [c.rows, c.rowNumbers]), [[2, [1, 2]], [2, [3, 4]], [1, [5]]])
        const products = new TextEncoder().encode('sku,name\r\n' + Array.from({ length: 5 }, (_, i) => `P${i},n`).join('\r\n') + '\r\n')
        assert.equal(planImportCalls('products', products, 2).length, 1, 'products are never cut')
        const orders = new TextEncoder().encode('orderKey,sku\r\nA,1\r\nA,2\r\nA,3\r\nB,1\r\nC,1\r\nC,2\r\n')
        // Lines of one order are grouped into a call: A1, B1, A2 is sent as A1, A2, B1, and each call row keeps its number in the residual file.
        const interleaved = planImportCalls('purchase-orders', new TextEncoder().encode('orderKey,sku\r\nA,1\r\nB,1\r\nA,2\r\n'), 10)
        assert.deepEqual(interleaved.map((c) => c.rowNumbers), [[1, 3, 2]])
        const orderCalls = planImportCalls('purchase-orders', orders, 3)
        assert.deepEqual(orderCalls.map((c) => c.rows), [3, 3], 'A (3 lines) fills a call; B and C share the next')
        for (const call of orderCalls) {
          const keys = new TextDecoder().decode(call.bytes).split('\r\n').slice(1).filter(Boolean).map((l) => l.split(',')[0])
          for (const key of new Set(keys)) assert.equal(keys.filter((k) => k === key).length, key === 'A' ? 3 : key === 'C' ? 2 : 1)
        }
        assert.deepEqual(planImportCalls('suppliers', new TextEncoder().encode('name\r\n'), 2), [])
        precondition(t, 'cuts checked', cuts.length + orderCalls.length)
      })

      it('the real importer is called once per planned call, each with its own file, and the row numbers in its messages point at the residual file', async () => {
        await resetData()
        const execute = m.execute.createExecutor({ runId: 'chunking', operator: 'Chunk Test', maxRowsPerCall: 1 })
        const keyed = keyStep('suppliers', ODD_FILES.suppliers)
        const file = buildResidual('suppliers', ODD_FILES.suppliers, classifyStep('suppliers', keyed.units, { entries: [] }))[0]!
        const before = await count('activity_logs')
        // The second supplier is a duplicate name of the first in another case: its call reports a row-level message for ITS file's row 2.
        const result = await execute('suppliers', file, NO_LOCK)
        const logged = (await count('activity_logs')) - before
        assert.equal(logged, 2, 'one activity row per importer call: two calls')
        assert.equal(result.created, 2)
        assert.equal(await count('suppliers'), 2)
        // A row-level message from the second call is shifted by the first call's rows.
        await m.db.supplier.create({ data: { name: SUPPLIER_B.toUpperCase() } })
        await m.db.supplier.create({ data: { name: SUPPLIER_B.toLowerCase() } })
        const again = await execute('suppliers', file, NO_LOCK)
        assert.ok(again.errors.some((e) => /Row 3\b/.test(e)), `the second call's row 2 is reported as row 3 of the residual file: ${again.errors.join(' | ')}`)
      })
    })

    describe('an unreadable database is a refusal, never an empty one', () => {
      it('CONTROL: the same calls succeed while the database is up', async () => {
        await resetData()
        assert.deepEqual((await m.observe.observeStep(prepared, 'suppliers')).entries, [])
        assert.equal((await runLoad(prepared, ports(), plan())).exit, 'OK')
      })

      it('when a table cannot be read, observe throws ObservationError, a plan and an apply are refused with a bounded sentence, and no driver text survives', async () => {
        // Mutation named: swallow the read error and return an empty observation -> the plan reports every unit "to load" and exits OK: red.
        await sql('alter table suppliers rename to suppliers_hidden')
        try {
          await assert.rejects(m.observe.observeStep(prepared, 'suppliers'), (e: unknown) => e instanceof ObservationError && e.message === m.observe.DATABASE_READ_FAILED)
          const result = await runLoad(prepared, ports(), plan())
          assert.equal(result.exit, 'PRECONDITION_REFUSED')
          assert.match(result.problems.join(' '), /could not be read/)
          assert.ok(!/suppliers|relation|does not exist|127\.0\.0\.1|password/i.test(result.problems.join(' ')), `no driver text: ${result.problems.join(' ')}`)
          const applied = await runLoad(prepared, ports(), apply(prepared))
          assert.equal(applied.exit, 'PRECONDITION_REFUSED')
          assert.equal(await count('first_load_apply_runs'), 0, 'nothing was written')
        } finally {
          await sql('alter table suppliers_hidden rename to suppliers')
        }
      })

      it('an unreadable run record is a refusal too', async () => {
        await sql('alter table first_load_apply_runs rename to first_load_apply_runs_hidden')
        try {
          await assert.rejects(m.journal.createJournal().load(), (e: unknown) => e instanceof ObservationError && e.message === m.observe.DATABASE_READ_FAILED)
          assert.equal((await runLoad(prepared, ports(), plan())).exit, 'PRECONDITION_REFUSED')
        } finally {
          await sql('alter table first_load_apply_runs_hidden rename to first_load_apply_runs')
        }
      })
    })
  })
})

/** The odd purchase-order file as a stub prepared run, so the tax rail can read its tax cells. */
async function loadWithTaxFile(): Promise<PreparedRun> {
  return { manifest: prepared.manifest, report: prepared.report, steps: [{ step: 'purchase-orders', target: 'purchase-orders', files: [], data: ODD_FILES['purchase-orders'], units: keyStep('purchase-orders', ODD_FILES['purchase-orders']).units }] } as unknown as PreparedRun
}
