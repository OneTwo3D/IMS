import assert from 'node:assert/strict'
import test from 'node:test'

import { cronOutcome } from '../lib/ops/cron-outcomes.ts'
import {
  decideCreateClaim,
  runWmsOrderPushSweepCore,
  type WmsOrderPushPort,
  type WmsPushCandidate,
} from '../lib/domain/wms/order-push-sweep.ts'
import { runWmsDispatchSweepCore, type WmsDispatchCandidate, type WmsDispatchSweepDeps } from '../lib/domain/wms/dispatch-sweep.ts'
import {
  EMPTY_SYSTEMIC_STATE,
  type SystemicFailureStore,
  type SystemicIncident,
  type SystemicState,
} from '../lib/domain/wms/systemic-failure.ts'
import type { WmsOrderPushInput, WmsOrderPushResult, WmsOrderStatus } from '../lib/connectors/wms/types.ts'

/**
 * The circuit breaker wired into the sweeps that park records after exhausted retries. Mocked everywhere: no database, no HTTP.
 * The contract under test: a systemic pass parks NOTHING and raises ONE incident; the next clean pass resolves it; the sixth
 * consecutive pass isolates per record again.
 */

function memoryStore() {
  const rows = new Map<string, SystemicState>()
  const raised: SystemicIncident[] = []
  const resolved: string[] = []
  const store: SystemicFailureStore = {
    async load(sweep) { return rows.get(sweep) ?? { ...EMPTY_SYSTEMIC_STATE } },
    async save(sweep, state) { rows.set(sweep, state); return true },
    async raise(incident) { raised.push(incident) },
    async resolve(info) { resolved.push(info.sweep) },
  }
  return { store, rows, raised, resolved }
}

// --- order push ------------------------------------------------------------------------------------------------------------

type LinkRow = { state: string; attempts: number; lastAttemptAt: Date | null; lastError: string | null }

