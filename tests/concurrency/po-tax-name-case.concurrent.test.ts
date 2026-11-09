import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { config } from 'dotenv'
import * as fixtures from './po-landed-fixtures'

/**
 * A PURCHASE ORDER NAMING A TAX RATE IN OTHER CASE TAKES THAT RATE (create and edit).
 *
 * The purchase-order importer finds a rate by name ignoring case, then hands the file's own spelling to createPurchaseOrder, which looked
 * the name up exactly: an order whose tax name differed from the stored one only in case passed the importer and then took no rate at all.
 * Both writers now match the way the importer does. Real createPurchaseOrder / updatePurchaseOrder over a real PostgreSQL. Fixture names
 * are unique by entropy and never deleted (one shared database).
 */

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const SKIP = { skip: !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1' } as const

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
    requireRole: async () => ({ user: { id: 'test-user', role: 'ADMIN' } }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } })
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => {} } })
mock.module('@/lib/notifications', { namedExports: { notify: async () => {} } })

test.before(async () => {
  if (!RUN) return
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_CONCURRENCY_TESTS=1')
})

test('a tax name in other case resolves the stored active rate on create and on edit; an unknown name still takes none', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder, updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = `${fixtures.uid()}-taxcase`
  const rateName = `Tag Rate ${tag}`
  const rate = await db.taxRate.create({ data: { name: rateName, rate: '0.1234', usedFor: 'PURCHASE', active: true }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: `${fixtures.uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const sku = `${tag}-sku`
  const product = await db.product.create({ data: { sku, name: `taxcase ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const line = { productId: product.id, sku, productName: `taxcase ${tag}`, qty: 2, unitCostForeign: 10 }
  const base = { supplierId: supplier.id, currency: 'GBP', destinationWarehouseId: warehouse.id, pricesIncludeVat: false, taxRateValue: 0, lines: [line] }
  const lineRates = async (poId: string) => (await db.purchaseOrderLine.findMany({ where: { poId }, select: { taxRateId: true } })).map((l) => l.taxRateId)

  // Create: the stored spelling, the same name in upper case, and padded; each takes the rate.
  for (const [label, name] of [['exact', rateName], ['upper', rateName.toUpperCase()], ['padded', `  ${rateName.toLowerCase()}  `]] as const) {
    const created = await createPurchaseOrder({ ...base, reference: `${tag}-${label}`, taxRateName: name })
    assert.equal(created.success, true, `create (${label}): ${created.error}`)
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: `${tag}-${label}` }, select: { id: true } })
    assert.deepEqual(await lineRates(po.id), [rate.id], `create (${label}): the line takes the named rate`)
  }

  // Control: a name that is not a rate (not just a case difference) takes none, as before.
  const unknown = await createPurchaseOrder({ ...base, reference: `${tag}-unknown`, taxRateName: `${rateName} nope` })
  assert.equal(unknown.success, true, `create (unknown): ${unknown.error}`)
  const unknownPo = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: `${tag}-unknown` }, select: { id: true } })
  assert.deepEqual(await lineRates(unknownPo.id), [null], 'an unknown name takes no rate')

  // Edit: the draft is moved onto the rate by a differently-cased name.
  const edited = await updatePurchaseOrder(unknownPo.id, { taxRateName: rateName.toLowerCase(), lines: [line] })
  assert.equal(edited.success, true, `edit: ${edited.error}`)
  assert.deepEqual(await lineRates(unknownPo.id), [rate.id], 'edit: the line takes the named rate in other case')
})

