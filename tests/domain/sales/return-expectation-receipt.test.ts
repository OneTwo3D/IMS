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
const candidate = (id: string, qty: string, received: string, snapshot: unknown[], expectationId = `e-${id}`, valued = true) => ({
  lineId: id, expectationId, qty, qtyReceived: received, qtyWrittenOff: '0', costSnapshot: snapshot, valued,
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

type Line = { id: string; expectation_id: string; qty: Prisma.Decimal; qty_received: Prisma.Decimal; qty_written_off: Prisma.Decimal; cost_snapshot: unknown[]; valued?: boolean }

type SyncRow = { status: string; connector: string; externalTransactionId?: string | null; abandonedBeforeRemoteCall?: boolean | null; settlementBasis?: string | null } | null
function fakeTx(
  lines: Line[],
  expectation: { transitJournalKey: string | null; transitDebitBase?: string; syncRow?: SyncRow; retryRequired?: boolean },
) {
  const cleared = { value: new Prisma.Decimal(0) }
  const syncRow: { current: SyncRow } = { current: expectation.syncRow === undefined ? { status: 'SYNCED', connector: 'xero' } : expectation.syncRow }
  const updates: Array<Record<string, unknown>> = []
  const logs: Array<Record<string, unknown>> = []
  const open = () => lines.filter((l) => l.qty.gt(l.qty_received.add(l.qty_written_off)))
  const tx = {
    $queryRaw: async () => open().map((l) => ({ line_id: l.id, expectation_id: l.expectation_id, qty: l.qty, qty_received: l.qty_received, qty_written_off: l.qty_written_off, cost_snapshot: l.cost_snapshot, valued: l.valued ?? true })),
    returnExpectationLine: {
      update: async (args: { where: { id: string }; data: { qtyReceived: { increment: string } } }) => {
        updates.push(args)
        const line = lines.find((l) => l.id === args.where.id)!
        line.qty_received = line.qty_received.add(args.data.qtyReceived.increment)
      },
    },
    returnExpectation: {
      findUniqueOrThrow: async () => ({
        id: 'e-1', reference: 'RX-CN-1', refundId: 'r-1', transitJournalKey: expectation.transitJournalKey,
        transitDebitBase: new Prisma.Decimal(expectation.transitDebitBase ?? '12.5'),
        transitClearedAmount: cleared.value,
        refund: { accountingRetryRequired: expectation.retryRequired ?? false },
        lines: lines.map((l) => ({ id: l.id, qty: l.qty, qtyReceived: l.qty_received, qtyWrittenOff: l.qty_written_off, costSnapshot: l.cost_snapshot })),
      }),
      update: async (args: { data?: { transitClearedAmount?: { increment: string } } }) => {
        updates.push(args)
        if (args.data?.transitClearedAmount) cleared.value = cleared.value.add(args.data.transitClearedAmount.increment)
      },
    },
    accountingSyncLog: { findFirst: async () => (syncRow.current ? { externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null, ...syncRow.current } : null) },
    transitSubledgerMovement: {
      aggregate: async () => ({
        _sum: { baseDelta: subledger.reduce((sum, r) => sum.add(r.baseDelta as Prisma.Decimal), new Prisma.Decimal(0)) },
      }),
    },
    activityLog: { create: async (args: Record<string, unknown>) => { logs.push(args) } },
  }
  return { tx: tx as unknown as Prisma.TransactionClient, updates, logs, syncRow, cleared }
}

const oneLine = (): Line[] => [{ id: 'l-1', expectation_id: 'e-1', qty: new Prisma.Decimal(1), qty_received: new Prisma.Decimal(0), qty_written_off: new Prisma.Decimal(0), cost_snapshot: [entry('1', '12.5')] }]
const params = (accounting: { connector: 'xero' | null; syncEnabled: boolean }, qty = 1) => ({
  inboxId: 'in-1', orderId: 'o-1', productId: 'p-1', qty, arrivedAt: new Date('2026-11-03T10:00:00Z'), accounting,
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

test('a refund that never debited transit (no journal key, no retry owed) clears no ledger value; stock only', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0; enqueueAnswer = { queued: true }
  const result = await receiveReturnAgainstExpectationsTx(fakeTx(oneLine(), { transitJournalKey: null }).tx, params({ connector: 'xero', syncEnabled: true }))
  assert.equal(queued.length, 0)
  assert.equal(result.expectationIds.length, 1)
})

test('accounting off while the refund DID queue a transit debit: the arrival is HELD with no stock, then clears once with GL equal to the sub-ledger', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0; enqueueAnswer = { queued: true }
  const lines: Line[] = [{ id: 'l-1', expectation_id: 'e-1', qty: new Prisma.Decimal(2), qty_received: new Prisma.Decimal(0), qty_written_off: new Prisma.Decimal(0), cost_snapshot: [entry('2', '5')] }]
  const { tx, updates } = fakeTx(lines, { transitJournalKey: 'k', transitDebitBase: '10' })
  await assert.rejects(() => receiveReturnAgainstExpectationsTx(tx, params({ connector: null, syncEnabled: false })), /awaiting_accounting/)
  assert.equal(updates.length, 0)
  assert.equal(lines[0].qty_received.toFixed(0), '0', 'no quantity advanced without its journal')
  await receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true }))
  await receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true }))
  const gl = queued.reduce((sum, q) => sum + ((q.payload as { lines: Array<{ debit?: number }> }).lines[0].debit ?? 0), 0)
  const sub = subledger.reduce((sum, r) => sum.add(r.baseDelta as Prisma.Decimal), new Prisma.Decimal(0))
  assert.equal(gl, 10)
  assert.equal(sub.toFixed(2), '-10.00', 'GL equals the sub-ledger')
})