function candidate(id: string, pushAttempts: number): WmsPushCandidate {
  return {
    id,
    orderNumber: `SO-${id}`,
    externalOrderNumber: null,
    currency: 'GBP',
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    customerVatNumber: null,
    shippingAddress: { line1: '1 St', city: 'Leeds', postcode: 'LS1', country: 'GB' },
    shippingService: 'Royal Mail',
    subtotalForeign: 10,
    shippingForeign: 0,
    taxForeign: 0,
    taxRatePercent: null,
    pricesIncludeVat: false,
    discountAmount: 0,
    totalForeign: 10,
    shipFromWarehouseId: 'wh-1',
    pushAttempts,
    lines: [{ sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget' }],
  }
}

/** A port whose link rows carry state between passes, so the retry ladder is real: attempts climb, a parked order leaves the queue. */
function ladderPort(orders: string[], startAttempts: number, breaker: SystemicFailureStore | undefined) {
  const links = new Map<string, LinkRow>(orders.map((id) => [id, { state: 'PENDING_CREATE', attempts: startAttempts, lastAttemptAt: null, lastError: null }]))
  const audits: Array<{ action: string; outcome: string; summary: string }> = []
  const port: WmsOrderPushPort = {
    activeBindings: async () => [{ warehouseId: 'wh-1', externalWarehouseId: '301' }],
    releasableHeldOrders: async () => [],
    createCandidates: async () => orders
      .filter((id) => links.get(id)!.state === 'PENDING_CREATE')
      .map((id) => candidate(id, links.get(id)!.attempts)),
    // THE PRODUCTION CLAIM RULE (decideCreateClaim, with its real lease): a stamped PENDING_CREATE link is skipped while the lease is
    // fresh and parked AMBIGUOUS_CREATE once it lapses; only an unstamped one is claimed.
    claimForCreate: async (orderId, _connector, attemptedAt) => {
      const row = links.get(orderId)!
      const decision = decideCreateClaim({ state: row.state, lastAttemptAt: row.lastAttemptAt }, attemptedAt)
      if (decision === 'CLAIM') { row.lastAttemptAt = attemptedAt; return 'CLAIMED' }
      if (decision === 'PARK_AMBIGUOUS') { row.state = 'AMBIGUOUS_CREATE'; return 'PARKED_AMBIGUOUS' }
      return 'SKIPPED'
    },
    verifiableLinks: async () => [],
    updatableLinks: async () => [],
    holdableLinks: async () => [],
    cancellableLinks: async () => [],
    revalidatableLinks: async () => ({ links: [], total: 0 }),
    recordValidationFailure: async () => true,
    upsertByOrder: async (orderId, create, update) => {
      const row = links.get(orderId)!
      const data = update as Partial<LinkRow>
      Object.assign(row, { state: data.state ?? row.state, attempts: data.attempts ?? row.attempts, lastError: data.lastError ?? row.lastError })
      if ('lastAttemptAt' in update) row.lastAttemptAt = (update.lastAttemptAt as Date | null) ?? null
      void create
    },
    updateLink: async () => {},
    updateLinkIfCreateClaimOwned: async (orderId, stamp, data) => {
      const row = links.get(orderId)!
      if (row.state !== 'PENDING_CREATE' || row.lastAttemptAt?.getTime() !== stamp.getTime()) return false
      const next = data as Partial<LinkRow>
      Object.assign(row, { state: next.state ?? row.state, attempts: next.attempts ?? row.attempts, lastError: next.lastError ?? row.lastError })
      if ('lastAttemptAt' in data) row.lastAttemptAt = (data.lastAttemptAt as Date | null) ?? null
      return true
    },
    updateLinkIfState: async () => true,
    raiseOperatorTask: async () => ({ id: 't', created: true }) as never,
    countOpenOperatorTasks: async () => 0,
    recordEvent: async (event) => { audits.push({ action: event.action, outcome: event.outcome, summary: event.summary }) },
    systemicBreaker: breaker,
  }
  return { port, links, audits }
}

let clock = 0
const NOW = () => new Date(Date.UTC(2026, 10, 16, 0, clock++))

type Behaviour = { down: boolean; failOnly?: Set<string>; ambiguous?: boolean; calls?: string[]; created?: string[] }

/** A DEFINITE refusal (the connector proves nothing was sent) unless `ambiguous`, which is a 5xx that may have been honoured. */
class NotSentError extends Error { readonly nothingSent = true }

function pushConnector(behaviour: Behaviour) {
  return {
    pushOrder: async (input: WmsOrderPushInput): Promise<WmsOrderPushResult> => {
      behaviour.calls?.push(input.orderNumber)
      const broken = behaviour.down || behaviour.failOnly?.has(input.orderNumber)
      if (broken) throw behaviour.ambiguous ? new Error('HTTP 500 from the WMS') : new NotSentError('HTTP 400 from the WMS: refused before creating')
      behaviour.created?.push(input.orderNumber)
      return { externalOrderId: `wms-${input.orderNumber}`, externalOrderNumber: input.orderNumber, status: 'NEW' }
    },
    updateOrder: async () => ({ updated: true, status: 'NEW' }),
    cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
  }
}

async function pushPass(connectorBehaviour: Behaviour, port: WmsOrderPushPort) {
  return runWmsOrderPushSweepCore(pushConnector(connectorBehaviour), 'mintsoft', port, { now: NOW })
}

test('order push: a systemic pass parks nothing, raises ONE incident, and fails the run', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1', '2', '3'], 4, m.store)
  const r = await pushPass({ down: true }, port)

  assert.equal(r.deadLettered, 0, 'nothing was parked')
  assert.equal(r.systemicSuppressed, 3, 'all three exhausted orders were left alone, and the pass says so')
  assert.equal(r.failed, 3)
  for (const row of links.values()) assert.equal(row.state, 'PENDING_CREATE', 'every order stays eligible for the next create')
  assert.equal(m.raised.length, 1)
  assert.equal(m.raised[0].sweep, 'order-push')
  assert.equal(m.raised[0].kind, 'open')
  assert.equal(m.rows.get('order-push')?.consecutive, 1)
  assert.equal(cronOutcome('wms-order-push', r as never), 'failed', 'the exit contract: an outage handled gracefully is still a failed run')
})

test('order push: the next clean pass recovers every order and resolves the incident', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1', '2', '3'], 4, m.store)
  await pushPass({ down: true }, port)
  await pushPass({ down: true }, port)
  assert.equal(m.rows.get('order-push')?.consecutive, 2)
  assert.equal(m.raised.length, 1, 'two systemic passes, still one incident')

  const recovered = await pushPass({ down: false }, port)
  assert.equal(recovered.created, 3, 'the orders that would have been parked were created by the automatic retry')
  assert.equal(recovered.systemicSuppressed, undefined)
  assert.equal(m.resolved.length, 1)
  assert.equal(m.rows.get('order-push')?.consecutive, 0)
  assert.equal(m.rows.get('order-push')?.incidentOpenedAt, null)
  assert.equal(cronOutcome('wms-order-push', recovered as never), 'ok')
  void links
})

