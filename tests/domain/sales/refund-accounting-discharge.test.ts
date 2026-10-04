import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma } from '@/app/generated/prisma/client'
import {
  dischargeRefundAccountingObligation,
  refundReversalDecidedNeverToPost,
} from '@/lib/domain/sales/refund-accounting-discharge'
import type { RefundAccountingObligation, RefundAccountingSettlement } from '@/lib/domain/sales/refund-accounting-obligations'

/**
 * o3d-fj4m - THE DISCHARGE IS ONE STATEMENT, AND IT WRITES DOWN RELIEF ONLY FOR A REVERSAL THAT WILL
 * NEVER EXIST.
 *
 * The statement shape is what is under test here (the behaviour end to end is
 * tests/concurrency/refund-relief-never-queued.concurrent.test.ts): the flag, the warning, the staged
 * record and - conditionally - the relief go in ONE update, because clearing the flag first and zeroing
 * afterwards leaves a window in which the refund no longer blocks the next one and its relief stands.
 */

const unearned = (refundId: string): RefundAccountingObligation => ({ type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: refundId })
const none: RefundAccountingSettlement = { decidedNeverToPost: [], pinnedConnector: 'xero' }
const never = (refundId: string): RefundAccountingSettlement => ({ decidedNeverToPost: [unearned(refundId)], pinnedConnector: 'xero' })

type Row = { id: string; connector: string; status: string; externalTransactionId: string | null; abandonedBeforeRemoteCall: boolean | null; settlementBasis: string | null }

function recorder(rows: Row[] = []) {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = []
  const locks: unknown[][] = []
  const tx = {
    $executeRaw: async (...args: unknown[]) => { locks.push(args); return 0 },
    accountingSyncLog: { findMany: async () => rows },
    salesOrderRefund: { update: async (args: { where: unknown; data: Record<string, unknown> }) => { updates.push(args); return {} } },
  }
  const client = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) }
  return { client: client as unknown as Parameters<typeof dischargeRefundAccountingObligation>[0], updates, locks }
}
const row = (over: Partial<Row>): Row => ({ id: 'row-1', connector: 'xero', status: 'PENDING', externalTransactionId: null, abandonedBeforeRemoteCall: null, settlementBasis: null, ...over })

test('o3d-fj4m: a reversal decided never to post is discharged with relief 0 in the SAME single update', async () => {
  const { client, updates } = recorder()
  const result = await dischargeRefundAccountingObligation(client, 'r1', never('r1'))
  assert.deepEqual(result, { discharged: true, reliefWrittenDown: true })
  console.log(`o3d-fj4m discharge (never-post): updates=${updates.length} data=${JSON.stringify(updates[0]?.data)}`)
  assert.equal(updates.length, 1, 'ONE statement, not a clear followed by a zeroing')
  assert.equal(updates[0].data.accountingRetryRequired, false)
  assert.equal(updates[0].data.accountingWarning, null)
  assert.equal(updates[0].data.accountingRetrySyncs, Prisma.DbNull)
  assert.equal(updates[0].data.allocatedReliefAmount, 0, 'the relief recorded for a journal that will never exist is written down')
})

test('o3d-fj4m: a QUEUED reversal leaves the relief untouched (the control: the key is absent, not 0)', async () => {
  const { client, updates } = recorder()
  await dischargeRefundAccountingObligation(client, 'r1', none)
  console.log(`o3d-fj4m discharge (queued): updates=${updates.length} keys=${Object.keys(updates[0]?.data ?? {}).join(',')}`)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].data.accountingRetryRequired, false)
  assert.equal('allocatedReliefAmount' in updates[0].data, false, 'the journal exists, so what staging recorded is resolved against it by the next refund')
})