test('connector switch: the debit sits in another ledger than the active one, so the arrival is HELD', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0
  const { tx } = fakeTx(oneLine(), { transitJournalKey: 'k', syncRow: { status: 'SYNCED', connector: 'quickbooks' } })
  await assert.rejects(() => receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true })), /awaiting_accounting/)
  assert.equal(queued.length, 0)
})

test('arrival before the refund journal is queued is HELD, then clears after it is', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0
  const f = fakeTx(oneLine(), { transitJournalKey: 'k', syncRow: null })
  await assert.rejects(() => receiveReturnAgainstExpectationsTx(f.tx, params({ connector: 'xero', syncEnabled: true })), /awaiting_refund_journal/)
  const owed = fakeTx(oneLine(), { transitJournalKey: null, retryRequired: true })
  await assert.rejects(() => receiveReturnAgainstExpectationsTx(owed.tx, params({ connector: 'xero', syncEnabled: true })), /awaiting_refund_journal/)
  f.syncRow.current = { status: 'PENDING', connector: 'xero' }
  await receiveReturnAgainstExpectationsTx(f.tx, params({ connector: 'xero', syncEnabled: true }))
  assert.equal(queued.length, 1)
})

test('an unproven refund debit (failed with no proof) is HELD for a person, not restocked and not cleared', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0
  const { tx } = fakeTx(oneLine(), { transitJournalKey: 'k', syncRow: { status: 'FAILED', connector: 'xero' } })
  await assert.rejects(() => receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true })), /awaiting_refund_journal/)
  assert.equal(queued.length, 0)
})

test('the refund debit was shadowed for good: stock comes back with no clearing journal, recorded, no sub-ledger row', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0
  const f = fakeTx(oneLine(), { transitJournalKey: 'k', syncRow: { status: 'CANCELLED', connector: 'xero', settlementBasis: 'HELD_SHADOW' } })
  const result = await receiveReturnAgainstExpectationsTx(f.tx, params({ connector: null, syncEnabled: false }))
  assert.equal(result.expectationIds.length, 1)
  assert.equal(queued.length, 0)
  assert.equal(subledger.length, 0)
  assert.equal((f.logs[0].data as { action: string }).action, 'return_expectation_arrival_debit_not_posted')
})

