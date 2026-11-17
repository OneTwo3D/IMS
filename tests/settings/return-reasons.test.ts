import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Return reason settings: CRUD, ordering, the active flag, the permission, and the two protections (a duplicate name is refused ignoring case because
 * the WooCommerce import maps by name; a reason that refunds use cannot be deleted). The database and auth are doubles.
 */
type Reason = { id: string; name: string; sortOrder: number; active: boolean }
let rows: Reason[] = []
let refundsUsing: Record<string, number> = {}
let nextId = 1
let allowed = true
const permissionsAsked: string[] = []
const activity: string[] = []

const dbDouble = {
  returnReason: {
    findMany: async (args: { where?: { active?: boolean } }) => rows
      .filter((r) => args.where?.active === undefined || r.active === args.where.active)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    findFirst: async (args: { where: { name: { equals: string }; id?: { not: string } } }) =>
      rows.find((r) => r.name.toLowerCase() === args.where.name.equals.toLowerCase() && r.id !== args.where.id?.not) ?? null,
    create: async (args: { data: Omit<Reason, 'id'> }) => { const row = { id: `rr-${nextId++}`, ...args.data }; rows.push(row); return row },
    update: async (args: { where: { id: string }; data: Omit<Reason, 'id'> }) => {
      const row = rows.find((r) => r.id === args.where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, args.data)
      return row
    },
    delete: async (args: { where: { id: string } }) => { rows = rows.filter((r) => r.id !== args.where.id) },
  },
  salesOrderRefund: { count: async (args: { where: { returnReasonId: string } }) => refundsUsing[args.where.returnReasonId] ?? 0 },
}
mock.module('@/lib/db', { namedExports: { db: dbDouble, prisma: dbDouble } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireInternalUser: async () => ({ user: { id: 'u1' } }),
    requirePermission: async (permission: string) => {
      permissionsAsked.push(permission)
      if (!allowed) throw new Error('Forbidden')
      return { user: { id: 'u1' } }
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async (input: { action: string }) => { activity.push(input.action) } } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('next/navigation', { namedExports: { unstable_rethrow: () => undefined } })

const reset = () => { rows = []; refundsUsing = {}; nextId = 1; allowed = true; permissionsAsked.length = 0; activity.length = 0 }

test('create, update, list in sort order, and the active filter', async () => {
  reset()
  const { createReturnReason, updateReturnReason, getReturnReasons } = await import('../../app/actions/return-reasons.ts')
  const b = await createReturnReason({ name: 'Wrong item', sortOrder: 2, active: true })
  const a = await createReturnReason({ name: ' Damaged ', sortOrder: 1, active: true })
  assert.equal(b.success, true)
  assert.equal(a.item?.name, 'Damaged', 'the name is trimmed')
  assert.deepEqual((await getReturnReasons()).map((r) => r.name), ['Damaged', 'Wrong item'], 'ordered by sort order')

  const off = await updateReturnReason(a.item!.id, { name: 'Damaged', sortOrder: 1, active: false })
  assert.equal(off.item?.active, false)
  assert.deepEqual((await getReturnReasons(true)).map((r) => r.name), ['Wrong item'], 'the picker list shows only active reasons')
  assert.deepEqual((await getReturnReasons()).map((r) => r.name), ['Damaged', 'Wrong item'], 'Settings still lists inactive ones')
  assert.deepEqual(activity, ['created', 'created', 'updated'])
})

test('a blank name and a name that differs only by case are refused', async () => {
  reset()
  const { createReturnReason, updateReturnReason } = await import('../../app/actions/return-reasons.ts')
  assert.ok((await createReturnReason({ name: '   ', sortOrder: 0, active: true })).errors?.name)
  const first = await createReturnReason({ name: 'Damaged', sortOrder: 0, active: true })
  assert.ok((await createReturnReason({ name: 'DAMAGED', sortOrder: 0, active: true })).errors?.name)
  const other = await createReturnReason({ name: 'Other', sortOrder: 0, active: true })
  assert.ok((await updateReturnReason(other.item!.id, { name: 'damaged', sortOrder: 0, active: true })).errors?.name)
  assert.equal((await updateReturnReason(first.item!.id, { name: 'damaged', sortOrder: 0, active: true })).success, true, 'a reason may change its own case')
  assert.equal(rows.length, 2)
})

test('a reason that refunds use cannot be deleted; an unused one can', async () => {
  reset()
  const { createReturnReason, deleteReturnReason } = await import('../../app/actions/return-reasons.ts')
  const used = await createReturnReason({ name: 'Used', sortOrder: 0, active: true })
  const unused = await createReturnReason({ name: 'Unused', sortOrder: 1, active: true })
  refundsUsing[used.item!.id] = 3
  const refused = await deleteReturnReason(used.item!.id)
  assert.match(refused.error ?? '', /used by 3 refunds/)
  assert.ok(rows.some((r) => r.id === used.item!.id))
  assert.deepEqual(await deleteReturnReason(unused.item!.id), {})
  assert.ok(!rows.some((r) => r.id === unused.item!.id))
})

test('every write needs settings.company, and a denied caller writes nothing', async () => {
  reset()
  const { createReturnReason, updateReturnReason, deleteReturnReason } = await import('../../app/actions/return-reasons.ts')
  const seed = await createReturnReason({ name: 'Seed', sortOrder: 0, active: true })
  permissionsAsked.length = 0
  allowed = false
  await assert.rejects(createReturnReason({ name: 'X', sortOrder: 0, active: true }))
  await assert.rejects(updateReturnReason(seed.item!.id, { name: 'Y', sortOrder: 0, active: true }))
  await assert.rejects(deleteReturnReason(seed.item!.id))
  assert.deepEqual(permissionsAsked, ['settings.company', 'settings.company', 'settings.company'])
  assert.deepEqual(rows.map((r) => r.name), ['Seed'])
})