test('order push: the sixth consecutive systemic pass isolates, and the incident says so', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1', '2', '3'], 4, m.store)
  for (let pass = 1; pass <= 5; pass += 1) {
    const r = await pushPass({ down: true }, port)
    assert.equal(r.deadLettered, 0, `pass ${pass}: nothing parked`)
    assert.equal(r.systemicSuppressed, 3)
  }
  assert.equal(m.raised.length, 1, 'five suppressed passes, one incident')
  assert.ok([...links.values()].every((row) => row.state === 'PENDING_CREATE'))

  const sixth = await pushPass({ down: true }, port)
  assert.equal(sixth.deadLettered, 3, 'the bound is spent: they are isolated per record')
  assert.equal(sixth.failed, 0)
  assert.equal(sixth.systemicSuppressed, undefined)
  assert.ok([...links.values()].every((row) => row.state === 'DEAD_LETTER'))
  assert.equal(m.raised.length, 2)
  assert.equal(m.raised[1].kind, 'escalate')
  assert.match(m.raised[1].message, /isolated one by one again/)
})

test('order push: one broken order among healthy ones is a record fault and is parked, with no incident', async () => {
  const m = memoryStore()
  const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']
  const { port, links } = ladderPort(ids, 4, m.store)
  const r = await pushPass({ down: false, failOnly: new Set(['SO-7']) }, port)

  assert.equal(r.created, 9)
  assert.equal(r.deadLettered, 1)
  assert.equal(r.failed, 0, 'the provisional failure was converted to the park, not counted twice')
  assert.equal(links.get('7')!.state, 'DEAD_LETTER')
  assert.equal(links.get('7')!.attempts, 5)
  assert.equal(m.raised.length, 0)
})

test('order push: a lone failing order on a quiet tick is parked (below the floor)', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1'], 4, m.store)
  const r = await pushPass({ down: true }, port)
  assert.equal(r.deadLettered, 1)
  assert.equal(links.get('1')!.state, 'DEAD_LETTER')
  assert.equal(m.raised.length, 0)
})

test('order push: an order not yet at the bound is retried, never parked, and does not touch the breaker\'s incident', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1', '2', '3'], 1, m.store)
  const r = await pushPass({ down: true }, port)
  assert.equal(r.failed, 3)
  assert.equal(r.deadLettered, 0)
  assert.equal(r.systemicSuppressed, undefined, 'nothing was at stake')
  assert.equal(m.raised.length, 0)
  assert.equal(links.get('1')!.attempts, 2)
})

test('order push: a park that the order has since moved on from is not forced', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1'], 4, m.store)
  // another worker re-claims the order between the failed attempt and the end-of-pass park
  const original = port.updateLinkIfCreateClaimOwned!
  port.updateLinkIfCreateClaimOwned = async (orderId, stamp, data) => {
    links.get(orderId)!.lastAttemptAt = new Date(stamp.getTime() + 1)
    return original(orderId, stamp, data)
  }
  const r = await pushPass({ down: true }, port)
  assert.equal(r.deadLettered, 0)
  assert.equal(links.get('1')!.state, 'PENDING_CREATE', 'the compare-and-set refused: the newer claim stands')
})

