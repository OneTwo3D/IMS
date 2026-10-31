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

// [mutation: the live-document guard removed from the deactivation -> the order's rate is deactivated: red; the write-time re-count removed -> the stranded arm is red]
test('deactivateAbsent leaves a rate that a live sales order names (its tax identity resolves through the active rate of that name), and a cancelled order does not hold it', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const foreign = await clearForeignPurchaseRates(deps)
  const { db } = deps
  try {
    await cleanRates(deps)
    await seed(deps, LIST())
    const held = await db.taxRate.create({ data: { name: `${TAG}Demo held`, rate: '0.2', usedFor: 'BOTH', accountingTaxType: 'ZQPTI002', active: true } })
    const freed = await db.taxRate.create({ data: { name: `${TAG}Demo freed`, rate: '0.2', usedFor: 'BOTH', accountingTaxType: 'ZQPTI003', active: true } })
    const live = await db.salesOrder.create({ data: { externalOrderNumber: `${TAG}live`, status: 'PROCESSING', taxRateName: held.name, subtotalForeign: 0, totalForeign: 0, subtotalBase: 0, totalBase: 0 } })
    const cancelled = await db.salesOrder.create({ data: { externalOrderNumber: `${TAG}cancelled`, status: 'CANCELLED', taxRateName: freed.name, subtotalForeign: 0, totalForeign: 0, subtotalBase: 0, totalBase: 0 } })
    try {
      const dry = await deps.imp.runPurchaseTaxImport({ apply: false, deactivateAbsent: true })
      assert.deepEqual(dry.plan.notInXero.filter((r) => [held.id, freed.id].includes(r.id)).map((r) => [r.name, r.deactivate, r.keptBecause]).sort(), [[freed.name, true, null], [held.name, false, 'LIVE_DOCUMENTS']])
      await deps.imp.runPurchaseTaxImport({ apply: true, deactivateAbsent: true })
      assert.deepEqual((await db.taxRate.findMany({ where: { id: { in: [held.id, freed.id] } }, orderBy: { name: 'asc' } })).map((r) => [r.name, r.active]), [[freed.name, false], [held.name, true]])
    } finally { await db.salesOrder.deleteMany({ where: { id: { in: [live.id, cancelled.id] } } }) }
  } finally { await restoreForeign(deps, foreign) }
})

