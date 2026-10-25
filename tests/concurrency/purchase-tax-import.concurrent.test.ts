import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after } from 'node:test'
import { config } from 'dotenv'

/**
 * THE IMPORT OF IMS TAX RATES FROM THE STORED XERO LIST, COMMITTED, AGAINST A REAL DATABASE (the in-memory arms of the planner are in tests/connectors/purchase-tax-import.test.ts).
 * Each arm has a CONTROL: the same call writes when nothing is wrong. Rows are created under a per-run tag and removed afterwards; the Xero list, the token and the stamp are replaced and removed.
 *
 *   - the explicit action creates the purchase rows, a second run is a no-op, and two runs at once create each rate exactly once (the connection fence's lock);
 *   - a dry run (`apply: false`) writes nothing;
 *   - narrowing and deactivation happen only when asked, a referenced row keeps its rate and type, and nothing is deleted;
 *   - a connection that changes between the plan and the write discards the write (XERO_CONNECTION_CHANGED);
 *   - the first load's all-or-nothing (`requireAll`) writes nothing when one needed type is refused.
 */
const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
config({ path: '.env.local', quiet: true })
config({ quiet: true })

const CHECKED_KEY = 'xero_tax_rate_drift_last_checked_at'
const run = randomUUID().slice(0, 8)
const TENANT = `tenant-pti-${run}`
const TAG = `ZQPTI${run} `

async function loadDeps() {
  const [{ db }, imp, listLib] = await Promise.all([
    import('../../lib/db/index.ts'),
    import('../../lib/tax/purchase-tax-import.ts'),
    import('../../lib/connectors/xero/tax-rate-list.ts'),
  ])
  return { db, imp, listLib }
}
type Deps = Awaited<ReturnType<typeof loadDeps>>

const xero = (taxType: string, name: string, percent: string, over: { expenses?: boolean; revenue?: boolean; status?: 'ACTIVE' | 'ARCHIVED' } = {}) => ({
  taxType, name: `${TAG}${name}`, status: over.status ?? ('ACTIVE' as const), reportTaxType: null, effectiveRate: percent, displayTaxRate: percent,
  components: Number(percent) === 0 ? [] : [{ name: 'VAT', rate: percent, compound: false, nonRecoverable: false }],
  canApply: { assets: false, equity: false, expenses: over.expenses ?? true, liabilities: false, revenue: over.revenue ?? false },
})
const LIST = () => [
  xero('INPUT2', 'Std', '20.000000'), xero('ZERORATEDINPUT', 'Zero', '0.000000'), xero('NONE', 'None', '0.000000'),
  xero('OUTPUT2', 'Sales std', '20.000000', { expenses: false, revenue: true }),
]

async function seed(deps: Deps, rows: ReturnType<typeof LIST>, tenant = TENANT) {
  const { db } = deps
  await wipeXero(deps)
  const fetchedAt = new Date(Date.now() - 300_000)
  await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000), tenantId: tenant, tenantName: `Org ${tenant}`, connectionGeneration: `gen-${run}` } })
  await db.xeroTaxRate.createMany({ data: rows.map((r) => ({ connector: 'xero', tenantId: tenant, taxType: r.taxType, name: r.name, status: r.status, reportTaxType: r.reportTaxType, effectiveRate: r.effectiveRate, displayTaxRate: r.displayTaxRate, components: r.components, canApplyToAssets: r.canApply.assets, canApplyToEquity: false, canApplyToExpenses: r.canApply.expenses, canApplyToLiabilities: false, canApplyToRevenue: r.canApply.revenue, fetchedAt })) })
  await db.xeroTaxRateList.create({ data: { connector: 'xero', tenantId: tenant, fetchedAt, rowCount: rows.length, digest: deps.listLib.digestTaxRateList(tenant, rows as never) } })
  await db.setting.upsert({ where: { key: CHECKED_KEY }, create: { key: CHECKED_KEY, value: fetchedAt.toISOString() }, update: { value: fetchedAt.toISOString() } })
}
async function wipeXero(deps: Deps) {
  await deps.db.setting.deleteMany({ where: { key: CHECKED_KEY } })
  await deps.db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await deps.db.xeroTaxRateList.deleteMany({})
  await deps.db.xeroTaxRate.deleteMany({})
}
async function cleanRates(deps: Deps) {
  const ids = (await deps.db.taxRate.findMany({ where: { OR: [{ name: { startsWith: TAG } }, { accountingTaxType: { startsWith: 'ZQPTI' } }] }, select: { id: true } })).map((r) => r.id)
  await deps.db.supplier.updateMany({ where: { taxRateId: { in: ids } }, data: { taxRateId: null } })
  await deps.db.taxRateComponent.deleteMany({ where: { taxRateId: { in: ids } } })
  await deps.db.taxRate.deleteMany({ where: { id: { in: ids } } })
}
const mine = (deps: Deps) => deps.db.taxRate.findMany({ where: { name: { startsWith: TAG } }, orderBy: { name: 'asc' }, include: { components: true } })
/** Real tables may hold unrelated rows (a seeded installation): the arms only ever look at, and count, the rows of this run, and ask the import only about types no other row carries. */
const PURCHASE_TYPES = ['INPUT2', 'ZERORATEDINPUT', 'NONE'] as const