test('names are not unique: an ambiguous name is refused, an id or an exact spelling decides, a sales-only rate is ignored, an unchanged name keeps an edit on its rate', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder, updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = `${fixtures.uid()}-taxamb`
  const upper = `VAT ${tag}`
  const lower = upper.toLowerCase()
  // Created in this order, so ids ascend: the sales-only rate is the EARLIEST by id and must never win a purchase lookup.
  const salesOnly = await db.taxRate.create({ data: { name: `Solo ${tag}`, rate: '0.5000', usedFor: 'SALES', active: true }, select: { id: true } })
  const solo = await db.taxRate.create({ data: { name: `solo ${tag}`, rate: '0.0700', usedFor: 'BOTH', active: true }, select: { id: true } })
  const a = await db.taxRate.create({ data: { name: upper, rate: '0.2000', usedFor: 'PURCHASE', active: true }, select: { id: true } })
  const b = await db.taxRate.create({ data: { name: lower, rate: '0.0500', usedFor: 'BOTH', active: true }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: `${fixtures.uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const sku = `${tag}-sku`
  const product = await db.product.create({ data: { sku, name: `taxamb ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const line = { productId: product.id, sku, productName: `taxamb ${tag}`, qty: 1, unitCostForeign: 10 }
  const base = { supplierId: supplier.id, currency: 'GBP', destinationWarehouseId: warehouse.id, pricesIncludeVat: false, taxRateValue: 0 }
  const poOf = async (ref: string) => db.purchaseOrder.findUniqueOrThrow({ where: { reference: ref }, select: { id: true } })
  const lineRates = async (poId: string) => (await db.purchaseOrderLine.findMany({ where: { poId }, select: { taxRateId: true } })).map((l) => l.taxRateId)
  const count = async () => db.purchaseOrder.count({ where: { reference: { startsWith: tag } } })

  // Two active purchase rates whose names differ by case: a spelling that is neither exactly is ambiguous and nothing is written.
  const mixed = `Vat ${tag}`
  const refused = await createPurchaseOrder({ ...base, reference: `${tag}-mixed`, taxRateName: mixed, lines: [line] })
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /matches 2 active purchase tax rates.*choose the rate by id/)
  assert.equal(await count(), 0, 'a refused order writes nothing')

  // An exact spelling picks that rate; the other spelling picks the other.
  assert.equal((await createPurchaseOrder({ ...base, reference: `${tag}-up`, taxRateName: upper, lines: [line] })).success, true)
  assert.deepEqual(await lineRates((await poOf(`${tag}-up`)).id), [a.id])
  assert.equal((await createPurchaseOrder({ ...base, reference: `${tag}-low`, taxRateName: lower, lines: [line] })).success, true)
  assert.deepEqual(await lineRates((await poOf(`${tag}-low`)).id), [b.id])

  // An id wins over any name.
  assert.equal((await createPurchaseOrder({ ...base, reference: `${tag}-id`, taxRateId: a.id, taxRateName: lower, lines: [line] })).success, true)
  assert.deepEqual(await lineRates((await poOf(`${tag}-id`)).id), [a.id])

  // A sales-only rate earlier by id with the same name (other case) is ignored: the one purchase rate is a unique match.
  assert.ok(salesOnly.id < solo.id, 'PRECONDITION: the sales-only rate sorts first by id')
  assert.equal((await createPurchaseOrder({ ...base, reference: `${tag}-solo`, taxRateName: `SOLO ${tag}`, lines: [line] })).success, true)
  assert.deepEqual(await lineRates((await poOf(`${tag}-solo`)).id), [solo.id])
  // A name only a sales-only rate has takes no rate.
  const salesOnlyName = await db.taxRate.create({ data: { name: `Sales only ${tag}`, rate: '0.3000', usedFor: 'SALES', active: true }, select: { id: true } })
  assert.ok(salesOnlyName.id)
  assert.equal((await createPurchaseOrder({ ...base, reference: `${tag}-none`, taxRateName: `sales only ${tag}`, lines: [line] })).success, true)
  assert.deepEqual(await lineRates((await poOf(`${tag}-none`)).id), [null])

  // Edit: a PO whose lines carry rate B, edited with an ambiguous spelling, stays on B (its lines' rate is the tie-break)...
  const lowId = (await poOf(`${tag}-low`)).id
  const kept = await updatePurchaseOrder(lowId, { taxRateName: mixed, lines: [line] })
  assert.equal(kept.success, true, `edit: ${kept.error}`)
  assert.deepEqual(await lineRates(lowId), [b.id], 'an edit that leaves the tax name as it was cannot move the line to the other rate')
  // ...and an ambiguous name on a PO whose lines carry neither is refused with the lines untouched.
  const nonePo = (await poOf(`${tag}-none`)).id
  const refusedEdit = await updatePurchaseOrder(nonePo, { taxRateName: mixed, lines: [line] })
  assert.equal(refusedEdit.success, false)
  assert.match(refusedEdit.error ?? '', /choose the rate by id/)
  assert.deepEqual(await lineRates(nonePo), [null], 'a refused edit leaves the lines as they were')
})