// [mutation: the FOR UPDATE row lock removed from lockAndRecheck -> the import does not wait for the writer holding the rate and deactivates it: red; the re-count after the lock removed -> it deactivates a rate the writer's order just committed: red]
test('a deactivation waits for a writer that holds the rate, then sees that writer\'s committed order and writes nothing', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const foreign = await clearForeignPurchaseRates(deps)
  const { db } = deps
  try {
    await cleanRates(deps)
    await seed(deps, LIST())
    const held = await db.taxRate.create({ data: { name: `${TAG}Demo raced`, rate: '0.2', usedFor: 'BOTH', accountingTaxType: 'ZQPTI004', active: true } })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let locked!: () => void
    const lockedFirst = new Promise<void>((resolve) => { locked = resolve })
    // A writer in the shape of writable-tax-rate.ts: share-lock the rate, then commit an order that names it.
    const writer = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tax_rates WHERE id = ${held.id} FOR SHARE`
      await tx.salesOrder.create({ data: { externalOrderNumber: `${TAG}raced`, status: 'PROCESSING', taxRateName: held.name, subtotalForeign: 0, totalForeign: 0, subtotalBase: 0, totalBase: 0 } })
      locked()
      await gate
    })
    try {
      await lockedFirst
      let settled = false
      const importing = deps.imp.runPurchaseTaxImport({ apply: true, deactivateAbsent: true }).then((r) => ({ r }), (e: unknown) => ({ e })).finally(() => { settled = true })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      assert.equal(settled, false, 'the import is waiting for the writer\'s row lock')
      release()
      await writer
      const outcome = await importing
      assert.ok('e' in outcome && outcome.e instanceof deps.imp.PurchaseTaxImportRaceError, 'the committed order stops the deactivation')
      assert.equal((await db.taxRate.findUniqueOrThrow({ where: { id: held.id } })).active, true)
    } finally { release(); await writer.catch(() => undefined); await db.salesOrder.deleteMany({ where: { externalOrderNumber: { startsWith: TAG } } }) }
  } finally { await restoreForeign(deps, foreign) }
})

// [mutation: lockOrderNamedTaxRate's lock removed (the query returns without FOR KEY SHARE) -> the import does not wait for the order writer and deactivates the rate its order names: red;
//  the lock taken on another mode (FOR NO KEY UPDATE) -> the writer is not made to wait for the deactivation: the second half is red]
test('the order writers\' own lock (lockOrderNamedTaxRate) makes deactivateAbsent wait for an order that locked the named rate first, and a writer that arrives after the deactivation finds the rate inactive', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const { lockOrderNamedTaxRate } = await import('../../lib/tax/writable-tax-rate.ts')
  const foreign = await clearForeignPurchaseRates(deps)
  const { db } = deps
  try {
    await cleanRates(deps)
    await seed(deps, LIST())
    // (1) The writer locks first and commits an order naming the rate: the deactivation waits, re-counts, finds the order, and writes nothing.
    const held = await db.taxRate.create({ data: { name: `${TAG}Demo writer first`, rate: '0.2', usedFor: 'BOTH', accountingTaxType: 'ZQPTI006', active: true } })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let locked!: () => void
    const lockedFirst = new Promise<void>((resolve) => { locked = resolve })
    const writer = db.$transaction(async (tx) => {
      assert.equal(await lockOrderNamedTaxRate(tx, held.name), 1, 'the active named rate is locked')
      await tx.salesOrder.create({ data: { externalOrderNumber: `${TAG}writer-first`, status: 'PROCESSING', taxRateName: held.name, subtotalForeign: 0, totalForeign: 0, subtotalBase: 0, totalBase: 0 } })
      locked()
      await gate
    })
    try {
      await lockedFirst
      let settled = false
      const importing = deps.imp.runPurchaseTaxImport({ apply: true, deactivateAbsent: true }).then((r) => ({ r }), (e: unknown) => ({ e })).finally(() => { settled = true })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      assert.equal(settled, false, 'the deactivation is waiting for the writer\'s lock')
      release()
      await writer
      const outcome = await importing
      assert.ok('e' in outcome && outcome.e instanceof deps.imp.PurchaseTaxImportRaceError, 'the committed order stops the deactivation')
      assert.equal((await db.taxRate.findUniqueOrThrow({ where: { id: held.id } })).active, true)
    } finally { release(); await writer.catch(() => undefined); await db.salesOrder.deleteMany({ where: { externalOrderNumber: { startsWith: TAG } } }) }

    // (2) The deactivation holds the rate first: the writer waits for it, and when it commits finds NO active rate of the name (0), so a writer that resolved the rate earlier can refuse.
    const freed = await db.taxRate.create({ data: { name: `${TAG}Demo import first`, rate: '0.2', usedFor: 'BOTH', accountingTaxType: 'ZQPTI007', active: true } })
    let hold!: () => void
    const holdGate = new Promise<void>((resolve) => { hold = resolve })
    let holding!: () => void
    const holdingFirst = new Promise<void>((resolve) => { holding = resolve })
    const deactivator = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tax_rates WHERE id = ${freed.id} FOR UPDATE`
      await tx.taxRate.update({ where: { id: freed.id }, data: { active: false } })
      holding()
      await holdGate
    })
    try {
      await holdingFirst
      let settled = false
      const writing = db.$transaction(async (tx) => lockOrderNamedTaxRate(tx, freed.name)).finally(() => { settled = true })
      await new Promise((resolve) => setTimeout(resolve, 1000))
      assert.equal(settled, false, 'the writer waits for the deactivation that holds the rate')
      hold()
      await deactivator
      assert.equal(await writing, 0, 'after the deactivation committed there is no active rate of the name to lock')
    } finally { hold(); await deactivator.catch(() => undefined) }
  } finally { await restoreForeign(deps, foreign) }
})

