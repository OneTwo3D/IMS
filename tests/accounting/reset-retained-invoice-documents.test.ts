import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * Stored customer invoice documents are a statutory record, and the foreign keys from them to orders and refunds are RESTRICT. A reset is a
 * sequence of separate deletes, so reaching the order delete with documents present would fail MIDWAY, after earlier deletes had committed.
 * The reset therefore asks FIRST: documents stored and the database not declared disposable means it refuses before the confirmation code is
 * spent and before anything is deleted; on a disposable database it deletes the fetch states and documents ahead of the orders and refunds.
 */
const state = { deleted: [] as string[], storedDocuments: 0, storedAfterFirstCount: null as number | null, comment: null as string | null, codeConsumed: 0, assertHeldCalls: 0, lockLostAfter: null as number | null, documentCountCalls: 0 }

const model = (name: string) => ({
  deleteMany: async () => { state.deleted.push(name); return { count: 0 } },
  updateMany: async () => ({ count: 0 }),
  count: async () => {
    if (name !== 'salesOrderInvoiceDocument') return 0
    state.documentCountCalls++
    // `storedAfterFirstCount`: a document that appears AFTER the first look (the outer preflight) and is seen by the next (the one inside the transaction).
    return state.documentCountCalls > 1 && state.storedAfterFirstCount !== null ? state.storedAfterFirstCount : state.storedDocuments
  },
  findMany: async () => [],
  findUnique: async () => null,
  create: async () => ({}),
  upsert: async () => ({}),
})
const client: Record<string, unknown> = new Proxy({}, {
  get(_t, prop: string) {
    if (prop === '$transaction') return async (fn: (tx: unknown) => Promise<unknown>) => fn(client)
    if (prop === '$queryRaw') return async () => [{ db: 'ims_test', comment: state.comment }]
    if (prop === 'then') return undefined
    return model(prop)
  },
})

mock.module('@/lib/domain/invoice-documents/reset-lock', {
  namedExports: {
    withInvoiceDocumentResetLock: async (run: (lock: { assertHeld: (context?: string) => void }) => Promise<unknown>) => run({
      assertHeld: (context?: string) => {
        state.assertHeldCalls++
        if (state.lockLostAfter !== null && state.assertHeldCalls > state.lockLostAfter) throw new Error(`the reset lock was lost (${context ?? 'unknown stage'})`)
      },
    }),
    lockResetInTransaction: async () => { state.deleted.push('<<reset transaction lock>>') },
    AdvisoryLockWaitTimeoutError: class extends Error {},
  },
})
mock.module('@/lib/db', { namedExports: { db: client } })
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })
mock.module('@/lib/integration-plugin-selection-lock', { namedExports: { lockIntegrationPluginSelection: async () => {} } })
mock.module('@/lib/auth/server', { namedExports: { requireFreshAdmin: async () => ({ user: { id: 'admin-1', email: 'admin@example.test' } }), freshAuthFailureResult: () => null } })
mock.module('@/lib/destructive-action-confirm', {
  namedExports: { consumeDestructiveActionCode: async () => { state.codeConsumed++; return true }, issueDestructiveActionCode: async () => ({ success: true }) },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })

function fresh(over: Partial<typeof state> = {}) {
  state.deleted = []
  state.storedDocuments = 0
  state.comment = null
  state.codeConsumed = 0
  state.assertHeldCalls = 0
  state.lockLostAfter = null
  state.storedAfterFirstCount = null
  state.documentCountCalls = 0
  Object.assign(state, over)
}

test('stored invoice documents on a database that is not declared disposable: refused before the code is spent and before anything is deleted', async () => {
  fresh({ storedDocuments: 3 })
  const { resetDatabase } = await import('@/app/actions/reset')
  for (const level of ['transactions', 'products', 'full'] as const) {
    const result = await resetDatabase(level, '123456')
    assert.equal(result.success, false)
    assert.match(result.error ?? '', /Nothing was deleted/)
  }
  assert.deepEqual(state.deleted, [], 'nothing was deleted')
  assert.equal(state.codeConsumed, 0, 'the confirmation code was not spent')
})

test('no stored invoice documents: the reset runs as before and clears the fetch states ahead of the orders', async () => {
  fresh()
  const { resetDatabase } = await import('@/app/actions/reset')
  assert.equal((await resetDatabase('transactions', '123456')).success, true)
  assert.ok(state.deleted.includes('invoiceDocumentFetchState'))
  assert.ok(!state.deleted.includes('salesOrderInvoiceDocument'), 'nothing to delete, and the retained table is not touched')
  assert.ok(state.deleted.indexOf('invoiceDocumentFetchState') < state.deleted.indexOf('salesOrder'))
})

test('a database declared disposable: the documents and states are deleted first, so the reset completes', async () => {
  const { expectedDisposableDatabaseMarker } = await import('@/lib/disposable-database-marker')
  fresh({ storedDocuments: 2, comment: expectedDisposableDatabaseMarker('ims_test') })
  const { resetDatabase } = await import('@/app/actions/reset')
  assert.equal((await resetDatabase('transactions', '123456')).success, true)
  const order = (name: string) => state.deleted.indexOf(name)
  assert.ok(order('salesOrderInvoiceDocument') >= 0 && order('invoiceDocumentFetchState') >= 0)
  assert.ok(order('salesOrderInvoiceDocument') < order('salesOrderRefund'), 'documents go before the refunds they reference')
  assert.ok(order('salesOrderInvoiceDocument') < order('salesOrder'), 'and before the orders')
  assert.equal(state.codeConsumed, 1)
})

test('a comment that is not exactly this database\'s disposable marker does not count', async () => {
  const { expectedDisposableDatabaseMarker } = await import('@/lib/disposable-database-marker')
  fresh({ storedDocuments: 1, comment: expectedDisposableDatabaseMarker('some_other_database') })
  const { resetDatabase } = await import('@/app/actions/reset')
  assert.equal((await resetDatabase('full', '123456')).success, false)
  assert.deepEqual(state.deleted, [])
})

test('the lock is lost mid-reset: assertHeld stops the reset, and no further delete is issued', async () => {
  fresh({ lockLostAfter: 3 })
  const { resetDatabase } = await import('@/app/actions/reset')
  const result = await resetDatabase('full', '123456')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /reset lock was lost/)
  const after = state.deleted.length
  // Stages 1 to 3 (email and WMS, stock sync, stock ledger) ran; the sales stage, purchasing and everything after never did.
  assert.ok(state.deleted.includes('payment'))
  assert.ok(!state.deleted.includes('salesOrder'), 'the sales stage did not run')
  assert.ok(!state.deleted.includes('purchaseOrder'), 'nor purchasing')
  assert.ok(!state.deleted.includes('product') && !state.deleted.includes('warehouse'), 'nor the product and full scopes')
  assert.equal(state.deleted.length, after)
})

test('a document that appears after the preflight is seen by the verdict INSIDE the sales transaction, which refuses before it deletes anything there', async () => {
  fresh({ storedDocuments: 0, storedAfterFirstCount: 1 })
  const { resetDatabase } = await import('@/app/actions/reset')
  const result = await resetDatabase('transactions', '123456')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /Nothing was deleted/)
  assert.ok(state.deleted.includes('<<reset transaction lock>>'), 'the transaction took its own exclusive lock first')
  for (const name of ['shipment', 'salesOrderRefund', 'salesOrder', 'salesOrderInvoiceDocument', 'invoiceDocumentFetchState']) {
    assert.ok(!state.deleted.includes(name), `${name} was not deleted: the sales stage rolled back`)
  }
})
