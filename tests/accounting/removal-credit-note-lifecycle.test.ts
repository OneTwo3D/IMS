import assert from 'node:assert/strict'
import test from 'node:test'

import { removalsCoveredByRestoration, withdrawStagedRemovalCreditNote, REMOVAL_CREDIT_NOTE_WITHDRAWN_REASON } from '@/lib/domain/accounting/removal-credit-note-lifecycle'

/**
 * o3d-hqvrp.395: a removal credit note staged behind the outbound write hold is WITHDRAWN when the payment is restored before it is released. Nothing here reaches a network or a database.
 */
type SyncRow = { id: string; type: string; referenceType: string; referenceId: string; status: string; externalTransactionId: string | null; errorMessage?: string | null }

function client(rows: SyncRow[]) {
  const matches = (r: SyncRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const actual = (r as Record<string, unknown>)[k]
      if (v && typeof v === 'object' && 'in' in (v as object)) return ((v as { in: unknown[] }).in).includes(actual)
      return actual === v
    })
  return {
    accountingSyncLog: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<SyncRow> }) => {
        let count = 0
        for (const r of rows) if (matches(r, where)) { Object.assign(r, data); count += 1 }
        return { count }
      },
      count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length,
    },
  } as never
}

const staged = (over: Partial<SyncRow> = {}): SyncRow => ({ id: 's1', type: 'CREDIT_NOTE', referenceType: 'SalesOrderRefund', referenceId: 'refund-1', status: 'PENDING', externalTransactionId: null, ...over })

test('a restored payment withdraws the credit note that is still staged (unsent)', async () => {
  const rows = [staged()]
  const out = await withdrawStagedRemovalCreditNote(client(rows), 'refund-1')
  assert.equal(out.outcome, 'withdrawn')
  assert.equal(rows[0]?.status, 'CANCELLED')
  assert.equal(rows[0]?.errorMessage, REMOVAL_CREDIT_NOTE_WITHDRAWN_REASON)
})

test('a credit note already being sent or sent is NOT touched, only reported', async () => {
  for (const status of ['PROCESSING', 'SYNCED']) {
    const rows = [staged({ status })]
    const out = await withdrawStagedRemovalCreditNote(client(rows), 'refund-1')
    assert.equal(out.outcome, 'not-pending')
    assert.equal(rows[0]?.status, status)
  }
})

test('withdrawing is idempotent and another refund\'s credit note is never touched', async () => {
  const rows = [staged(), staged({ id: 's2', referenceId: 'refund-2' })]
  await withdrawStagedRemovalCreditNote(client(rows), 'refund-1')
  const again = await withdrawStagedRemovalCreditNote(client(rows), 'refund-1')
  assert.equal(again.outcome, 'not-pending', 'already withdrawn: nothing more to cancel, and it is not reported as sent')
  assert.equal(rows[1]?.status, 'PENDING')
})

test('a restoration covers removals newest first, whole amounts only; the rest is for a person', () => {
  const removals = [
    { id: 'a', refundId: 'ra', amountForeign: '30', createdAt: new Date('2026-11-01') },
    { id: 'b', refundId: 'rb', amountForeign: '20', createdAt: new Date('2026-11-05') },
  ]
  assert.deepEqual(removalsCoveredByRestoration(removals, '20'), { covered: ['rb'], partlyCovered: [], leftover: removalsCoveredByRestoration(removals, '20').leftover })
  const full = removalsCoveredByRestoration(removals, '50')
  assert.deepEqual(full.covered, ['rb', 'ra'])
  assert.equal(full.leftover.toNumber(), 0)
  const partial = removalsCoveredByRestoration(removals, '25')
  assert.deepEqual(partial.covered, ['rb'])
  assert.deepEqual(partial.partlyCovered, ['ra'])
})
