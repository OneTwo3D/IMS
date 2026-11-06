import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import {
  ERASED_ORDER_PUSH_REASON,
  buildPushInput,
  runWmsOrderPushSweepCore,
  type WmsPushCandidate,
  type WmsPushUpdateLink,
  type WmsOrderPushPort,
} from '../lib/domain/wms/order-push-sweep.ts'

/**
 * AN ERASED ORDER NEVER LEAVES IMS. Every connector method is a tripwire: the sweep is run over an erased order
 * that was never pushed (create pass) and over one with a live warehouse link (amend pass), and the connector is
 * never called, so no VATNumber and no identity field of any kind can have been sent. The fixtures keep a stale
 * VAT number, name, email and address ON PURPOSE (what a row looks like if the erasure and a push interleave),
 * so the guard, not the cleared columns, is what is being proved.
 */

mock.module('@/lib/db', { namedExports: { db: { $queryRaw: async () => [], $executeRaw: async () => 1 } } })

const NOW = () => new Date('2026-06-26T00:00:00.000Z')
const ERASED = new Date('2026-11-06T00:00:00.000Z')
const VAT = 'GB123456789'

const line = { id: 'l1', sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget', productId: 'p1', externalLineItemId: 1, wclcFeeKind: null }
const baseOrder = {
  id: 'so-1', orderNumber: 'SO-1', externalOrderNumber: null, currency: 'GBP', customerName: 'Jane Doe', customerEmail: 'jane@example.com',
  customerVatNumber: VAT, shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' }, shippingService: 'Royal Mail',
  subtotalForeign: 10, shippingForeign: 0, taxForeign: 0, taxRatePercent: null, pricesIncludeVat: false, discountAmount: 0, totalForeign: 10,
  shipFromWarehouseId: 'wh-1', lines: [line], refunds: [],
}

function tripwireConnector(calls: string[]) {
  const trip = (name: string) => async () => { calls.push(name); throw new Error(`unexpected outbound call: ${name}`) }
  return { pushOrder: trip('pushOrder'), updateOrder: trip('updateOrder'), addOrderComment: trip('addOrderComment'), cancelOrder: trip('cancelOrder') }
}

function port(over: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = []
  const failures: string[] = []
  const base = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: async () => [], createCandidates: async () => [], revalidatableLinks: async () => ({ links: [], total: 0 }),
    ambiguousCreateLinks: async () => ({ links: [], total: 0 }), verifiableLinks: async () => [], holdableLinks: async () => [],
    cancellableLinks: async () => [], updatableLinks: async () => [],
    updateLink: async (_id: string, data: Record<string, unknown>) => { writes.push(data) },
    updateLinkByOrder: async () => undefined, updateLinkIfState: async () => true, upsertByOrder: async () => undefined,
    claimForCreate: async () => 'CLAIMED',
    recordValidationFailure: async (_id: string, _c: string, message: string) => { failures.push(message); return true },
    screenLiveWithdrawals: async () => new Set<string>(), verifyWithdrawalFence: async () => true, recordEvent: async () => undefined,
  }
  return { port: { ...base, ...over } as unknown as WmsOrderPushPort, writes, failures }
}

test('buildPushInput refuses an erased order before any payload exists, even if a stale VAT number and address remain', () => {
  assert.throws(() => buildPushInput({ ...baseOrder, erasedAt: ERASED } as never, '301'), (e: Error) => e.message === ERASED_ORDER_PUSH_REASON)
  assert.doesNotThrow(() => buildPushInput({ ...baseOrder, erasedAt: null } as never, '301'), 'the same order un-erased still builds, so the refusal is the guard and not the fixture')
})

test('create pass: an erased order that was never pushed sends nothing and is recorded as a validation failure', async () => {
  const calls: string[] = []
  const { port: p, failures } = port({ createCandidates: async () => [{ ...baseOrder, erasedAt: ERASED, pushAttempts: 0 } as unknown as WmsPushCandidate] })
  await runWmsOrderPushSweepCore(tripwireConnector(calls) as never, 'mintsoft', p, { now: NOW })
  assert.deepEqual(calls, [], 'no connector method is called')
  assert.ok(failures.some((m) => m.includes(ERASED_ORDER_PUSH_REASON)), `recorded: ${failures.join('|')}`)
})

test('amend pass: an erased order with a live link is settled locally, with no remote call and no retry loop', async () => {
  const calls: string[] = []
  const link = { id: 'link-1', externalOrderId: 'wms-1', courierForm: null, courierFormName: null, order: { ...baseOrder, erasedAt: ERASED } } as unknown as WmsPushUpdateLink
  const { port: p, writes } = port({ updatableLinks: async () => [link] })
  await runWmsOrderPushSweepCore(tripwireConnector(calls) as never, 'mintsoft', p, { now: NOW })
  assert.deepEqual(calls, [])
  assert.equal(writes.length, 1)
  assert.ok(writes[0]!.pushedAt, 'pushedAt is stamped so the pass does not select the order again')
  assert.equal(writes[0]!.lastError, ERASED_ORDER_PUSH_REASON)
})

