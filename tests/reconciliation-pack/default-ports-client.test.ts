import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { cleanBracket, D, fakeRun, goodState } from './basis-fixtures.ts'

/**
 * The DEFAULT basis port builds a client of its own (createSnapshotClient, mocked here so no database is touched) for each
 * transaction. In its own file: a module mock must be installed before the module under test is first loaded.
 */

// [mutation: the client is not disconnected / is the application's / the mode is not verified]
test('the default basis port builds a client of its own for each transaction, proves its mode, and always disconnects it - even when the read fails', async () => {
  const state = goodState()
  const made: Array<{ disconnects: number; transactions: number }> = []
  let mode = { isolation: 'repeatable read', readOnly: 'on', timeout: '20s' }
  let failInside = false
  mock.module('@/lib/reconciliation-pack/invariant-snapshot', {
    namedExports: {
      createSnapshotClient: () => {
        const record = { disconnects: 0, transactions: 0 }
        made.push(record)
        return {
          $disconnect: async () => { record.disconnects += 1 },
          $transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
            record.transactions += 1
            const fake = fakeRun(state)
            return fake.run(async (strict) => {
              const tx = new Proxy({}, { get: (_t, p) => (p === '$executeRawUnsafe' ? async () => 0 : p === '$queryRawUnsafe' ? async () => [mode] : failInside && p === 'setting' ? { findMany: async () => { throw new Error('boom') } } : (strict as never)[p]) })
              return cb(tx)
            })
          },
        }
      },
    },
  })
  const { ownClientBasisPort } = await import('@/lib/reconciliation-pack/default-ports')
  const basis = ownClientBasisPort()
  const settled = await basis.settle(await basis.read(D), cleanBracket())
  assert.equal(settled.available, true, JSON.stringify(settled))
  assert.equal(made.length, 2, 'a client for the read and another for the settle')
  assert.deepEqual(made.map((m) => [m.transactions, m.disconnects]), [[1, 1], [1, 1]])

  failInside = true
  const failed = await basis.read(D)
  assert.equal(failed.resolved, null, 'a failing read is an unreadable read')
  assert.equal(made.at(-1)!.disconnects, 1, 'disconnected after a failure too')
  failInside = false

  mode = { isolation: 'read committed', readOnly: 'on', timeout: '20s' }
  const wrongMode = await basis.read(D)
  assert.equal(wrongMode.resolved, null, 'a transaction that is not repeatable read is never read in')
  mode = { isolation: 'repeatable read', readOnly: 'off', timeout: '20s' }
  assert.equal((await basis.read(D)).resolved, null, 'nor one that is not read only')
  assert.ok(made.every((m) => m.disconnects === m.transactions))
  mock.reset()
})
