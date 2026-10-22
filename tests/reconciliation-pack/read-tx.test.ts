import assert from 'node:assert/strict'
import test from 'node:test'

import { PACK_READ_STATEMENT_TIMEOUT_MS, ReadTxModeError, withReadOnlySnapshot, type ReadTx } from '../../lib/reconciliation-pack/read-tx.ts'

/** The read transaction: asked for READ ONLY REPEATABLE READ with a timeout, and asked what it got before the first read. */

function client(mode: { isolation: string; readOnly: string; timeout?: string } | 'none', log: string[] = [], optionsSeen: unknown[] = []) {
  const tx: ReadTx = {
    $executeRawUnsafe: async (query) => { log.push(query); return 0 },
    $queryRawUnsafe: (async (query: string) => { log.push(query.slice(0, 30)); return mode === 'none' ? [] : [{ timeout: '20s', ...mode }] }) as never,
  }
  return { $transaction: async (fn: (tx: never) => Promise<unknown>, options?: unknown) => { optionsSeen.push(options); return fn(tx as never) } } as never
}

test('asks for read only and the statement timeout first, reads the mode back, then runs the caller', async () => {
  const log: string[] = []
  const seen: unknown[] = []
  const result = await withReadOnlySnapshot(async () => { log.push('BODY'); return 7 }, { client: client({ isolation: 'repeatable read', readOnly: 'on' }, log, seen), isolationLevel: 'RepeatableRead' })
  assert.equal(result, 7)
  assert.deepEqual(log, ['SET TRANSACTION READ ONLY', `SET LOCAL statement_timeout = ${PACK_READ_STATEMENT_TIMEOUT_MS}`, `SELECT current_setting('transa`, 'BODY'])
  assert.deepEqual((seen[0] as { isolationLevel: string }).isolationLevel, 'RepeatableRead')
})

// [mutation: the mode check removed]
test('a transaction that is not repeatable read, not read only, or that cannot say, runs NOTHING', async () => {
  for (const mode of [
    { isolation: 'read committed', readOnly: 'on' },
    { isolation: 'serializable', readOnly: 'on' },
    { isolation: 'repeatable read', readOnly: 'off' },
    { isolation: 'repeatable read', readOnly: 'on', timeout: '0' },
    'none',
  ] as const) {
    let ran = false
    await assert.rejects(withReadOnlySnapshot(async () => { ran = true }, { client: client(mode), isolationLevel: 'RepeatableRead' }), ReadTxModeError)
    assert.equal(ran, false, JSON.stringify(mode))
  }
})

test('a bad statement timeout is refused before a transaction opens', async () => {
  for (const statementTimeoutMs of [0, -1, Number.NaN, 0.4]) {
    let opened = false
    const spy = { $transaction: async () => { opened = true } } as never
    await assert.rejects(withReadOnlySnapshot(async () => 1, { client: spy, statementTimeoutMs, isolationLevel: 'RepeatableRead' }), ReadTxModeError)
    assert.equal(opened, false)
  }
})
