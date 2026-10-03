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
const none: RefundAccountingSettlement = { decidedNeverToPost: [] }

function recorder() {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = []
  const client = {
    salesOrderRefund: {
      update: async (args: { where: unknown; data: Record<string, unknown> }) => { updates.push(args); return {} },
    },
  }
  return { client: client as unknown as Parameters<typeof dischargeRefundAccountingObligation>[0], updates }
}

test('o3d-fj4m: a reversal decided never to post is discharged with relief 0 in the SAME single update', async () => {
  const { client, updates } = recorder()
  await dischargeRefundAccountingObligation(client, 'r1', { decidedNeverToPost: [unearned('r1')] })
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
  assert.equal(refundReversalDecidedNeverToPost('r1', { decidedNeverToPost: [unearned('r1')] }), true)
  assert.equal(refundReversalDecidedNeverToPost('r1', { decidedNeverToPost: [unearned('r2')] }), false, 'another refund\'s decision says nothing about this one')
  assert.equal(
    refundReversalDecidedNeverToPost('r1', { decidedNeverToPost: [{ type: 'COGS_REVERSAL', referenceType: 'SalesOrderRefund', referenceId: 'r1' }] }),
    false,
    'a COGS or credit-note decision does not touch the allocation relief',
  )
  assert.equal(
    refundReversalDecidedNeverToPost('r1', { decidedNeverToPost: [{ type: 'UNEARNED_REV_REVERSAL', referenceType: 'SalesOrder', referenceId: 'r1' }] }),
    false,
    'an order-scoped row is not this refund\'s journal',
  )
})
