import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

/**
 * CUSTOM FIELDS AGAINST A REAL DATABASE: what the migration guarantees (unique key per entity, one owner, one filled value column, the
 * foreign keys), the CSV round trip through the real importer and exporter (blank = unchanged), the sales-order list filter, and the
 * erasure removing sales-order values. GATED on RUN_DB_RETENTION_TESTS (npm run test:db).
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'
if (skip && process.env.REQUIRE_DB_RETENTION_TESTS === '1') {
  throw new Error('REQUIRE_DB_RETENTION_TESTS=1 but RUN_DB_RETENTION_TESTS is not 1, so every test in tests/db/custom-fields.test.ts would have been skipped')
}

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async () => ({ user: { id: null, role: 'ADMIN' } }),
    requireApiAuth: async () => ({ user: { id: 'u', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'u', role: 'ADMIN' } }),
  },
})
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined, revalidateTag: () => undefined } })
// importProductsCsv schedules a storefront metadata push and a stock sync; neither may run here.
mock.module('@/lib/shopping', { namedExports: { enqueueStockSync: async () => undefined, pushProductMetadata: async () => ({ success: true }) } })

test('custom fields on a real database', { skip }, async (t) => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when RUN_DB_RETENTION_TESTS=1')
  const { db } = await import('@/lib/db')
  const { createCustomFieldDefinitionAction, updateCustomFieldDefinitionAction, saveCustomFieldValues, getCustomFieldCardData } = await import('@/app/actions/custom-fields')
  const { importProductsCsv } = await import('@/app/actions/import')
  const { GET: exportProducts } = await import('@/app/api/export/products/route')
  const { getSalesOrders } = await import('@/app/actions/sales')
  const { eraseCustomerPersonalData } = await import('@/lib/domain/erasure/erase-personal-data')
  const { parseCsv } = await import('@/lib/csv')

  const RUN = `cf${randomUUID().slice(0, 8)}`
  const key = (name: string) => `${RUN}_${name}`
  const customer = await db.customer.create({ data: { firstName: 'Cora', lastName: 'Fields', email: `${RUN}@example.test` } })
  const orderIds: string[] = []
  const order = async (label: string) => {
    const created = await db.salesOrder.create({
      data: { orderNumber: `${RUN}-${label}`, status: 'DRAFT', currency: 'GBP', customerId: customer.id, customerName: 'Cora Fields', subtotalForeign: 1, totalForeign: 1, subtotalBase: 1, totalBase: 1 },
      select: { id: true },
    })
    orderIds.push(created.id)
    return created.id
  }
  t.after(async () => {
    await db.activityLog.deleteMany({ where: { OR: [{ entityId: { in: [...orderIds, customer.id] } }, { description: { contains: RUN } }] } })
    await db.salesOrder.deleteMany({ where: { id: { in: orderIds } } })
    await db.product.deleteMany({ where: { sku: { startsWith: RUN.toUpperCase() } } })
    await db.customFieldValue.deleteMany({ where: { definition: { key: { startsWith: RUN } } } })
    await db.customFieldDefinition.deleteMany({ where: { key: { startsWith: RUN } } })
    await db.customer.deleteMany({ where: { id: customer.id } })
  })

  const define = async (entity: 'PRODUCT' | 'SALES_ORDER', name: string, type: string, extra: Record<string, unknown> = {}) => {
    const result = await createCustomFieldDefinitionAction({ entity, namespace: 'testing', key: key(name), label: `${name} label`, type, ...extra })
    assert.ok(result.success, JSON.stringify(result))
    return result.success ? result.definition : (undefined as never)
  }

  const grade = await define('PRODUCT', 'grade', 'STRING', { options: ['A', 'B'] })
  const pallets = await define('PRODUCT', 'pallets', 'NUMBER')
  const launched = await define('PRODUCT', 'launched', 'DATE')
  const meta = await define('PRODUCT', 'meta', 'JSON')
  const fragile = await define('PRODUCT', 'fragile', 'BOOLEAN')
  const stage = await define('SALES_ORDER', 'stage', 'STRING', { options: ['Pick', 'Pack'] })
  const remark = await define('SALES_ORDER', 'remark', 'STRING')

  await t.test('the key is unique per entity, in the database and in the action', async () => {
    const again = await createCustomFieldDefinitionAction({ entity: 'PRODUCT', namespace: 'testing', key: key('grade'), label: 'dupe', type: 'STRING' })
    assert.ok(!again.success && /already a product custom field/.test(again.error))
    const otherEntity = await createCustomFieldDefinitionAction({ entity: 'SALES_ORDER', namespace: 'testing', key: key('grade'), label: 'same key, other entity', type: 'STRING' })
    assert.ok(otherEntity.success, 'the same key on the other entity is allowed')
    await assert.rejects(
      db.$executeRaw`INSERT INTO custom_field_definitions (id, entity, namespace, key, label, type, "updatedAt") VALUES (${randomUUID()}, 'PRODUCT'::"CustomFieldEntity", 'testing', ${key('grade')}, 'dupe', 'STRING'::"CustomFieldType", now())`,
      /custom_field_definitions_entity_key_key|unique/i,
    )
  })

  const product = await db.product.create({ data: { sku: `${RUN.toUpperCase()}-1`, name: 'Fixture', type: 'SIMPLE' }, select: { id: true } })
  const so = await order('1')

  await t.test('the database allows exactly one owner and exactly one filled value column', async () => {
    const insert = (productId: string | null, salesOrderId: string | null, valueText: string | null, valueBoolean: boolean | null) =>
      db.$executeRaw`INSERT INTO custom_field_values (id, "definitionId", "productId", "salesOrderId", "valueText", "valueBoolean", "updatedAt") VALUES (${randomUUID()}, ${grade.id}, ${productId}, ${salesOrderId}, ${valueText}, ${valueBoolean}, now())`
    await assert.rejects(insert(product.id, so, 'A', null), /custom_field_values_one_owner_check|check constraint/i, 'both owners')
    await assert.rejects(insert(null, null, 'A', null), /custom_field_values_one_owner_check|check constraint/i, 'no owner')
    await assert.rejects(insert(product.id, null, null, null), /custom_field_values_one_value_check|check constraint/i, 'no value column')
    await assert.rejects(insert(product.id, null, 'A', true), /custom_field_values_one_value_check|check constraint/i, 'two value columns')
  })

  await t.test('one value per definition per product and per order, and a definition with values cannot be removed', async () => {
    const saved = await saveCustomFieldValues('PRODUCT', product.id, { [grade.id]: 'A' })
    assert.deepEqual(saved, { success: true, changed: 1 })
    await assert.rejects(
      db.customFieldValue.create({ data: { definitionId: grade.id, productId: product.id, valueText: 'B' } }),
      /Unique constraint/i,
    )
    await assert.rejects(db.customFieldDefinition.delete({ where: { id: grade.id } }), /foreign key|constraint|Restrict/i)
  })

  await t.test('typed round trip per type through the real tables, and the type change is refused once values exist', async () => {
    const saved = await saveCustomFieldValues('PRODUCT', product.id, {
      [pallets.id]: '12', [launched.id]: '2026-11-18', [meta.id]: '{"a": [1, 2]}', [fragile.id]: 'yes', [grade.id]: 'B',
    })
    assert.deepEqual(saved, { success: true, changed: 5 })
    const card = await getCustomFieldCardData('PRODUCT', product.id)
    const value = (id: string) => card.fields.find((f) => f.id === id)!.value
    assert.deepEqual([value(pallets.id), value(launched.id), value(meta.id), value(fragile.id), value(grade.id)], ['12', '2026-11-18', '{"a":[1,2]}', 'true', 'B'])
    const rawDate = await db.customFieldValue.findFirstOrThrow({ where: { definitionId: launched.id, productId: product.id } })
    assert.equal(rawDate.valueDate!.toISOString(), '2026-11-18T00:00:00.000Z')
    assert.equal(rawDate.valueText, null)
    const refused = await updateCustomFieldDefinitionAction({ id: pallets.id, namespace: 'testing', label: 'p', type: 'STRING', required: false, sortOrder: 0, active: true })
    assert.ok(!refused.success && /type cannot be changed/.test(refused.error))
    assert.equal((await saveCustomFieldValues('PRODUCT', product.id, { [grade.id]: 'C' })).success, false, 'options enforced')
  })

  await t.test('deactivating hides the field from the card and the export and keeps its values', async () => {
    const off = await updateCustomFieldDefinitionAction({ id: pallets.id, namespace: 'testing', label: 'p', type: 'NUMBER', required: false, sortOrder: 0, active: false })
    assert.ok(off.success)
    assert.equal((await getCustomFieldCardData('PRODUCT', product.id)).fields.some((f) => f.id === pallets.id), false)
    const csv = await (await exportProducts(new Request('http://localhost/api/export/products'))).text()
    assert.ok(!csv.includes(`cf:${key('pallets')}`))
    assert.equal(await db.customFieldValue.count({ where: { definitionId: pallets.id } }), 1)
    const on = await updateCustomFieldDefinitionAction({ id: pallets.id, namespace: 'testing', label: 'p', type: 'NUMBER', required: false, sortOrder: 0, active: true })
    assert.ok(on.success)
    assert.equal((await getCustomFieldCardData('PRODUCT', product.id)).fields.find((f) => f.id === pallets.id)!.value, '12')
  })

  await t.test('CSV export then import: the export carries cf columns last; import writes them; a BLANK cell leaves the value unchanged', async () => {
    const exported = await (await exportProducts(new Request('http://localhost/api/export/products'))).text()
    const headers = exported.split('\r\n')[0]!.split(',')
    const cfHeaders = headers.filter((h) => h.startsWith('cf:') && h.includes(RUN))
    assert.ok(cfHeaders.length === 5)
    assert.equal(headers.slice(headers.length - cfHeaders.length).filter((h) => h.startsWith('cf:')).length >= cfHeaders.length, true, 'cf columns come last')
    assert.equal(headers.indexOf('category') < headers.indexOf(cfHeaders[0]!), true)
    const row = parseCsv(exported).find((r) => r.sku === `${RUN.toUpperCase()}-1`)!
    assert.equal(row[`cf:${key('pallets')}`], '12')
    assert.equal(row[`cf:${key('fragile')}`], 'true')

    // Re-import the product's own exported row, plus a NEW product: a blank cell on the existing row, a value on the new one.
    const sku2 = `${RUN.toUpperCase()}-2`
    const csv = [
      `sku,name,cf:${key('grade')},cf:${key('pallets')},cf:${key('fragile')},cf:${RUN.toUpperCase()}_GONE`,
      `${RUN.toUpperCase()}-1,Fixture,,,,x`,
      `${sku2},Second,A,7,no,x`,
    ].join('\r\n')
    const form = new FormData()
    form.set('file', new File([csv], 'products.csv', { type: 'text/csv' }))
    const result = await importProductsCsv(form)
    assert.equal(result.errors.filter((e) => !/not a custom field/.test(e)).length, 0, JSON.stringify(result.errors))
    assert.ok(result.errors.some((e) => /_GONE" is not a custom field/i.test(e)), 'an unknown cf column is reported once and ignored')
    const first = await getCustomFieldCardData('PRODUCT', product.id)
    assert.equal(first.fields.find((f) => f.id === pallets.id)!.value, '12', 'blank = unchanged')
    assert.equal(first.fields.find((f) => f.id === fragile.id)!.value, 'true', 'blank = unchanged')
    assert.equal(first.fields.find((f) => f.id === grade.id)!.value, 'B', 'blank = unchanged')
    const second = await db.product.findUniqueOrThrow({ where: { sku: sku2 }, select: { id: true } })
    const secondCard = await getCustomFieldCardData('PRODUCT', second.id)
    assert.deepEqual([grade.id, pallets.id, fragile.id].map((id) => secondCard.fields.find((f) => f.id === id)!.value), ['A', '7', 'false'])

    // A bad value is reported against its row; the product row itself still imports and its other values are kept.
    const bad = new FormData()
    bad.set('file', new File([`sku,name,cf:${key('grade')},cf:${key('pallets')}\r\n${sku2},Second renamed,Z,9`], 'bad.csv', { type: 'text/csv' }))
    const badResult = await importProductsCsv(bad)
    assert.ok(badResult.errors.some((e) => /Row 2 .*not one of the allowed choices/.test(e)), JSON.stringify(badResult.errors))
    assert.equal((await db.product.findUniqueOrThrow({ where: { sku: sku2 }, select: { name: true } })).name, 'Second renamed')
    assert.equal((await getCustomFieldCardData('PRODUCT', second.id)).fields.find((f) => f.id === pallets.id)!.value, '7', 'a refused row changes none of its custom fields')
  })

  await t.test('SALES ORDER list: filter by a dropdown value, and by a yes / no value', async () => {
    const o2 = await order('2')
    const o3 = await order('3')
    assert.equal((await saveCustomFieldValues('SALES_ORDER', so, { [stage.id]: 'Pick' })).success, true)
    assert.equal((await saveCustomFieldValues('SALES_ORDER', o2, { [stage.id]: 'Pack' })).success, true)
    // o3 has no value at all
    const list = async (cfv: string) => (await getSalesOrders({ q: RUN, customFieldKey: key('stage'), customFieldValue: cfv })).rows.map((r) => r.id).sort()
    assert.deepEqual(await list('Pick'), [so])
    assert.deepEqual(await list('Pack'), [o2])
    assert.deepEqual((await getSalesOrders({ q: RUN })).rows.map((r) => r.id).sort(), [so, o2, o3].sort(), 'no filter: every order')
    assert.deepEqual(await list('Ship'), [so, o2, o3].sort(), 'a value that is not a choice is ignored')
    const offered = (await getSalesOrders({ q: RUN })).customFieldFilters.map((f) => f.key)
    assert.ok(offered.includes(key('stage')) && !offered.includes(key('remark')), 'only dropdown and yes / no fields are offered')
  })

  await t.test('ERASURE deletes the sales-order values (and only those); the definitions and the product values stay', async () => {
    assert.equal((await saveCustomFieldValues('SALES_ORDER', so, { [remark.id]: 'Mrs Fields asked us to leave it with the neighbour at number 9' })).success, true)
    assert.equal(await db.customFieldValue.count({ where: { salesOrderId: { in: orderIds } } }) >= 3, true)
    const erased = await eraseCustomerPersonalData(customer.id, { trigger: 'ON_REQUEST', userId: null })
    assert.equal(erased.success, true, JSON.stringify(erased))
    assert.equal(await db.customFieldValue.count({ where: { salesOrderId: { in: orderIds } } }), 0, 'every order value is gone')
    assert.equal(await db.customFieldDefinition.count({ where: { id: { in: [stage.id, remark.id] } } }), 2)
    assert.ok(await db.customFieldValue.count({ where: { productId: product.id } }) > 0, 'product values are not personal data')
    const late = await saveCustomFieldValues('SALES_ORDER', so, { [remark.id]: 'late text' })
    assert.ok(!late.success && /erased/.test(late.error), 'an erased order takes no new value')
    assert.equal(await db.customFieldValue.count({ where: { salesOrderId: so } }), 0)
  })
})
