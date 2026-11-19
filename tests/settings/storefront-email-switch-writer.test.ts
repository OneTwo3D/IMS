import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

process.env.SETTINGS_ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || 'a1'.repeat(32)

// o3d-pdnzu items 4 and 6, SETTINGS SCREEN WRITER: turning `storefront_customer_email_enabled` ON through setSettings is refused by the interlock (nothing
// written) and otherwise records `storefront_customer_email_enabled_at` in the same transaction; off, and an unchanged on, record nothing. The enabled-at
// row itself is not writable through the generic writer.

const state = { rows: new Map<string, string>(), writes: [] as string[], transactions: 0, refusal: null as string | null, interlockCalls: 0 }
const reset = () => { state.rows = new Map(); state.writes = []; state.transactions = 0; state.refusal = null; state.interlockCalls = 0 }

const setting = {
  findUnique: async ({ where }: { where: { key: string } }) => (state.rows.has(where.key) ? { value: state.rows.get(where.key)! } : null),
  upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => { state.rows.set(where.key, create.value); state.writes.push(where.key) },
  deleteMany: async ({ where }: { where: { key: string } }) => { state.rows.delete(where.key); state.writes.push(`delete:${where.key}`) },
}
mock.module('@/lib/db', { namedExports: { db: { setting, $transaction: async (fn: (tx: { setting: typeof setting }) => Promise<unknown>) => { state.transactions += 1; return fn({ setting }) } } } })
mock.module('@/lib/auth/server', {
  namedExports: {
    requireAuth: async () => ({ user: { id: 'u1', role: 'ADMIN' } }), requirePermission: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireInternalUser: async () => ({ user: { id: 'u1', role: 'ADMIN' } }), requireAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }),
    requireFreshAdmin: async () => ({ user: { id: 'u1', role: 'ADMIN' } }), freshAuthFailureResult: () => null,
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => undefined } })
mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('@/lib/crontab-reconcile', { namedExports: { reconcileCrontab: async () => ({ success: true }), readOwnCrontabResult: async () => ({ resolved: true, text: '', present: false }) } })
mock.module('@/lib/domain/storefront-customer-email/switch-on-interlock', {
  namedExports: { storefrontEmailSwitchOnRefusal: async () => { state.interlockCalls += 1; return state.refusal } },
})

test.beforeEach(reset)

const KEY = 'storefront_customer_email_enabled'
const AT = 'storefront_customer_email_enabled_at'

test('refused by the interlock: nothing is written and the refusal text comes back (MUTATION: skip the interlock in the writer => red)', async () => {
  const { setSettings } = await import('@/app/actions/settings')
  state.refusal = 'Cannot turn on customer e-mail for storefront orders: step W is not live.'
  assert.deepEqual(await setSettings({ [KEY]: 'true' }), { status: 'refused', error: state.refusal })
  assert.equal(state.interlockCalls, 1)
  assert.equal(state.transactions, 0)
  assert.deepEqual(state.writes, [])
})

test('allowed: the switch and its switch-on instant are written in ONE transaction (MUTATION: no stamp => red)', async () => {
  const { setSettings } = await import('@/app/actions/settings')
  const before = Date.now()
  assert.deepEqual(await setSettings({ [KEY]: 'true' }), { status: 'saved' })
  assert.equal(state.transactions, 1)
  assert.deepEqual(state.writes, [AT, KEY])
  const stamp = Date.parse(state.rows.get(AT)!)
  assert.ok(stamp >= before && stamp <= Date.now())
})

test('turning it off CLEARS the stamp, in the same transaction; saving it unchanged-on neither asks the interlock nor moves the stamp (MUTATION: no clear => red)', async () => {
  const { setSettings } = await import('@/app/actions/settings')
  state.rows.set(KEY, 'true'); state.rows.set(AT, '2026-12-09T00:00:00.000Z')
  state.refusal = 'would refuse'
  assert.deepEqual(await setSettings({ [KEY]: 'true' }), { status: 'saved' }, 'unchanged: not a transition')
  assert.equal(state.rows.get(AT), '2026-12-09T00:00:00.000Z', 'unchanged on: the stamp stays')
  assert.deepEqual(await setSettings({ [KEY]: 'false' }), { status: 'saved' }, 'off is never refused')
  assert.equal(state.interlockCalls, 0)
  assert.equal(state.rows.has(AT), false, 'off clears the stamp')
})

test('the switch-on instant is not writable through the generic writer', async () => {
  const { setSettings } = await import('@/app/actions/settings')
  await assert.rejects(() => setSettings({ [AT]: '2020-01-01T00:00:00.000Z' }))
  assert.equal(state.rows.has(AT), false)
})
