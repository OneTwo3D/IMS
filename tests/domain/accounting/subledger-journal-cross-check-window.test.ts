import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * o3d-hqvrp.44 at the loader: the cross-check of a sub-ledger against the queued journals ignores nothing silently. FAILED and
 * cancelled journals are reported apart (their sub-ledger rows remain), a reclass queued before its row existed is out of the window,
 * a compacted journal is counted as unreadable, and a probable chart re-bind makes the comparison inconclusive, not a false warning.
 */
type Log = { type: string; status: string; createdAt: Date; payload: unknown; payloadAccountNets: unknown }
let logs: Log[] = []
let ledgerSum = 0
let ledgerCount = 0
let firstReclassRow: Date | null = null

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: { findMany: async ({ where }: { where: { status: { in: string[] } } }) => logs.filter((l) => where.status.in.includes(l.status)) },
      cogsSubledgerMovement: {
        findFirst: async () => (firstReclassRow ? { createdAt: firstReclassRow } : null),
        aggregate: async () => ({ _sum: { baseDelta: ledgerSum } }),
        count: async () => ledgerCount,
      },
      transitSubledgerMovement: { aggregate: async () => ({ _sum: { baseDelta: ledgerSum } }), count: async () => ledgerCount },
    },
  },
})

const NOW = new Date('2026-11-17T12:00:00.000Z')
const input = { accountCode: '500', openingExclusive: '2026-11-10', closingInclusive: '2026-11-17', logTypes: ['DAILY_BATCH_GROUP_B', 'MANUFACTURING_RECLASS'], ledgerSourceTypes: ['DISPATCH', 'MANUFACTURING_RECLASS'] }
const journal = (over: Partial<Log> & { debit?: number; code?: string; date?: string }): Log => ({
  type: 'DAILY_BATCH_GROUP_B', status: 'SYNCED', createdAt: NOW, payloadAccountNets: null,
  payload: { date: over.date ?? '2026-11-12', lines: [{ accountCode: over.code ?? '500', debit: over.debit ?? 10 }, { accountCode: '630', credit: over.debit ?? 10 }] },
  ...over,
})
const reset = () => { logs = []; ledgerSum = 0; ledgerCount = 0; firstReclassRow = null }
const run = async () => (await import('../../../lib/domain/accounting/subledger-journal-cross-check.ts')).crossCheckSubledgerAgainstQueuedJournals(input, 'cogs')

test('matching live journals and ledger rows agree', async () => {
  reset(); logs = [journal({ debit: 10 }), journal({ debit: 5 })]; ledgerSum = 15; ledgerCount = 2
  const r = await run()
  assert.equal(r.agrees, true)
  assert.equal(r.queuedNet, 15)
})

test('a FAILED or CANCELLED journal is not queued movement but its remaining sub-ledger row is not blamed on the sub-ledger', async () => {
  reset(); logs = [journal({ debit: 10 }), journal({ debit: 7, status: 'FAILED' }), journal({ debit: 3, status: 'CANCELLED' })]; ledgerSum = 20; ledgerCount = 3
  const r = await run()
  assert.equal(r.queuedNet, 10, 'only the live journal is queued movement')
  assert.equal(r.notLiveJournalCount, 2)
  assert.equal(r.notLiveNet, 10)
  assert.equal(r.agrees, true)
  // A real gap is still found: the sub-ledger is short of both.
  ledgerSum = 12
  assert.equal((await run()).agrees, false)
})

test('a reclass journal queued before its sub-ledger row existed is out of the window; one after it is compared', async () => {
  reset(); firstReclassRow = new Date('2026-11-15T00:00:00.000Z')
  logs = [journal({ type: 'MANUFACTURING_RECLASS', debit: 40, createdAt: new Date('2026-11-12T00:00:00.000Z') }), journal({ type: 'MANUFACTURING_RECLASS', debit: 6, createdAt: new Date('2026-11-16T00:00:00.000Z'), date: '2026-11-16' })]
  ledgerSum = 6; ledgerCount = 1
  const r = await run()
  assert.equal(r.preCutInJournalCount, 1)
  assert.equal(r.queuedNet, 6)
  assert.equal(r.agrees, true)
  // With no reclass row at all yet, no reclass journal can be compared.
  firstReclassRow = null; ledgerSum = 0; ledgerCount = 0
  const none = await run()
  assert.equal(none.preCutInJournalCount, 2)
  assert.equal(none.agrees, true)
})

test('a compacted journal (payload {}) is counted as unreadable and compacted, not skipped', async () => {
  reset(); logs = [journal({ debit: 10 }), { type: 'DAILY_BATCH_GROUP_B', status: 'SYNCED', createdAt: NOW, payload: {}, payloadAccountNets: { version: 1, accounts: { '500': { credit: 0, debit: 99 } } } }]
  ledgerSum = 10; ledgerCount = 1
  const r = await run()
  assert.equal(r.unreadableJournalCount, 1)
  assert.equal(r.compactedJournalCount, 1)
  assert.equal(r.agrees, false, 'a window with a journal that cannot be placed is not called agreeing')
})

test('journals that moved the account before it was re-bound make the comparison inconclusive, not a mismatch', async () => {
  reset(); logs = [journal({ debit: 10 }), journal({ debit: 8, code: '501' })]; ledgerSum = 18; ledgerCount = 2
  const r = await run()
  assert.equal(r.otherAccountJournalCount, 1)
  assert.equal(r.inconclusive, true)
  assert.equal(r.agrees, true)
})
