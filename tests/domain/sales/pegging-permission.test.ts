import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Pegging decides which order gets stock, so writing a peg takes the same permission as allocating by hand (sales.process).
 * The role matrix is the real one; only the session is doubled.
 */

const session = { role: 'READONLY' }
const calls: string[] = []

mock.module('@/lib/auth/server', {
  namedExports: {
    requirePermission: async (permission: string) => {
      const { hasPermission } = await import('@/lib/permissions')
      calls.push(permission)
      if (!hasPermission(session.role as never, permission as never)) throw new Error(`Forbidden: missing permission ${permission}`)
      return { user: { id: 'user-1', role: session.role } }
    },
    requireInternalUser: async () => ({ user: { id: 'user-1', role: session.role } }),
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      // Reaching the database means the permission gate let the call through.
      $transaction: async () => { throw new Error('REACHED_DATABASE') },
    },
  },
})

test('creating and removing a peg need sales.process: a read-only user and a finance user are refused before the database', async () => {
  const { createPeg, removePeg } = await import('@/app/actions/pegging')
  for (const role of ['READONLY', 'FINANCE']) {
    session.role = role
    await assert.rejects(() => createPeg({ salesOrderLineId: 'l', purchaseOrderLineId: 'p', qty: 1 }), /missing permission sales\.process/, role)
    await assert.rejects(() => removePeg('peg'), /missing permission sales\.process/, role)
  }
  assert.ok(calls.every((permission) => permission === 'sales.process'))
})

test('a role that may allocate by hand passes the gate (it reaches the transaction)', async () => {
  const { createPeg } = await import('@/app/actions/pegging')
  for (const role of ['WAREHOUSE', 'MANAGER', 'ADMIN']) {
    session.role = role
    const result = await createPeg({ salesOrderLineId: 'l', purchaseOrderLineId: 'p', qty: 1 })
    assert.deepEqual(result, { success: false, error: 'Could not create the peg' }, `${role}: the gate passed and the doubled database was reached`)
  }
})
