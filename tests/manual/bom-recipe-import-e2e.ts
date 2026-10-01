/**
 * o3d-zjsb5.9 — END-TO-END PROOF THAT A MIGRATED BOM RECIPE IS USABLE, NOT MERELY PRESENT.
 *
 * WHY IT IS NOT A `*.test.ts` FILE. `test:unit`'s glob is `tests/**\/*.test.ts` and that tier must
 * run with NO database. This file drives the real `importProductsCsv` server action and the real
 * production-order lifecycle against a real Postgres, so it is named to fall OUTSIDE the glob and
 * is run explicitly:
 *
 *   BOM_VERIFY_SCRATCH_DB=<db> npx tsx --test --experimental-test-module-mocks \
 *     tests/manual/bom-recipe-import-e2e.ts
 *
 * It is committed rather than kept in a scratch directory so the proof is re-runnable by whoever
 * next doubts it. A mocked client cannot stand in for it: the unique index on `boms.productId`, the
 * foreign keys, and the deferrable `assert_stock_movement_reporting_evidence` constraint trigger
 * only participate against a real server.
 *
 * WHAT IT PROVES:
 *   1. a valid products CSV loads BOTH representations of a BOM recipe, in one import;
 *   2. the drift check is GREEN on that load;
 *   3. breaking one recipe makes the drift check RED naming the product, and restoring it makes it
 *      green again — a check never seen to refuse is not known to work;
 *   4. a row whose component SKU exists nowhere is refused BY ROW NUMBER and writes NO recipe at
 *      all rather than a partial one (and the drift check catches the recipeless BOM it leaves);
 *   5. a cyclic recipe is refused and writes NEITHER representation;
 *   6. a file over MAX_IMPORT_ROWS imports exactly the cap and drops the rest with ONE error line;
 *   7. a production order is created AND COMPLETED against the migrated Bom, moving stock.
 *
 * WHAT IT DOES NOT PROVE: that any recipe matches Qoblex. It is an agreement and usability proof.
 *
 * SAFETY. The connected database must be named in `BOM_VERIFY_SCRATCH_DB`, must carry the o3d-zzgp
 * disposability comment, and must not be `onetwo3d_ims_dev`. All three are checked on a read-only
 * query BEFORE anything writes. `@/lib/shopping` is mocked to no-ops so no WooCommerce push can
 * leave the box even if a connector row somehow exists.
 */
import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'

import { config } from 'dotenv'

config({ path: '.env.local', quiet: true })
config({ quiet: true })

const ALWAYS_REFUSED = 'onetwo3d_ims_dev'
const CAP = 10_000

mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'verify-user', role: 'ADMIN' } }),
    requireAuth: async () => ({ user: { id: 'verify-user', role: 'ADMIN' } }),
    requireInternal: async () => ({ user: { id: 'verify-user', role: 'ADMIN' } }),
  },
})
// Belt, not decoration: importProductsCsv schedules a WooCommerce metadata push and an IMMEDIATE
// stock sync. A scratch database has no connector rows so both are no-ops, but "no vendor calls"
// must not rest on a database being empty.
mock.module('@/lib/shopping', {
  namedExports: {
    enqueueStockSync: async () => {},
    pushProductMetadata: async () => ({ success: true }),
  },
})

type Db = typeof import('../../lib/db/index')['db']
let db: Db
let importProductsCsv: typeof import('../../app/actions/import')['importProductsCsv']
let importOpeningStockCsv: typeof import('../../app/actions/import')['importOpeningStockCsv']
let findBomRecipeDrift: typeof import('../../lib/products/bom-recipe')['findBomRecipeDrift']
let createManufacturingOrder: typeof import('../../app/actions/manufacturing')['createManufacturingOrder']
let updateManufacturingOrderStatus: typeof import('../../app/actions/manufacturing')['updateManufacturingOrderStatus']

let tableId = ''
let claimedBomId = ''
let warehouse = { id: '', code: '' }

function form(csv: string, mode = 'execute'): FormData {
  const data = new FormData()
  data.set('file', new File([csv], 'products.csv', { type: 'text/csv' }))
  data.set('mode', mode)
  return data
}

function errorsOf(result: { errors?: string[] }): string[] {
  return result.errors ?? []
}

