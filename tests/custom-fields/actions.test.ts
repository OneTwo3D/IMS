import assert from 'node:assert/strict'
import test, { before, mock } from 'node:test'
import { Prisma } from '@/app/generated/prisma/client'
import { def, freshState, makeTx, type FakeState } from './fake-db'

/**
 * PERMISSIONS. Definitions need settings.company; product values are read with inventory and written with inventory.edit; order values
 * are read with sales and written with sales.create. A denial THROWS and happens before any database access.
 */

let state: FakeState = freshState()
const asked: string[] = []
let granted = new Set<string>()
let dbTouched = 0

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      asked.push(permission)
      if (!granted.has(permission)) throw new Error(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'user-1', role: 'MANAGER' } }
    },
  },
})
mock.module('@/lib/auth', { namedExports: { auth: async () => null } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/domain/sales/allocation-service', { namedExports: { lockSalesOrder: async () => {} } })
mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({}, {
      get: (_t, key: string) => {
        dbTouched += 1
        const tx = makeTx(state, Prisma.PrismaClientKnownRequestError as never) as Record<string, unknown>
        if (key === '$transaction') return async (fn: (t: unknown) => Promise<unknown>) => fn(tx)
        if (key === 'customFieldValue') return { ...(tx.customFieldValue as object), groupBy: async () => [] }
        return tx[key]
      },
    }),
  },
})

let actions: typeof import('../../app/actions/custom-fields.ts')
before(async () => { actions = await import('../../app/actions/custom-fields.ts') })

function reset(...permissions: string[]) {
  state = freshState()
  state.products.push({ id: 'p1', sku: 'SKU-1' })
  state.orders.push({ id: 'o1', orderNumber: 'SO-1', externalOrderNumber: null, erasedAt: null })
  state.definitions.push(def({ id: 'dP', key: 'kp', type: 'STRING' }), def({ id: 'dS', entity: 'SALES_ORDER', key: 'ks', type: 'STRING' }))
  asked.length = 0
  dbTouched = 0
  granted = new Set(permissions)
}

const denied = /Forbidden: missing permission/

test('definition actions need settings.company, and a denial touches no data', async () => {
  reset('inventory', 'inventory.edit', 'sales', 'sales.create')
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['list', () => actions.listCustomFieldDefinitions()],
    ['create', () => actions.createCustomFieldDefinitionAction({ entity: 'PRODUCT', namespace: 'a', key: 'k', label: 'L', type: 'STRING' })],
    ['update', () => actions.updateCustomFieldDefinitionAction({ id: 'dP', namespace: 'a', label: 'L', type: 'STRING', required: false, sortOrder: 0, active: true })],
    ['delete', () => actions.deleteCustomFieldDefinitionAction('dP')],
  ]
  for (const [name, call] of calls) {
    dbTouched = 0
    await assert.rejects(call(), denied, name)
    assert.equal(dbTouched, 0, `${name}: nothing read or written on denial`)
  }
  assert.deepEqual([...new Set(asked)], ['settings.company'])
  assert.equal(state.definitions.length, 2)
})

test('definition actions succeed with settings.company', async () => {
  reset('settings.company')
  const created = await actions.createCustomFieldDefinitionAction({ entity: 'PRODUCT', namespace: 'a', key: 'fresh', label: 'Fresh', type: 'BOOLEAN' })
  assert.ok(created.success)
  const list = await actions.listCustomFieldDefinitions()
  assert.equal(list.length, 3)
})

test('product values: read needs inventory, write needs inventory.edit (a reader cannot write)', async () => {
  reset('inventory')
  assert.ok((await actions.getCustomFieldCardData('PRODUCT', 'p1')).fields.length === 1)
  await assert.rejects(actions.saveCustomFieldValues('PRODUCT', 'p1', { dP: 'x' }), denied)
  assert.deepEqual(state.values, [], 'a denied write wrote nothing')
  assert.deepEqual(asked, ['inventory', 'inventory.edit'])
  reset('inventory.edit')
  const saved = await actions.saveCustomFieldValues('PRODUCT', 'p1', { dP: 'x' })
  assert.deepEqual(saved, { success: true, changed: 1 })
  await assert.rejects(actions.getCustomFieldCardData('PRODUCT', 'p1'), denied)
})

test('order values: read needs sales, write needs sales.create', async () => {
  reset('sales')
  assert.ok((await actions.getCustomFieldCardData('SALES_ORDER', 'o1')).fields.length === 1)
  await assert.rejects(actions.saveCustomFieldValues('SALES_ORDER', 'o1', { dS: 'x' }), denied)
  assert.deepEqual(state.values, [])
  reset('sales.create')
  assert.deepEqual(await actions.saveCustomFieldValues('SALES_ORDER', 'o1', { dS: 'x' }), { success: true, changed: 1 })
  await assert.rejects(actions.getCustomFieldCardData('SALES_ORDER', 'o1'), denied)
})

test('an order value cannot be written with the product key, nor a product value with the order key', async () => {
  reset('inventory.edit')
  await assert.rejects(actions.saveCustomFieldValues('SALES_ORDER', 'o1', { dS: 'x' }), denied)
  reset('sales.create')
  await assert.rejects(actions.saveCustomFieldValues('PRODUCT', 'p1', { dP: 'x' }), denied)
})

test('a refusal comes back as a result (not a throw) with the per-field messages', async () => {
  reset('inventory.edit')
  state.definitions.push(def({ id: 'dN', key: 'num', type: 'NUMBER', label: 'Count' }))
  const result = await actions.saveCustomFieldValues('PRODUCT', 'p1', { dN: 'abc' })
  assert.ok(!result.success && /Count: must be a whole number/.test(result.fieldErrors.dN!))
})

test('an unknown record type is refused after the permission check', async () => {
  reset('inventory.edit', 'sales.create')
  const result = await actions.saveCustomFieldValues('CUSTOMER' as never, 'x', { a: 'b' })
  assert.ok(!result.success)
})
