import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AMBIGUOUS_ATTEMPTS,
  decideCreateClaim,
  runWmsOrderPushSweepCore,
  shouldGrantCreateClaim,
  type WmsOrderPushPort,
  type WmsPushAmbiguousCreateLink,
  type WmsPushCandidate,
} from '../lib/domain/wms/order-push-sweep.ts'
import { wmsAmbiguousCreateRefusal } from '../lib/domain/wms/create-replay-policy.ts'
import type { WmsOrderPushInput, WmsOrderPushResult } from '../lib/connectors/wms/types.ts'
import type { WmsMutationEventInput } from '../lib/domain/wms/mutation-audit.ts'

/**
 * o3d-2k5r r4 — THE ORDINARY CRASHED-CREATE PATH.
 *
 * The r3 round put a three-rung ladder in front of the RE-QUEUE of a VALIDATION_FAILED link, and
 * its test reached that ladder by ALSO clearing a SKU. That mutation is what routed the scenario
 * through `recordValidationFailure`; without it the link never leaves PENDING_CREATE, and
 * PENDING_CREATE is a create candidate. So the common crash — valid payload, create lands, worker
 * dies before the writeback — walked straight past every rung, and `claimForCreate` handed the
 * order to the next worker on state and a stale timestamp alone.
 *
 * EVERY TEST IN THIS FILE TAKES THE CREATE-PASS ROUTE AND ASSERTS THAT IT DID:
 * `recordValidationFailure` is never called, `revalidatableLinks` is seeded empty, and the payload
 * is the SAME valid payload from beginning to end. A test that had to break the order's data to
 * reach the guard is the defect this file exists to stop repeating, so the route is an assertion
 * here and not a comment.
 */

const BINDINGS = [{ warehouseId: 'wh-1', externalWarehouseId: '301' }]
const T0 = new Date('2026-06-26T00:00:00.000Z')
/** Past CREATE_CLAIM_LEASE_MS (5 minutes) — the instant the old rule handed the claim over. */
const T1 = new Date('2026-06-26T00:06:00.000Z')
const T2 = new Date('2026-06-26T00:12:00.000Z')

function candidate(overrides: Partial<WmsPushCandidate> = {}): WmsPushCandidate {
  return {
    id: 'so-1',
    orderNumber: 'SO-1',
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
    pushAttempts: 0,
    // A VALID line. Nothing in this file ever removes it: the whole point is that this payload
    // builds on every sweep, so the order stays a CREATE candidate and never becomes a
    // revalidation candidate.
    lines: [{ sku: 'A', qty: 1, taxForeign: 0, totalForeign: 10, description: 'Widget' }],
    ...overrides,
  }
}

type LinkRow = {
  id: string
  orderId: string
  connector: string
  state: string
  attempts: number
  lastError: string | null
  lastAttemptAt: Date | null
  pushedAt: Date | null
  externalOrderId: string | null
  externalOrderNumber: string | null
}

/**
 * A link table, not a list of canned answers.
 *
 * `createCandidates` selects on STATE ALONE — `no link OR PENDING_CREATE` — because that is what
 * the production query does, and it is the reason a stale claim is re-offered to the create pass
 * at all. `claimForCreate` delegates to the PRODUCTION decision rather than re-stating it, so this
 * harness cannot quietly diverge from the rule it is supposed to be exercising.
 */
