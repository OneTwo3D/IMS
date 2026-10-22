import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import { runInvariantInOneSnapshot, type SnapshotClient, type SnapshotTx } from '@/lib/reconciliation-pack/invariant-snapshot'

/**
 * The invariant run's one-snapshot binding, with a fake client: the transaction is REPEATABLE READ and set READ ONLY before
 * anything else, the application's client is the transaction while the run reads, and the proof is withheld (null) when any
 * part of it is missing or different. The same binding against a real PostgreSQL is in
 * tests/concurrency/reconciliation-pack-snapshot.concurrent.test.ts.
 */

const holder = globalThis as unknown as { prisma?: unknown }
afterEach(() => { delete holder.prisma })

type Row = { isolation: string; read_only: string; snapshot: string }
function fake(rows: { start?: Row[] | unknown; end?: Row[] | unknown } = {}) {
  const log: string[] = []
  let proofReads = 0
  let options: unknown
  let disconnected = 0
  const ok: Row[] = [{ isolation: 'repeatable read', read_only: 'on', snapshot: '812:812:' }]
  const tx: SnapshotTx = {
    $executeRawUnsafe: async (sql) => { log.push(sql); return 0 },
    $queryRawUnsafe: async (sql) => { log.push(sql); proofReads += 1; return proofReads === 1 ? (rows.start ?? ok) : (rows.end ?? ok) },
  }
  const client: SnapshotClient = {
    $transaction: async (fn, opts) => { options = opts; return await fn(tx) as never },
    $disconnect: async () => { disconnected += 1 },
  }
  return { tx, client, log, options: () => options, disconnected: () => disconnected }
}

test('a clean binding: REPEATABLE READ, READ ONLY first, the application client IS the transaction, and the proof is attached', async () => {
  const f = fake()
  let seenDuringRun: unknown
  const evidence = await runInvariantInOneSnapshot(async () => { seenDuringRun = holder.prisma; return { ok: true, result: {} } }, { client: f.client, loadApplicationDb: async () => holder.prisma })
  assert.equal(seenDuringRun, f.tx)
  assert.equal(f.log[0], 'SET TRANSACTION READ ONLY')
  assert.equal((f.options() as { isolationLevel: unknown }).isolationLevel, Prisma.TransactionIsolationLevel.RepeatableRead)
  assert.deepEqual((evidence as Record<string, unknown>).snapshot, { isolation: 'repeatable read', readOnly: true, snapshot: '812:812:', boundToApplicationClient: true })
  assert.equal((evidence as Record<string, unknown>).ok, true)
  assert.equal(f.disconnected(), 1)
})

const WITHHELD: Array<{ name: string; start?: unknown; end?: unknown; loadApplicationDb?: () => Promise<unknown> }> = [
  { name: 'the application client is not the transaction (lib/db was loaded first)', loadApplicationDb: async () => ({ other: true }) },
  { name: 'the snapshot moved between start and end', end: [{ isolation: 'repeatable read', read_only: 'on', snapshot: '813:813:' }] },
  { name: 'read committed', start: [{ isolation: 'read committed', read_only: 'on', snapshot: '812:812:' }], end: [{ isolation: 'read committed', read_only: 'on', snapshot: '812:812:' }] },
  { name: 'not read-only', start: [{ isolation: 'repeatable read', read_only: 'off', snapshot: '812:812:' }], end: [{ isolation: 'repeatable read', read_only: 'off', snapshot: '812:812:' }] },
  { name: 'no proof row', start: [] },
  { name: 'two proof rows', end: [{ isolation: 'repeatable read', read_only: 'on', snapshot: '812:812:' }, { isolation: 'repeatable read', read_only: 'on', snapshot: '812:812:' }] },
  { name: 'an empty snapshot', start: [{ isolation: 'repeatable read', read_only: 'on', snapshot: '' }], end: [{ isolation: 'repeatable read', read_only: 'on', snapshot: '' }] },
  { name: 'a proof row that is not an object', start: [null] },
]

test('any missing or different part of the proof withholds it (snapshot: null), and the client is still closed', async () => {
  for (const c of WITHHELD) {
    const f = fake({ start: c.start, end: c.end })
    const evidence = await runInvariantInOneSnapshot(async () => ({ ok: true }), { client: f.client, loadApplicationDb: c.loadApplicationDb ?? (async () => holder.prisma) })
    assert.equal((evidence as Record<string, unknown>).snapshot, null, c.name)
    assert.equal(f.disconnected(), 1, c.name)
    delete holder.prisma
  }
})

test('an application client that already exists is a refusal before any transaction opens', async () => {
  const f = fake()
  holder.prisma = { existing: true }
  await assert.rejects(runInvariantInOneSnapshot(async () => ({ ok: true }), { client: f.client, loadApplicationDb: async () => holder.prisma }), /already exists/)
  assert.equal(f.options(), undefined)
})

test('a run that throws propagates, and the client is closed', async () => {
  const f = fake()
  await assert.rejects(runInvariantInOneSnapshot(async () => { throw new Error('report blew up') }, { client: f.client, loadApplicationDb: async () => holder.prisma }), /report blew up/)
  assert.equal(f.disconnected(), 1)
})
