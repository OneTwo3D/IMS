import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCogsReconciliationSweepJournal,
  sumCogsSubledgerMovement,
  type CogsGlReconciliationResult,
} from '@/lib/domain/accounting/cogs-gl-reconciliation'
import { evaluateAccountGlReconciliation } from '@/lib/domain/accounting/account-gl-reconciliation'

type AggregateCall = { where: { [k: string]: { gt: Date; lte: Date } } }

/** Minimal stand-in for the Prisma client surface sumCogsSubledgerMovement uses. */
function mockClient(dispatchSum: number | null, refundSum: number | null) {
  const calls: { shipment?: AggregateCall; salesOrderRefund?: AggregateCall } = {}
  return {
    calls,
    client: {
      shipment: {
        aggregate: async (args: AggregateCall) => {
          calls.shipment = args
          return { _sum: { cogsBatchAmount: dispatchSum } }
        },
      },
      salesOrderRefund: {
        aggregate: async (args: AggregateCall) => {
          calls.salesOrderRefund = args
          return { _sum: { cogsReversalBase: refundSum } }
        },
      },
    } as never,
  }
}

const W_START = new Date('2026-06-19T00:00:00.000Z')
const W_END = new Date('2026-06-20T00:00:00.000Z')

test('subledger movement nets refund reversals out of dispatch COGS', async () => {
  const { client } = mockClient(1000.5, 12.25)
  assert.equal(await sumCogsSubledgerMovement(W_START, W_END, client), 988.25)
})

test('dispatch-only window equals the dispatch sum', async () => {
  const { client } = mockClient(742.123456, null)
  assert.equal(await sumCogsSubledgerMovement(W_START, W_END, client), 742.123456)
})

test('empty window (both null) is zero, not NaN', async () => {
  const { client } = mockClient(null, null)
  assert.equal(await sumCogsSubledgerMovement(W_START, W_END, client), 0)
})

test('a net-reversal window (refunds exceed dispatch) is negative', async () => {
  const { client } = mockClient(50, 130) // a quiet day dominated by a large refund
  assert.equal(await sumCogsSubledgerMovement(W_START, W_END, client), -80)
})

test('both sides are windowed half-open on the same GL date dimension', async () => {
  const { calls, client } = mockClient(0, 0)
  await sumCogsSubledgerMovement(W_START, W_END, client)
  assert.deepEqual(calls.shipment?.where.shipmentJournalDate, { gt: W_START, lte: W_END })
  assert.deepEqual(calls.salesOrderRefund?.where.cogsReversalJournalDate, { gt: W_START, lte: W_END })
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
