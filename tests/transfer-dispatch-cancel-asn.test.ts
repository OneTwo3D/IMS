import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closeTransferAsnsForDispatchCancel,
  describeClosedTransferAsns,
  resolveAsnCancelRequest,
  TransferAsnBlocksDispatchCancelError,
} from '@/lib/domain/wms/transfer-dispatch-cancel-asn'

/**
 * o3d-hqvrp.120: cancelling a transfer's dispatch closes its ASN in IMS (and nothing in Mintsoft), and refuses while the
 * warehouse may already hold or have booked goods against it. Fake transaction: no database, no network.
 */
type Asn = { id: string; connector: string; externalAsnId: string; status: string; remoteCreateAttemptedAt: Date | null; lastCallbackAt: Date | null; closedAt: Date | null; sourceType: string; sourceId: string; lines?: ReadonlyArray<{ lastProcessedReceivedQty: number; qtyAccountedViaReceipt: number; qtyAccountedViaSnapshot: number }> }
type ReceiptEvent = { connector: string; externalAsnId: string; processedAt: Date | null; processingStatus: string }

function fakeTx(rows: Asn[], events: ReceiptEvent[] = []) {
  const locked: string[][] = []
  const requests = new Map<string, { entityType: string; action: string; detail: string | null; attempts: number }>()
  const tx = {
    // The lock query takes one parameter (the ids). The cancel-request upsert (INSERT ... ON CONFLICT on entity/action/gate) takes many:
    // id, entity_type, entity_id, action, gate, permanence, severity, intent, detail, ...
    $queryRaw: async (_strings: TemplateStringsArray, ...params: unknown[]) => {
      if (params.length === 1) { locked.push(params[0] as string[]); return [] }
      const [, entityType, entityId, action, , , , , detail] = params as [string, string, string, string, string, string, string, string, string | null]
      const key = `${entityType}:${entityId}:${action}`
      const existing = requests.get(key)
      requests.set(key, { entityType, action, detail, attempts: (existing?.attempts ?? 0) + 1 })
      return [{ id: key, attempts: (existing?.attempts ?? 0) + 1 }]
    },
    wmsInboundReceiptEvent: {
      findMany: async (args: { where: { externalAsnId: { in: string[] }; processedAt: null; processingStatus: { in: string[] } } }) =>
        events.filter((e) => args.where.externalAsnId.in.includes(e.externalAsnId) && e.processedAt === null && args.where.processingStatus.in.includes(e.processingStatus)),
    },
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
  return { tx: tx as never, locked, requests }
}

const asn = (over: Partial<Asn>): Asn => ({ id: 'a1', connector: 'mintsoft', externalAsnId: '9001', status: 'OPEN', remoteCreateAttemptedAt: null, lastCallbackAt: null, closedAt: null, sourceType: 'STOCK_TRANSFER', sourceId: 't1', ...over })
const now = new Date('2026-11-18T10:00:00Z')

test('an open transfer ASN is closed locally, others are untouched, and the operator is told to ask the warehouse', async () => {
  const mine = asn({}); const partial = asn({ id: 'a2', externalAsnId: '9002', status: 'CREATE_PENDING' })
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
  // o3d-zz37l (4): the placeholder (CREATE_PENDING, never sent) is closed but is not named in the notice, so the operator is not told to chase the warehouse about it.
  const notice = describeClosedTransferAsns('TR-1', closed) ?? ''
  assert.match(notice, /9001/)
  assert.doesNotMatch(notice, /9002/)
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
  ['a partially booked-in ASN with units really received', { status: 'PARTIALLY_BOOKED_IN', lastCallbackAt: new Date(), lines: [{ lastProcessedReceivedQty: 2, qtyAccountedViaReceipt: 0, qtyAccountedViaSnapshot: 0 }] }],
  ['an ASN with units accounted via a receipt', { lines: [{ lastProcessedReceivedQty: 0, qtyAccountedViaReceipt: 1, qtyAccountedViaSnapshot: 0 }] }],
  ['an ASN with units accounted via a snapshot', { lines: [{ lastProcessedReceivedQty: 0, qtyAccountedViaReceipt: 0, qtyAccountedViaSnapshot: 3 }] }],
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

// o3d-zz37l (2): a receipt event for the ASN that is not yet applied is evidence the warehouse acted; closing the ASN would dead-letter it against the cancelled transfer.
for (const processingStatus of ['PENDING', 'PENDING_RETRY', 'FAILED_RETRY', 'REQUIRES_REVIEW']) {
  test(`cancelling the dispatch is refused while a receipt event for the ASN is ${processingStatus}, and nothing is closed`, async () => {
    const mine = asn({})
    const { tx } = fakeTx([mine], [{ connector: 'mintsoft', externalAsnId: '9001', processedAt: null, processingStatus }])
    await assert.rejects(closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now }), TransferAsnBlocksDispatchCancelError)
    assert.equal(mine.closedAt, null)
  })
}

test('a processed or dead receipt event, or one for another ASN, does not block', async () => {
  const mine = asn({})
  const { tx } = fakeTx([mine], [
    { connector: 'mintsoft', externalAsnId: '9001', processedAt: new Date(), processingStatus: 'PROCESSED' },
    { connector: 'mintsoft', externalAsnId: '9001', processedAt: null, processingStatus: 'DEAD' },
    { connector: 'mintsoft', externalAsnId: '7777', processedAt: null, processingStatus: 'PENDING' },
  ])
  const closed = await closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now })
  assert.deepEqual(closed.map((c) => c.externalAsnId), ['9001'])
})