after(async () => {
  if (!RUN) return
  const deps = await loadDeps()
  await wipeXero(deps)
  await cleanRates(deps)
})

async function clearForeignPurchaseRates(deps: Deps): Promise<Array<{ id: string; active: boolean }>> {
  // The scratch database may carry rates of its own for the three purchase types; they are made inactive for the arm and restored after, so the arm sees "no rate yet".
  const foreign = await deps.db.taxRate.findMany({ where: { accountingTaxType: { in: [...PURCHASE_TYPES] }, active: true, NOT: { name: { startsWith: TAG } } }, select: { id: true, active: true } })
  await deps.db.taxRate.updateMany({ where: { id: { in: foreign.map((r) => r.id) } }, data: { active: false } })
  return foreign
}
async function restoreForeign(deps: Deps, foreign: Array<{ id: string; active: boolean }>) {
  await deps.db.taxRate.updateMany({ where: { id: { in: foreign.map((r) => r.id) } }, data: { active: true } })
}

// [mutation: the fence's lock removed from runPurchaseTaxImport (call writePurchaseTaxImport on db directly) -> the concurrent arm creates twice]
test('the action creates the purchase rows, a second run is a no-op, and two runs at once create each rate exactly once', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const foreign = await clearForeignPurchaseRates(deps)
  try {
    await cleanRates(deps)
    await seed(deps, LIST())
    const first = await deps.imp.runPurchaseTaxImport({ apply: true })
    assert.deepEqual(first.plan.refusals, [])
    assert.equal(first.wrote, true)
    assert.deepEqual((await mine(deps)).map((r) => [r.accountingTaxType, r.usedFor, r.active, r.rate.toFixed(4), r.type, r.components.length]), [
      ['NONE', 'PURCHASE', true, '0.0000', 'NONE', 0], ['INPUT2', 'PURCHASE', true, '0.2000', 'VAT', 1], ['ZERORATEDINPUT', 'PURCHASE', true, '0.0000', 'VAT', 0],
    ])
    const again = await deps.imp.runPurchaseTaxImport({ apply: true })
    assert.deepEqual([again.wrote, again.plan.creates.length, again.plan.refusals.length], [false, 0, 0], 'a re-run changes nothing')
    assert.equal((await mine(deps)).length, 3)

    // Two at once, from nothing.
    await cleanRates(deps)
    const [a, b] = await Promise.all([deps.imp.runPurchaseTaxImport({ apply: true }), deps.imp.runPurchaseTaxImport({ apply: true })])
    assert.equal((await mine(deps)).length, 3, 'each rate was created exactly once')
    assert.equal([a, b].filter((r) => r.wrote).length, 1, 'only one of the two wrote')
  } finally { await restoreForeign(deps, foreign) }
})

