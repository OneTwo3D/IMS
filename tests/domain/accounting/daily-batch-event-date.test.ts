import assert from 'node:assert/strict'
import test from 'node:test'

import {
  groupByPostingDate,
  lockBlocksRun,
  lockBlocksRunMessage,
  isOnOrBeforeLock,
  laterDay,
  lockedPeriodNarration,
  parseBatchDay,
  resolvePostingDate,
  utcDay,
  businessDay,
} from '@/lib/domain/accounting/daily-batch-event-date'
import { preBatchRefundedNetBase, revenueDeferralAmount, revenueDeferralGrossAmount, preBatchRefundAdjustments, preBatchRefundsNettedIntoStoredDeferral } from '@/lib/domain/accounting/daily-batch-discount-fence'

// ACC-H11: a daily-batch journal is dated by its EVENT, and an event in a locked period is never back-dated.
// ACC-H13: a refund entered before the first batch run is netted out of the deferral.

const NO_LOCK = { today: '2026-04-01', lockDate: null }

test('utcDay reads the UTC calendar day and refuses anything unreadable', () => {
  assert.equal(utcDay(new Date('2026-03-31T23:59:59.000Z')), '2026-03-31')
  assert.equal(utcDay('2026-03-31T23:30:00.000Z'), '2026-03-31')
  assert.equal(utcDay(null), null)
  assert.equal(utcDay(undefined), null)
  assert.equal(utcDay('not a date'), null)
})

test('parseBatchDay accepts only a real YYYY-MM-DD', () => {
  assert.equal(parseBatchDay('2026-03-31'), '2026-03-31')
  assert.equal(parseBatchDay(' 2026-03-31 '), '2026-03-31')
  assert.equal(parseBatchDay('2026-02-30'), null)
  assert.equal(parseBatchDay('31/03/2026'), null)
  assert.equal(parseBatchDay(''), null)
  assert.equal(parseBatchDay(undefined), null)
})

test('laterDay ignores nulls and returns null only when there is nothing', () => {
  assert.equal(laterDay('2026-03-30', null, '2026-03-31'), '2026-03-31')
  assert.equal(laterDay(null, undefined), null)
})

test('an event dated before the run is dated on its own day, not the run day', () => {
  const resolved = resolvePostingDate('2026-03-31', NO_LOCK)
  assert.equal(resolved.date, '2026-03-31')
  assert.equal(resolved.movedFromLockedDay, null)
})

test('no usable event day falls back to the run date, and a future event day is clamped to it', () => {
  assert.equal(resolvePostingDate(null, NO_LOCK).date, '2026-04-01')
  assert.equal(resolvePostingDate('2026-05-01', NO_LOCK).date, '2026-04-01')
})

test('an event on or before the lock date is moved to the first open day, never back-dated', () => {
  const ctx = { today: '2026-04-10', lockDate: '2026-03-31' }
  const inside = resolvePostingDate('2026-03-15', ctx)
  assert.equal(inside.date, '2026-04-01')
  assert.equal(inside.movedFromLockedDay, '2026-03-15')
  // The lock day itself is locked.
  assert.equal(resolvePostingDate('2026-03-31', ctx).date, '2026-04-01')
  // The first open day is open.
  const open = resolvePostingDate('2026-04-01', ctx)
  assert.equal(open.date, '2026-04-01')
  assert.equal(open.movedFromLockedDay, null)
})

test('when the first open day is after the run date there is NO date: never one on or before the lock', () => {
  for (const lockDate of ['2026-03-31', '2026-04-15']) {
    const resolved = resolvePostingDate('2026-03-15', { today: '2026-03-31', lockDate })
    assert.equal(resolved.date, null, `lock ${lockDate} must defer, not return a locked day`)
    assert.equal(resolved.movedFromLockedDay, '2026-03-15')
  }
  // The day after the lock IS today: open.
  assert.equal(resolvePostingDate('2026-03-15', { today: '2026-04-01', lockDate: '2026-03-31' }).date, '2026-04-01')
  assert.equal(lockBlocksRun({ today: '2026-03-31', lockDate: '2026-03-31' }), true)
  assert.equal(lockBlocksRun({ today: '2026-04-01', lockDate: '2026-03-31' }), false)
  assert.equal(lockBlocksRun({ today: '2026-04-01', lockDate: null }), false)
  assert.match(lockBlocksRunMessage('A1', '2026-04-15'), /locked up to 2026-04-15, after today; .*wait until the lock is moved or the period opens/)
})

test('rows with no open day are returned as deferred and never grouped', () => {
  const rows = [{ day: '2026-03-10' }, { day: '2026-03-12' }]
  const dated = groupByPostingDate(rows, (row) => row.day, { today: '2026-03-31', lockDate: '2026-03-31' })
  assert.deepEqual(dated.groups, [])
  assert.equal(dated.deferred.length, 2)
})

test('groupByPostingDate makes one group per resolved date, ascending, keeping row order', () => {
  const rows = [
    { id: 'a', day: '2026-03-31' },
    { id: 'b', day: '2026-03-30' },
    { id: 'c', day: '2026-03-31' },
    { id: 'd', day: null },
  ]
  const { groups } = groupByPostingDate(rows, (row) => row.day, NO_LOCK)
  assert.deepEqual(groups.map((group) => [group.date, group.rows.map((row) => row.id)]), [
    ['2026-03-30', ['b']],
    ['2026-03-31', ['a', 'c']],
    ['2026-04-01', ['d']],
  ])
})