test('an arrival is HELD whole while the oldest open expectation that would take it is unvalued, and nothing falls through to a plain restock', async () => {
  const { planReturnReceipt, receiveReturnAgainstExpectationsTx } = await mod
  const plan = planReturnReceipt(2, [candidate('a', '1', '0', [entry('1', '5')], 'e-a', false), candidate('b', '5', '0', [entry('5', '9')], 'e-b', true)])
  assert.equal(plan.awaitingValuation, true, 'the older unvalued one wins over the newer valued one')
  assert.equal(plan.chunks.length, 0)
  // A valued older one clears first, and only then does the unvalued one hold the rest.
  const mixed = planReturnReceipt(3, [candidate('a', '1', '0', [entry('1', '5')], 'e-a', true), candidate('b', '5', '0', [entry('5', '9')], 'e-b', false)])
  assert.equal(mixed.awaitingValuation, true)
  // Quantity beyond ALL open expectations is the only plain remainder; an unvalued one that is not reached holds nothing.
  const beyond = planReturnReceipt(3, [candidate('a', '1', '0', [entry('1', '5')], 'e-a', true)])
  assert.equal(beyond.awaitingValuation, false)
  assert.equal(beyond.remainder.toFixed(6), '2.000000')

  queued.length = 0
  const lines = oneLine(); lines[0].valued = false
  const { tx, updates } = fakeTx(lines, { transitJournalKey: 'k' })
  await assert.rejects(() => receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true })), /awaiting_refund_valuation/)
  assert.equal(updates.length, 0, 'nothing written')
  assert.equal(queued.length, 0)
  // After valuation the same arrival clears once.
  lines[0].valued = true
  const result = await receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true }))
  assert.equal(result.expectationIds.length, 1)
  assert.equal(queued.length, 1)
})

test('three one-unit arrivals at 0.333333 clear 1.00 in total and the transit sub-ledger nets to zero with the refund row', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0; enqueueAnswer = { queued: true }
  const lines: Line[] = [{ id: 'l-1', expectation_id: 'e-1', qty: new Prisma.Decimal(3), qty_received: new Prisma.Decimal(0), qty_written_off: new Prisma.Decimal(0), cost_snapshot: [entry('3', '0.333333')] }]
  // The refund debited 0.999999 at 6dp, which its 2dp journal posted as 1.00.
  const { tx } = fakeTx(lines, { transitJournalKey: 'k', transitDebitBase: '0.999999' })
  const amounts: number[] = []
  for (let i = 0; i < 3; i += 1) {
    const before = queued.length
    await receiveReturnAgainstExpectationsTx(tx, { ...params({ connector: 'xero', syncEnabled: true }), inboxId: `in-${i}` })
    amounts.push(queued.length > before ? ((queued[queued.length - 1].payload as { lines: Array<{ debit?: number }> }).lines[0].debit ?? 0) : 0)
  }
  assert.deepEqual(amounts, [0.33, 0.34, 0.33], 'cumulative rounding: no cent is lost between arrivals')
  assert.equal(Number(amounts.reduce((a, b) => a + b, 0).toFixed(2)), 1)
  const net = subledger.reduce((sum, r) => sum.add(r.baseDelta as Prisma.Decimal), new Prisma.Decimal('0.999999'))
  assert.equal(net.toFixed(6), '0.000000')
})

test('an intermediate arrival too small to move a cent records its quantity and journals nothing, carrying the value forward', async () => {
  const { receiveReturnAgainstExpectationsTx } = await mod
  queued.length = 0; subledger.length = 0; enqueueAnswer = { queued: true }
  const lines: Line[] = [{ id: 'l-1', expectation_id: 'e-1', qty: new Prisma.Decimal(3), qty_received: new Prisma.Decimal(0), qty_written_off: new Prisma.Decimal(0), cost_snapshot: [entry('3', '0.004')] }]
  const { tx } = fakeTx(lines, { transitJournalKey: 'k', transitDebitBase: '0.012' })
  await receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true }))
  assert.equal(queued.length, 0)
  assert.equal(lines[0].qty_received.toFixed(0), '1', 'the quantity is recorded')
  await receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true }))
  await receiveReturnAgainstExpectationsTx(tx, params({ connector: 'xero', syncEnabled: true }))
  assert.equal(queued.length, 1)
  assert.equal((queued[0].payload as { lines: Array<{ debit?: number }> }).lines[0].debit, 0.01)
})
