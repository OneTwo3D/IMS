import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Product.accountingItemId and Customer/Supplier.accountingContactId are connector-AGNOSTIC: they
 * hold ids belonging to whichever accounting connector is currently connected. That is only safe
 * while disconnect wipes them.
 *
 * Left behind, they are read straight back — the lookups short-circuit on a stored id precisely so
 * they never re-verify it — and a Xero ItemID gets handed to QuickBooks, or to a reconnect against
 * a DIFFERENT Xero org, as if it were that system's own id.
 *
 * QuickBooks cleared contacts and Xero did not, which was already live before accountingItemId gave
 * it a second column to leak (o3d-3nc).
 */

type Cleared = { model: string; data: unknown }

const cleared: Cleared[] = []

function recorder(model: string) {
  return {
    updateMany: async (args: { data: unknown }) => {
      cleared.push({ model, data: args.data })
      return { count: 0 }
    },
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
      // findUnique => null: no stored token, so QuickBooks' disconnect skips remote token
      // revocation and goes straight to the local clear-down, which is what is under test here.
      accountingToken: {
        deleteMany: async () => ({ count: 1 }),
        findFirst: async () => null,
        findUnique: async () => null,
      },
      setting: { deleteMany: async () => ({ count: 1 }), findUnique: async () => null },
      customer: recorder('customer'),
      supplier: recorder('supplier'),
      product: recorder('product'),
    },
  },
})

async function disconnectXero() {
  const m = await import('@/lib/connectors/xero/auth')
  return m.disconnect()
}
async function disconnectQbo() {
  const m = await import('@/lib/connectors/quickbooks/auth')
  return m.disconnect()
}

test.beforeEach(() => { cleared.length = 0 })

test('disconnecting Xero clears contact AND item ids', async () => {
  await disconnectXero()

  const models = cleared.map((c) => c.model).sort()
  assert.deepEqual(models, ['customer', 'product', 'supplier'])
  assert.deepEqual(
    cleared.find((c) => c.model === 'product')?.data,
    { accountingItemId: null },
    'a Xero ItemID left on a product is a live id for a system we are no longer talking to',
  )
  assert.deepEqual(cleared.find((c) => c.model === 'customer')?.data, { accountingContactId: null })
  assert.deepEqual(cleared.find((c) => c.model === 'supplier')?.data, { accountingContactId: null })
})

test('disconnecting QuickBooks clears contact AND item ids', async () => {
  await disconnectQbo()

  const models = cleared.map((c) => c.model).sort()
  assert.deepEqual(models, ['customer', 'product', 'supplier'])
  assert.deepEqual(cleared.find((c) => c.model === 'product')?.data, { accountingItemId: null })
})
