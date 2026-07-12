import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCogsReconciliationSweepJournal,
  sumCogsSubledgerMovement,
  type CogsGlReconciliationResult,
} from '@/lib/domain/accounting/cogs-gl-reconciliation'
import { evaluateAccountGlReconciliation } from '@/lib/domain/accounting/account-gl-reconciliation'

type AggregateCall = { where: { [k: string]: { gt: Date; lte: Date } } }

/** Minimal stand-in for the Prisma client surface sumCogsSubledgerMovement uses.
 *  `ledgerSum` = Σ signed ledger delta (dispatch positive, refund reversals
 *  negative, revaluation/landed-cost signed). */
function mockClient(ledgerSum: number | null) {
  const calls: { cogsSubledgerMovement?: AggregateCall } = {}
  return {
    calls,
    client: {
      cogsSubledgerMovement: {
        aggregate: async (args: AggregateCall) => {
          calls.cogsSubledgerMovement = args
          return { _sum: { baseDelta: ledgerSum } }
        },
      },
    } as never,
  }
}

const W_START = new Date('2026-06-19T00:00:00.000Z')
const W_END = new Date('2026-06-20T00:00:00.000Z')

test('subledger movement is the signed ledger total (dispatch + reversals netted)', async () => {
  // e.g. 1000.50 dispatch + (-12.25) refund reversal already summed in the ledger.
  const { client } = mockClient(988.25)
  assert.equal(await sumCogsSubledgerMovement(W_START, W_END, client), 988.25)
})

test('empty window (null ledger sum) is zero, not NaN', async () => {
  const { client } = mockClient(null)
  assert.equal(await sumCogsSubledgerMovement(W_START, W_END, client), 0)
})

test('a net-reversal window (ledger credits exceed dispatch) is negative', async () => {
  const { client } = mockClient(-80)
  assert.equal(await sumCogsSubledgerMovement(W_START, W_END, client), -80)
})

test('the ledger is windowed half-open on the GL date dimension', async () => {
  const { calls, client } = mockClient(0)
  await sumCogsSubledgerMovement(W_START, W_END, client)
  assert.deepEqual(calls.cogsSubledgerMovement?.where.journalDate, { gt: W_START, lte: W_END })
})

function availableResult(subledgerValue: number, glBalance: number): CogsGlReconciliationResult {
  return { available: true, balanceDate: '2026-06-20', ...evaluateAccountGlReconciliation({ subledgerValue, glBalance }) }
}

const COGS_SWEEP = { cogsAccount: '5000', roundingAccount: '7999', currency: 'GBP' }

test('COGS sweep journal: subledger above GL → DR COGS / CR Rounding, balanced', () => {
  const journal = buildCogsReconciliationSweepJournal(availableResult(1000.47, 1000.0), COGS_SWEEP)
  assert.ok(journal)
  assert.deepEqual(journal.lines, [
    { accountCode: '5000', description: 'COGS subledger reconciliation 2026-06-20', debit: 0.47 },
    { accountCode: '7999', description: 'COGS subledger reconciliation 2026-06-20', credit: 0.47 },
  ])
})

test('COGS sweep journal: material gap flags (no journal); unavailable produces none', () => {
  assert.equal(buildCogsReconciliationSweepJournal(availableResult(1050, 1000), COGS_SWEEP), null)
  assert.equal(
    buildCogsReconciliationSweepJournal({ available: false, reason: 'no_opening_snapshot' }, COGS_SWEEP),
    null,
  )
})