test('control: an un-erased order IS amended, so the tripwire connector is wired and the guard is the only difference', async () => {
  const calls: string[] = []
  const link = { id: 'link-1', externalOrderId: 'wms-1', courierForm: null, courierFormName: null, order: { ...baseOrder, erasedAt: null } } as unknown as WmsPushUpdateLink
  const { port: p } = port({ updatableLinks: async () => [link] })
  await runWmsOrderPushSweepCore(tripwireConnector(calls) as never, 'mintsoft', p, { now: NOW })
  assert.deepEqual(calls, ['updateOrder'])
})


// ---- The boundary re-read: the order is read AGAIN under its lock immediately before the send. -----------------------------

test('create pass: an erasure after the sweep loaded the order and before the push sends nothing, and gives the claim back', async () => {
  const calls: string[] = []
  const given: Array<Record<string, unknown>> = []
  // The candidate list (the earlier read) is NOT erased; the boundary re-read is.
  const { port: p } = port({
    createCandidates: async () => [{ ...baseOrder, erasedAt: null, pushAttempts: 0 } as unknown as WmsPushCandidate],
    updateLinkIfCreateClaimOwned: async (_o: string, _s: Date, data: Record<string, unknown>) => { given.push(data); return true },
    reloadOrderForPush: async () => ({ ...baseOrder, customerName: 'GDPR Anonymised', customerEmail: null, customerVatNumber: null, erasedAt: ERASED }),
  })
  await runWmsOrderPushSweepCore(tripwireConnector(calls) as never, 'mintsoft', p, { now: NOW })
  assert.deepEqual(calls, [], 'no identity and no VAT number reached the warehouse double')
  assert.ok(given.some((d) => d.lastError === ERASED_ORDER_PUSH_REASON), JSON.stringify(given))
})

test('create pass: the payload that IS sent is built from the boundary re-read, not from the earlier list read', async () => {
  const sent: Array<Record<string, unknown>> = []
  const connector = {
    pushOrder: async (input: Record<string, unknown>) => { sent.push(input); return { externalOrderId: 'w1', status: 'NEW' } },
    updateOrder: async () => { throw new Error('unexpected') }, addOrderComment: async () => undefined, cancelOrder: async () => undefined,
  }
  const { port: p } = port({
    createCandidates: async () => [{ ...baseOrder, erasedAt: null, pushAttempts: 0 } as unknown as WmsPushCandidate],
    reloadOrderForPush: async () => ({ ...baseOrder, customerVatNumber: 'GB-FRESH-1', erasedAt: null }),
  })
  await runWmsOrderPushSweepCore(connector as never, 'mintsoft', p, { now: NOW })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.vatNumber, 'GB-FRESH-1', 'the VAT number is the re-read one (the earlier read said ' + VAT + ')')
})

test('create pass: an order that cannot be re-read is not sent (fail closed)', async () => {
  const calls: string[] = []
  const { port: p } = port({
    createCandidates: async () => [{ ...baseOrder, erasedAt: null, pushAttempts: 0 } as unknown as WmsPushCandidate],
    reloadOrderForPush: async () => { throw new Error('db down') },
  })
  await runWmsOrderPushSweepCore(tripwireConnector(calls) as never, 'mintsoft', p, { now: NOW })
  assert.deepEqual(calls, [])
})

test('amend pass: an erasure after the sweep loaded the link sends nothing and is settled locally; an unreadable order stays due', async () => {
  const calls: string[] = []
  const link = { id: 'link-1', externalOrderId: 'wms-1', courierForm: null, courierFormName: null, order: { ...baseOrder, erasedAt: null } } as unknown as WmsPushUpdateLink
  const erased = port({ updatableLinks: async () => [link], reloadOrderForPush: async () => ({ ...baseOrder, erasedAt: ERASED }) })
  await runWmsOrderPushSweepCore(tripwireConnector(calls) as never, 'mintsoft', erased.port, { now: NOW })
  assert.deepEqual(calls, [])
  assert.ok(erased.writes[0]!.pushedAt, 'settled: not selected again')
  assert.equal(erased.writes[0]!.lastError, ERASED_ORDER_PUSH_REASON)

  const unreadable = port({ updatableLinks: async () => [link], reloadOrderForPush: async () => { throw new Error('db down') } })
  await runWmsOrderPushSweepCore(tripwireConnector(calls) as never, 'mintsoft', unreadable.port, { now: NOW })
  assert.deepEqual(calls, [])
  assert.equal('pushedAt' in unreadable.writes[0]!, false, 'left due, so the next pass tries again')
})
