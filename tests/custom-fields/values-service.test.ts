import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { def, freshState, makeTx, type FakeState } from './fake-db'

/**
 * VALUES: typed server-side validation, options enforced, required enforced, only changed fields written, the erased-order refusal,
 * variants carry their own values, and the audit rows never carry a sales-order value.
 */

const lockedOrders: string[] = []
mock.module('@/lib/db', { namedExports: { db: {} } })
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })
mock.module('@/lib/domain/sales/allocation-service', {
  namedExports: { lockSalesOrder: async (_tx: unknown, id: string) => { lockedOrders.push(id) } },
})

let applyCustomFieldValues: typeof import('../../lib/custom-fields/values-service.ts')['applyCustomFieldValues']
let loadCustomFieldCard: typeof import('../../lib/custom-fields/values-service.ts')['loadCustomFieldCard']
before(async () => {
  ;({ applyCustomFieldValues, loadCustomFieldCard } = await import('../../lib/custom-fields/values-service.ts'))
})

let state: FakeState
const tx = () => makeTx(state, Prisma.PrismaClientKnownRequestError as never) as never
type ApplyInput = Parameters<typeof import('../../lib/custom-fields/values-service.ts')['applyCustomFieldValues']>[1]
const apply = (changes: Record<string, string>, over: Partial<ApplyInput> = {}) =>
  applyCustomFieldValues(tx(), { entity: 'PRODUCT', entityId: 'p1', changes, userId: 'u1', source: 'editor', ...over })

function seed() {
  state = freshState()
  lockedOrders.length = 0
  state.products.push({ id: 'p1', sku: 'SKU-1' }, { id: 'variant1', sku: 'SKU-1-S' })
  state.orders.push({ id: 'o1', orderNumber: 'SO-1', externalOrderNumber: null, erasedAt: null })
  state.definitions.push(
    def({ id: 'dText', key: 'note', type: 'STRING', label: 'Note' }),
    def({ id: 'dChoice', key: 'grade', type: 'STRING', label: 'Grade', options: ['A', 'B'] }),
    def({ id: 'dNum', key: 'pallets', type: 'NUMBER', label: 'Pallets' }),
    def({ id: 'dBool', key: 'fragile', type: 'BOOLEAN', label: 'Fragile' }),
    def({ id: 'dJson', key: 'meta', type: 'JSON', label: 'Meta' }),
    def({ id: 'dReq', key: 'owner', type: 'STRING', label: 'Owner', required: true }),
    def({ id: 'dOff', key: 'old', type: 'STRING', label: 'Old', active: false }),
    def({ id: 'dSo', entity: 'SALES_ORDER', key: 'stage', type: 'STRING', label: 'Process stage', options: ['Pick', 'Pack'] }),
    def({ id: 'dSoFree', entity: 'SALES_ORDER', key: 'remark', type: 'STRING', label: 'Remark' }),
  )
}

test('a valid change is written typed, in one column, and audited with before and after for a product', async () => {
  seed()
  const result = await apply({ dNum: '12', dBool: 'yes', dChoice: 'A' })
  assert.deepEqual(result, { ok: true, changed: 3 })
  const byDef = Object.fromEntries(state.values.map((v) => [v.definitionId, v]))
  assert.equal(byDef.dNum!.valueDecimal, '12')
  assert.equal(byDef.dBool!.valueBoolean, true)
  assert.equal(byDef.dChoice!.valueText, 'A')
  assert.equal(byDef.dNum!.productId, 'p1')
  assert.equal(byDef.dNum!.salesOrderId, null)
  assert.equal(byDef.dNum!.valueText, null, 'only the type\'s own column is filled')
  assert.equal(state.activity.length, 1)
  assert.equal(state.activity[0]!.entityType, 'PRODUCT')
  assert.deepEqual((state.activity[0]!.metadata as { changes: unknown[] }).changes, [
    { key: 'pallets', from: null, to: '12' }, { key: 'fragile', from: null, to: 'true' }, { key: 'grade', from: null, to: 'A' },
  ])
})

test('a type error is refused and NOTHING is written, every refusal is reported together', async () => {
  seed()
  const result = await apply({ dNum: 'twelve', dBool: 'maybe', dText: 'fine' })
  assert.ok(!result.ok)
  assert.deepEqual(Object.keys(result.fieldErrors).sort(), ['dBool', 'dNum'])
  assert.match(result.fieldErrors.dNum!, /Pallets: must be a whole number/)
  assert.deepEqual(state.values, [])
  assert.deepEqual(state.activity, [])
})

test('OPTIONS are enforced server-side: a value outside a dropdown is refused even if the form was bypassed', async () => {
  seed()
  const result = await apply({ dChoice: 'Z' })
  assert.ok(!result.ok && /not one of the allowed choices \(A, B\)/.test(result.fieldErrors.dChoice!))
  assert.deepEqual(state.values, [])
})

test('required: blank is refused for a required field, allowed (and clears) for an optional one', async () => {
  seed()
  assert.ok((await apply({ dText: 'hello', dReq: 'me' })).ok)
  const refused = await apply({ dReq: '' })
  assert.ok(!refused.ok && /Owner: a value is required/.test(refused.fieldErrors.dReq!))
  assert.equal(state.values.find((v) => v.definitionId === 'dReq')!.valueText, 'me', 'the required value is still there')
  assert.deepEqual(await apply({ dText: '' }), { ok: true, changed: 1 })
  assert.equal(state.values.some((v) => v.definitionId === 'dText'), false, 'a cleared optional field has no row')
})