test('locked-period events collapse into the first open day and are named once each', () => {
  const rows = [{ day: '2026-03-10' }, { day: '2026-03-12' }, { day: '2026-03-10' }, { day: '2026-04-05' }]
  const { groups } = groupByPostingDate(rows, (row) => row.day, { today: '2026-04-10', lockDate: '2026-03-31' })
  assert.deepEqual(groups.map((group) => [group.date, group.rows.length, group.movedFromLockedDays]), [
    ['2026-04-01', 3, ['2026-03-10', '2026-03-12']],
    ['2026-04-05', 1, []],
  ])
  assert.match(lockedPeriodNarration(groups[0].movedFromLockedDays, '2026-03-31'), /2026-03-10, 2026-03-12 fall in a locked period/)
  assert.equal(lockedPeriodNarration([], '2026-03-31'), '')
})

// --- ACC-H13 ---

const baseOrder = {
  id: 'o1',
  fxRateToBase: 1,
  subtotalBase: 100,
  shippingBase: 10,
  discountAmount: 0,
  pricesIncludeVat: false,
  taxRatePercent: 0,
  shoppingLinks: [],
  lines: [{ totalBase: 60 }, { totalBase: 40 }],
}

test('no refund: the deferral is subtotal + shipping - discount, exactly as before', () => {
  assert.equal(revenueDeferralAmount(baseOrder), 110)
  assert.equal(revenueDeferralAmount({ ...baseOrder, refunds: [] }), 110)
})

test('a NET refund entered before the first run is netted out of the deferral (the 60 + 40 + 10 example)', () => {
  const order = { ...baseOrder, refunds: [{ totalBase: 40, totalsBasis: 'NET' }] }
  assert.equal(revenueDeferralAmount(order), 70)
})

test('several NET refunds all net; a legacy gross refund (NULL basis) is not subtracted', () => {
  const order = {
    ...baseOrder,
    refunds: [
      { totalBase: 25, totalsBasis: 'NET' },
      { totalBase: 15, totalsBasis: 'NET' },
      { totalBase: 30, totalsBasis: null },
    ],
  }
  assert.equal(preBatchRefundedNetBase(order.refunds), 40)
  assert.equal(revenueDeferralAmount(order), 70)
})

test('the gross deferral ignores refunds; each NET refund is its own adjustment with its own date', () => {
  const order = {
    ...baseOrder,
    refunds: [
      { id: 'r1', totalBase: 40, totalsBasis: 'NET', refundedAt: new Date('2026-04-01T09:00:00.000Z') },
      { id: 'r2', totalBase: 30, totalsBasis: null, refundedAt: new Date('2026-04-01T09:00:00.000Z') },
    ],
  }
  assert.equal(revenueDeferralGrossAmount(order), 110)
  assert.equal(revenueDeferralAmount(order), 70)
  assert.deepEqual(preBatchRefundAdjustments(order.refunds), [{ refundId: 'r1', amount: 40, refundedAt: new Date('2026-04-01T09:00:00.000Z') }])
})

test('only refunds the batch stamped with an adjustment ref are added back; an old gross stamp is left at its stored amount', () => {
  assert.equal(preBatchRefundsNettedIntoStoredDeferral({ refunds: [{ totalBase: 40, totalsBasis: 'NET', deferralAdjustmentRef: 'A1-2026-03-31-aabbccdd' }] }), 40)
  assert.equal(preBatchRefundsNettedIntoStoredDeferral({ refunds: [{ totalBase: 40, totalsBasis: 'NET', deferralAdjustmentRef: null }] }), 0)
  assert.equal(preBatchRefundsNettedIntoStoredDeferral({ refunds: [{ totalBase: 40, totalsBasis: null, deferralAdjustmentRef: 'x' }] }), 0)
  assert.equal(preBatchRefundsNettedIntoStoredDeferral({}), 0)
})

test('isOnOrBeforeLock is true on the lock day and before, false after, and never judges an unreadable day', () => {
  assert.equal(isOnOrBeforeLock('2026-03-31', '2026-03-31'), true)
  assert.equal(isOnOrBeforeLock('2026-03-30', '2026-03-31'), true)
  assert.equal(isOnOrBeforeLock('2026-04-01', '2026-03-31'), false)
  assert.equal(isOnOrBeforeLock(null, '2026-03-31'), false)
  assert.equal(isOnOrBeforeLock('2026-03-01', null), false)
})

// One order's legs share a day: the paid day is read on the London business day, like the invoice and the receipt.
test('businessDay reads the London day: 23:30 UTC in BST is the next day, and in winter it is the UTC day', () => {
  assert.equal(businessDay(new Date('2026-06-30T23:30:00.000Z')), '2026-07-01')
  assert.equal(utcDay(new Date('2026-06-30T23:30:00.000Z')), '2026-06-30')
  assert.equal(businessDay('2026-12-31T23:30:00.000Z'), '2026-12-31')
  assert.equal(businessDay(null), null)
  assert.equal(businessDay('not a date'), null)
})
test('a deferral for an order paid 23:30 UTC on 30 June (BST) is dated 1 July, with the invoice, when the run day is the business day', () => {
  const ctx = { today: '2026-07-01', lockDate: null }
  assert.equal(resolvePostingDate(businessDay('2026-06-30T23:30:00.000Z'), ctx).date, '2026-07-01')
  // On the UTC run day it would have been clamped back to 30 June: the run day is the business day for that reason.
  assert.equal(resolvePostingDate(businessDay('2026-06-30T23:30:00.000Z'), { today: '2026-06-30', lockDate: null }).date, '2026-06-30')
})