before(async () => {
  ;({ db } = await import('../../lib/db/index'))
  const { expectedDisposableDatabaseMarker } = await import('../../lib/disposable-database-marker')

  const [facts] = await db.$queryRaw<Array<{ name: string; marker: string | null }>>`
    SELECT current_database() AS name,
           pg_catalog.shobj_description(oid, 'pg_database') AS marker
    FROM pg_database WHERE datname = current_database()
  `
  const declared = process.env.BOM_VERIFY_SCRATCH_DB
  assert.notEqual(facts.name, ALWAYS_REFUSED, `refusing to run against ${ALWAYS_REFUSED}`)
  assert.equal(
    declared, facts.name,
    `BOM_VERIFY_SCRATCH_DB must name the connected database exactly (connected ${facts.name}, declared ${declared ?? 'unset'})`,
  )
  assert.equal(
    facts.marker, expectedDisposableDatabaseMarker(facts.name),
    `database ${facts.name} is not stamped disposable (comment: ${facts.marker ?? 'none'})`,
  )
  console.log(`# gate: connected to declared, disposability-stamped database ${facts.name}`)

  ;({ importProductsCsv, importOpeningStockCsv } = await import('../../app/actions/import'))
  ;({ findBomRecipeDrift } = await import('../../lib/products/bom-recipe'))
  ;({ createManufacturingOrder, updateManufacturingOrderStatus } = await import('../../app/actions/manufacturing'))
})

test('1. a valid products CSV writes BOTH representations of a BOM recipe', async () => {
  const csv = [
    'sku,name,type,components,stockUnit',
    'RAW-OAK,Oak board,SIMPLE,,each',
    'GLUE,Wood glue,SIMPLE,,each',
    // Deliberately BEFORE its component LEG-01 is defined: order WITHIN one file does not matter,
    // because components are resolved after every row has been read. Order ACROSS files does.
    'TABLE-01,Oak table,BOM,LEG-01:4;RAW-OAK:2,each',
    'LEG-01,Table leg,BOM,RAW-OAK:0.5;GLUE:0.25,each',
  ].join('\n')

  const result = await importProductsCsv(form(csv))
  assert.deepEqual(errorsOf(result), [], 'the valid file must import with no errors')

  const table = await db.product.findUnique({
    where: { sku: 'TABLE-01' },
    select: {
      id: true,
      productComponents: { select: { componentId: true, qty: true } },
      manufacturingBom: {
        select: { id: true, productId: true, items: { select: { componentProductId: true, qty: true } } },
      },
    },
  })
  assert.ok(table, 'TABLE-01 must exist')
  assert.ok(table.manufacturingBom, 'TABLE-01 must have a CLAIMED Bom — this is the gap the change closes')
  assert.equal(table.manufacturingBom.productId, table.id, 'the Bom must be claimed by the product')
  assert.equal(table.productComponents.length, 2)
  assert.equal(table.manufacturingBom.items.length, 2)
  tableId = table.id
  claimedBomId = table.manufacturingBom.id
  console.log(`# TABLE-01: ${table.productComponents.length} ProductComponent + ${table.manufacturingBom.items.length} BomItem rows, Bom ${claimedBomId}`)
})

test('2. the drift check is green after the load', async () => {
  const drift = await findBomRecipeDrift(db)
  assert.deepEqual(drift, [], `expected no drift, got ${JSON.stringify(drift, null, 1)}`)
})

test('3. the drift check goes RED on a deliberate break and green again on restore', async () => {
  const legItem = await db.bomItem.findFirst({
    where: { bomId: claimedBomId, qty: 4 },
    select: { id: true, componentProductId: true },
  })
  assert.ok(legItem, 'precondition: the x4 leg BomItem must exist')

  await db.bomItem.update({ where: { id: legItem.id }, data: { qty: 7 } })
  const red = await findBomRecipeDrift(db)
  assert.equal(red.length, 1, `expected exactly one finding, got ${JSON.stringify(red, null, 1)}`)
  assert.equal(red[0].sku, 'TABLE-01')
  assert.equal(red[0].kind, 'recipe-differs')
  assert.match(red[0].detail, /x4\.0000 in product_components and x7\.0000 in bom_items/)
  console.log(`# RED: ${red[0].detail}`)

  await db.bomItem.update({ where: { id: legItem.id }, data: { qty: 4 } })
  assert.deepEqual(await findBomRecipeDrift(db), [], 'restoring the qty must clear the finding')
})

