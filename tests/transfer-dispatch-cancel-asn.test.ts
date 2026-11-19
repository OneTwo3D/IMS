import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closeTransferAsnsForDispatchCancel,
  describeClosedTransferAsns,
  TransferAsnBlocksDispatchCancelError,
} from '@/lib/domain/wms/transfer-dispatch-cancel-asn'

/**
 * o3d-hqvrp.120: cancelling a transfer's dispatch closes its ASN in IMS (and nothing in Mintsoft), and refuses while the
 * warehouse may already hold or have booked goods against it. Fake transaction: no database, no network.
 */
type Asn = { id: string; externalAsnId: string; status: string; remoteCreateAttemptedAt: Date | null; closedAt: Date | null; sourceType: string; sourceId: string }

function fakeTx(rows: Asn[]) {
  const locked: string[][] = []
  const tx = {
    $queryRaw: async (_strings: TemplateStringsArray, ids: string[]) => { locked.push(ids); return [] },
    wmsAsnMap: {
      findMany: async (args: { where: { sourceType?: string; sourceId?: string; id?: { in: string[] }; closedAt: null } }) =>
        rows.filter((r) => r.closedAt === null
          && (!args.where.sourceId || (r.sourceType === args.where.sourceType && r.sourceId === args.where.sourceId))
          && (!args.where.id || args.where.id.in.includes(r.id))),
      updateMany: async (args: { where: { id: { in: string[] } }; data: { closedAt: Date } }) => {
        let count = 0
        for (const r of rows) if (args.where.id.in.includes(r.id) && r.closedAt === null) { r.closedAt = args.data.closedAt; count += 1 }
        return { count }
      },
    },
  }
  return { tx: tx as never, locked }
}

const asn = (over: Partial<Asn>): Asn => ({ id: 'a1', externalAsnId: '9001', status: 'OPEN', remoteCreateAttemptedAt: null, closedAt: null, sourceType: 'STOCK_TRANSFER', sourceId: 't1', ...over })
const now = new Date('2026-11-18T10:00:00Z')

test('an open transfer ASN is closed locally, others are untouched, and the operator is told to ask the warehouse', async () => {
  const mine = asn({}); const partial = asn({ id: 'a2', externalAsnId: '9002', status: 'PARTIALLY_BOOKED_IN' })
  const other = asn({ id: 'a3', externalAsnId: '9003', sourceId: 't2' }); const po = asn({ id: 'a4', sourceType: 'PURCHASE_ORDER', sourceId: 't1' })
  const { tx, locked } = fakeTx([mine, partial, other, po])
  const closed = await closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now })
  assert.deepEqual(closed.map((c) => c.externalAsnId), ['9001', '9002'])
  assert.equal(mine.closedAt, now)
  assert.equal(partial.closedAt, now)
  assert.equal(other.closedAt, null)
  assert.equal(po.closedAt, null)
  assert.deepEqual(locked, [['a1', 'a2']], 'ASN headers are locked before the decision')
  assert.match(describeClosedTransferAsns('TR-1', closed) ?? '', /ask the warehouse to cancel it/)
})

test('a transfer with no open ASN closes nothing and says nothing', async () => {
  const { tx } = fakeTx([asn({ closedAt: new Date() })])
  const closed = await closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now })
  assert.deepEqual(closed, [])
  assert.equal(describeClosedTransferAsns('TR-1', closed), null)
})

for (const [label, over] of [
  ['a create that may have reached the warehouse', { status: 'CREATE_IN_FLIGHT' }],
  ['a claimed pending create', { status: 'CREATE_PENDING', remoteCreateAttemptedAt: new Date() }],
  ['a booked-in ASN still owed a receipt', { status: 'BOOKED_IN' }],
] as const) {
  test(`cancelling the dispatch is refused for ${label}, and nothing is closed`, async () => {
    const blocking = asn(over); const fine = asn({ id: 'a2', externalAsnId: '9002' })
    const { tx } = fakeTx([blocking, fine])
    await assert.rejects(closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now }), TransferAsnBlocksDispatchCancelError)
    assert.equal(fine.closedAt, null)
  })
}

test('a never-claimed pending reservation is closed like any other open ASN', async () => {
  const pending = asn({ status: 'CREATE_PENDING' })
  const { tx } = fakeTx([pending])
  assert.equal((await closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now })).length, 1)
  assert.equal(pending.closedAt, now)
})