test('an unchanged value writes nothing and logs nothing; a changed one logs the true old value', async () => {
  seed()
  await apply({ dNum: '5' })
  state.writes.length = 0
  state.activity.length = 0
  assert.deepEqual(await apply({ dNum: '5.0'.replace('.0', '') }), { ok: true, changed: 0 })
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.activity, [])
  await apply({ dNum: '6' })
  assert.deepEqual(((state.activity as Array<Record<string, unknown>>)[0]!.metadata as { changes: unknown[] }).changes, [{ key: 'pallets', from: '5', to: '6' }])
})

test('a switched-off field, a field of the other entity and an unknown field are refused', async () => {
  seed()
  const off = await apply({ dOff: 'x' })
  assert.ok(!off.ok && /switched off/.test(off.fieldErrors.dOff!))
  const wrongEntity = await apply({ dSo: 'Pick' })
  assert.ok(!wrongEntity.ok && /no longer exists/.test(wrongEntity.fieldErrors.dSo!))
  const unknown = await apply({ nope: 'x' })
  assert.ok(!unknown.ok)
  assert.deepEqual(state.values, [])
})

test('the definitions being written are share-locked, so a type or choice change cannot interleave', async () => {
  seed()
  await apply({ dText: 'x' })
  assert.ok(state.locks.some((l) => /custom_field_definitions.*FOR SHARE/.test(l)))
})

test('a variant has its OWN values: nothing is inherited from, or written to, the parent', async () => {
  seed()
  await apply({ dText: 'parent value' }, { entityId: 'p1' })
  const variantCard = await loadCustomFieldCard(tx(), 'PRODUCT', 'variant1')
  assert.equal(variantCard.fields.find((f) => f.id === 'dText')!.value, null, 'no inheritance in v1')
  await apply({ dText: 'variant value' }, { entityId: 'variant1' })
  assert.equal((await loadCustomFieldCard(tx(), 'PRODUCT', 'p1')).fields.find((f) => f.id === 'dText')!.value, 'parent value')
  assert.equal((await loadCustomFieldCard(tx(), 'PRODUCT', 'variant1')).fields.find((f) => f.id === 'dText')!.value, 'variant value')
})

test('the card lists only active fields of the entity, by namespace then sort order, with each value in its text form', async () => {
  seed()
  await apply({ dNum: '7', dJson: '{"a": 1}' })
  const card = await loadCustomFieldCard(tx(), 'PRODUCT', 'p1')
  assert.equal(card.fields.some((f) => f.id === 'dOff'), false, 'a switched-off field is hidden')
  assert.equal(card.fields.some((f) => f.id === 'dSo'), false, 'an order field is not on a product')
  assert.equal(card.fields.find((f) => f.id === 'dNum')!.value, '7')
  assert.equal(card.fields.find((f) => f.id === 'dJson')!.value, '{"a":1}')
})

test('a hidden field\'s values are kept and are not shown, then reappear on reactivation', async () => {
  seed()
  await apply({ dText: 'kept' })
  state.definitions.find((d) => d.id === 'dText')!.active = false
  assert.equal((await loadCustomFieldCard(tx(), 'PRODUCT', 'p1')).fields.some((f) => f.id === 'dText'), false)
  assert.equal(state.values.length, 1)
  state.definitions.find((d) => d.id === 'dText')!.active = true
  assert.equal((await loadCustomFieldCard(tx(), 'PRODUCT', 'p1')).fields.find((f) => f.id === 'dText')!.value, 'kept')
})

test('SALES ORDER: written under the order lock; the audit row names the field and NEVER carries the value', async () => {
  seed()
  const result = await apply({ dSo: 'Pick', dSoFree: 'call Mrs Example on 07700 900123' }, { entity: 'SALES_ORDER', entityId: 'o1' })
  assert.deepEqual(result, { ok: true, changed: 2 })
  assert.deepEqual(lockedOrders, ['o1'])
  assert.equal(state.values.every((v) => v.salesOrderId === 'o1' && v.productId === null), true)
  assert.equal(state.activity.length, 1)
  assert.equal(state.activity[0]!.entityType, 'SALES_ORDER')
  const logged = JSON.stringify(state.activity[0])
  assert.ok(!logged.includes('Mrs Example') && !logged.includes('07700') && !logged.includes('Pick'), `the log must not carry values: ${logged}`)
  assert.deepEqual((state.activity[0]!.metadata as { fields: string[] }).fields, ['stage', 'remark'])
})

test('an ERASED order refuses every value write (nothing written, nothing logged)', async () => {
  seed()
  state.orders[0]!.erasedAt = new Date()
  const result = await apply({ dSoFree: 'late free text' }, { entity: 'SALES_ORDER', entityId: 'o1' })
  assert.ok(!result.ok && /personal data has been erased/.test(result.error))
  assert.deepEqual(state.values, [])
  assert.deepEqual(state.activity, [])
})

test('a missing product or order is refused', async () => {
  seed()
  const noProduct = await apply({ dText: 'x' }, { entityId: 'gone' })
  assert.ok(!noProduct.ok && /no longer exists/.test(noProduct.error))
  const noOrder = await apply({ dSoFree: 'x' }, { entity: 'SALES_ORDER', entityId: 'gone' })
  assert.ok(!noOrder.ok && /no longer exists/.test(noOrder.error))
})

test('a CSV source is recorded on the product audit row', async () => {
  seed()
  await apply({ dText: 'x' }, { source: 'csv' })
  assert.match(String(state.activity[0]!.description), /by CSV import/)
})