test('3b. ROUND 2 finding 1: editing an imported BOM through the PRODUCT EDITOR keeps both halves in step', async () => {
  // The path people actually use. Before round 2 this wrote only ProductComponent, so an imported
  // BOM edited here left production consuming the new list and planning reading the old one — and
  // the drift check would have reported it as a defect the product creates daily.
  const { saveProductComponents } = await import('../../app/actions/products')
  const rawOak = await db.product.findUniqueOrThrow({ where: { sku: 'RAW-OAK' }, select: { id: true } })

  // Change a quantity AND drop a component in one edit: 4x LEG + 2x RAW-OAK  ->  9x RAW-OAK only.
  const saved = await saveProductComponents(tableId, [{ componentId: rawOak.id, qty: '9' }])
  assert.equal(saved.success, true, `editor save failed: ${JSON.stringify(saved)}`)

  const after = await db.product.findUniqueOrThrow({
    where: { id: tableId },
    select: {
      productComponents: { select: { componentId: true, qty: true } },
      manufacturingBom: { select: { id: true, active: true, items: { select: { componentProductId: true, qty: true } } } },
    },
  })
  assert.equal(after.productComponents.length, 1, 'the editor wrote the new ProductComponent list')
  assert.ok(after.manufacturingBom, 'the claimed Bom must still exist')
  assert.equal(after.manufacturingBom.id, claimedBomId, 'it must be the SAME Bom, not a second one')
  assert.deepEqual(
    after.manufacturingBom.items.map((item) => [item.componentProductId, Number(item.qty)]),
    [[rawOak.id, 9]],
    'the BomItem side must have followed the edit — dropped component gone, qty updated',
  )
  assert.deepEqual(await findBomRecipeDrift(db), [], 'the two representations must agree after an editor edit')
  console.log('# editor edit: both representations moved together, Bom ' + claimedBomId)

  // Put the original recipe back so the later steps read the fixture they expect.
  const leg = await db.product.findUniqueOrThrow({ where: { sku: 'LEG-01' }, select: { id: true } })
  const restored = await saveProductComponents(tableId, [
    { componentId: leg.id, qty: '4' },
    { componentId: rawOak.id, qty: '2' },
  ])
  assert.equal(restored.success, true, `restore failed: ${JSON.stringify(restored)}`)
  assert.deepEqual(await findBomRecipeDrift(db), [])
})

test('3c. ROUND 2 finding 1b: a type conversion RETIRES the recipe, and converting back ADOPTS the same Bom', async () => {
  // clearComponents deleted ProductComponent and left BomItem behind. Retiring deactivates and
  // unclaims instead of deleting, so completed-order history keeps resolving while planning stops
  // reading it — and the drift check stays green through an entirely legitimate conversion.
  const toSimple = await importProductsCsv(form([
    'sku,name,type,stockUnit',
    'TABLE-01,Oak table,SIMPLE,each',
  ].join('\n')))
  assert.deepEqual(errorsOf(toSimple), [], 'the conversion row must import cleanly')

  const retired = await db.bom.findUniqueOrThrow({
    where: { id: claimedBomId },
    select: { active: true, productId: true, items: { select: { id: true } } },
  })
  assert.equal(retired.active, false, 'the Bom must be deactivated — that is what planning filters on')
  assert.equal(retired.productId, null, 'and unclaimed, so a later conversion can adopt it')
  assert.ok(retired.items.length > 0, 'its items must SURVIVE — deleting them rewrites completed-order history')
  assert.equal(
    await db.productComponent.count({ where: { productId: tableId } }), 0,
    'precondition: the conversion really did clear ProductComponent',
  )
  assert.deepEqual(await findBomRecipeDrift(db), [], 'a retired recipe is history, not drift')
  console.log('# BOM -> SIMPLE: Bom ' + claimedBomId + ' deactivated + unclaimed, ' + retired.items.length + ' item(s) kept')

  const backToBom = await importProductsCsv(form([
    'sku,name,type,components,stockUnit',
    'TABLE-01,Oak table,BOM,LEG-01:4;RAW-OAK:2,each',
  ].join('\n')))
  assert.deepEqual(errorsOf(backToBom), [], 'converting back must import cleanly')

  const readopted = await db.product.findUniqueOrThrow({
    where: { id: tableId },
    select: { manufacturingBom: { select: { id: true, active: true, items: { select: { componentProductId: true } } } } },
  })
  assert.ok(readopted.manufacturingBom, 'it must have a claimed Bom again')
  assert.equal(readopted.manufacturingBom.id, claimedBomId, 'ADOPTED the retired row rather than adding a second')
  assert.equal(readopted.manufacturingBom.active, true, 're-activated, or planning still cannot see it')
  assert.equal(readopted.manufacturingBom.items.length, 2)
  assert.deepEqual(await findBomRecipeDrift(db), [])
  console.log('# SIMPLE -> BOM: re-adopted and re-activated the same Bom ' + claimedBomId)
})