test('order push: without a breaker the park is inline, exactly as before', async () => {
  const { port, links } = ladderPort(['1', '2', '3'], 4, undefined)
  const r = await pushPass({ down: true }, port)
  assert.equal(r.deadLettered, 3)
  assert.equal(r.systemicSuppressed, undefined)
  assert.ok([...links.values()].every((row) => row.state === 'DEAD_LETTER'))
})

test('order push: an order refused by the outbound-write hold is not an attempt and cannot make a pass systemic', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1', '2', '3'], 4, m.store)
  const { outboundWriteRefusal, OutboundWriteHeldError } = await import('../lib/security/outbound-write-grant')
  const refusal = outboundWriteRefusal({ connectorName: 'Mintsoft', method: 'PUT', url: 'https://api.mintsoft.co.uk/api/Order', writeScopeId: '89', env: {} })
  assert.ok(refusal, 'precondition: the real refusal path refused the create')
  const heldText = new OutboundWriteHeldError(refusal, 0).message
  const held = {
    ...pushConnector({ down: false }),
    pushOrder: async (): Promise<WmsOrderPushResult> => { throw new Error(heldText) },
  }
  const r = await runWmsOrderPushSweepCore(held, 'mintsoft', port, { now: NOW })
  assert.equal(r.deadLettered, 0)
  assert.equal(m.raised.length, 0, 'no evidence of a connector fault: the connector was never asked')
  void links
})

// --- dispatch --------------------------------------------------------------------------------------------------------------

function dispatchStatus(number: string): WmsOrderStatus {
  return {
    externalOrderId: `M-${number}`, externalOrderNumber: number, status: 'DESPATCHED', statusLabel: 'Despatched', isSplit: false, partCount: null,
    isMerged: false, mergedOrderNumbers: [], deepLinkUrl: null, tracking: [{ trackingNumber: 'TN1', carrier: 'DPD', despatchedAt: '2026-08-19T10:00:00Z' }],
    dispatched: true, raw: null,
  }
}

function dispatchHarness(count: number, startFailures: number, breaker: SystemicFailureStore | undefined) {
  const candidates: WmsDispatchCandidate[] = Array.from({ length: count }, (_, i) => ({ linkId: `l${i + 1}`, orderId: `o${i + 1}`, externalOrderNumber: `WC-${1000 + i}` }))
  const strikes = new Map(candidates.map((c) => [c.linkId, startFailures]))
  const parked = new Set<string>()
  const state = { warehouseDown: true, brokenOnly: new Set<string>() }
  const deps: WmsDispatchSweepDeps = {
    listCandidates: async () => candidates.filter((c) => !parked.has(c.linkId)),
    fetchOrderStatus: async (number) => {
      if (state.warehouseDown || state.brokenOnly.has(number)) throw new Error('HTTP 500 from the WMS')
      return dispatchStatus(number)
    },
    applyDispatch: async () => ({ success: true }),
    partsSupported: true,
    fetchOrderParts: async () => [],
    fetchPartItems: async () => [],
    pushPartialShipment: async () => ({ ok: true }),
    repointLink: async () => {},
    recordDispatchError: async (candidate, _reason, options) => {
      const next = (strikes.get(candidate.linkId) ?? 0) + 1
      strikes.set(candidate.linkId, next)
      if (next < 5) return { deadLettered: false }
      if (options?.deferDeadLetter) return { deadLettered: false, exhausted: { failureCount: next } }
      parked.add(candidate.linkId)
      return { deadLettered: true }
    },
    deadLetterDispatch: async (candidate) => { parked.add(candidate.linkId); return { deadLettered: true } },
    clearDispatchFailures: async (linkId) => { strikes.set(linkId, 0) },
    countLinksByOrderNumber: async (numbers) => new Map(numbers.map((number) => [number, 1])),
    systemicBreaker: breaker ? { store: breaker, connectorId: 'mintsoft' } : undefined,
  }
  return { deps, parked, strikes, state }
}