function makeLinkStore(options: { connectorId: string; failLinkWrites?: boolean }) {
  const links = new Map<string, LinkRow>()
  const events: WmsMutationEventInput[] = []
  const claimCalls: Array<{ orderId: string; at: Date }> = []
  const validationFailureCalls: string[] = []
  let seq = 0

  const write = (orderId: string, data: Record<string, unknown>) => {
    const row = links.get(orderId)
    if (!row) return
    Object.assign(row, data)
  }

  const port: WmsOrderPushPort = {
    activeBindings: async () => BINDINGS,
    releasableHeldOrders: async () => [],
    createCandidates: async () => {
      const link = links.get('so-1')
      if (link && link.state !== 'PENDING_CREATE') return []
      return [candidate({ pushAttempts: link?.attempts ?? 0 })]
    },
    // Deliberately EMPTY. A link that never fails validation is never a revalidation candidate,
    // so the r3 ladder cannot be what stops the duplicate in any test here.
    revalidatableLinks: async () => ({ links: [], total: 0 }),
    recordValidationFailure: async (orderId) => {
      validationFailureCalls.push(orderId)
      return true
    },
    claimForCreate: async (orderId, connector, attemptedAt) => {
      claimCalls.push({ orderId, at: attemptedAt })
      const existing = links.get(orderId) ?? null
      // MIRRORS THE PRISMA PORT (createPrismaWmsOrderPushPort.claimForCreate): read the link under
      // the order lock, DELEGATE TO THE PRODUCTION RULE — not a restatement of it, which is how a
      // harness quietly stops testing what it claims to — and write PENDING_CREATE BEFORE the
      // remote call. The park is written here too, in the same place the real port writes it.
      const decision = decideCreateClaim(existing, attemptedAt)
      if (decision === 'SKIP') return 'SKIPPED'
      if (decision === 'PARK_AMBIGUOUS') {
        write(orderId, {
          state: 'AMBIGUOUS_CREATE',
          attempts: Math.max(existing?.attempts ?? 0, AMBIGUOUS_ATTEMPTS),
          lastError: wmsAmbiguousCreateRefusal(connector, 'SO-1'),
          lastAttemptAt: attemptedAt,
        })
        return 'PARKED_AMBIGUOUS'
      }
      if (existing) write(orderId, { lastAttemptAt: attemptedAt })
      else {
        seq += 1
        links.set(orderId, {
          id: `link-${seq}`,
          orderId,
          connector,
          state: 'PENDING_CREATE',
          attempts: 0,
          lastError: null,
          lastAttemptAt: attemptedAt,
          pushedAt: null,
          externalOrderId: null,
          externalOrderNumber: null,
        })
      }
      return 'CLAIMED'
    },
    ambiguousCreateLinks: async () => {
      const link = links.get('so-1')
      if (!link || link.state !== 'AMBIGUOUS_CREATE') return { links: [], total: 0 }
      const row: WmsPushAmbiguousCreateLink = {
        id: link.id,
        orderId: link.orderId,
        lastError: link.lastError,
        attempts: link.attempts,
        pushedAt: link.pushedAt,
        externalOrderId: link.externalOrderId,
        order: { ...candidate({ pushAttempts: link.attempts }), shipFromWarehouseId: 'wh-1' },
      }
      return { links: [row], total: 1 }
    },
    verifiableLinks: async () => [],
    updatableLinks: async () => [],
    holdableLinks: async () => [],
    cancellableLinks: async () => [],
    upsertByOrder: async (orderId, create, update) => {
      // A killed worker: the claim committed, and nothing after it did. The create path's own
      // failure write is `.catch(() => {})`-swallowed, so this is all that is left behind.
      if (options.failLinkWrites) throw new Error('worker died before the writeback')
      if (links.has(orderId)) write(orderId, update as Record<string, unknown>)
      else {
        seq += 1
        links.set(orderId, {
          id: `link-${seq}`, orderId, connector: options.connectorId, state: 'PENDING_CREATE', attempts: 0,
          lastError: null, lastAttemptAt: null, pushedAt: null, externalOrderId: null, externalOrderNumber: null,
          ...(create as object),
        } as LinkRow)
      }
    },
    updateLink: async (id, data) => {
      const row = [...links.values()].find((l) => l.id === id)
      if (row) Object.assign(row, data)
    },
    updateLinkIfState: async (id, fromState, data) => {
      const row = [...links.values()].find((l) => l.id === id)
      if (!row || row.state !== fromState) return false
      Object.assign(row, data)
      return true
    },
    recordEvent: async (event) => { events.push(event) },
  }

  return { port, links, events, claimCalls, validationFailureCalls }
}

/**
 * A ShipHero-shaped warehouse: `order_create` does NOT enforce partner_order_id uniqueness, so the
 * only dedupe is the connector's own preflight lookup — and a preflight cannot see a request that
 * is still ON THE WIRE. `dispatchInFlight` / `land` model exactly that window, which is the reason
 * "the probe says MISSING" is not evidence that a create can be replayed.
 */
function shipheroWarehouse() {
  const created: string[] = []
  const inFlight: string[] = []
  return {
    created,
    inFlight,
    dispatchInFlight(externalReference: string) { inFlight.push(externalReference) },
    land() { created.push(...inFlight.splice(0)) },
    pushOrder: async (input: WmsOrderPushInput): Promise<WmsOrderPushResult> => {
      const hit = created.indexOf(input.externalReference)
      if (hit >= 0) {
        return { externalOrderId: `sh-${hit + 1}`, externalOrderNumber: `SH-${hit + 1}`, status: 'pending' }
      }
      created.push(input.externalReference)
      return { externalOrderId: `sh-${created.length}`, externalOrderNumber: `SH-${created.length}`, status: 'pending' }
    },
    probeOrderPresence: async (orderNumber: string): Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'> =>
      // Answers from what the warehouse HOLDS. An in-flight create is neither present nor proof of
      // absence — which is the whole point.
      (created.length > 0 && orderNumber === 'SO-1' ? 'FOUND' : 'MISSING'),
  }
}