test('4. an unknown component refuses the WHOLE recipe, by row number, writing no partial recipe', async () => {
  const result = await importProductsCsv(form([
    'sku,name,type,components,stockUnit',
    'SHELF-01,Oak shelf,BOM,RAW-OAK:1;NOT-A-SKU:2,each',
  ].join('\n')))

  const errors = errorsOf(result)
  assert.ok(
    errors.some((line) => line.includes('Row 2: component SKU "NOT-A-SKU" not found')),
    `the refusal must name the offending row: ${JSON.stringify(errors)}`,
  )

  const shelf = await db.product.findUnique({
    where: { sku: 'SHELF-01' },
    select: { id: true, productComponents: { select: { componentId: true } }, manufacturingBom: { select: { id: true } } },
  })
  // THE DANGEROUS CASE, asserted rather than described: the product IS created, the import does not
  // fail overall, and the error line is the ONLY notice. What must never happen is a PARTIAL recipe
  // — RAW-OAK:1 alone would build under-specified units that nothing reports.
  assert.ok(shelf, 'the product row itself is still created')
  assert.deepEqual(shelf.productComponents, [], 'no partial ProductComponent recipe')
  assert.equal(shelf.manufacturingBom, null, 'no partial BomItem recipe')

  const drift = await findBomRecipeDrift(db)
  const finding = drift.find((row) => row.sku === 'SHELF-01')
  assert.ok(finding, `the drift check must catch the recipeless BOM: ${JSON.stringify(drift, null, 1)}`)
  assert.equal(finding.kind, 'missing-bom')
  console.log(`# recipeless BOM caught: ${finding.detail}`)

  await db.product.delete({ where: { id: shelf.id } })
})

test('5. a cyclic recipe is refused and writes NEITHER representation', async () => {
  const before = await db.productComponent.count({ where: { componentId: tableId } })
  const result = await importProductsCsv(form([
    'sku,name,type,components,stockUnit',
    'LEG-01,Table leg,BOM,TABLE-01:1,each',
  ].join('\n')))

  const errors = errorsOf(result)
  assert.ok(errors.some((line) => /circular/i.test(line)), `expected a circular refusal: ${JSON.stringify(errors)}`)
  assert.equal(
    await db.productComponent.count({ where: { componentId: tableId } }), before,
    'the ProductComponent side must be unchanged',
  )
  assert.equal(
    await db.bomItem.count({ where: { componentProductId: tableId } }), 0,
    'the BomItem side must be unchanged',
  )
  assert.deepEqual(await findBomRecipeDrift(db), [], 'a refused row must leave the two representations in step')
  console.log(`# refused: ${errors.filter((line) => /circular/i.test(line)).join(' | ')}`)
})

test('5b. a cycle that ONLY exists in bom_items is refused — the case detectComponentCycle cannot see', async () => {
  // Test 5 above is caught by the EXISTING `detectComponentCycle`, which walks product_components.
  // That is the common case and proves nothing about the new check. THIS is the case only the new
  // check can see, and it is reachable from real legacy data: a Bom written from an older snapshot
  // of product_components keeps an edge product_components no longer has.
  const seed = await importProductsCsv(form([
    'sku,name,type,components,stockUnit',
    'STALE-A,Stale parent A,BOM,RAW-OAK:1,each',
    'STALE-B,Stale parent B,BOM,RAW-OAK:1,each',
  ].join('\n')))
  assert.deepEqual(errorsOf(seed), [])

  const a = await db.product.findUniqueOrThrow({ where: { sku: 'STALE-A' }, select: { id: true, manufacturingBom: { select: { id: true } } } })
  const b = await db.product.findUniqueOrThrow({ where: { sku: 'STALE-B' }, select: { id: true, manufacturingBom: { select: { id: true } } } })

  // The stale edge: B -> A in bom_items ONLY. No ProductComponent for it, so product_components
  // stays acyclic and `detectComponentCycle` will answer "ok" for the import below.
  await db.bomItem.create({
    data: { bomId: b.manufacturingBom!.id, parentProductId: b.id, componentProductId: a.id, qty: 1, sortOrder: 9 },
  })

  const result = await importProductsCsv(form([
    'sku,name,type,components,stockUnit',
    'STALE-A,Stale parent A,BOM,STALE-B:1,each',
  ].join('\n')))
  const errors = errorsOf(result)
  assert.ok(
    errors.some((line) => /manufacturing BOM graph circular/.test(line)),
    `the bom_items cycle must be refused with its own message: ${JSON.stringify(errors)}`,
  )
  console.log(`# bom_items-only cycle refused: ${errors.filter((line) => /manufacturing BOM graph circular/.test(line)).join(' | ')}`)

  // AND the ProductComponent write rolled back with it: STALE-A must still require RAW-OAK, not
  // STALE-B. This is the half that makes the refusal atomic rather than cosmetic.
  const after = await db.product.findUniqueOrThrow({
    where: { id: a.id },
    select: { productComponents: { select: { componentId: true } } },
  })
  assert.deepEqual(
    after.productComponents.map((component) => component.componentId === b.id), [false],
    'the ProductComponent side must not have been rewritten',
  )

  // Clean up so the later drift assertions are about the main fixture, not this deliberate mess.
  await db.bomItem.deleteMany({ where: { parentProductId: { in: [a.id, b.id] } } })
  await db.bom.deleteMany({ where: { productId: { in: [a.id, b.id] } } })
  await db.productComponent.deleteMany({ where: { productId: { in: [a.id, b.id] } } })
  await db.product.deleteMany({ where: { id: { in: [a.id, b.id] } } })
  assert.deepEqual(await findBomRecipeDrift(db), [], 'the fixture must be clean again')
})