test('a dry run writes nothing; the first load\'s all-or-nothing writes nothing when one needed type is refused', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const foreign = await clearForeignPurchaseRates(deps)
  try {
    await cleanRates(deps)
    await seed(deps, LIST())
    const dry = await deps.imp.runPurchaseTaxImport({ apply: false, narrowSalesTypes: true, deactivateAbsent: true })
    assert.equal(dry.plan.creates.length, 3)
    assert.deepEqual([dry.applied, dry.wrote, (await mine(deps)).length], [false, false, 0])
    await seed(deps, LIST().filter((r) => r.taxType !== 'ZERORATEDINPUT'))
    const refused = await deps.imp.runPurchaseTaxImport({ apply: true, requireAll: true })
    assert.deepEqual(refused.plan.refusals.map((r) => `${r.code}:${r.taxType}`), ['TYPE_NOT_IN_XERO:ZERORATEDINPUT'])
    assert.deepEqual([refused.wrote, (await mine(deps)).length], [false, 0], 'INPUT2 and NONE were importable but nothing is written')
    const partial = await deps.imp.runPurchaseTaxImport({ apply: true })
    assert.deepEqual([partial.wrote, (await mine(deps)).map((r) => r.accountingTaxType)], [true, ['NONE', 'INPUT2']], 'control: the operator action writes what is allowed')
  } finally { await restoreForeign(deps, foreign) }
})

// [mutation: the usedFor update widened to `data: { usedFor: 'SALES', rate: 0 }` -> the referenced row's rate changes: red]
test('narrowing and deactivation happen only when asked; a referenced row keeps its rate and type; nothing is deleted', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const foreign = await clearForeignPurchaseRates(deps)
  const { db } = deps
  try {
    await cleanRates(deps)
    await seed(deps, LIST())
    const salesType = await db.taxRate.create({ data: { name: `${TAG}UK VAT`, rate: '0.2', usedFor: 'BOTH', accountingTaxType: 'OUTPUT2', active: true } })
    // The scratch database may already carry an active BOTH OUTPUT2 rate of its own; it is narrowed too, so remember and restore it.
    const others = await db.taxRate.findMany({ where: { accountingTaxType: 'OUTPUT2', usedFor: 'BOTH', active: true, NOT: { id: salesType.id } }, select: { id: true } })
    const demo = await db.taxRate.create({ data: { name: `${TAG}Demo Austria`, rate: '0.2', usedFor: 'BOTH', accountingTaxType: 'ZQPTI001', active: true } })
    const supplier = await db.supplier.create({ data: { name: `${TAG}Supplier`, taxRateId: salesType.id } })
    const snapshot = async () => JSON.stringify((await db.taxRate.findMany({ where: { id: { in: [salesType.id, demo.id] } }, orderBy: { id: 'asc' } })).map((r) => [r.id, r.rate.toFixed(4), r.accountingTaxType, r.name]))
    const before = await snapshot()
    const defaults = await deps.imp.runPurchaseTaxImport({ apply: true })
    assert.deepEqual(defaults.plan.narrow, [], 'default: nothing narrowed')
    assert.equal(defaults.plan.notInXero.find((r) => r.id === demo.id)!.deactivate, false)
    assert.deepEqual((await db.taxRate.findMany({ where: { id: { in: [salesType.id, demo.id] } }, select: { usedFor: true, active: true }, orderBy: { id: 'asc' } })).map((r) => [r.usedFor, r.active]), [['BOTH', true], ['BOTH', true]])
    const asked = await deps.imp.runPurchaseTaxImport({ apply: true, narrowSalesTypes: true, deactivateAbsent: true })
    assert.ok(asked.plan.narrow.some((n) => n.id === salesType.id && n.references.suppliers === 1))
    const after = await db.taxRate.findMany({ where: { id: { in: [salesType.id, demo.id] } }, select: { id: true, usedFor: true, active: true } })
    assert.deepEqual([after.find((r) => r.id === salesType.id)!.usedFor, after.find((r) => r.id === demo.id)!.active], ['SALES', false])
    assert.equal(await snapshot(), before, 'rate, type and name unchanged on both referenced/unreferenced rows')
    assert.equal((await db.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).taxRateId, salesType.id, 'the supplier still points at the (narrowed) row: nothing deleted')
    const rerun = await deps.imp.runPurchaseTaxImport({ apply: true, narrowSalesTypes: true, deactivateAbsent: true })
    assert.equal(rerun.wrote, false)
    await db.taxRate.updateMany({ where: { id: { in: others.map((r) => r.id) } }, data: { usedFor: 'BOTH' } })
  } finally { await restoreForeign(deps, foreign) }
})