/**
 * A Mintsoft-shaped warehouse: `PUT /api/Order` REFUSES a duplicate order number
 * (`{Success:false, Message:'Order already exists'}`) and `pushMintsoftOrder` then reconciles to
 * the order that already exists. A replay therefore cannot mint a second warehouse order — even
 * one racing a request still on the wire, because the REMOTE is what refuses.
 */
function mintsoftWarehouse() {
  const created: string[] = []
  const inFlight: string[] = []
  return {
    created,
    dispatchInFlight(orderNumber: string) { inFlight.push(orderNumber) },
    land() { created.push(...inFlight.splice(0)) },
    pushOrder: async (input: WmsOrderPushInput): Promise<WmsOrderPushResult> => {
      const hit = created.indexOf(input.orderNumber)
      if (hit >= 0) {
        return { externalOrderId: `ms-${hit + 1}`, externalOrderNumber: `MS-${hit + 1}`, status: 'NEW' }
      }
      created.push(input.orderNumber)
      return { externalOrderId: `ms-${created.length}`, externalOrderNumber: `MS-${created.length}`, status: 'NEW' }
    },
    probeOrderPresence: async (orderNumber: string): Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'> =>
      (created.includes(orderNumber) ? 'FOUND' : 'MISSING'),
  }
}

function connectorFor(warehouse: { pushOrder: (input: WmsOrderPushInput) => Promise<WmsOrderPushResult>; probeOrderPresence: (n: string) => Promise<'FOUND' | 'MISSING' | 'AMBIGUOUS'> }) {
  return {
    pushOrder: warehouse.pushOrder,
    probeOrderPresence: warehouse.probeOrderPresence,
    updateOrder: async () => ({ updated: true, status: 'NEW' }),
    cancelOrder: async () => ({ cancelled: true, status: 'CANCELLED' }),
    addOrderComment: undefined,
    verifyPushedOrder: undefined,
  }
}

function quiet<T>(run: () => Promise<T>): Promise<T> {
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  return run().finally(() => { console.warn = warn; console.error = error })
}

test('o3d-2k5r r4 create: a crashed create is NOT re-dispatched when the lease expires — valid payload, create-pass route', async () => {
  const wms = shipheroWarehouse()
  const conn = connectorFor(wms)

  // SWEEP 1 — the create leaves and the worker is killed before the writeback. The request is
  // still on the wire when the process dies, so the warehouse has not recorded it YET.
  const dying = makeLinkStore({ connectorId: 'shiphero', failLinkWrites: true })
  const first = await quiet(() => runWmsOrderPushSweepCore(
    { ...conn, pushOrder: async (input: WmsOrderPushInput) => { wms.dispatchInFlight(input.externalReference); return { externalOrderId: 'sh-inflight', externalOrderNumber: 'SH-inflight', status: 'pending' } } },
    'shiphero', dying.port, { now: () => T0 },
  ))
  assert.equal(first.created, 0, 'IMS recorded nothing about the create')
  const stale = dying.links.get('so-1')!
  assert.equal(stale.state, 'PENDING_CREATE', 'the claim is all that survived')
  assert.equal(stale.attempts, 0)
  assert.deepEqual(stale.lastAttemptAt, T0)

  // SWEEP 2 — six minutes later. The payload is UNCHANGED and still valid, so the order is a
  // create candidate on state alone and reaches claimForCreate. This is the route the r3 ladder
  // never sees.
  const second = makeLinkStore({ connectorId: 'shiphero' })
  second.links.set('so-1', { ...stale })
  const r = await quiet(() => runWmsOrderPushSweepCore(conn, 'shiphero', second.port, { now: () => T1 }))

  // ROUTE ASSERTIONS: this scenario reached the guard through the create pass and nothing else.
  assert.deepEqual(second.validationFailureCalls, [], 'no validation-failure route was taken')
  assert.equal(second.claimCalls.length, 1, 'the create pass DID ask for the claim')

  // THE ASSERTION THAT MATTERS: the crashed worker's request finally lands, and it is the ONLY
  // order the warehouse ever holds for this sale.
  wms.land()
  assert.deepEqual(wms.created, ['so-1'], 'the warehouse was not told to fulfil the same sale twice')
  assert.equal(r.created, 0)

  // And the link is parked where a human can see it, not left as a create candidate that the next
  // sweep offers up all over again.
  const parked = second.links.get('so-1')!
  assert.equal(parked.state, 'AMBIGUOUS_CREATE')
  assert.ok(parked.attempts >= AMBIGUOUS_ATTEMPTS, 'and it no longer reads as "no call was dispatched"')
  assert.match(String(parked.lastError), /outcome/i)
})