test('o3d-fj4m: only THIS refund\'s UNEARNED_REV_REVERSAL counts (isolating: another refund, another type)', () => {
  assert.equal(refundReversalDecidedNeverToPost('r1', { decidedNeverToPost: [unearned('r1')], pinnedConnector: 'xero' }), true)
  assert.equal(refundReversalDecidedNeverToPost('r1', { decidedNeverToPost: [unearned('r2')], pinnedConnector: 'xero' }), false, 'another refund\'s decision says nothing about this one')
  assert.equal(
    refundReversalDecidedNeverToPost('r1', { decidedNeverToPost: [{ type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: 'r1' }], pinnedConnector: 'xero' }),
    false,
    'a COGS or credit-note decision does not touch the allocation relief',
  )
  assert.equal(
    refundReversalDecidedNeverToPost('r1', { decidedNeverToPost: [{ type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrder', referenceId: 'r1' }], pinnedConnector: 'xero' }),
    false,
    'an order-scoped row is not this refund\'s journal',
  )
})

/* The crash gap (Codex HIGH on #733): the reversal was queued or posted, the process died before the
 * discharge, sync was switched off, the retry settles it as "will never post". Each standing below is
 * one arm; the precondition (the standing the module reports) is asserted and printed per arm. */
const STANDING_ARMS: Array<{ name: string; row: Row; standing: string; zeroes: boolean; discharges?: boolean }> = [
  { name: 'LIVE_WORK', row: row({ status: 'PENDING' }), standing: 'LIVE_WORK', zeroes: false },
  { name: 'CONFIRMED_POSTED', row: row({ status: 'SYNCED', externalTransactionId: 'JNL-1' }), standing: 'CONFIRMED_POSTED', zeroes: false, discharges: true },
  { name: 'ASSERTED_POSTED', row: row({ status: 'SYNCED', externalTransactionId: 'TYPED', settlementBasis: 'OPERATOR_ASSERTION' }), standing: 'ASSERTED_POSTED', zeroes: false },
  { name: 'ASSERTED_NOT_POSTED', row: row({ status: 'CANCELLED', settlementBasis: 'OPERATOR_ASSERTION' }), standing: 'ASSERTED_NOT_POSTED', zeroes: false },
  { name: 'UNKNOWN (FAILED, no id)', row: row({ status: 'FAILED' }), standing: 'UNKNOWN', zeroes: false },
  { name: 'PROVEN_NOT_POSTED', row: row({ status: 'CANCELLED', abandonedBeforeRemoteCall: true }), standing: 'PROVEN_NOT_POSTED', zeroes: true },
]
for (const arm of STANDING_ARMS) {
  test(`o3d-fj4m crash gap: a prior attempt standing ${arm.name} ${arm.zeroes ? 'still lets the relief be written down' : arm.discharges ? 'DISCHARGES the obligation and PRESERVES the relief' : 'KEEPS the relief and leaves the obligation unresolved'}`, async () => {
    const { ledgerStanding } = await import('@/lib/domain/accounting/ledger-standing')
    assert.equal(ledgerStanding(arm.row), arm.standing, 'PRECONDITION: the fixture has the standing the arm names')
    const { client, updates, locks } = recorder([arm.row])
    const result = await dischargeRefundAccountingObligation(client, 'r1', never('r1'))
    console.log(`o3d-fj4m crash-gap ${arm.name}: result=${JSON.stringify(result).slice(0, 80)} updates=${updates.length} lockStatements=${locks.length}`)
    assert.ok(locks.length >= 1, 'the follow-up scope lock is taken before the read')
    if (arm.zeroes) {
      assert.deepEqual(result, { discharged: true, reliefWrittenDown: true })
      assert.equal(updates[0].data.allocatedReliefAmount, 0)
    } else if (arm.discharges) {
      assert.deepEqual(result, { discharged: true, reliefWrittenDown: false })
      assert.equal(updates[0].data.accountingRetryRequired, false, 'the journal posted, so the flag and record come down')
      assert.equal('allocatedReliefAmount' in updates[0].data, false, 'and the relief is never zeroed')
    } else {
      assert.equal(result.discharged, false)
      assert.equal(updates.length, 0, 'nothing is written: the flag stays, the relief stays')
    }
  })
}

test('o3d-fj4m crash gap: a CONFIRMED_POSTED row beside a PROVEN_NOT_POSTED one discharges and preserves the relief (mixed)', async () => {
  const { client, updates } = recorder([row({ id: 'a', status: 'CANCELLED', abandonedBeforeRemoteCall: true }), row({ id: 'b', status: 'SYNCED', externalTransactionId: 'J' })])
  const result = await dischargeRefundAccountingObligation(client, 'r1', never('r1'))
  assert.deepEqual(result, { discharged: true, reliefWrittenDown: false })
  assert.equal('allocatedReliefAmount' in updates[0].data, false)
})

test('o3d-fj4m crash gap: ONE unproven attempt among settled ones is enough to stay unresolved (isolating)', async () => {
  const { client, updates } = recorder([row({ id: 'a', status: 'CANCELLED', abandonedBeforeRemoteCall: true }), row({ id: 'c', status: 'SYNCED', externalTransactionId: 'J' }), row({ id: 'b', status: 'FAILED' })])
  const result = await dischargeRefundAccountingObligation(client, 'r1', never('r1'))
  assert.equal(result.discharged, false)
  assert.equal(updates.length, 0)
})

test('o3d-fj4m crash gap: the check applies only to a decided-never reversal (a queued one is discharged normally even with a live row)', async () => {
  const { client, updates } = recorder([row({ status: 'PENDING' })])
  const result = await dischargeRefundAccountingObligation(client, 'r1', none)
  assert.deepEqual(result, { discharged: true, reliefWrittenDown: false })
  assert.equal('allocatedReliefAmount' in updates[0].data, false)
})
