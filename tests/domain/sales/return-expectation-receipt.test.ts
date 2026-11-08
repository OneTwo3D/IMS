import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { Prisma } from '../../../app/generated/prisma/client'

/**
 * ARRIVAL CLEARING: the pure planning (which lines an arrival clears, at what cost) and the ledger leg
 * (the journal and the sub-ledger row, the fail-closed refusals) over a transaction double.
 */

const queued: Array<Record<string, unknown>> = []
const subledger: Array<Record<string, unknown>> = []
let enqueueAnswer: { queued: boolean; reason?: string } = { queued: true }
let accounts = { inventoryAccount: '630', transitAccount: '840' }

mock.module('@/lib/accounting', {
  namedExports: {
    getAccountingSettingsFor: async () => ({ syncEnabled: true }),
    getActiveAccountingConnectorId: async () => 'xero',
    readStockReceiptAccountsTx: async () => accounts,
    queueAccountingSyncTxWithOutcome: async (_tx: unknown, params: Record<string, unknown>) => {
      queued.push(params)
      return enqueueAnswer
    },
  },
})
mock.module('@/lib/integration-plugin-selection-lock', { namedExports: { lockAccountingMappingSelection: async () => {} } })
mock.module('@/lib/domain/accounting/transit-subledger-movement', {
  namedExports: { recordTransitSubledgerMovement: async (_tx: unknown, input: Record<string, unknown>) => { subledger.push(input) } },
})

const mod = import('../../../lib/domain/sales/return-expectation-receipt')

const entry = (qty: string, unitCostBase: string | null) => ({ qty, unitCostBase, poLineId: null, sourceCostLayerId: null })
const candidate = (id: string, qty: string, received: string, snapshot: unknown[], expectationId = `e-${id}`) => ({
  lineId: id, expectationId, qty, qtyReceived: received, qtyWrittenOff: '0', costSnapshot: snapshot,
})

test('the oldest line is cleared first, a short arrival leaves the next line untouched', async () => {
  const { planReturnReceipt } = await mod
  const plan = planReturnReceipt(3, [
    candidate('a', '2', '0', [entry('2', '10')]),
    candidate('b', '5', '0', [entry('5', '20')]),
  ])
  assert.deepEqual(plan.chunks.map((chunk) => [chunk.lineId, chunk.qty.toFixed(6), chunk.valueBase.toFixed(6)]), [
    ['a', '2.000000', '20.000000'],
    ['b', '1.000000', '20.000000'],
  ])
  assert.equal(plan.remainder.toFixed(6), '0.000000')
})

test('an over-return leaves a remainder for the plain restock, and nothing outstanding matches nothing', async () => {
  const { planReturnReceipt } = await mod
  const over = planReturnReceipt(5, [candidate('a', '2', '0', [entry('2', '10')])])
  assert.equal(over.remainder.toFixed(6), '3.000000')
  assert.equal(over.chunks.length, 1)
  const none = planReturnReceipt(2, [candidate('a', '2', '2', [entry('2', '10')])])
  assert.equal(none.chunks.length, 0)
  assert.equal(none.remainder.toFixed(6), '2.000000')
})

test('a part-arrival takes the first units cost, the next arrival the next, and the pieces add to the line value exactly', async () => {
  const { planReturnReceipt } = await mod
  const snapshot = [entry('1', '10'), entry('2', '11.333333')]
  const first = planReturnReceipt(2, [candidate('a', '3', '0', snapshot)])
  assert.deepEqual(first.chunks[0].entries.map((e) => [e.qty, e.unitCostBase]), [['1.000000', '10'], ['1.000000', '11.333333']])
  const second = planReturnReceipt(1, [candidate('a', '3', '2', snapshot)])
  assert.deepEqual(second.chunks[0].entries.map((e) => [e.qty, e.unitCostBase]), [['1.000000', '11.333333']])
  const total = first.chunks[0].valueBase.add(second.chunks[0].valueBase)
  assert.equal(total.toFixed(6), '32.666666')
})

test('a cost-less entry carries no value and still comes back as a row', async () => {
  const { planReturnReceipt } = await mod
  const plan = planReturnReceipt(2, [candidate('a', '2', '0', [entry('1', null), entry('1', '4')])])
  assert.equal(plan.chunks[0].valueBase.toFixed(6), '4.000000')
  assert.equal(plan.chunks[0].entries.length, 2)
})

test('an unreadable snapshot is refused, never read as free stock', async () => {
  const { planReturnReceipt } = await mod
  assert.throws(() => planReturnReceipt(1, [candidate('a', '1', '0', 'nope' as unknown as unknown[])]), /snapshot_unreadable/)
})

type Line = { id: string; expectation_id: string; qty: Prisma.Decimal; qty_received: Prisma.Decimal; qty_written_off: Prisma.Decimal; cost_snapshot: unknown[] }