test('6. a file over MAX_IMPORT_ROWS imports exactly the cap and reports ONE error line', async () => {
  const rows = ['sku,name,type,stockUnit']
  for (let i = 0; i < CAP + 3; i++) rows.push(`CAP-${i},Capped ${i},SIMPLE,each`)

  const result = await importProductsCsv(form(rows.join('\n')))
  const capLines = errorsOf(result).filter((line) => line.includes(`more than ${CAP} rows`))
  assert.equal(capLines.length, 1, `exactly one cap notice expected: ${JSON.stringify(errorsOf(result).slice(0, 5))}`)
  assert.match(capLines[0], new RegExp(`${CAP} rows — 3 row\\(s\\) skipped`))
  assert.equal(await db.product.count({ where: { sku: { startsWith: 'CAP-' } } }), CAP)
  console.log(`# ${CAP + 3} rows in, ${CAP} imported, notice: "${capLines[0]}"`)
})

test('7. a production order is created AND COMPLETED against the migrated Bom', async () => {
  const found = await db.warehouse.findFirst({ select: { id: true, code: true } })
  assert.ok(found, 'the scratch database must have a warehouse')
  warehouse = found

  const stock = await importOpeningStockCsv(form([
    'sku,warehouseCode,qty,unitCostBase',
    `RAW-OAK,${warehouse.code},500,1`,
    `GLUE,${warehouse.code},500,1`,
    `LEG-01,${warehouse.code},500,2`,
  ].join('\n')))
  assert.deepEqual(errorsOf(stock), [], 'opening stock must load through the sanctioned path')

  const created = await createManufacturingOrder({
    productId: tableId,
    warehouseId: warehouse.id,
    orderType: 'ASSEMBLY',
    qtyPlanned: 2,
  })
  assert.ok(created.success && created.id, `order create failed: ${JSON.stringify(created)}`)

  const order = await db.productionOrder.findUnique({
    where: { id: created.id },
    select: { bomId: true, reference: true },
  })
  assert.equal(
    order?.bomId, claimedBomId,
    'the order must run against the MIGRATED Bom, not one invented lazily at create time',
  )

  const started = await updateManufacturingOrderStatus(created.id, 'IN_PROGRESS')
  assert.ok(started.success, `start failed: ${JSON.stringify(started)}`)
  const completed = await updateManufacturingOrderStatus(created.id, 'COMPLETED')
  assert.ok(completed.success, `completion failed: ${JSON.stringify(completed)}`)

  const output = await db.stockLevel.findFirst({
    where: { productId: tableId, warehouseId: warehouse.id },
    select: { quantity: true },
  })
  assert.equal(Number(output?.quantity ?? 0), 2, 'completing the order must add finished stock')
  console.log(`# ${order.reference} completed against Bom ${claimedBomId}; TABLE-01 stock ${Number(output!.quantity)} at ${warehouse.code}`)

  assert.deepEqual(await findBomRecipeDrift(db), [], 'the two representations must still agree afterwards')
  await db.$disconnect()
})