test('dispatch: a systemic pass parks nothing, raises ONE incident, and still counts the errors', async () => {
  const m = memoryStore()
  const h = dispatchHarness(3, 4, m.store)
  const r = await runWmsDispatchSweepCore(h.deps)
  assert.equal(h.parked.size, 0, 'no link was dead-lettered')
  assert.equal(r.systemicSuppressed, 3)
  assert.equal(r.counters.errors, 3, 'the pass failed: the job is not green')
  assert.equal(m.raised.length, 1)
  assert.equal(m.raised[0].sweep, 'dispatch')
  assert.equal(m.rows.get('dispatch')?.consecutive, 1)
})

test('dispatch: the next clean pass resolves the incident and the links dispatch', async () => {
  const m = memoryStore()
  const h = dispatchHarness(3, 4, m.store)
  await runWmsDispatchSweepCore(h.deps)
  await runWmsDispatchSweepCore(h.deps)
  assert.equal(m.raised.length, 1)
  h.state.warehouseDown = false
  const r = await runWmsDispatchSweepCore(h.deps)
  assert.equal(r.counters.dispatched, 3)
  assert.equal(r.counters.errors, 0)
  assert.equal(m.resolved.length, 1)
  assert.equal(m.rows.get('dispatch')?.consecutive, 0)
  assert.equal(h.parked.size, 0)
})

test('dispatch: the sixth consecutive systemic pass dead-letters per link, and the incident says so', async () => {
  const m = memoryStore()
  const h = dispatchHarness(3, 4, m.store)
  for (let pass = 1; pass <= 5; pass += 1) {
    const r = await runWmsDispatchSweepCore(h.deps)
    assert.equal(r.systemicSuppressed, 3, `pass ${pass}`)
    assert.equal(h.parked.size, 0, `pass ${pass}: nothing parked`)
  }
  assert.equal(m.raised.length, 1)
  const sixth = await runWmsDispatchSweepCore(h.deps)
  assert.equal(sixth.systemicSuppressed, 0)
  assert.deepEqual([...h.parked].sort(), ['l1', 'l2', 'l3'])
  assert.equal(m.raised.length, 2)
  assert.equal(m.raised[1].kind, 'escalate')
  assert.match(m.raised[1].message, /isolated one by one again/)
})

test('dispatch: one stuck order among healthy ones is dead-lettered as before, with no incident', async () => {
  const m = memoryStore()
  const h = dispatchHarness(10, 0, m.store)
  h.state.warehouseDown = false
  h.state.brokenOnly.add('WC-1004')
  h.strikes.set('l5', 4)
  const r = await runWmsDispatchSweepCore(h.deps)
  assert.deepEqual([...h.parked], ['l5'])
  assert.equal(r.systemicSuppressed, 0)
  assert.equal(r.counters.dispatched, 9)
  assert.equal(m.raised.length, 0)
})

test('dispatch: without a breaker the dead-letter is inline, exactly as before', async () => {
  const h = dispatchHarness(3, 4, undefined)
  const r = await runWmsDispatchSweepCore(h.deps)
  assert.equal(h.parked.size, 3)
  assert.equal(r.systemicSuppressed, 0)
})

// --- the production claim rule and lease -------------------------------------------------------------------------------------

test('order push: a DEFINITE-refusal outage is retried every pass, suppressed for 5 passes, isolated on the 6th (production claim rule)', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1', '2', '3'], 4, m.store)
  const calls: string[] = []
  for (let pass = 1; pass <= 5; pass += 1) {
    const before = calls.length
    const r = await pushPass({ down: true, calls }, port)
    assert.equal(calls.length - before, 3, `pass ${pass}: all three were offered a fresh create (the claim was released, not left to lapse into AMBIGUOUS_CREATE)`)
    assert.equal(r.systemicSuppressed, 3)
    assert.equal(r.deadLettered, 0)
    for (const row of links.values()) {
      assert.equal(row.state, 'PENDING_CREATE')
      assert.equal(row.lastAttemptAt, null, 'the dispatch stamp was released')
    }
  }
  assert.equal(m.raised.length, 1)
  const sixth = await pushPass({ down: true, calls }, port)
  assert.equal(sixth.deadLettered, 3)
  assert.ok([...links.values()].every((row) => row.state === 'DEAD_LETTER'))
  assert.equal(m.raised[1].kind, 'escalate')
})

