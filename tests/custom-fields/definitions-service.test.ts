import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { def, freshState, makeTx, type FakeState, type FakeValue } from './fake-db'

/**
 * DEFINITIONS: unique key per entity, a type change is refused once values exist, a choice list cannot strand an existing value,
 * deactivating hides a field but deletes nothing, and only an unused definition can be deleted.
 */

mock.module('@/lib/db', { namedExports: { db: {} } })
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })

type Definitions = typeof import('../../lib/custom-fields/definitions-service.ts')
let createCustomFieldDefinition: Definitions['createCustomFieldDefinition']
let updateCustomFieldDefinition: Definitions['updateCustomFieldDefinition']
let deleteCustomFieldDefinition: Definitions['deleteCustomFieldDefinition']
let loadActiveDefinitions: typeof import('../../lib/custom-fields/values-service.ts')['loadActiveDefinitions']
before(async () => {
  ;({ createCustomFieldDefinition, updateCustomFieldDefinition, deleteCustomFieldDefinition } = await import('../../lib/custom-fields/definitions-service.ts'))
  ;({ loadActiveDefinitions } = await import('../../lib/custom-fields/values-service.ts'))
})

let state: FakeState
const tx = () => makeTx(state, Prisma.PrismaClientKnownRequestError as never) as never

const value = (over: Partial<FakeValue>): FakeValue => ({
  id: `v${Math.random()}`, definitionId: 'd1', productId: 'p1', salesOrderId: null,
  valueText: null, valueDecimal: null, valueBoolean: null, valueDate: null, valueDateTime: null, valueJson: null, ...over,
})

type CreateInput = Parameters<Definitions['createCustomFieldDefinition']>[1]
const create = (over: Partial<CreateInput> = {}) => createCustomFieldDefinition(tx(), {
  entity: 'PRODUCT', namespace: 'logistics', key: 'hazard_class', label: 'Hazard class', type: 'STRING', ...over,
}, 'u1')

test('create: a valid definition is stored and audited', async () => {
  state = freshState()
  const result = await create({ options: ['A', 'B'], required: true, sortOrder: 3 })
  assert.ok(result.ok)
  assert.equal(state.definitions.length, 1)
  assert.deepEqual(state.definitions[0]!.options, ['A', 'B'])
  assert.equal(state.activity.length, 1)
  assert.equal(state.activity[0]!.action, 'custom_field_created')
})

test('create: the key is unique PER ENTITY (the same key on a product and on an order is fine, twice on one entity is refused)', async () => {
  state = freshState()
  assert.ok((await create()).ok)
  const again = await create()
  assert.ok(!again.ok && /already a product custom field with the key "hazard_class"/.test(again.error))
  assert.equal(state.definitions.length, 1)
  assert.ok((await create({ entity: 'SALES_ORDER' })).ok, 'the same key on the other entity is allowed')
  assert.equal(state.definitions.length, 2)
})

test('create: a database unique violation (a concurrent create) is reported in words, not thrown', async () => {
  state = freshState()
  state.uniqueViolationOnCreate = true
  const result = await create()
  assert.ok(!result.ok && /already a product custom field/.test(result.error))
})

test('create: bad slug, namespace, label, type, entity, sort order and choices are refused before any write', async () => {
  state = freshState()
  const bad: Array<[Partial<CreateInput>, RegExp]> = [
    [{ key: 'Bad Key' }, /key must start/],
    [{ namespace: 'Bad NS' }, /namespace must start/],
    [{ label: '  ' }, /label is required/],
    [{ label: 'x'.repeat(81) }, /80 characters/],
    [{ type: 'MONEY' }, /Choose a field type/],
    [{ entity: 'CUSTOMER' }, /products or sales orders/],
    [{ sortOrder: 1.5 }, /whole number/],
    [{ type: 'NUMBER', options: ['1', '2'] }, /Only a text field/],
    [{ options: ['A', 'A'] }, /listed twice/],
  ]
  for (const [over, message] of bad) {
    const result = await create(over)
    assert.ok(!result.ok && message.test(result.error), `${JSON.stringify(over)} -> ${JSON.stringify(result)}`)
  }
  assert.deepEqual(state.writes, [])
})

test('create: at most 100 definitions per entity', async () => {
  state = freshState()
  for (let i = 0; i < 100; i++) state.definitions.push(def({ id: `d${i}`, key: `k${i}`, type: 'STRING' }))
  const result = await create({ key: 'one_more' })
  assert.ok(!result.ok && /at most 100/.test(result.error))
})

test('update: a type change is REFUSED once the field holds a value, and allowed while it holds none', async () => {
  state = freshState()
  state.definitions.push(def({ id: 'd1', key: 'weightclass', type: 'STRING' }))
  state.values.push(value({ valueText: 'heavy' }))
  const input = { id: 'd1', namespace: 'logistics', label: 'Weight class', type: 'NUMBER', options: null, required: false, sortOrder: 0, active: true }
  const refused = await updateCustomFieldDefinition(tx(), input, 'u1')
  assert.ok(!refused.ok && /already holds 1 value, so its type cannot be changed/.test(refused.error))
  assert.equal(state.definitions[0]!.type, 'STRING', 'the definition is untouched')
  assert.equal(state.writes.includes('definition.update'), false)

  state.values = []
  const allowed = await updateCustomFieldDefinition(tx(), input, 'u1')
  assert.ok(allowed.ok && allowed.definition.type === 'NUMBER')
})