test('an inactive rate never matches by name, and narrowing never shrinks a tie to a smaller tie', SKIP, async () => {
  const { db } = await import('@/lib/db')
  const { createPurchaseOrder, updatePurchaseOrder } = await import('@/app/actions/purchase-orders')
  const tag = `${fixtures.uid()}-taxtie`
  const mk = (name: string, usedFor: string, active = true) => db.taxRate.create({ data: { name, rate: '0.1000', usedFor, active }, select: { id: true } })
  const warehouse = await db.warehouse.create({ data: { code: `${fixtures.uid()}-W`, name: `${tag} wh`, type: 'STANDARD' }, select: { id: true } })
  const supplier = await db.supplier.create({ data: { name: `${tag} supplier`, currency: 'GBP' }, select: { id: true } })
  const sku = `${tag}-sku`
  const product = await db.product.create({ data: { sku, name: `taxtie ${tag}`, type: 'SIMPLE', countryOfOrigin: 'CN' }, select: { id: true } })
  const line = { productId: product.id, sku, productName: `taxtie ${tag}`, qty: 1, unitCostForeign: 10 }
  const base = { supplierId: supplier.id, currency: 'GBP', destinationWarehouseId: warehouse.id, pricesIncludeVat: false, taxRateValue: 0 }
  const lineRates = async (ref: string) => (await db.purchaseOrderLine.findMany({ where: { po: { reference: ref } }, select: { taxRateId: true } })).map((l) => l.taxRateId)

  // An inactive rate earlier by id does not shadow the one active rate, and a name only an inactive rate has takes none.
  const dead = await mk(`Dead ${tag}`, 'BOTH', false)
  const live = await mk(`dead ${tag}`, 'BOTH')
  const onlyDead = await mk(`Gone ${tag}`, 'BOTH', false)
  assert.ok(dead.id < live.id && onlyDead.id)
  assert.equal((await createPurchaseOrder({ ...base, reference: `${tag}-live`, taxRateName: `DEAD ${tag}`, lines: [line] })).success, true)
  assert.deepEqual(await lineRates(`${tag}-live`), [live.id])
  assert.equal((await createPurchaseOrder({ ...base, reference: `${tag}-gone`, taxRateName: `gone ${tag}`, lines: [line] })).success, true)
  assert.deepEqual(await lineRates(`${tag}-gone`), [null])

  // Three active rates: two spelled exactly "Tie <tag>" and one "tie <tag>". The exact spelling is still a tie of two, and the refusal says three.
  const t1 = await mk(`Tie ${tag}`, 'BOTH')
  const t2 = await mk(`Tie ${tag}`, 'PURCHASE')
  const t3 = await mk(`tie ${tag}`, 'BOTH')
  const refused = await createPurchaseOrder({ ...base, reference: `${tag}-tie`, taxRateName: `Tie ${tag}`, lines: [line] })
  assert.equal(refused.success, false)
  assert.match(refused.error ?? '', /matches 3 active purchase tax rates/)

  // An edit whose lines carry two of the three (by id) is still a tie of three, not of the two it carries.
  const seeded = await createPurchaseOrder({ ...base, reference: `${tag}-seed`, taxRateId: t1.id, lines: [line, { ...line, taxRateId: t2.id }] })
  assert.equal(seeded.success, true, `seed: ${seeded.error}`)
  const po = await db.purchaseOrder.findUniqueOrThrow({ where: { reference: `${tag}-seed` }, select: { id: true } })
  const edit = await updatePurchaseOrder(po.id, { taxRateName: `TIE ${tag}`, lines: [{ ...line, taxRateId: t1.id }, { ...line, taxRateId: t2.id }] })
  assert.equal(edit.success, false)
  assert.match(edit.error ?? '', /matches 3 active purchase tax rates/)
  assert.ok(t3.id)
})