// [mutation: the re-read and identity compare removed from lockAndRecheck -> the renamed rate is deactivated: red]
test('a rate renamed, with an order naming the new name, between the plan and the row lock is not deactivated', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const foreign = await clearForeignPurchaseRates(deps)
  const { db } = deps
  try {
    await cleanRates(deps)
    await seed(deps, LIST())
    const held = await db.taxRate.create({ data: { name: `${TAG}Demo renamed`, rate: '0.2', usedFor: 'BOTH', accountingTaxType: 'ZQPTI005', active: true } })
    const newName = `${TAG}Demo renamed B`
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let locked!: () => void
    const lockedFirst = new Promise<void>((resolve) => { locked = resolve })
    const editor = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tax_rates WHERE id = ${held.id} FOR SHARE`
      await tx.$executeRaw`UPDATE tax_rates SET name = ${newName} WHERE id = ${held.id}`
      await tx.salesOrder.create({ data: { externalOrderNumber: `${TAG}renamed`, status: 'PROCESSING', taxRateName: newName, subtotalForeign: 0, totalForeign: 0, subtotalBase: 0, totalBase: 0 } })
      locked()
      await gate
    })
    try {
      await lockedFirst
      let settled = false
      const importing = deps.imp.runPurchaseTaxImport({ apply: true, deactivateAbsent: true }).then((r) => ({ r }), (e: unknown) => ({ e })).finally(() => { settled = true })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      assert.equal(settled, false, 'the import is waiting for the editor\'s row lock')
      release()
      await editor
      const outcome = await importing
      assert.ok('e' in outcome && outcome.e instanceof deps.imp.PurchaseTaxImportRaceError, 'the changed identity stops the deactivation')
      assert.deepEqual((await db.taxRate.findUniqueOrThrow({ where: { id: held.id } })).active, true)
    } finally { release(); await editor.catch(() => undefined); await db.salesOrder.deleteMany({ where: { externalOrderNumber: { startsWith: TAG } } }) }
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
    assert.equal((await db.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).taxRateId, fresh[0]!.id, 'the supplier default follows the replacement in the same write (no default is left on the deactivated row)')
    const rate = replaced.plan.rateSet.find((e) => e.taxType === 'ZQPTIOUT5')!
    assert.deepEqual([rate.percentage, rate.side, rate.status], ['5.000000', 'SALES', 'created'])
    assert.equal((await deps.imp.runPurchaseTaxImport({ apply: true, types: [], mirrorSales: true, replaceDiffering: true })).wrote, false)
  } finally { await cleanRates(deps) }
})

// [mutation: the shared-BOTH-row conversion removed from planPurchaseTaxImport -> a purchase and a sales replacement from the one old row: the second is refused by name after the first deactivated the old row, leaving no sales-capable row: red]
test('replaceDiffering with mirrorSales, committed: one differing BOTH row serving a requested dual-side type is replaced by ONE BOTH row, and the old row is deactivated with it', { skip: !RUN }, async () => {
  const deps = await loadDeps()
  const { db } = deps
  try {
    await cleanRates(deps)
    await seed(deps, [xero('ZQPTIDUAL', 'Dual', '5.000000', { expenses: true, revenue: true })])
    const old = await db.taxRate.create({ data: { name: `${TAG}Old dual`, rate: '0.04', usedFor: 'BOTH', accountingTaxType: 'ZQPTIDUAL', active: true } })
    const supplier = await db.supplier.create({ data: { name: `${TAG}Supplier dual`, taxRateId: old.id } })
    const done = await deps.imp.runPurchaseTaxImport({ apply: true, types: ['ZQPTIDUAL'], mirrorSales: true, replaceDiffering: true })
    assert.equal(done.wrote, true)
    assert.deepEqual(done.plan.refusals.filter((r) => r.taxType === 'ZQPTIDUAL'), [], 'no name collision between two replacements')
    const oldNow = await db.taxRate.findUniqueOrThrow({ where: { id: old.id } })
    assert.deepEqual([oldNow.rate.toFixed(4), oldNow.accountingTaxType, oldNow.active], ['0.0400', 'ZQPTIDUAL', false])
    const fresh = await db.taxRate.findMany({ where: { accountingTaxType: 'ZQPTIDUAL', active: true } })
    assert.deepEqual(fresh.map((r) => [r.rate.toFixed(4), r.usedFor]), [['0.0500', 'BOTH']], 'one active row, usable for sales and purchases')
    assert.equal((await db.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).taxRateId, fresh[0]!.id)
    assert.equal((await deps.imp.runPurchaseTaxImport({ apply: true, types: ['ZQPTIDUAL'], mirrorSales: true, replaceDiffering: true })).wrote, false, 'a re-run writes nothing')
  } finally { await cleanRates(deps) }
})