test('a connection that changes between the plan and the write discards the write', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const foreign = await clearForeignPurchaseRates(deps)
  try {
    await cleanRates(deps)
    await seed(deps, LIST())
    // The connection is rebound after the run's first plan has read the stored list and before its locked write: the hook is a spy on the plan's own header read.
    const target = deps.db.xeroTaxRateList as unknown as { findMany: (args: never) => Promise<unknown> }
    const original = target.findMany.bind(target)
    let calls = 0
    target.findMany = async (args: never) => {
      const result = await original(args)
      if (++calls === 1) await deps.db.accountingToken.updateMany({ where: { connector: 'xero' }, data: { connectionGeneration: `rebound-${run}` } })
      return result
    }
    try {
      const result = await deps.imp.runPurchaseTaxImport({ apply: true })
      assert.ok(result.plan.refusals.some((r) => r.code === 'XERO_CONNECTION_CHANGED'), JSON.stringify(result.plan.refusals))
      assert.deepEqual([result.wrote, (await mine(deps)).length], [false, 0])
    } finally { target.findMany = original }
    const control = await deps.imp.runPurchaseTaxImport({ apply: true })
    assert.deepEqual([control.wrote, (await mine(deps)).length], [true, 3], 'control: with no rebind the same call writes')
  } finally { await restoreForeign(deps, foreign) }
})

// [mutation: the replaced row's rate edited in place instead of a new row -> red]
test('sales mirroring and replacement are committed: a differing referenced rate keeps its rate and type, a new row carries Xero\'s percentage, the old one is only deactivated', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const { db } = deps
  try {
    await cleanRates(deps)
    await seed(deps, [...LIST(), xero('ZQPTIOUT5', 'Reduced', '5.000000', { expenses: false, revenue: true })])
    const old = await db.taxRate.create({ data: { name: `${TAG}Old reduced`, rate: '0.04', usedFor: 'BOTH', accountingTaxType: 'ZQPTIOUT5', active: true } })
    const supplier = await db.supplier.create({ data: { name: `${TAG}Supplier2`, taxRateId: old.id } })
    const reported = await deps.imp.runPurchaseTaxImport({ apply: true, types: [], mirrorSales: true })
    assert.deepEqual(reported.plan.differs.filter((d) => d.id === old.id).map((d) => [d.imsRate, d.xeroRate, d.replaced, d.references.suppliers]), [['0.0400', '0.0500', false, 1]])
    assert.equal((await db.taxRate.findUniqueOrThrow({ where: { id: old.id } })).active, true, 'default: reported only')
    const replaced = await deps.imp.runPurchaseTaxImport({ apply: true, types: [], mirrorSales: true, replaceDiffering: true })
    assert.equal(replaced.wrote, true)
    const oldNow = await db.taxRate.findUniqueOrThrow({ where: { id: old.id } })
    assert.deepEqual([oldNow.rate.toFixed(4), oldNow.accountingTaxType, oldNow.active], ['0.0400', 'ZQPTIOUT5', false])
    const fresh = await db.taxRate.findMany({ where: { accountingTaxType: 'ZQPTIOUT5', active: true } })
    assert.deepEqual(fresh.map((r) => [r.rate.toFixed(4), r.usedFor]), [['0.0500', 'SALES']])
    assert.equal((await db.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).taxRateId, old.id, 'documents keep pointing at the unchanged row')
    const rate = replaced.plan.rateSet.find((e) => e.taxType === 'ZQPTIOUT5')!
    assert.deepEqual([rate.percentage, rate.side, rate.status], ['5.000000', 'SALES', 'created'])
    assert.equal((await deps.imp.runPurchaseTaxImport({ apply: true, types: [], mirrorSales: true, replaceDiffering: true })).wrote, false)
  } finally { await cleanRates(deps) }
})
