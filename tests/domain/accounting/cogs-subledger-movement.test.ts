import assert from 'node:assert/strict'
import test from 'node:test'

import { recordCogsSubledgerMovement } from '@/lib/domain/accounting/cogs-subledger-movement'

type UpsertArgs = {
  where: { idempotencyKey: string }
  create: { sourceType: string; sourceRef: string; idempotencyKey: string; baseDelta: unknown; journalDate: Date }
  update: Record<string, unknown>
}

function mockClient() {
  const upserts: UpsertArgs[] = []
  return {
    upserts,
    client: { cogsSubledgerMovement: { upsert: async (args: UpsertArgs) => { upserts.push(args); return {} } } } as never,
  }
}

test('records a signed movement, coercing a YYYY-MM-DD journal date to UTC midnight', async () => {
  const { upserts, client } = mockClient()
  await recordCogsSubledgerMovement(client, {
    sourceType: 'REFUND_REVERSAL',
    sourceRef: 'refund_1',
    idempotencyKey: 'sales-order-refund:refund_1:cogs-reversal',
    baseDelta: -12.34,
    journalDate: '2026-06-20',
  })
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]!.where.idempotencyKey, 'sales-order-refund:refund_1:cogs-reversal')
  assert.equal(upserts[0]!.create.sourceType, 'REFUND_REVERSAL')
  assert.equal(Number(upserts[0]!.create.baseDelta), -12.34)
  assert.equal(upserts[0]!.create.journalDate.toISOString(), '2026-06-20T00:00:00.000Z')
  // Upsert update is empty: the key identifies one posting, so a re-run is a no-op.
  assert.deepEqual(upserts[0]!.update, {})
})

test('a zero movement is skipped (no ledger noise)', async () => {
  const { upserts, client } = mockClient()
  await recordCogsSubledgerMovement(client, {
    sourceType: 'LANDED_COST_ADJUSTMENT',
    sourceRef: 'po_1',
    idempotencyKey: 'k',
    baseDelta: 0,
    journalDate: new Date('2026-06-20T00:00:00.000Z'),
  })
  assert.equal(upserts.length, 0)
})

test('baseDelta is rounded to 6dp before storing', async () => {
  const { upserts, client } = mockClient()
  await recordCogsSubledgerMovement(client, {
    sourceType: 'SHIPMENT_REVALUATION',
    sourceRef: 'shp_1',
    idempotencyKey: 'k2',
    baseDelta: 1.23456789,
    journalDate: '2026-06-20',
  })
  assert.equal(Number(upserts[0]!.create.baseDelta), 1.234568)
})