test('update: the definition row is locked FOR UPDATE before it is read', async () => {
  state = freshState()
  state.definitions.push(def({ id: 'd1', key: 'k', type: 'STRING' }))
  await updateCustomFieldDefinition(tx(), { id: 'd1', namespace: 'logistics', label: 'L', type: 'STRING', options: null, required: false, sortOrder: 0, active: true }, 'u1')
  assert.ok(state.locks.some((l) => /custom_field_definitions.*FOR UPDATE/.test(l)))
})

test('update: a choice list that would strand an existing value is refused, naming the value', async () => {
  state = freshState()
  state.definitions.push(def({ id: 'd1', key: 'colour', type: 'STRING', options: ['Red', 'Green'] }))
  state.values.push(value({ valueText: 'Red' }), value({ valueText: 'Green', productId: 'p2' }))
  const base = { id: 'd1', namespace: 'logistics', label: 'Colour', type: 'STRING', required: false, sortOrder: 0, active: true }
  const refused = await updateCustomFieldDefinition(tx(), { ...base, options: ['Red'] }, 'u1')
  assert.ok(!refused.ok && /"Green"/.test(refused.error))
  assert.deepEqual(state.definitions[0]!.options, ['Red', 'Green'])
  const ok = await updateCustomFieldDefinition(tx(), { ...base, options: ['Red', 'Green', 'Blue'] }, 'u1')
  assert.ok(ok.ok)
})

test('update: label, namespace, required and sort order change freely; the key and entity are not parameters at all', async () => {
  state = freshState()
  state.definitions.push(def({ id: 'd1', key: 'k', type: 'STRING' }))
  state.values.push(value({ valueText: 'x' }))
  const result = await updateCustomFieldDefinition(tx(), { id: 'd1', namespace: 'other', label: 'New label', type: 'STRING', options: null, required: true, sortOrder: 9, active: true }, 'u1')
  assert.ok(result.ok)
  assert.deepEqual({ ...state.definitions[0]!, id: undefined }, { ...def({ id: 'x', key: 'k', type: 'STRING' }), id: undefined, namespace: 'other', label: 'New label', required: true, sortOrder: 9 })
  assert.equal(state.values.length, 1)
})

test('DEACTIVATE hides the field everywhere it is read, and deletes no value; reactivating brings it back', async () => {
  state = freshState()
  state.definitions.push(def({ id: 'd1', key: 'k', type: 'STRING' }))
  state.values.push(value({ valueText: 'kept' }))
  const off = await updateCustomFieldDefinition(tx(), { id: 'd1', namespace: 'logistics', label: 'L', type: 'STRING', options: null, required: false, sortOrder: 0, active: false }, 'u1')
  assert.ok(off.ok)
  assert.equal(state.activity.at(-1)!.action, 'custom_field_deactivated')
  assert.deepEqual(await loadActiveDefinitions(tx(), 'PRODUCT'), [], 'hidden from every reader that loads the active definitions (card, CSV, list filter)')
  assert.equal(state.writes.includes('value.deleteMany'), false)
  assert.equal(state.values.length, 1, 'the value is still stored')
  const on = await updateCustomFieldDefinition(tx(), { id: 'd1', namespace: 'logistics', label: 'L', type: 'STRING', options: null, required: false, sortOrder: 0, active: true }, 'u1')
  assert.ok(on.ok)
  assert.equal((await loadActiveDefinitions(tx(), 'PRODUCT')).length, 1)
})

test('update: an unknown definition is refused politely', async () => {
  state = freshState()
  const result = await updateCustomFieldDefinition(tx(), { id: 'nope', namespace: 'a', label: 'L', type: 'STRING', options: null, required: false, sortOrder: 0, active: true }, 'u1')
  assert.ok(!result.ok && /no longer exists/.test(result.error))
})

test('delete: refused while any value exists (switch it off instead), allowed once none do', async () => {
  state = freshState()
  state.definitions.push(def({ id: 'd1', key: 'k', type: 'STRING' }))
  state.values.push(value({ valueText: 'x' }), value({ valueText: 'y', productId: 'p2' }))
  const refused = await deleteCustomFieldDefinition(tx(), 'd1', 'u1')
  assert.ok(!refused.ok && /holds 2 values/.test(refused.error) && /Switch it off/.test(refused.error))
  assert.equal(state.definitions.length, 1)
  state.values = []
  assert.deepEqual(await deleteCustomFieldDefinition(tx(), 'd1', 'u1'), { ok: true })
  assert.equal(state.definitions.length, 0)
})