// A zero-quantity booked-in recheck (operator recheck, QuantityBooked 0 callback, post-maintenance pass) sets PARTIALLY_BOOKED_IN and lastCallbackAt on an ASN that holds nothing.
// A transfer ASN has no close-short path, so refusing that for good would strand the transfer IN_TRANSIT.
test('an OPEN ASN after a zero-delta recheck (PARTIALLY_BOOKED_IN, lastCallbackAt set, nothing received) can still be cancelled', async () => {
  const rechecked = asn({ status: 'PARTIALLY_BOOKED_IN', lastCallbackAt: new Date('2026-11-18T09:00:00Z'), lines: [{ lastProcessedReceivedQty: 0, qtyAccountedViaReceipt: 0, qtyAccountedViaSnapshot: 0 }] })
  const { tx } = fakeTx([rechecked])
  const closed = await closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now })
  assert.deepEqual(closed.map((c) => c.externalAsnId), ['9001'])
  assert.equal(rechecked.closedAt, now)
})

test('the refusal names a way forward that exists', async () => {
  const mine = asn({ lines: [{ lastProcessedReceivedQty: 1, qtyAccountedViaReceipt: 0, qtyAccountedViaSnapshot: 0 }] })
  const { tx } = fakeTx([mine])
  await assert.rejects(closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now }), /complete the transfer receipt for what arrived/)
})

// o3d-zz37l (3): the instruction to ask the warehouse is a durable row, once per ASN that reached the warehouse.
test('each closed ASN that reached the warehouse gets exactly one durable cancel request; a placeholder gets none', async () => {
  const sent = asn({}); const placeholder = asn({ id: 'a2', externalAsnId: '9002', status: 'CREATE_PENDING' })
  const { tx, requests } = fakeTx([sent, placeholder])
  await closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now })
  assert.deepEqual([...requests.keys()], ['WMS_ASN_MAP:a1:WMS_ASN_CANCEL_REQUEST'])
  const request = requests.get('WMS_ASN_MAP:a1:WMS_ASN_CANCEL_REQUEST')!
  assert.match(request.detail ?? '', /Please cancel ASN 9001 \(IMS transfer TR-1\)/)
  assert.equal(request.attempts, 1)
})

test('a refused cancel records no request (the whole cancel rolls back)', async () => {
  const { tx, requests } = fakeTx([asn({ status: 'BOOKED_IN' })])
  await assert.rejects(closeTransferAsnsForDispatchCancel(tx, { transferId: 't1', transferReference: 'TR-1', now }), TransferAsnBlocksDispatchCancelError)
  assert.equal(requests.size, 0)
})

test('resolveAsnCancelRequest closes only that ASN\'s open cancel request, and is idempotent', async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = { refusedAction: { updateMany: async (args: { where: Record<string, unknown> }) => { calls.push(args.where); return { count: calls.length === 1 ? 1 : 0 } } } } as never
  assert.equal(await resolveAsnCancelRequest(client, 'a1'), true)
  assert.equal(await resolveAsnCancelRequest(client, 'a1'), false)
  assert.equal(calls[0]!.entityType, 'WMS_ASN_MAP')
  assert.equal(calls[0]!.entityId, 'a1')
  assert.equal(calls[0]!.action, 'WMS_ASN_CANCEL_REQUEST')
  assert.equal(calls[0]!.resolvedAt, null)
})