test('order push: an AMBIGUOUS failure keeps its AMBIGUOUS_CREATE path and is never retried blind', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1', '2', '3'], 4, m.store)
  const calls: string[] = []
  const first = await pushPass({ down: true, ambiguous: true, calls }, port)
  assert.equal(first.systemicSuppressed, 3, 'it still counts as a failure for the ratio, and nothing is parked')
  assert.equal(calls.length, 3)
  assert.ok([...links.values()].every((row) => row.lastAttemptAt !== null), 'the stamp stands: a create may have landed')
  // inside the lease: no second create
  await pushPass({ down: true, ambiguous: true, calls }, port)
  assert.equal(calls.length, 3, 'a fresh lease is never claimed over')
  // after the lease lapses: AMBIGUOUS_CREATE, still no create
  clock += 10
  await pushPass({ down: true, ambiguous: true, calls }, port)
  assert.equal(calls.length, 3, 'never retried blind')
  assert.ok([...links.values()].every((row) => row.state === 'AMBIGUOUS_CREATE'))
})

test('order push: after a definite-refusal outage the next pass creates every order exactly once', async () => {
  const m = memoryStore()
  const { port, links } = ladderPort(['1', '2', '3'], 4, m.store)
  const created: string[] = []
  await pushPass({ down: true, created }, port)
  await pushPass({ down: true, created }, port)
  const recovered = await pushPass({ down: false, created }, port)
  assert.equal(recovered.created, 3)
  assert.deepEqual(created.sort(), ['SO-1', 'SO-2', 'SO-3'], 'each order was created once: no duplicate')
  assert.equal(m.resolved.length, 1)
  void links
})

// --- the inbox reads every sweep key the breaker writes ------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { buildSystemicIncidents, systemicFailureStateKey, systemicIncidentKeys, SYSTEMIC_SWEEPS } from '../lib/domain/wms/systemic-failure-store.ts'
import { runSystemicPass } from '../lib/domain/wms/systemic-failure.ts'

test('inbox: every sweep key the sweeps write is queried', () => {
  const written = new Set<string>()
  for (const file of ['lib/domain/wms/order-push-sweep.ts', 'lib/domain/wms/dispatch-sweep.ts']) {
    for (const match of readFileSync(file, 'utf8').matchAll(/runSystemicPass\([^)]*?sweep: '([a-z-]+)'/g)) written.add(match[1])
  }
  assert.deepEqual([...written].sort(), ['dispatch', 'order-push', 'order-push-verify'], 'precondition: the scan found the sweeps')
  const queried = new Set(systemicIncidentKeys(['mintsoft']).map((entry) => entry.key))
  for (const sweep of written) assert.ok(queried.has(systemicFailureStateKey('mintsoft', sweep)), `${sweep} is missing from the inbox query`)
  assert.deepEqual([...SYSTEMIC_SWEEPS].sort(), [...written].sort())
})

test('inbox: a suppressed verification pass appears in the summary count and the section rows', async () => {
  const m = memoryStore()
  await runSystemicPass(m.store, { sweep: 'order-push-verify', connector: 'mintsoft', outcomes: { attempted: 3, failed: 3, exhausted: 3 }, now: new Date('2026-11-16T00:00:00Z'), reason: 'HTTP 500' })
  const stored = new Map([...m.rows].map(([sweep, state]) => [systemicFailureStateKey('mintsoft', sweep), JSON.stringify(state)]))
  const rows = buildSystemicIncidents(systemicIncidentKeys(['mintsoft']), stored)
  assert.equal(rows.length, 1, 'the summary counts rows.length')
  assert.equal(rows[0].sweep, 'order-push-verify')
  assert.equal(rows[0].label, 'Order push verification')
  assert.equal(rows[0].failed, 3)
  assert.equal(rows[0].isolating, false)
})
