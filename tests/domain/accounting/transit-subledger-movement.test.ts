import assert from 'node:assert/strict'
import test from 'node:test'

import { recordTransitSubledgerMovement } from '@/lib/domain/accounting/transit-subledger-movement'

type UpsertArgs = {
  where: { idempotencyKey: string }
  create: { sourceType: string; sourceRef: string; idempotencyKey: string; baseDelta: unknown; journalDate: Date }
  update: Record<string, unknown>
}

function mockClient() {
  const upserts: UpsertArgs[] = []
  return {
    upserts,
    client: { transitSubledgerMovement: { upsert: async (args: UpsertArgs) => { upserts.push(args); return {} } } } as never,
  }
}

test('records a signed transit debit (bill), coercing a YYYY-MM-DD journal date to UTC midnight', async () => {
  const { upserts, client } = mockClient()
  await recordTransitSubledgerMovement(client, {
    sourceType: 'PURCHASE_BILL',
    sourceRef: 'po_1',
    idempotencyKey: 'purchase-invoice:po_1:hash',
    baseDelta: 120.5, // DR transit (goods/freight in transit) → positive
    journalDate: '2026-06-20',
  })
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]!.where.idempotencyKey, 'purchase-invoice:po_1:hash')
  assert.equal(upserts[0]!.create.sourceType, 'PURCHASE_BILL')
  assert.equal(upserts[0]!.create.sourceRef, 'po_1')
  assert.equal(Number(upserts[0]!.create.baseDelta), 120.5)
  assert.equal(upserts[0]!.create.journalDate.toISOString(), '2026-06-20T00:00:00.000Z')
  // Idempotent: the key identifies one posting, so a re-run is a no-op.
  assert.deepEqual(upserts[0]!.update, {})
})

test('records a signed transit credit (receipt drains transit) as a negative delta', async () => {
  const { upserts, client } = mockClient()
  await recordTransitSubledgerMovement(client, {
    sourceType: 'STOCK_RECEIPT',
    sourceRef: 'po_2',
    idempotencyKey: 'purchase-receipt:po_2:r1',
    baseDelta: -80.25, // CR transit → negative
    journalDate: '2026-06-20',
  })
  assert.equal(Number(upserts[0]!.create.baseDelta), -80.25)
})

test('truncates a Date with a wall-clock time to UTC midnight', async () => {
  // The recon window is (opening, closing] between two date-only GL snapshots, so a
  // row dated mid-afternoon on the closing date would fall OUTSIDE its own day's
  // window and perpetually flag. Date inputs MUST be truncated to date-only.
  const { upserts, client } = mockClient()
  await recordTransitSubledgerMovement(client, {
    sourceType: 'LANDED_COST_RECLASS',
    sourceRef: 'po_3',
    idempotencyKey: 'landed:po_3',
    baseDelta: -5,
    journalDate: new Date('2026-06-20T15:30:45.123Z'),
  })
  assert.equal(upserts[0]!.create.journalDate.toISOString(), '2026-06-20T00:00:00.000Z')
})

test('a zero movement is skipped (no ledger noise)', async () => {
  const { upserts, client } = mockClient()
  await recordTransitSubledgerMovement(client, {
    sourceType: 'PURCHASE_BILL_UPDATE',
    sourceRef: 'po_4',
    idempotencyKey: 'k',
    baseDelta: 0, // an edit with no net transit change
    journalDate: new Date('2026-06-20T00:00:00.000Z'),
  })
  assert.equal(upserts.length, 0)
})

test('baseDelta is rounded to 6dp before storing', async () => {
  const { upserts, client } = mockClient()
  await recordTransitSubledgerMovement(client, {
    sourceType: 'SUPPLIER_CREDIT_NOTE',
    sourceRef: 'cn_1',
    idempotencyKey: 'supplier-credit-note:cn_1',
    baseDelta: -1.23456789,
    journalDate: '2026-06-20',
  })
  assert.equal(Number(upserts[0]!.create.baseDelta), -1.234568)
})