function fakeTx(lines: Line[], expectation: { transitJournalKey: string | null }) {
  const updates: Array<Record<string, unknown>> = []
  const logs: Array<Record<string, unknown>> = []
  const tx = {
    $queryRaw: async () => lines.map((l) => ({ line_id: l.id, expectation_id: l.expectation_id, qty: l.qty, qty_received: l.qty_received, qty_written_off: l.qty_written_off, cost_snapshot: l.cost_snapshot })),
    returnExpectationLine: { update: async (args: Record<string, unknown>) => { updates.push(args) } },
    returnExpectation: {
      findUniqueOrThrow: async () => ({
        id: 'e-1', reference: 'RX-CN-1', refundId: 'r-1', transitJournalKey: expectation.transitJournalKey,
        lines: lines.map((l) => ({ qty: l.qty, qtyReceived: l.qty_received.add(1), qtyWrittenOff: l.qty_written_off })),
      }),
      update: async (args: Record<string, unknown>) => { updates.push(args) },
    },
    activityLog: { create: async (args: Record<string, unknown>) => { logs.push(args) } },
  }
  return { tx: tx as unknown as Prisma.TransactionClient, updates, logs }
}

const oneLine = (): Line[] => [{ id: 'l-1', expectation_id: 'e-1', qty: new Prisma.Decimal(1), qty_received: new Prisma.Decimal(0), qty_written_off: new Prisma.Decimal(0), cost_snapshot: [entry('1', '12.5')] }]
const params = (accounting: { connector: 'xero' | null; syncEnabled: boolean }) => ({
  inboxId: 'in-1', orderId: 'o-1', productId: 'p-1', qty: 1, arrivedAt: new Date('2026-11-03T10:00:00Z'), accounting,
})

test('arrival queues DR Inventory / CR Stock in Transit dated the arrival, and records the negative transit row on the queue answer', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0; enqueueAnswer = { queued: true }
  const { tx } = fakeTx(oneLine(), { transitJournalKey: 'k' })
  const result = await receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true }))
  assert.equal(result.rows.length, 1)
  assert.equal(queued.length, 1)
  const payload = queued[0].payload as { date: string; lines: Array<{ accountCode: string; debit?: number; credit?: number }> }
  assert.equal(queued[0].type, 'STOCK_RECEIPT')
  assert.equal(payload.date, '2026-11-03')
  assert.deepEqual(payload.lines.map((l) => [l.accountCode, l.debit ?? null, l.credit ?? null]), [['630', 12.5, null], ['840', null, 12.5]])
  assert.equal(subledger.length, 1)
  assert.equal(subledger[0].sourceType, 'CUSTOMER_RETURN_IN_TRANSIT')
  assert.equal(subledger[0].sourceRef, 'r-1')
  assert.equal(String(subledger[0].baseDelta), '-12.5')
  assert.equal(subledger[0].idempotencyKey, queued[0].idempotencyKey, 'journal and sub-ledger share one key')
})

test('a shadowed journal writes no sub-ledger row and does not refuse', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0; enqueueAnswer = { queued: false, reason: 'shadowed' }
  const { tx } = fakeTx(oneLine(), { transitJournalKey: 'k' })
  await receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true }))
  assert.equal(subledger.length, 0)
})

test('a refused journal rolls the arrival back (the throw), and a missing account fails closed before queueing', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0; enqueueAnswer = { queued: false, reason: 'refused' }
  await assert.rejects(() => receiveReturnAgainstExpectationsTx(fakeTx(oneLine(), { transitJournalKey: 'k' }).tx, params({ connector: 'xero', syncEnabled: true })), /arrival_journal_refused/)
  assert.equal(subledger.length, 0)

  queued.length = 0; accounts = { inventoryAccount: '630', transitAccount: '' }
  await assert.rejects(() => receiveReturnAgainstExpectationsTx(fakeTx(oneLine(), { transitJournalKey: 'k' }).tx, params({ connector: 'xero', syncEnabled: true })), /arrival_accounts_not_configured/)
  assert.equal(queued.length, 0)
  accounts = { inventoryAccount: '630', transitAccount: '840' }
})

test('a refund that never debited transit (no journal key) clears no ledger value; accounting off warns without queueing', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0; enqueueAnswer = { queued: true }
  await receiveReturnAgainstExpectationsTx(fakeTx(oneLine(), { transitJournalKey: null }).tx, params({ connector: 'xero', syncEnabled: true }))
  assert.equal(queued.length, 0)
  const off = fakeTx(oneLine(), { transitJournalKey: 'k' })
  await receiveReturnAgainstExpectationsTx(off.tx, params({ connector: null, syncEnabled: false }))
  assert.equal(queued.length, 0)
  assert.equal(off.logs.length, 1)
  assert.equal((off.logs[0].data as { action: string }).action, 'return_expectation_arrival_not_journalled')
})
